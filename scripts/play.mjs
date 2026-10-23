/**
 * Starts everything needed for a game of Magic, and prints the address to share.
 *
 *   node scripts/play.mjs
 *
 * Two processes: the table server (`apps/realtime`) and the web app (Vite). Redis has to be running
 * already — it is the only other dependency, and deliberately so: the table needs no Postgres, no
 * `apps/api` and no Grimore account, so there is very little that can be misconfigured on a games
 * night. See claude/play-realm-setup.md.
 *
 * Both processes are children of this one, so Ctrl-C stops the pair.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';

const REALTIME_PORT = Number(process.env.REALTIME_PORT ?? 4100);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5100);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/**
 * The address another device on the same network can reach this machine at.
 *
 * `PLAY_HOST` overrides it, which matters on a machine with several interfaces (a VPN, a docker
 * bridge, a container) where the first non-internal address is not the one your phone can reach.
 * Set `PLAY_HOST=127.0.0.1` to keep everything on this machine.
 */
function lanAddress() {
  if (process.env.PLAY_HOST) return process.env.PLAY_HOST;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1500);
  });
}

const redis = new URL(REDIS_URL);
if (!(await checkPort(redis.hostname || '127.0.0.1', Number(redis.port || 6379)))) {
  console.error(`\nRedis is not answering on ${REDIS_URL}.`);
  console.error('Start it first:  redis-server --daemonize yes --save \'\' --appendonly no\n');
  process.exit(1);
}

// A port already in use is the most common way this fails twice in a row — usually a server left
// over from the last run. Said plainly here rather than as a stack trace from inside Vite.
for (const [label, port] of [['the table server', REALTIME_PORT], ['the web app', WEB_PORT]]) {
  if (await checkPort('127.0.0.1', port)) {
    console.error(`\nPort ${port} (${label}) is already in use — something is still running from last time.`);
    console.error(`Find it with:  lsof -i :${port}       (or: fuser ${port}/tcp)`);
    console.error(`Or pick another port:  REALTIME_PORT=4101 WEB_PORT=5101 node scripts/play.mjs\n`);
    process.exit(1);
  }
}

if (!existsSync('apps/realtime/dist/server.js')) {
  console.error('\napps/realtime is not built. Run:');
  console.error("  pnpm install && pnpm -r --filter './packages/*' run build && pnpm --filter @grimore/realtime run build\n");
  process.exit(1);
}

const host = lanAddress();
const children = [];

function start(name, command, args, { env = {}, cwd } = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}] `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) console.log(prefix + line);
    });
  }
  child.on('exit', (code) => {
    console.log(`${prefix}exited (${code})`);
    stopAll();
  });
  children.push(child);
  return child;
}

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

start('table', process.execPath, ['apps/realtime/dist/server.js'], {
  env: {
    PORT: String(REALTIME_PORT),
    REDIS_URL,
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    // Left unset so any origin may connect, which is what makes "open it on my phone" work on a
    // home network. Set it in production, where the origins are known.
    SOCKET_ALLOWED_ORIGINS: process.env.SOCKET_ALLOWED_ORIGINS ?? '',
  },
});

start('web', './node_modules/.bin/vite', ['--host', '0.0.0.0', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: 'apps/web',
  env: {
    // The browser talks to the table server directly rather than through Vite's dev proxy, whose
    // WebSocket forwarding did not carry the upgrade reliably. In production one reverse proxy
    // serves both on one origin and this variable is not set at all.
    VITE_REALTIME_URL: `http://${host}:${REALTIME_PORT}`,
  },
});

setTimeout(() => {
  console.log('\n──────────────────────────────────────────────');
  console.log('  Play Realm is up. Open this on both devices:');
  console.log(`    http://${host}:${WEB_PORT}/react/play`);
  console.log('  One of you creates a table and shares the code.');
  console.log('  Ctrl-C stops both servers.');
  console.log('──────────────────────────────────────────────\n');
}, 2500);
