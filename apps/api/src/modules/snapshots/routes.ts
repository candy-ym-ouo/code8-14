import type { FastifyPluginAsync } from 'fastify';
import { Prisma, type TraceEntityType } from '@prisma/client';
import { z } from 'zod';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { writeEvent } from '../../lib/events.js';
import { paginationFromQuery, parseId } from '../../lib/http.js';
import {
  annotationState,
  appendSnapshot,
  dogEarState,
  replayChain,
  rereadMarkState,
  snapshotAtTime,
  statesEqual,
  type DogEarSnapshotState,
  type TraceSnapshotState
} from '../../lib/snapshots.js';

type Tx = Prisma.TransactionClient;

interface TraceRowBase {
  id: string;
  userId: string;
  bookId: string;
  version: number;
  deletedAt: Date | null;
}

/**
 * 三类痕迹共用同一套快照与回滚逻辑，差异只在表名、状态字段和序列化。
 * state 在任何路径下都通过 toState/applyState 成对转换，保证差异可复算。
 */
interface TraceDelegate {
  entityType: TraceEntityType;
  lockRow: (tx: Tx, id: string, userId: string) => Promise<unknown>;
  findRow: (tx: Tx, id: string) => Promise<TraceRowBase | null>;
  toState: (row: any) => TraceSnapshotState;
  applyState: (tx: Tx, id: string, expectedVersion: number, state: any) => Promise<{ count: number }>;
  reload: (tx: Tx, id: string) => Promise<TraceRowBase>;
  validateTarget?: (tx: Tx, row: TraceRowBase, state: TraceSnapshotState) => Promise<void>;
  eventPages: (state: any) => Record<string, number>;
  serialize: (row: TraceRowBase) => Record<string, unknown>;
}

