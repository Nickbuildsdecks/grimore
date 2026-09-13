import pino from 'pino';
import { parseEnv } from '@grimore/shared';
import { createRealtime } from './io.js';

const env = parseEnv();
const log = pino({ level: env.LOG_LEVEL, name: 'realtime' });

const rt = await createRealtime({
  redisUrl: env.REDIS_URL,
  allowedOrigins: env.SOCKET_ALLOWED_ORIGINS,
  log,
});

rt.httpServer.listen(env.PORT, () => log.info({ port: env.PORT }, 'realtime listening'));

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await rt.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
