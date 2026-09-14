/**
 * Builds the realtime gateway: an http server (with /healthz), a
 * WebSocket-only socket.io server backed by the Redis streams adapter so rooms
 * span every node, and a Redis-backed PodStore.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { createClient, type RedisClientType } from 'redis';
import type { Logger } from 'pino';
import { registerHandlers, type RealtimeServer } from './handlers.js';
import { PodStore, type PodStoreOptions } from './pod.js';
import type { RateLimitOptions } from './ratelimit.js';

export interface RealtimeOptions {
  redisUrl: string;
  allowedOrigins: string[];
  log: Logger;
  store?: PodStoreOptions;
  rateLimit?: RateLimitOptions;
  /** Disable the cross-node adapter (single-process tests). Defaults to enabled. */
  adapter?: boolean;
}

export interface Realtime {
  io: RealtimeServer;
  httpServer: HttpServer;
  store: PodStore;
  redis: RedisClientType;
  close: () => Promise<void>;
}

export const MAX_HTTP_BUFFER_SIZE = 16 * 1024;
export const RECOVERY_WINDOW_MS = 60_000;

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  // Non-browser clients (native apps, tests) send no Origin header.
  if (!origin) return true;
  return allowed.includes(origin) || allowed.includes('*');
}

export async function createRealtime(opts: RealtimeOptions): Promise<Realtime> {
  const { log, allowedOrigins } = opts;

  const redis: RedisClientType = createClient({ url: opts.redisUrl });
  redis.on('error', (err) => log.error({ err }, 'redis error'));
  await redis.connect();

  // The streams adapter issues blocking XREAD calls, so it gets its own connection.
  let adapterRedis: RedisClientType | null = null;
  if (opts.adapter !== false) {
    adapterRedis = redis.duplicate();
    adapterRedis.on('error', (err) => log.error({ err }, 'redis (adapter) error'));
    await adapterRedis.connect();
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz') {
      void redis
        .ping()
        .then((pong) => {
          const ok = pong === 'PONG';
          res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', checks: { redis: ok ? 'ok' : 'fail' } }));
        })
        .catch(() => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'degraded', checks: { redis: 'fail' } }));
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
  });

  const io: RealtimeServer = new Server(httpServer, {
    transports: ['websocket'],
    allowUpgrades: false,
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    connectionStateRecovery: { maxDisconnectionDuration: RECOVERY_WINDOW_MS, skipMiddlewares: true },
    cors: { origin: allowedOrigins.length > 0 ? allowedOrigins : false },
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      const ok = originAllowed(origin, allowedOrigins);
      if (!ok) log.warn({ origin }, 'rejected socket handshake: origin not allowed');
      cb(ok ? null : 'origin not allowed', ok);
    },
    ...(adapterRedis ? { adapter: createAdapter(adapterRedis) } : {}),
  });

  const store = new PodStore(redis, opts.store);
  const dispose = registerHandlers(io, store, log, { ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}) });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    dispose();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
    });
    await Promise.allSettled([redis.quit(), adapterRedis?.quit()]);
  };

  return { io, httpServer, store, redis, close };
}
