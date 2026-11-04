#!/usr/bin/env node
/**
 * Are the services the v2 suites test against actually reachable?
 *
 *     node scripts/services-up.js
 *     pnpm v2:services
 *
 * ## Why this exists: a green gate with both services down
 *
 * The local pre-push gate is `node scripts/guards.js`, `pnpm v2:typecheck`,
 * `pnpm v2:typecheck:tests`, `pnpm v2:test`. On 2026-11-04 it printed
 *
 *     @grimore/rules-engine:test:  Tests  1425 passed (1425)
 *     @grimore/api:test:           Tests   306 passed (306)
 *     @grimore/realtime:test:      Tests    46 passed (46)
 *     Cached: 17 cached, 17 total
 *       Time: 462ms >>> FULL TURBO
 *
 * with **Redis and Postgres both stopped**. Every line was a turbo cache replay. The two numbers
 * that give it away are the 462ms and the word `cached`, and neither of them is what a person
 * reads when they are looking for the words "passed" and a zero failure count.
 *
 * Turbo is not wrong to do this. Its cache key is the task's declared inputs — source files,
 * dependencies, env vars — and a running Redis is none of those. Nothing in the repository had
 * changed, so the cached result was the correct answer to the question turbo was asked. The
 * problem is the question the *person* was asking, which was "do the tests pass against live
 * services", and a cache replay cannot answer it either way.
 *
 * It is the same shape as the rest of this repository's recurring finding: **a check that cannot
 * fail reads as good news.** The variants already recorded are a check that cannot fail (#311's
 * guest-auth step), a check that cannot pass (D355's two anonymous advisor calls), a swallowed
 * throw (D244, 35 harnesses), a documented flag that does not exist (D352), and a skipped suite
 * that reads green (D303's 35 realtime tests without `REDIS_URL`). A cached pass is the sixth: it
 * is a check that did not run, wearing the output of one that did.
 *
 * So this script asks the one thing the cache cannot know. It opens a TCP connection to each
 * service and speaks just enough of each protocol to be sure something is listening rather than
 * an unrelated process holding the port.
 *
 * ## What it does not do
 *
 * It does not start anything and it does not clear the cache. It answers a question, and it is
 * meant to run **before** `pnpm v2:test` rather than instead of it: the test command can still
 * replay a cached green afterwards, and that is fine once the services are known to be up, because
 * the cached result was produced by a run that did reach them.
 *
 * It is also not needed in CI, which brings both services up as containers with health checks and
 * runs the suites through `pnpm -r` rather than turbo, so there is no cache to restore. This is a
 * local-gate instrument.
 */
const net = require('node:net');

/** The two services, and the URL each suite reads them from. */
const SERVICES = [
  {
    name: 'Redis',
    env: 'REDIS_URL',
    fallback: 'redis://127.0.0.1:6379',
    defaultPort: 6379,
    // RESP: a bare inline PING is answered `+PONG`, which no other service on that port would say.
    probe: 'PING\r\n',
    expect: (text) => text.startsWith('+PONG'),
    expectDescription: '+PONG',
    needs: 'the 46 realtime tests, which read and write pod state through it',
  },
  {
    name: 'Postgres',
    env: 'DATABASE_URL',
    fallback: 'postgresql://postgres:postgres@127.0.0.1:5432/grimore_dev',
    defaultPort: 5432,
    /*
      An SSLRequest: eight bytes, length then the magic 80877103. The server answers a single byte,
      `S` or `N`. Cheaper and more certain than a startup handshake, and it needs no credentials —
      the question here is "is Postgres listening", not "can these credentials log in", and a
      wrong password is a different failure with a different message.
    */
    probe: Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]),
    expect: (text) => text === 'S' || text === 'N',
    expectDescription: 'S or N to an SSLRequest',
    needs: 'the api and db suites, which run against a real schema rather than a mock',
  },
];

/** `{ host, port }` from a URL, falling back to the service's default port. */
function endpoint(url, defaultPort) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname === '' ? '127.0.0.1' : parsed.hostname,
      port: parsed.port === '' ? defaultPort : Number(parsed.port),
    };
  } catch {
    return null;
  }
}

/** Connects, sends the probe, and resolves with what came back — or why it could not. */
function ask({ host, port }, probe, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(probe));
    socket.on('data', (buf) => done({ ok: true, text: buf.toString('latin1') }));
    socket.on('timeout', () => done({ ok: false, why: `no answer within ${timeoutMs}ms` }));
    socket.on('error', (err) => done({ ok: false, why: err.message }));
    // A clean close with nothing said is its own answer: something accepted the connection and
    // then had nothing to say, which is not the service we are looking for.
    socket.on('close', () => done({ ok: false, why: 'connection closed without a reply' }));
  });
}

async function main() {
  console.log('\nServices the v2 suites test against:');
  const failures = [];

  for (const service of SERVICES) {
    const url = process.env[service.env] ?? service.fallback;
    const fromEnv = process.env[service.env] !== undefined;
    const target = endpoint(url, service.defaultPort);
    if (target === null) {
      failures.push({ service, why: `${service.env} is not a URL this script can read: ${url}` });
      console.log(`  ${service.name.padEnd(9)} UNREADABLE  ${service.env}=${url}`);
      continue;
    }
    const where = `${target.host}:${target.port}${fromEnv ? '' : ` (default; ${service.env} is unset)`}`;
    const answer = await ask(target, service.probe);
    if (answer.ok && service.expect(answer.text)) {
      console.log(`  ${service.name.padEnd(9)} up          ${where}`);
      continue;
    }
    const why = answer.ok
      ? `answered ${JSON.stringify(answer.text.slice(0, 40))}, not ${service.expectDescription}`
      : answer.why;
    console.log(`  ${service.name.padEnd(9)} DOWN        ${where} — ${why}`);
    failures.push({ service, why });
  }

  if (failures.length === 0) {
    console.log('\nBoth up, so a run of `pnpm v2:test` reaches them — including a cached one.');
    process.exit(0);
  }

  console.log(`\n${failures.length} of ${SERVICES.length} not reachable. What that costs:`);
  for (const { service } of failures) console.log(`  ${service.name}: ${service.needs}`);
  console.log('\nThe trap this script exists for: `pnpm v2:test` will still print a full page of');
  console.log('passing tests, from turbo\'s cache, because a running service is not one of its');
  console.log('cache inputs. Start the services, then run the gate.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
