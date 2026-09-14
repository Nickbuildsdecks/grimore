import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient, type RedisClientType } from 'redis';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import type { Env } from '@grimore/shared';
import { createPool, ping, type Pool } from '@grimore/db';
import { authRouter } from './routes/auth.js';
import { cardsRouter } from './routes/cards.js';
import { collectionsRouter } from './routes/collections.js';
import { decksRouter } from './routes/decks.js';
import { playersRouter } from './routes/players.js';
import { ApiError, errorHandler } from './lib/errors.js';

export interface AppContext {
  env: Env;
  pool: Pool;
  redis: RedisClientType;
  log: pino.Logger;
}

declare module 'express-session' {
  interface SessionData {
    playerId?: string;
    isGuest?: boolean;
  }
}

export async function createContext(env: Env): Promise<AppContext> {
  const log = pino({ level: env.LOG_LEVEL });
  const pool = createPool({ connectionString: env.DATABASE_URL });
  const redis: RedisClientType = createClient({ url: env.REDIS_URL });
  redis.on('error', (err) => log.error({ err }, 'redis error'));
  await redis.connect();
  return { env, pool, redis, log };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await Promise.allSettled([ctx.pool.end(), ctx.redis.quit()]);
}

export function createApp(ctx: AppContext): Express {
  const { env, pool, redis, log } = ctx;
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false })); // CSP is set at the CDN/web layer for the SPA
  app.use(
    pinoHttp({
      logger: log,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    }),
  );

  // Liveness / readiness — readiness checks real dependencies so Fly only routes to healthy machines.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()) }));
  app.get('/readyz', async (_req, res) => {
    const checks: Record<string, 'ok' | 'fail'> = { db: 'fail', redis: 'fail' };
    try {
      if (await ping(pool)) checks.db = 'ok';
    } catch {
      /* fail */
    }
    try {
      if ((await redis.ping()) === 'PONG') checks.redis = 'ok';
    } catch {
      /* fail */
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    res.status(ready ? 200 : 503).json({ ready, checks });
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(
    session({
      store: new RedisStore({ client: redis, prefix: 'sess:' }),
      name: 'grimore.sid',
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
      },
    }),
  );

  app.use('/api/auth', authRouter(ctx));
  app.use('/api/decks', decksRouter(ctx));
  app.use('/api/cards', cardsRouter(ctx));
  app.use('/api/collections', collectionsRouter(ctx));
  app.use('/api/players', playersRouter(ctx));

  app.use((_req: Request, _res: Response, next: NextFunction) => next(new ApiError(404, 'NOT_FOUND', 'Route not found')));
  app.use(errorHandler(log));
  return app;
}
