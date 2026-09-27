import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import {
  assertRollbackTarget,
  diffValues,
  emptyDocument,
  hashDocument,
  materializeAt,
  planRestore,
  replayEvents,
  recomputeFromDeltas,
  seqAtTime,
  assertContinuous,
  type ChangePayload,
  type DiffOp,
  type RestorePlanItem,
  type SnapshotEventRecord,
  type SnapshotMeta,
  type TraceDocument
} from './engine.js';

type Tx = Prisma.TransactionClient;

export interface RollbackTargetInput {
  snapshotSeq?: number;
  eventSeq?: number;
  time?: Date;
}

interface SnapshotRow {
  id: string;
  seq: number;
  eventSeq: number;
  headVersion: number;
  label: string | null;
  stateHash: string;
  deltaJson: Prisma.JsonValue;
  createdAt: Date;
}

function toEventRecord(row: { seq: number; kind: 'CHANGE' | 'ROLLBACK'; payloadJson: Prisma.JsonValue; occurredAt: Date }): SnapshotEventRecord {
  return {
    seq: row.seq,
    kind: row.kind,
    payload: row.payloadJson as unknown as SnapshotEventRecord['payload'],
    occurredAt: row.occurredAt
  };
}

function toSnapshotMeta(row: SnapshotRow): SnapshotMeta & { delta: DiffOp[] } {
  return { seq: row.seq, eventSeq: row.eventSeq, stateHash: row.stateHash, delta: row.deltaJson as unknown as DiffOp[] };
}

async function loadEvents(tx: Tx, bookId: string, upToSeq?: number): Promise<SnapshotEventRecord[]> {
  const rows = await tx.traceSnapshotEvent.findMany({
    where: { bookId, ...(upToSeq !== undefined ? { seq: { lte: upToSeq } } : {}) },
    orderBy: { seq: 'asc' }
  });
  return rows.map(toEventRecord);
}

async function loadSnapshots(tx: Tx, bookId: string, upToSeq?: number): Promise<SnapshotRow[]> {
  return tx.traceSnapshot.findMany({
    where: { bookId, ...(upToSeq !== undefined ? { seq: { lte: upToSeq } } : {}) },
    orderBy: { seq: 'asc' }
  });
}

/** 从业务表物化当前痕迹文档（只含未删除记录）。 */
export async function materializeCurrentDocument(tx: Tx, bookId: string): Promise<TraceDocument> {
  const [dogEars, annotations, rereadMarks] = await Promise.all([
    tx.dogEar.findMany({ where: { bookId, deletedAt: null } }),
    tx.annotation.findMany({ where: { bookId, deletedAt: null } }),
    tx.rereadMark.findMany({ where: { bookId, deletedAt: null } })
  ]);
  const doc = emptyDocument();
  for (const item of dogEars) {
    doc.dogEars[item.id] = { pageNumber: item.pageNumber, reason: item.reason };
  }
  for (const item of annotations) {
    doc.annotations[item.id] = { startPage: item.startPage, endPage: item.endPage, content: item.content };
  }
  for (const item of rereadMarks) {
    doc.rereadMarks[item.id] = { pageNumber: item.pageNumber, reason: item.reason };
  }
  return doc;
}

/**
 * 在调用方事务内记录痕迹变更。head 行是每本书的发号器：
 * 事务内的行锁序列化并发写入，事务回滚不会消耗 seq，序列因此连续。
 */
export async function recordChanges(
  tx: Tx,
  input: { userId: string; bookId: string; changes: ChangePayload[] }
): Promise<void> {
  if (input.changes.length === 0) return;
  await tx.traceSnapshotHead.upsert({
    where: { bookId: input.bookId },
    create: { bookId: input.bookId, userId: input.userId },
    update: {}
  });
  for (const change of input.changes) {
    const head = await tx.traceSnapshotHead.update({
      where: { bookId: input.bookId },
      data: { headSeq: { increment: 1 }, version: { increment: 1 } }
    });
    await tx.traceSnapshotEvent.create({
      data: {
        bookId: input.bookId,
        userId: input.userId,
        seq: head.headSeq,
        kind: 'CHANGE',
        payloadJson: change as unknown as Prisma.InputJsonValue
      }
    });
  }
}