function deletedAtParam(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

const dogEarDelegate: TraceDelegate = {
  entityType: 'DOG_EAR',
  lockRow: (tx, id, userId) =>
    tx.$queryRaw`SELECT id FROM dog_ears WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`,
  findRow: (tx, id) => tx.dogEar.findFirst({ where: { id } }),
  toState: (row) => dogEarState(row),
  applyState: (tx, id, expectedVersion, state: DogEarSnapshotState) =>
    tx.dogEar.updateMany({
      where: { id, version: expectedVersion },
      data: {
        pageNumber: state.pageNumber,
        reason: state.reason,
        deletedAt: deletedAtParam(state.deletedAt),
        version: { increment: 1 }
      }
    }),
  reload: (tx, id) => tx.dogEar.findUniqueOrThrow({ where: { id } }),
  validateTarget: async (tx, row, state) => {
    const target = state as DogEarSnapshotState;
    if (target.deletedAt) return;
    const conflict = await tx.dogEar.findFirst({
      where: { bookId: row.bookId, pageNumber: target.pageNumber, deletedAt: null, id: { not: row.id } }
    });
    if (conflict) throw new AppError(409, 'DOG_EAR_EXISTS', '目标页已有有效折角，无法回滚到该状态');
  },
  eventPages: (state: DogEarSnapshotState) => ({ pageNumber: state.pageNumber }),
  serialize: (row) => ({ ...row, type: 'DOG_EAR' })
};

const annotationDelegate: TraceDelegate = {
  entityType: 'ANNOTATION',
  lockRow: (tx, id, userId) =>
    tx.$queryRaw`SELECT id FROM annotations WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`,
  findRow: (tx, id) => tx.annotation.findFirst({ where: { id } }),
  toState: (row) => annotationState(row),
  applyState: (tx, id, expectedVersion, state) =>
    tx.annotation.updateMany({
      where: { id, version: expectedVersion },
      data: {
        startPage: state.startPage,
        endPage: state.endPage,
        content: state.content,
        deletedAt: deletedAtParam(state.deletedAt),
        version: { increment: 1 }
      }
    }),
  reload: (tx, id) => tx.annotation.findUniqueOrThrow({ where: { id } }),
  eventPages: (state) => ({ startPage: state.startPage, endPage: state.endPage }),
  serialize: (row) => ({ ...row, type: 'ANNOTATION' })
};

const rereadMarkDelegate: TraceDelegate = {
  entityType: 'REREAD_MARK',
  lockRow: (tx, id, userId) =>
    tx.$queryRaw`SELECT id FROM reread_marks WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`,
  findRow: (tx, id) => tx.rereadMark.findFirst({ where: { id } }),
  toState: (row) => rereadMarkState(row),
  applyState: (tx, id, expectedVersion, state) =>
    tx.rereadMark.updateMany({
      where: { id, version: expectedVersion },
      data: {
        pageNumber: state.pageNumber,
        reason: state.reason,
        deletedAt: deletedAtParam(state.deletedAt),
        version: { increment: 1 }
      }
    }),
  reload: (tx, id) => tx.rereadMark.findUniqueOrThrow({ where: { id } }),
  eventPages: (state) => ({ pageNumber: state.pageNumber }),
  serialize: (row) => ({ ...row, type: 'REREAD_MARK' })
};

function delegateFor(entityType: TraceType): TraceDelegate {
  switch (entityType) {
    case 'DOG_EAR':
      return dogEarDelegate;
    case 'ANNOTATION':
      return annotationDelegate;
    case 'REREAD_MARK':
      return rereadMarkDelegate;
  }
}

function parseEntityType(raw: string): TraceType {
  const value = raw.toUpperCase();
  if (!TRACE_TYPES.includes(value as TraceType)) {
    throw new AppError(404, 'NOT_FOUND', '痕迹类型无效');
  }
  return value as TraceType;
}

async function assertOwnedTrace(entityType: TraceType, entityId: string, userId: string): Promise<TraceRowBase> {
  const row = await delegateFor(entityType).findRow(prisma, entityId);
  if (!row || row.userId !== userId) throw new AppError(404, 'NOT_FOUND', '痕迹不存在');
  return row;
}

/**
 * 回滚不改写历史：先复算目标时间点的状态，再以一个新版本追加到链尾，
 * 同时写入 ROLLED_BACK 事件，事件序列与快照链都只增不减。
 */
async function rollbackTrace(
  tx: Tx,
  delegate: TraceDelegate,
  input: { userId: string; entityId: string; targetTime: Date; expectedVersion: number }
): Promise<{ row: TraceRowBase; idempotent: boolean }> {
  await delegate.lockRow(tx, input.entityId, input.userId);
  const row = await delegate.findRow(tx, input.entityId);
  if (!row || row.userId !== input.userId) throw new AppError(404, 'NOT_FOUND', '痕迹不存在');
  if (row.version !== input.expectedVersion) {
    throw new AppError(409, 'STALE_WRITE', '记录已在其他位置被修改，请刷新后重试');
  }
  const book = await tx.book.findFirst({ where: { id: row.bookId }, select: { deletedAt: true } });
  if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
  if (book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除，无法回滚痕迹');

  const chain = await tx.traceSnapshot.findMany({
    where: { entityType: delegate.entityType, entityId: row.id },
    orderBy: { version: 'asc' }
  });
  if (chain.length === 0) {
    throw new AppError(409, 'SNAPSHOT_MISSING', '该痕迹还没有版本快照，无法回滚');
  }
  const tip = replayChain(chain);
  const currentState = delegate.toState(row);
  if (!statesEqual(currentState, tip.state)) {
    throw new AppError(500, 'SNAPSHOT_CORRUPT', '版本快照与当前状态不一致');
  }
  const target = snapshotAtTime(chain, input.targetTime);
  if (!target) {
    throw new AppError(422, 'ROLLBACK_TARGET_NOT_FOUND', '该时间点之前没有可回滚的版本');
  }
  const targetState = replayChain(chain, target.version).state;
  if (statesEqual(currentState, targetState)) {
    return { row, idempotent: true };
  }

  await delegate.validateTarget?.(tx, row, targetState);
  const result = await delegate.applyState(tx, row.id, row.version, targetState);
  if (result.count !== 1) {
    throw new AppError(409, 'STALE_WRITE', '记录已在其他位置被修改，请刷新后重试');
  }
  const nextVersion = row.version + 1;
  await appendSnapshot(tx, {
    userId: input.userId,
    bookId: row.bookId,
    entityType: delegate.entityType,
    entityId: row.id,
    version: nextVersion,
    prevState: currentState,
    nextState: targetState
  });
  await writeEvent(tx, {
    userId: input.userId,
    bookId: row.bookId,
    entityType: delegate.entityType,
    entityId: row.id,
    action: 'ROLLED_BACK',
    payload: {
      ...delegate.eventPages(targetState),
      targetTime: input.targetTime.toISOString(),
      restoredVersion: target.version,
      fromVersion: row.version,
      toVersion: nextVersion
    }
  });
  return { row: await delegate.reload(tx, row.id), idempotent: false };
}

const rollbackSchema = z.object({
  targetTime: z.string().datetime({ offset: true }),
  version: z.number().int().positive()
});

export const snapshotRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/traces/:entityType/:entityId/snapshots', async (request) => {
    const params = request.params as { entityType: string; entityId: string };
    const entityType = parseEntityType(params.entityType);
    const entityId = parseId(params.entityId, 'entityId');
    const userId = currentUser(request).id;
    await assertOwnedTrace(entityType, entityId, userId);
    const { page, pageSize, skip } = paginationFromQuery(request);
    const where = { entityType, entityId };
    const [total, items] = await Promise.all([
      prisma.traceSnapshot.count({ where }),
      prisma.traceSnapshot.findMany({ where, orderBy: { version: 'desc' }, skip, take: pageSize })
    ]);
    return {
      items: items.map((item) => ({
        version: item.version,
        diff: item.diffJson,
        stateHash: item.stateHash,
        createdAt: item.createdAt
      })),
      pagination: { page, pageSize, total }
    };
  });

  app.get('/traces/:entityType/:entityId/snapshots/:version/state', async (request) => {
    const params = request.params as { entityType: string; entityId: string; version: string };
    const entityType = parseEntityType(params.entityType);
    const entityId = parseId(params.entityId, 'entityId');
    const version = Number(params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new AppError(404, 'NOT_FOUND', '快照不存在');
    }
    const userId = currentUser(request).id;
    await assertOwnedTrace(entityType, entityId, userId);
    const chain = await prisma.traceSnapshot.findMany({
      where: { entityType, entityId },
      orderBy: { version: 'asc' }
    });
    const { state, stateHash } = replayChain(chain, version);
    return { entityType, entityId, version, state, stateHash, verified: true };
  });

  app.post('/traces/:entityType/:entityId/rollback', async (request) => {
    const params = request.params as { entityType: string; entityId: string };
    const entityType = parseEntityType(params.entityType);
    const entityId = parseId(params.entityId, 'entityId');
    const parsed = rollbackSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '回滚参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const delegate = delegateFor(entityType);
    const result = await prisma.$transaction((tx) =>
      rollbackTrace(tx, delegate, {
        userId,
        entityId,
        targetTime: new Date(parsed.data.targetTime),
        expectedVersion: parsed.data.version
      })
    );
    return { trace: delegate.serialize(result.row), idempotent: result.idempotent };
  });
};
