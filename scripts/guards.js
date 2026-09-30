// CI guards for the v2 workspaces: no emoji in source/UI, no raw hex colors outside
// packages/theme, and the apps/api image manifest list kept in step with the workspace.
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
const HEX = /#[0-9a-fA-F]{6}\b/;
// Files temporarily exempt from the raw-hex guard.
// TODO(phase-4 polish sweep): apps/web/src/index.css is the pre-monorepo "Mythic Grimoire"
// stylesheet (~1500 lines, ~38 hex literals under :root). Migrate its --background/--primary/...
// variables onto @grimore/theme --g-* tokens, then delete this exemption.
const HEX_EXEMPT = [join('apps', 'web', 'src', 'index.css')];
let bad = 0;
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'dist') continue;
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|tsx|css|html|js)$/.test(f)) continue;
    const src = readFileSync(p, 'utf8');
    if (EMOJI.test(src)) {
      console.error(`[guards] emoji in ${p}`);
      bad++;
    }
    const hexExempt = p.includes('packages/theme') || HEX_EXEMPT.some((e) => p.endsWith(e));
    if (HEX.test(src) && !hexExempt && /\.(tsx|css|html)$/.test(f)) {
      console.error(`[guards] raw hex color in ${p} (use theme tokens)`);
      bad++;
    }
  }
}
for (const r of ['apps', 'packages']) {
  try {
    walk(r);
  } catch {
    /* missing dir */
  }
}
/**
 * `apps/api/Dockerfile` has to COPY every workspace member's package.json before
 * `pnpm install --frozen-lockfile`, including the ones that image never builds — otherwise pnpm
 * judges the lockfile out of sync and the build fails.
 *
 * That is invisible until someone runs a Docker build, and nothing in CI does: a new package under
 * packages/ or apps/ would break the image with no signal until a deploy. This checks it statically
 * instead, so the failure lands on the PR that causes it.
 */
function checkApiDockerfileCopiesEveryManifest() {
  const dockerfilePath = join('apps', 'api', 'Dockerfile');
  let dockerfile;
  try {
    dockerfile = readFileSync(dockerfilePath, 'utf8');
  } catch {
    console.error(`[guards] ${dockerfilePath} is missing`);
    bad++;
    return;
  }
  for (const root of ['packages', 'apps']) {
    let members;
    try {
      members = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of members) {
      const manifest = join(root, name, 'package.json');
      try {
        if (!statSync(manifest).isFile()) continue;
      } catch {
        continue;
      }
      // Dockerfile paths are POSIX regardless of the host, so compare on that spelling.
      const copied = `COPY ${root}/${name}/package.json`;
      if (!dockerfile.includes(copied)) {
        console.error(
          `[guards] ${dockerfilePath} does not copy ${root}/${name}/package.json — ` +
            `pnpm install --frozen-lockfile will fail. Add: ${copied} ./${root}/${name}/`,
        );
        bad++;
      }
    }
  }
}
checkApiDockerfileCopiesEveryManifest();

/**
 * `INSERT OR IGNORE` and `INSERT OR REPLACE` are SQLite-only. On Postgres they are a syntax error
 * at "OR", so any occurrence in server.js that is not inside a `db.isPostgres` branch is a route
 * that cannot work in production.
 *
 * Several are fixed; the rest need a unique constraint the production schema does not have, which
 * is a schema decision rather than a mechanical rewrite. This is a ratchet, not a clean bill of
 * health: the remaining ones are counted, and the count may only go down. Lower KNOWN_SQLITE_ONLY
 * as they are fixed. It exists so no NEW one is added silently.
 */
const KNOWN_SQLITE_ONLY = 0;
function checkNoNewSqliteOnlyInserts() {
  let src;
  try {
    src = readFileSync('server.js', 'utf8');
  } catch {
    return; // not in a checkout that has the legacy server
  }
  const lines = src.split('\n');
  const unguarded = [];
  lines.forEach((line, i) => {
    if (!/INSERT OR (IGNORE|REPLACE)/.test(line)) return;
    if (line.trim().startsWith('//')) return;
    // A dialect-safe site is a ternary, so its SQLite branch is the line beginning `:` and its
    // Postgres branch the one beginning `?`. Matching on that rather than on a nearby mention of
    // `db.isPostgres` matters: a proximity window silently treats any literal that happens to sit a
    // few lines under an unrelated `db.isPostgres` as guarded, which is a false negative in a check
    // whose entire job is to notice new ones.
    const head = line.trim()[0];
    if (head === ':' || head === '?') return;
    unguarded.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  if (unguarded.length > KNOWN_SQLITE_ONLY) {
    console.error(
      `[guards] ${unguarded.length} unguarded SQLite-only INSERTs in server.js, expected at most ` +
        `${KNOWN_SQLITE_ONLY}. These are a syntax error on Postgres. New ones:`,
    );
    for (const u of unguarded) console.error(`[guards]   server.js:${u}`);
    bad++;
  }
}
checkNoNewSqliteOnlyInserts();

if (bad) {
  console.error(`[guards] ${bad} violation(s)`);
  process.exit(1);
}
console.log('[guards] OK');