async function createSnapshot(
  tx: Tx,
  input: { userId: string; bookId: string; label: string | null; document: TraceDocument; headSeq: number; headVersion: number }
): Promise<SnapshotRow> {
  const chain = await loadSnapshots(tx, input.bookId);
  const previous = recomputeFromDeltas(chain.map((row) => row.deltaJson as unknown as DiffOp[]));
  const delta = diffValues(previous, input.document);
  const seq = (chain.at(-1)?.seq ?? 0) + 1;
  try {
    return await tx.traceSnapshot.create({
      data: {
        bookId: input.bookId,
        userId: input.userId,
        seq,
        eventSeq: input.headSeq,
        headVersion: input.headVersion,
        label: input.label,
        stateHash: hashDocument(input.document),
        deltaJson: delta as unknown as Prisma.InputJsonValue
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'STALE_WRITE', '快照序号冲突，请重试');
    }
    throw error;
  }
}

export async function getHead(userId: string, bookId: string): Promise<{ headSeq: number; version: number }> {
  const head = await prisma.traceSnapshotHead.findUnique({ where: { bookId } });
  if (!head || head.userId !== userId) return { headSeq: 0, version: 1 };
  return { headSeq: head.headSeq, version: head.version };
}

export async function listSnapshots(userId: string, bookId: string) {
  const head = await getHead(userId, bookId);
  const items = await prisma.traceSnapshot.findMany({
    where: { bookId, userId },
    orderBy: { seq: 'desc' },
    select: { seq: true, eventSeq: true, headVersion: true, label: true, stateHash: true, createdAt: true }
  });
  return { head, items };
}

export async function takeSnapshot(userId: string, bookId: string, label: string | null): Promise<SnapshotRow> {
  return prisma.$transaction(async (tx) => {
    const document = await materializeCurrentDocument(tx, bookId);
    const head = await tx.traceSnapshotHead.findUnique({ where: { bookId } });
    return createSnapshot(tx, {
      userId,
      bookId,
      label,
      document,
      headSeq: head?.headSeq ?? 0,
      headVersion: head?.version ?? 1
    });
  });
}

export async function getSnapshotWithDocument(userId: string, bookId: string, snapshotSeq: number) {
  const snapshot = await prisma.traceSnapshot.findFirst({ where: { bookId, userId, seq: snapshotSeq } });
  if (!snapshot) throw new AppError(404, 'NOT_FOUND', '快照不存在');
  const chain = await prisma.traceSnapshot.findMany({
    where: { bookId, seq: { lte: snapshot.seq } },
    orderBy: { seq: 'asc' }
  });
  // 详情始终从差异链复算，而不是另存全量文档
  const document = recomputeFromDeltas(chain.map((row) => row.deltaJson as unknown as DiffOp[]));
  return { snapshot, document };
}

function resolveTargetSeq(target: RollbackTargetInput, snapshots: SnapshotRow[], events: SnapshotEventRecord[]): number {
  if (target.snapshotSeq !== undefined) {
    const snapshot = snapshots.find((row) => row.seq === target.snapshotSeq);
    if (!snapshot) throw new AppError(404, 'NOT_FOUND', '快照不存在');
    return snapshot.eventSeq;
  }
  if (target.eventSeq !== undefined) return target.eventSeq;
  if (target.time !== undefined) return seqAtTime(events, target.time);
  throw new AppError(422, 'VALIDATION_ERROR', '缺少回滚目标', { target: '必须指定 snapshotSeq、eventSeq 或 targetTime 之一' });
}

/** 复算某个事件位置的文档（只读，不回滚）。 */
export async function stateAt(userId: string, bookId: string, target: RollbackTargetInput) {
  return prisma.$transaction(async (tx) => {
    const [events, snapshots] = await Promise.all([loadEvents(tx, bookId), loadSnapshots(tx, bookId)]);
    const targetSeq = resolveTargetSeq(target, snapshots, events);
    const head = await tx.traceSnapshotHead.findUnique({ where: { bookId } });
    const headSeq = head?.headSeq ?? 0;
    if (!Number.isInteger(targetSeq) || targetSeq < 0 || targetSeq > headSeq) {
      throw new AppError(422, 'INVALID_ROLLBACK_TARGET', '目标位置超出事件序列范围');
    }
    const document = materializeAt(targetSeq, snapshots.map(toSnapshotMeta), events);
    return { eventSeq: targetSeq, headSeq, document, stateHash: hashDocument(document) };
  });
}

/** 双路径复算校验：差异链与事件流分别复算，与存储哈希比对。 */
export async function verifySnapshot(userId: string, bookId: string, snapshotSeq: number) {
  return prisma.$transaction(async (tx) => {
    const snapshot = await tx.traceSnapshot.findFirst({ where: { bookId, userId, seq: snapshotSeq } });
    if (!snapshot) throw new AppError(404, 'NOT_FOUND', '快照不存在');
    const chain = await loadSnapshots(tx, bookId, snapshot.seq);
    const recomputed = recomputeFromDeltas(chain.map((row) => row.deltaJson as unknown as DiffOp[]));
    const recomputedHash = hashDocument(recomputed);
    const events = await loadEvents(tx, bookId, snapshot.eventSeq);
    assertContinuous(events);
    const replayedHash = hashDocument(replayEvents(events));
    return {
      ok: recomputedHash === snapshot.stateHash && replayedHash === snapshot.stateHash,
      stateHash: snapshot.stateHash,
      recomputedHash,
      replayedHash
    };
  });
}

async function applyRestorePlan(tx: Tx, plan: RestorePlanItem[]): Promise<void> {
  const now = new Date();
  for (const item of plan) {
    if (item.entity === 'dogEars') {
      const after = item.after as { pageNumber: number; reason: string | null } | undefined;
      await tx.dogEar.update({
        where: { id: item.entityId },
        data:
          item.op === 'upsert' && after
            ? { pageNumber: after.pageNumber, reason: after.reason, deletedAt: null, version: { increment: 1 } }
            : { deletedAt: now, version: { increment: 1 } }
      });
    } else if (item.entity === 'annotations') {
      const after = item.after as { startPage: number; endPage: number; content: string } | undefined;
      await tx.annotation.update({
        where: { id: item.entityId },
        data:
          item.op === 'upsert' && after
            ? { startPage: after.startPage, endPage: after.endPage, content: after.content, deletedAt: null, version: { increment: 1 } }
            : { deletedAt: now, version: { increment: 1 } }
      });
    } else {
      const after = item.after as { pageNumber: number; reason: string | null } | undefined;
      await tx.rereadMark.update({
        where: { id: item.entityId },
        data:
          item.op === 'upsert' && after
            ? { pageNumber: after.pageNumber, reason: after.reason, deletedAt: null, version: { increment: 1 } }
            : { deletedAt: now, version: { increment: 1 } }
      });
    }
  }
}

/**
 * 回滚到历史位置。
 *
 * 并发控制：第一步用 expectedVersion 做 CAS（updateMany + 行锁），
 * 并发回滚只有一个能推进；失败方收到 409 STALE_WRITE。
 * 恢复方式：回滚不删除事件，而是追加 ROLLBACK 事件并在其位置落
 * restore-point 快照，事件序列保持连续，旧快照仍可复算。
 */
export async function rollback(userId: string, bookId: string, target: RollbackTargetInput, expectedVersion: number) {
  return prisma.$transaction(async (tx) => {
    const cas = await tx.traceSnapshotHead.updateMany({
      where: { bookId, userId, version: expectedVersion },
      data: { version: { increment: 1 } }
    });
    if (cas.count !== 1) {
      throw new AppError(409, 'STALE_WRITE', '快照版本已变化，请刷新后重试');
    }
    const head = await tx.traceSnapshotHead.findUniqueOrThrow({ where: { bookId } });

    const [events, snapshots] = await Promise.all([loadEvents(tx, bookId), loadSnapshots(tx, bookId)]);
    const targetSeq = resolveTargetSeq(target, snapshots, events);
    assertRollbackTarget(targetSeq, head.headSeq);

    const restored = materializeAt(targetSeq, snapshots.map(toSnapshotMeta), events);
    const current = await materializeCurrentDocument(tx, bookId);
    const plan = planRestore(current, restored);
    await applyRestorePlan(tx, plan);

    // ROLLBACK 事件占据下一个 seq，恢复后的新变更继续递增，序列连续
    const nextHead = await tx.traceSnapshotHead.update({
      where: { bookId },
      data: { headSeq: { increment: 1 } }
    });
    const stateHash = hashDocument(restored);
    await tx.traceSnapshotEvent.create({
      data: {
        bookId,
        userId,
        seq: nextHead.headSeq,
        kind: 'ROLLBACK',
        payloadJson: { targetSeq, stateHash } satisfies Prisma.JsonObject
      }
    });

    const snapshot = await createSnapshot(tx, {
      userId,
      bookId,
      label: `回滚到事件 #${targetSeq}`,
      document: restored,
      headSeq: nextHead.headSeq,
      headVersion: nextHead.version
    });
    return {
      head: { headSeq: nextHead.headSeq, version: nextHead.version },
      snapshot,
      restoredEntities: plan.length,
      stateHash
    };
  });
}
