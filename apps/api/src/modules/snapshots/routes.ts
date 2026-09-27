import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { optionalDate, parseId } from '../../lib/http.js';
import { getHead, getSnapshotWithDocument, listSnapshots, rollback, stateAt, takeSnapshot, verifySnapshot } from './service.js';

const snapshotCreateSchema = z.object({
  label: z.string().trim().min(1).max(200).optional()
});

const rollbackSchema = z
  .object({
    snapshotSeq: z.number().int().positive().optional(),
    eventSeq: z.number().int().nonnegative().optional(),
    targetTime: z.string().min(1).optional(),
    expectedVersion: z.number().int().positive()
  })
  .refine(
    (value) => [value.snapshotSeq, value.eventSeq, value.targetTime].filter((item) => item !== undefined).length === 1,
    { message: '必须且只能指定一个回滚目标', path: ['target'] }
  );

function parseSeq(value: string, field = 'snapshotSeq'): number {
  const seq = Number(value);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new AppError(404, 'NOT_FOUND', '快照不存在', { [field]: '快照不存在' });
  }
  return seq;
}

async function requireBook(bookId: string, userId: string): Promise<void> {
  const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
  if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
}

function resolveTarget(query: Record<string, unknown>) {
  const defined = ['snapshotSeq', 'eventSeq', 'time'].filter((key) => query[key] !== undefined && query[key] !== '');
  if (defined.length !== 1) {
    throw new AppError(422, 'VALIDATION_ERROR', '必须且只能指定一个目标位置', { target: '必须且只能指定一个目标位置' });
  }
  if (query.snapshotSeq !== undefined && query.snapshotSeq !== '') {
    return { snapshotSeq: parseSeq(String(query.snapshotSeq)) };
  }
  if (query.eventSeq !== undefined && query.eventSeq !== '') {
    const seq = Number(query.eventSeq);
    if (!Number.isInteger(seq) || seq < 0) {
      throw new AppError(422, 'VALIDATION_ERROR', '事件位置无效', { eventSeq: '事件位置无效' });
    }
    return { eventSeq: seq };
  }
  return { time: optionalDate(query.time, 'time') as Date };
}

export const snapshotRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/trace-snapshots', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    await requireBook(bookId, userId);
    return listSnapshots(userId, bookId);
  });

  app.post('/books/:bookId/trace-snapshots', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = snapshotCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '快照参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    await requireBook(bookId, userId);
    const snapshot = await takeSnapshot(userId, bookId, parsed.data.label ?? null);
    return reply.status(201).send({ snapshot });
  });

  app.get('/books/:bookId/trace-snapshots/head', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    await requireBook(bookId, userId);
    return getHead(userId, bookId);
  });

  app.get('/books/:bookId/trace-snapshots/state', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    await requireBook(bookId, userId);
    const target = resolveTarget(request.query as Record<string, unknown>);
    return stateAt(userId, bookId, target);
  });

  app.post('/books/:bookId/trace-snapshots/rollback', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = rollbackSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '回滚参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    await requireBook(bookId, userId);
    const { snapshotSeq, eventSeq, targetTime, expectedVersion } = parsed.data;
    const target = {
      ...(snapshotSeq !== undefined ? { snapshotSeq } : {}),
      ...(eventSeq !== undefined ? { eventSeq } : {}),
      ...(targetTime !== undefined ? { time: optionalDate(targetTime, 'targetTime') as Date } : {})
    };
    return rollback(userId, bookId, target, expectedVersion);
  });

  app.get('/books/:bookId/trace-snapshots/:snapshotSeq', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const snapshotSeq = parseSeq((request.params as { snapshotSeq: string }).snapshotSeq);
    const userId = currentUser(request).id;
    await requireBook(bookId, userId);
    const { snapshot, document } = await getSnapshotWithDocument(userId, bookId, snapshotSeq);
    return { snapshot, document };
  });

  app.get('/books/:bookId/trace-snapshots/:snapshotSeq/verify', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const snapshotSeq = parseSeq((request.params as { snapshotSeq: string }).snapshotSeq);
    const userId = currentUser(request).id;
    await requireBook(bookId, userId);
    return verifySnapshot(userId, bookId, snapshotSeq);
  });
};
