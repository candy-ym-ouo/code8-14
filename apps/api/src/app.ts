import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { AppError, mapPrismaError, sendError, zodFields } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { bookRoutes } from './modules/books/routes.js';
import { traceRoutes } from './modules/traces/routes.js';
import { reflectionRoutes } from './modules/reflections/routes.js';
import { timelineRoutes } from './modules/timeline/routes.js';
import { exportRoutes } from './modules/exports/routes.js';
import { snapshotRoutes } from './modules/snapshots/routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]']
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      error: {
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后重试'
      }
    })
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && origin !== env.WEB_ORIGIN) {
      throw new AppError(403, 'ORIGIN_REJECTED', '请求来源不受信任');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.statusCode, error.code, error.message, error.fields, request.id);
    }
    if (error instanceof ZodError) {
      return sendError(reply, 422, 'VALIDATION_ERROR', '请求参数无效', zodFields(error), request.id);
    }
    if (mapPrismaError(error, reply)) return;
    request.log.error(error);
    return sendError(reply, 500, 'INTERNAL_ERROR', '服务器暂时无法处理请求', undefined, request.id);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(bookRoutes, { prefix: '/api/v1' });
  await app.register(traceRoutes, { prefix: '/api/v1' });
  await app.register(reflectionRoutes, { prefix: '/api/v1' });
  await app.register(timelineRoutes, { prefix: '/api/v1' });
  await app.register(exportRoutes, { prefix: '/api/v1' });
  await app.register(snapshotRoutes, { prefix: '/api/v1' });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, 'NOT_FOUND', '接口不存在', undefined, request.id)
  );

  return app;
}
