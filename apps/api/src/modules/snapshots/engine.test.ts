import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import {
  applyChange,
  applyDiff,
  assertContinuous,
  assertHeadVersion,
  assertRollbackTarget,
  diffValues,
  emptyDocument,
  hashDocument,
  materializeAt,
  planRestore,
  replayEvents,
  recomputeFromDeltas,
  seqAtTime,
  type ChangePayload,
  type DiffOp,
  type SnapshotEventRecord,
  type SnapshotMeta,
  type TraceDocument
} from './engine.js';

type SnapshotRow = SnapshotMeta & { delta: DiffOp[] };

/**
 * 内存版快照账本：复刻 service 层的编排不变量——
 * 事件只追加、回滚追加 ROLLBACK 事件并在其位置落 restore-point 快照、
 * 回滚前必须通过版本校验（对应数据库 CAS）。
 */
class MemoryLedger {
  events: SnapshotEventRecord[] = [];
  snapshots: SnapshotRow[] = [];
  headSeq = 0;
  version = 1;
  doc: TraceDocument = emptyDocument();
  now = new Date('2026-09-27T08:00:00.000Z');

  private tick(): void {
    this.now = new Date(this.now.getTime() + 60_000);
  }

  change(change: ChangePayload): void {
    this.tick();
    this.headSeq += 1;
    this.version += 1;
    this.events.push({ seq: this.headSeq, kind: 'CHANGE', payload: change, occurredAt: this.now });
    this.doc = applyChange(this.doc, change);
  }

  snapshot(): SnapshotRow {
    const previous = recomputeFromDeltas(this.snapshots.map((row) => row.delta));
    const row: SnapshotRow = {
      seq: this.snapshots.length + 1,
      eventSeq: this.headSeq,
      stateHash: hashDocument(this.doc),
      delta: diffValues(previous, this.doc)
    };
    this.snapshots.push(row);
    return row;
  }

  rollback(targetSeq: number, expectedVersion: number): void {
    assertHeadVersion(this.version, expectedVersion);
    assertRollbackTarget(targetSeq, this.headSeq);
    this.tick();
    const restored = materializeAt(targetSeq, this.snapshots, this.events);
    for (const item of planRestore(this.doc, restored)) {
      this.doc = applyChange(this.doc, { entity: item.entity, entityId: item.entityId, op: item.op, ...(item.after ? { after: item.after } : {}) });
    }
    this.headSeq += 1;
    this.version += 1;
    this.events.push({
      seq: this.headSeq,
      kind: 'ROLLBACK',
      payload: { targetSeq, stateHash: hashDocument(restored) },
      occurredAt: this.now
    });
    this.snapshot();
  }

  seqs(): number[] {
    return this.events.map((event) => event.seq);
  }

  verifyAllSnapshots(): void {
    for (const snapshot of this.snapshots) {
      const chain = this.snapshots.filter((row) => row.seq <= snapshot.seq).map((row) => row.delta);
      expect(hashDocument(recomputeFromDeltas(chain))).toBe(snapshot.stateHash);
      const prefix = this.events.filter((event) => event.seq <= snapshot.eventSeq);
      expect(hashDocument(replayEvents(prefix))).toBe(snapshot.stateHash);
    }
  }
}

const dogEar = (pageNumber: number, reason: string | null = null) => ({ pageNumber, reason });
const upsertDogEar = (id: string, pageNumber: number, reason: string | null = null): ChangePayload => ({
  entity: 'dogEars',
  entityId: id,
  op: 'upsert',
  after: dogEar(pageNumber, reason)
});

describe('diff / patch', () => {
  it('round-trips nested changes, additions and removals', () => {
    const before: TraceDocument = {
      dogEars: { a: dogEar(12, '伏笔'), b: dogEar(30) },
      annotations: { x: { startPage: 3, endPage: 5, content: '划线' } },
      rereadMarks: {}
    };
    const after: TraceDocument = {
      dogEars: { b: dogEar(31, '改页码'), c: dogEar(40) },
      annotations: { x: { startPage: 3, endPage: 5, content: '划线' } },
      rereadMarks: { r1: dogEar(3) }
    };
    const ops = diffValues(before, after);
    expect(applyDiff(before, ops)).toEqual(after);
    // 差异是确定性的：同样的输入产生同样的操作序列
    expect(diffValues(before, after)).toEqual(ops);
  });

  it('produces an empty diff for equal documents regardless of key order', () => {
    const one: TraceDocument = { dogEars: { a: dogEar(1), b: dogEar(2) }, annotations: {}, rereadMarks: {} };
    const two: TraceDocument = { dogEars: { b: dogEar(2), a: dogEar(1) }, annotations: {}, rereadMarks: {} };
    expect(diffValues(one, two)).toEqual([]);
  });

  it('rejects diffs that do not match the base state', () => {
    const doc = emptyDocument();
    expect(() => applyDiff(doc, [{ op: 'set', path: ['dogEars', 'a', 'pageNumber', 'deep'], value: 1 }])).toThrow(AppError);
  });
});

