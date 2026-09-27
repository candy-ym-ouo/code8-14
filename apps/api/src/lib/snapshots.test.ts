import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { AppError } from './errors.js';
import {
  appendSnapshot,
  applyDiff,
  diffStates,
  dogEarState,
  hashState,
  replayChain,
  snapshotAtTime,
  statesEqual,
  type DogEarSnapshotState,
  type SnapshotChainRow
} from './snapshots.js';

const base: DogEarSnapshotState = { pageNumber: 12, reason: '伏笔', deletedAt: null };

function row(version: number, diff: Record<string, unknown>, createdAt: string, hash?: string): SnapshotChainRow {
  return {
    version,
    diffJson: diff,
    stateHash: hash ?? '',
    createdAt: new Date(createdAt)
  };
}

/** 用内存表模拟事务客户端，验证 appendSnapshot 写出的链条。 */
function fakeTx() {
  const rows: Array<{ version: number; diffJson: unknown; stateHash: string; createdAt: Date }> = [];
  const tx = {
    traceSnapshot: {
      aggregate: async () => ({
        _max: { version: rows.length ? Math.max(...rows.map((item) => item.version)) : null }
      }),
      create: async ({ data }: { data: { version: number; diffJson: unknown; stateHash: string } }) => {
        rows.push({ ...data, createdAt: new Date(Date.now() + rows.length) });
        return data;
      }
    }
  } as unknown as Prisma.TransactionClient;
  return { tx, rows };
}

describe('snapshot diff', () => {
  it('diffs only changed fields and applies them back', () => {
    const next: DogEarSnapshotState = { pageNumber: 21, reason: '伏笔', deletedAt: null };
    const diff = diffStates(base, next);
    expect(diff).toEqual({ pageNumber: 21 });
    expect(applyDiff(base, diff)).toEqual(next);
  });

  it('treats null as a real change, not a missing key', () => {
    const next: DogEarSnapshotState = { ...base, reason: null };
    const diff = diffStates(base, next);
    expect(diff).toEqual({ reason: null });
    expect(applyDiff(base, diff)).toEqual(next);
  });

  it('produces an empty diff when nothing changed', () => {
    expect(diffStates(base, { ...base })).toEqual({});
  });

  it('hashes states independent of key order', () => {
    const reordered = { deletedAt: null, reason: '伏笔', pageNumber: 12 } as DogEarSnapshotState;
    expect(hashState(reordered)).toBe(hashState(base));
    expect(hashState({ ...base, pageNumber: 13 })).not.toBe(hashState(base));
  });

  it('compares states by value', () => {
    expect(statesEqual(base, { ...base })).toBe(true);
    expect(statesEqual(base, { ...base, deletedAt: '2026-09-27T00:00:00.000Z' })).toBe(false);
  });
});

