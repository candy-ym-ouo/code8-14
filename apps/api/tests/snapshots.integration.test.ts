import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * 痕迹版本快照的端到端集成测试。
 * 需要真实 PostgreSQL：RUN_SNAPSHOT_DB_TESTS=1 DATABASE_URL=... npx vitest run tests/
 * 默认跳过，不影响无数据库环境下的 npm test。
 */
const RUN = process.env.RUN_SNAPSHOT_DB_TESTS === '1';

interface Inject {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  payload?: unknown;
}

describe.skipIf(!RUN)('trace snapshots (integration)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let bookId: string;

  async function call({ method, url, payload }: Inject) {
    return app.inject({ method, url, payload, cookies: { pbt_session: cookie } });
  }

  async function head(): Promise<{ headSeq: number; version: number }> {
    const res = await call({ method: 'GET', url: `/api/v1/books/${bookId}/trace-snapshots/head` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function eventSeqs(): Promise<number[]> {
    const rows = await prisma.traceSnapshotEvent.findMany({ where: { bookId }, orderBy: { seq: 'asc' } });
    return rows.map((row) => row.seq);
  }

  async function verifyAllSnapshots(): Promise<void> {
    const list = await call({ method: 'GET', url: `/api/v1/books/${bookId}/trace-snapshots` });
    for (const item of list.json().items) {
      const res = await call({ method: 'GET', url: `/api/v1/books/${bookId}/trace-snapshots/${item.seq}/verify` });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }
  }

  beforeAll(async () => {
    app = await buildApp();
    const email = `snapshots-${Date.now()}@example.com`;
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'snapshot-password-1' }
    });
    expect(register.statusCode).toBe(201);
    const setCookie = register.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = /pbt_session=([^;]+)/.exec(raw ?? '')?.[1] ?? '';
    expect(cookie).not.toBe('');
    const book = await call({ method: 'POST', url: '/api/v1/books', payload: { title: '快照集成测试', pageCount: 300 } });
    expect(book.statusCode).toBe(201);
    bookId = book.json().book.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('records changes as a continuous event sequence', async () => {
    expect((await call({ method: 'POST', url: `/api/v1/books/${bookId}/dog-ears`, payload: { pageNumber: 10, reason: '第一处' } })).statusCode).toBe(201);
    expect((await call({ method: 'POST', url: `/api/v1/books/${bookId}/annotations`, payload: { startPage: 1, endPage: 3, content: '批注一' } })).statusCode).toBe(201);
    expect((await call({ method: 'POST', url: `/api/v1/books/${bookId}/reread-marks`, payload: { pageNumber: 3, reason: '重读' } })).statusCode).toBe(201);
    expect(await head()).toEqual({ headSeq: 3, version: 4 });
    expect(await eventSeqs()).toEqual([1, 2, 3]);
  });

  it('takes a baseline snapshot and recomputes it from the delta chain', async () => {
    const created = await call({ method: 'POST', url: `/api/v1/books/${bookId}/trace-snapshots`, payload: { label: '基线' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().snapshot).toMatchObject({ seq: 1, eventSeq: 3, label: '基线' });

    const detail = await call({ method: 'GET', url: `/api/v1/books/${bookId}/trace-snapshots/1` });
    const document = detail.json().document;
    expect(Object.keys(document.dogEars)).toHaveLength(1);
    expect(Object.keys(document.annotations)).toHaveLength(1);
    expect(Object.keys(document.rereadMarks)).toHaveLength(1);

    const verify = await call({ method: 'GET', url: `/api/v1/books/${bookId}/trace-snapshots/1/verify` });
    expect(verify.json()).toMatchObject({ ok: true });
    expect(verify.json().recomputedHash).toBe(verify.json().replayedHash);
  });

  it('mutates traces, takes a second snapshot, then rejects a stale rollback', async () => {
    expect((await call({ method: 'POST', url: `/api/v1/books/${bookId}/dog-ears`, payload: { pageNumber: 20 } })).statusCode).toBe(201);
    const annotations = await prisma.annotation.findMany({ where: { bookId, deletedAt: null } });
    expect((await call({ method: 'DELETE', url: `/api/v1/annotations/${annotations[0]!.id}` })).statusCode).toBe(204);
    const rereads = await prisma.rereadMark.findMany({ where: { bookId, deletedAt: null } });
    expect((await call({ method: 'PATCH', url: `/api/v1/reread-marks/${rereads[0]!.id}`, payload: { pageNumber: 4 } })).statusCode).toBe(200);
    expect(await head()).toEqual({ headSeq: 6, version: 7 });

    expect((await call({ method: 'POST', url: `/api/v1/books/${bookId}/trace-snapshots`, payload: { label: '第二版' } })).statusCode).toBe(201);

    const stale = await call({
      method: 'POST',
      url: `/api/v1/books/${bookId}/trace-snapshots/rollback`,
      payload: { eventSeq: 3, expectedVersion: 4 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('STALE_WRITE');
  });

  it('rolls back to the baseline, keeps the sequence continuous and restores traces', async () => {
    const { version } = await head();
    const rolled = await call({
      method: 'POST',
      url: `/api/v1/books/${bookId}/trace-snapshots/rollback`,
      payload: { eventSeq: 3, expectedVersion: version }
    });
    expect(rolled.statusCode).toBe(200);
    expect(rolled.json().head.headSeq).toBe(7);
    expect(rolled.json().snapshot.seq).toBe(3);

    // 事件序列连续：回滚事件占据 seq 7，历史事件全部保留
    expect(await eventSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const rollbackEvent = await prisma.traceSnapshotEvent.findUnique({ where: { bookId_seq: { bookId, seq: 7 } } });
    expect(rollbackEvent).toMatchObject({ kind: 'ROLLBACK' });
    expect(rollbackEvent?.payloadJson).toMatchObject({ targetSeq: 3 });

    // 业务表已恢复：批注回来了，p20 折角消失了，重读页码回到 3
    const traces = await call({ method: 'GET', url: `/api/v1/books/${bookId}/traces` });
    const items = traces.json().items;
    expect(items.filter((item: { type: string }) => item.type === 'DOG_EAR').map((item: { pageNumber: number }) => item.pageNumber)).toEqual([10]);
    expect(items.filter((item: { type: string }) => item.type === 'ANNOTATION')).toHaveLength(1);
    expect(items.find((item: { type: string }) => item.type === 'REREAD_MARK')).toMatchObject({ pageNumber: 3 });

    // 恢复后继续写入，序列仍然连续；旧快照全部可复算
    expect((await call({ method: 'POST', url: `/api/v1/books/${bookId}/dog-ears`, payload: { pageNumber: 30 } })).statusCode).toBe(201);
    expect(await eventSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await verifyAllSnapshots();
  });

  it('allows exactly one of two concurrent rollbacks carrying the same version', async () => {
    const { version } = await head();
    const [first, second] = await Promise.all([
      call({ method: 'POST', url: `/api/v1/books/${bookId}/trace-snapshots/rollback`, payload: { eventSeq: 1, expectedVersion: version } }),
      call({ method: 'POST', url: `/api/v1/books/${bookId}/trace-snapshots/rollback`, payload: { eventSeq: 3, expectedVersion: version } })
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const seqs = await eventSeqs();
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    await verifyAllSnapshots();
  });

  it('rolls back by time to the empty document and stays consistent', async () => {
    const firstEvent = await prisma.traceSnapshotEvent.findFirstOrThrow({ where: { bookId }, orderBy: { seq: 'asc' } });
    const beforeAll = new Date(firstEvent.occurredAt.getTime() - 1000);
    const { version } = await head();
    const rolled = await call({
      method: 'POST',
      url: `/api/v1/books/${bookId}/trace-snapshots/rollback`,
      payload: { targetTime: beforeAll.toISOString(), expectedVersion: version }
    });
    expect(rolled.statusCode).toBe(200);

    const traces = await call({ method: 'GET', url: `/api/v1/books/${bookId}/traces` });
    expect(traces.json().items).toHaveLength(0);

    const seqs = await eventSeqs();
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    await verifyAllSnapshots();

    // 从空文档重新写入，一切继续
    expect((await call({ method: 'POST', url: `/api/v1/books/${bookId}/dog-ears`, payload: { pageNumber: 5 } })).statusCode).toBe(201);
    const state = await call({ method: 'GET', url: `/api/v1/books/${bookId}/trace-snapshots/state?eventSeq=1` });
    expect(Object.keys(state.json().document.dogEars)).toHaveLength(1);
  });
});