describe('hashDocument', () => {
  it('is stable across key ordering and detects changes', () => {
    const one: TraceDocument = { dogEars: { a: dogEar(1), b: dogEar(2) }, annotations: {}, rereadMarks: {} };
    const two: TraceDocument = { dogEars: { b: dogEar(2), a: dogEar(1) }, annotations: {}, rereadMarks: {} };
    expect(hashDocument(one)).toBe(hashDocument(two));
    expect(hashDocument(one)).toMatch(/^[0-9a-f]{64}$/);
    const changed: TraceDocument = { ...one, dogEars: { a: dogEar(9), b: dogEar(2) } };
    expect(hashDocument(changed)).not.toBe(hashDocument(one));
  });
});

describe('event sequence', () => {
  it('accepts contiguous sequences and rejects gaps', () => {
    const at = new Date('2026-09-27T08:00:00.000Z');
    const events: SnapshotEventRecord[] = [
      { seq: 1, kind: 'CHANGE', payload: upsertDogEar('a', 1), occurredAt: at },
      { seq: 2, kind: 'CHANGE', payload: upsertDogEar('b', 2), occurredAt: at }
    ];
    expect(() => assertContinuous(events)).not.toThrow();
    expect(() => assertContinuous([events[0]!, { ...events[1]!, seq: 3 }])).toThrow(AppError);
  });

  it('resolves rollback targets strictly before the head', () => {
    expect(() => assertRollbackTarget(0, 5)).not.toThrow();
    expect(() => assertRollbackTarget(4, 5)).not.toThrow();
    expect(() => assertRollbackTarget(5, 5)).toThrow(AppError);
    expect(() => assertRollbackTarget(-1, 5)).toThrow(AppError);
  });

  it('locates the target seq by time', () => {
    const ledger = new MemoryLedger();
    ledger.change(upsertDogEar('a', 10));
    ledger.change(upsertDogEar('b', 20));
    ledger.change(upsertDogEar('c', 30));
    expect(seqAtTime(ledger.events, new Date('2026-09-27T08:00:30.000Z'))).toBe(0);
    expect(seqAtTime(ledger.events, new Date('2026-09-27T08:01:30.000Z'))).toBe(1);
    expect(seqAtTime(ledger.events, new Date('2026-09-27T08:03:00.000Z'))).toBe(3);
    expect(seqAtTime(ledger.events, new Date('2026-09-28T00:00:00.000Z'))).toBe(3);
  });
});