describe('replayChain', () => {
  const v1 = { ...base };
  const v2 = { ...base, reason: '重读标记' };
  const v3 = { ...v2, deletedAt: '2026-09-20T08:00:00.000Z' };
  const chain: SnapshotChainRow[] = [
    row(1, v1, '2026-09-18T08:00:00.000Z', hashState(v1)),
    row(2, diffStates(v1, v2), '2026-09-19T08:00:00.000Z', hashState(v2)),
    row(3, diffStates(v2, v3), '2026-09-20T08:00:00.000Z', hashState(v3))
  ];

  it('recomputes the latest state from diffs only', () => {
    const result = replayChain(chain);
    expect(result.state).toEqual(v3);
    expect(result.stateHash).toBe(hashState(v3));
  });

  it('recomputes any historical version (旧快照可复算)', () => {
    expect(replayChain(chain, 1).state).toEqual(v1);
    expect(replayChain(chain, 2).state).toEqual(v2);
  });

  it('rejects a chain with a version gap', () => {
    const broken = [chain[0]!, row(3, diffStates(v2, v3), '2026-09-20T08:00:00.000Z', hashState(v3))];
    expect(() => replayChain(broken)).toThrowError(AppError);
    expect(() => replayChain(broken)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_CORRUPT' }));
  });

  it('detects tampered diffs via stateHash', () => {
    const tampered = [
      chain[0]!,
      row(2, { reason: '被篡改' }, '2026-09-19T08:00:00.000Z', hashState(v2)),
      chain[2]!
    ];
    expect(() => replayChain(tampered)).toThrowError(
      expect.objectContaining({ code: 'SNAPSHOT_CORRUPT' })
    );
  });

  it('rejects unknown versions and empty chains', () => {
    expect(() => replayChain(chain, 9)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_NOT_FOUND' }));
    expect(() => replayChain([])).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_NOT_FOUND' }));
  });
});

describe('snapshotAtTime', () => {
  const chain = [
    row(1, {}, '2026-09-18T08:00:00.000Z'),
    row(2, {}, '2026-09-19T08:00:00.000Z'),
    row(3, {}, '2026-09-20T08:00:00.000Z')
  ];

  it('picks the latest snapshot at or before the target time', () => {
    expect(snapshotAtTime(chain, new Date('2026-09-19T12:00:00.000Z'))?.version).toBe(2);
    expect(snapshotAtTime(chain, new Date('2026-09-20T08:00:00.000Z'))?.version).toBe(3);
    expect(snapshotAtTime(chain, new Date('2027-01-01T00:00:00.000Z'))?.version).toBe(3);
  });

  it('returns null when the target is before the first snapshot', () => {
    expect(snapshotAtTime(chain, new Date('2026-09-17T08:00:00.000Z'))).toBeNull();
  });
});

describe('appendSnapshot', () => {
  it('stores the full state for the first version and diffs afterwards', async () => {
    const { tx, rows } = fakeTx();
    const v2 = { ...base, pageNumber: 30 };
    await appendSnapshot(tx, {
      userId: 'u',
      bookId: 'b',
      entityType: 'DOG_EAR',
      entityId: 'e',
      version: 1,
      prevState: null,
      nextState: base
    });
    await appendSnapshot(tx, {
      userId: 'u',
      bookId: 'b',
      entityType: 'DOG_EAR',
      entityId: 'e',
      version: 2,
      prevState: base,
      nextState: v2
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, diffJson: base, stateHash: hashState(base) });
    expect(rows[1]).toMatchObject({ version: 2, diffJson: { pageNumber: 30 }, stateHash: hashState(v2) });
    expect(replayChain(rows).state).toEqual(v2);
  });

  it('backfills a full baseline for pre-snapshot entities (version > 1, empty chain)', async () => {
    const { tx, rows } = fakeTx();
    const legacyV3 = { ...base, pageNumber: 99 };
    const v4 = { ...legacyV3, reason: null };
    await appendSnapshot(tx, {
      userId: 'u',
      bookId: 'b',
      entityType: 'DOG_EAR',
      entityId: 'e',
      version: 4,
      prevState: legacyV3,
      nextState: v4
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 3, diffJson: legacyV3 });
    expect(rows[1]).toMatchObject({ version: 4, diffJson: { reason: null } });
    expect(replayChain(rows, 3).state).toEqual(legacyV3);
    expect(replayChain(rows).state).toEqual(v4);
  });

  it('refuses to append when the chain tip does not match the entity version', async () => {
    const { tx } = fakeTx();
    await appendSnapshot(tx, {
      userId: 'u',
      bookId: 'b',
      entityType: 'DOG_EAR',
      entityId: 'e',
      version: 1,
      prevState: null,
      nextState: base
    });
    await expect(
      appendSnapshot(tx, {
        userId: 'u',
        bookId: 'b',
        entityType: 'DOG_EAR',
        entityId: 'e',
        version: 5,
        prevState: base,
        nextState: { ...base, pageNumber: 1 }
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'SNAPSHOT_CHAIN_BROKEN' }));
  });

  it('keeps a full lifecycle chain recomputable, including a rollback version', async () => {
    const { tx, rows } = fakeTx();
    const deletedAt = '2026-09-21T10:00:00.000Z';
    const versions: DogEarSnapshotState[] = [
      base, // v1 创建
      { ...base, reason: '改为书签' }, // v2 修改
      { ...base, reason: '改为书签', deletedAt }, // v3 删除
      { ...base, reason: '改为书签', deletedAt: null } // v4 恢复
    ];
    // v5 回滚到 v2 的状态：作为新版本追加，历史不被改写
    const rolledBack = versions[1]!;
    const nextVersion5 = { ...rolledBack };

    let prev: DogEarSnapshotState | null = null;
    for (const [index, state] of versions.entries()) {
      await appendSnapshot(tx, {
        userId: 'u',
        bookId: 'b',
        entityType: 'DOG_EAR',
        entityId: 'e',
        version: index + 1,
        prevState: prev,
        nextState: state
      });
      prev = state;
    }
    await appendSnapshot(tx, {
      userId: 'u',
      bookId: 'b',
      entityType: 'DOG_EAR',
      entityId: 'e',
      version: 5,
      prevState: prev,
      nextState: nextVersion5
    });

    expect(rows.map((item) => item.version)).toEqual([1, 2, 3, 4, 5]);
    for (const [index, state] of [...versions, nextVersion5].entries()) {
      expect(replayChain(rows, index + 1).state).toEqual(state);
    }
    // 回滚后链尾状态等于 v2，但 v3、v4 的历史仍然完整可复算
    expect(replayChain(rows).state).toEqual(versions[1]);
  });
});

describe('dogEarState', () => {
  it('normalizes deletedAt to ISO strings for stable hashing', () => {
    const state = dogEarState({ pageNumber: 3, reason: null, deletedAt: new Date('2026-09-20T08:00:00.000Z') });
    expect(state).toEqual({ pageNumber: 3, reason: null, deletedAt: '2026-09-20T08:00:00.000Z' });
  });
});
