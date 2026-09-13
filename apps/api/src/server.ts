import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext } from './app.js';

const env = parseEnv();
const ctx = await createContext(env);
await runMigrations(ctx.pool, (m) => ctx.log.info(m));
const app = createApp(ctx);

const server = app.listen(env.PORT, () => ctx.log.info({ port: env.PORT }, 'api listening'));

async function shutdown(signal: string) {
  ctx.log.info({ signal }, 'shutting down');
  server.close(async () => {
    await closeContext(ctx);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