describe('rollback lifecycle', () => {
  function buildLedger(): MemoryLedger {
    const ledger = new MemoryLedger();
    ledger.change(upsertDogEar('d1', 10, '第一处'));
    ledger.change(upsertDogEar('d2', 20));
    ledger.change({ entity: 'annotations', entityId: 'a1', op: 'upsert', after: { startPage: 1, endPage: 3, content: '批注一' } });
    ledger.snapshot(); // S1 @ seq 3
    ledger.change(upsertDogEar('d1', 11, '改过的折角'));
    ledger.change({ entity: 'rereadMarks', entityId: 'r1', op: 'upsert', after: dogEar(3, '重读') });
    ledger.change({ entity: 'annotations', entityId: 'a1', op: 'remove' });
    ledger.snapshot(); // S2 @ seq 6
    return ledger;
  }

  it('keeps the event sequence continuous after rollback and new changes', () => {
    const ledger = buildLedger();
    const atThree = materializeAt(3, ledger.snapshots, ledger.events);
    ledger.rollback(3, ledger.version);
    // 回滚事件占据下一个 seq，restore-point 快照锚定该位置
    expect(ledger.seqs()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ledger.events.at(-1)).toMatchObject({ seq: 7, kind: 'ROLLBACK', payload: { targetSeq: 3 } });
    expect(ledger.doc).toEqual(atThree);
    // 恢复后继续写入，序列仍然连续
    ledger.change(upsertDogEar('d3', 50));
    expect(ledger.seqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ledger.doc.dogEars['d3']).toEqual(dogEar(50));
    // 任意历史位置（含被回滚覆盖的分支）都可复算
    for (let seq = 0; seq <= ledger.headSeq; seq += 1) {
      expect(() => materializeAt(seq, ledger.snapshots, ledger.events)).not.toThrow();
    }
    expect(materializeAt(6, ledger.snapshots, ledger.events).annotations['a1']).toBeUndefined();
    ledger.verifyAllSnapshots();
  });

  it('keeps old snapshots recomputable after they are abandoned by a rollback', () => {
    const ledger = buildLedger();
    const [s1, s2] = ledger.snapshots;
    ledger.rollback(2, ledger.version);
    ledger.change(upsertDogEar('d9', 99));
    // S1/S2 位于被放弃的分支上，但差异链与事件前缀两条路径仍可复算
    const abandoned = ledger.snapshots.slice(0, 2).filter((row) => row.eventSeq > 2);
    expect(abandoned.map((row) => row.seq)).toEqual([1, 2]);
    ledger.verifyAllSnapshots();
    expect(s1 && hashDocument(materializeAt(s1.eventSeq, ledger.snapshots, ledger.events))).toBe(s1?.stateHash);
    expect(s2 && s2.eventSeq).toBe(6);
  });

  it('replays nested rollbacks deterministically from the event log alone', () => {
    const ledger = buildLedger();
    ledger.rollback(3, ledger.version); // seq 7
    ledger.change(upsertDogEar('d4', 40)); // seq 8
    ledger.change(upsertDogEar('d5', 50)); // seq 9
    ledger.rollback(1, ledger.version); // seq 10：嵌套回滚到更早位置
    ledger.change(upsertDogEar('d6', 60)); // seq 11
    // 三条路径一致：纯事件重放、最近快照+区间重放、业务表现态
    const replayed = replayEvents(ledger.events);
    const materialized = materializeAt(ledger.headSeq, ledger.snapshots, ledger.events);
    expect(hashDocument(replayed)).toBe(hashDocument(ledger.doc));
    expect(hashDocument(materialized)).toBe(hashDocument(ledger.doc));
    expect(ledger.doc).toEqual({ dogEars: { d1: dogEar(10, '第一处'), d6: dogEar(60) }, annotations: {}, rereadMarks: {} });
    ledger.verifyAllSnapshots();
  });

  it('rejects a replay range that crosses an unanchored rollback event', () => {
    const ledger = buildLedger();
    ledger.rollback(3, ledger.version);
    // 人为破坏不变量：删掉 restore-point 快照，区间重放必须报错
    const corrupted = ledger.snapshots.filter((row) => row.eventSeq !== 7);
    expect(() => materializeAt(7, corrupted, ledger.events)).toThrow(AppError);
  });
});

describe('concurrent rollback version check', () => {
  it('allows exactly one rollback per head version, then requires a fresh version', () => {
    const ledger = new MemoryLedger();
    ledger.change(upsertDogEar('a', 1));
    ledger.change(upsertDogEar('b', 2));
    ledger.change(upsertDogEar('c', 3));
    const stale = ledger.version;
    // 两个并发回滚携带同一版本：先者成功，后者必须 409
    ledger.rollback(2, stale);
    expect(() => ledger.rollback(1, stale)).toThrow(AppError);
    try {
      ledger.rollback(1, stale);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('STALE_WRITE');
    }
    // 读取新版本后重试成功，序列依旧连续
    ledger.rollback(1, ledger.version);
    expect(ledger.seqs()).toEqual([1, 2, 3, 4, 5]);
    expect(ledger.doc).toEqual(materializeAt(1, ledger.snapshots, ledger.events));
    ledger.verifyAllSnapshots();
  });

  it('invalidates in-flight rollbacks when new changes advance the version', () => {
    const ledger = new MemoryLedger();
    ledger.change(upsertDogEar('a', 1));
    const seen = ledger.version;
    ledger.change(upsertDogEar('b', 2));
    expect(() => ledger.rollback(1, seen)).toThrow(AppError);
  });
});

describe('restore plan', () => {
  it('plans upserts and removals deterministically', () => {
    const current: TraceDocument = {
      dogEars: { keep: dogEar(1), change: dogEar(2), drop: dogEar(3) },
      annotations: {},
      rereadMarks: {}
    };
    const target: TraceDocument = {
      dogEars: { keep: dogEar(1), change: dogEar(20), revive: dogEar(4) },
      annotations: { note: { startPage: 1, endPage: 2, content: 'n' } },
      rereadMarks: {}
    };
    // 顺序按实体分组、组内键序确定：先 upsert 后 remove
    const plan = planRestore(current, target);
    expect(plan).toEqual([
      { entity: 'dogEars', entityId: 'change', op: 'upsert', after: dogEar(20) },
      { entity: 'dogEars', entityId: 'revive', op: 'upsert', after: dogEar(4) },
      { entity: 'dogEars', entityId: 'drop', op: 'remove' },
      { entity: 'annotations', entityId: 'note', op: 'upsert', after: { startPage: 1, endPage: 2, content: 'n' } }
    ]);
    let restored = current;
    for (const item of plan) {
      restored = applyChange(restored, { entity: item.entity, entityId: item.entityId, op: item.op, ...(item.after ? { after: item.after } : {}) });
    }
    expect(restored).toEqual(target);
  });
});
