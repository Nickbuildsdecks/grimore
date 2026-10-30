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
 * Every app image has to COPY every workspace member's package.json before
 * `pnpm install --frozen-lockfile`, including the ones that image never builds — otherwise pnpm
 * judges the lockfile out of sync and the build fails.
 *
 * That is invisible until someone runs a Docker build, and nothing in CI does: a new package under
 * packages/ or apps/ would break the image with no signal until a deploy. This checks it statically
 * instead, so the failure lands on the PR that causes it.
 *
 * Checks every `apps/*\/Dockerfile` rather than only the API's: the trap is a property of building
 * a pnpm workspace member in Docker, not of one image, and the realtime image hits it identically.
 */
function checkAppDockerfilesCopyEveryManifest() {
  let apps;
  try {
    apps = readdirSync('apps');
  } catch {
    return;
  }
  const dockerfiles = apps
    .map((name) => join('apps', name, 'Dockerfile'))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (dockerfiles.length === 0) {
    console.error('[guards] no app Dockerfile found under apps/*/Dockerfile');
    bad++;
    return;
  }
  for (const dockerfilePath of dockerfiles) checkOneDockerfile(dockerfilePath);
}

function checkOneDockerfile(dockerfilePath) {
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
checkAppDockerfilesCopyEveryManifest();

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

/**
 * `server.js` may initialise the database exactly once.
 *
 * It used to do it twice: `db.initDb()` at the top of the boot chain and a second, un-awaited call
 * near the end of the file, both starting at module load against a pool of 35 connections. Postgres
 * DDL is **not** race-safe between sessions, so every cold boot raced its own schema creation —
 * reproduced at **20 of 20** runs, refusing statements with `duplicate key value violates unique
 * constraint "pg_type_typname_nsp_index"` and `relation "players" already exists`, every one of them
 * swallowed into a `Postgres DDL statement notice` line (D187).
 *
 * A source-text guard rather than a test, and deliberately: the legacy Postgres suite builds its
 * database from the v2 baseline and every migration **before** the server boots, so by the time
 * `initDb()` runs every table already exists, no creation is attempted, and nothing races. That
 * suite could not have caught this and re-introducing the second call does not fail it — which is
 * exactly the situation a guard is for.
 */
function checkSingleInitDb() {
  let src;
  try {
    src = readFileSync('server.js', 'utf8');
  } catch {
    return; // not in a checkout that has the legacy server
  }
  // Comments stripped first, because the note left at the old call site names the call it removed
  // — and a guard that counts its own explanation is a guard that fails on the fix.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const calls = code.split('\n').filter((line) => /db\.initDb\s*\(/.test(line));
  if (calls.length !== 1) {
    console.error(
      `[guards] server.js calls db.initDb() ${calls.length} time(s), expected exactly 1. ` +
        'Two concurrent initialisations race the schema on Postgres (D187); await the first instead.',
    );
    for (const line of calls) console.error(`[guards]   ${line.trim().slice(0, 100)}`);
    bad++;
  }
}
checkSingleInitDb();

/**
 * Every mechanic a player can read on a card has to be explained in the player documentation.
 *
 * `claude/play-realm-setup.md` carries the cheat sheet two people actually sit down with, and it
 * had fallen two keywords behind without anything saying so: **regenerate** (five cards across
 * three decks, with a cost most players get wrong) and **prowess** (two cards) were in the pool,
 * player-facing, and mentioned nowhere in it. Found by auditing by hand, which is exactly the kind
 * of check that is done once and then rots.
 *
 * **The list of mechanics is derived rather than written here**, which is what makes this worth
 * having rather than a second thing to forget. A mechanic is required to be documented when a
 * player can *read its name on a card* — so the candidates are the engine's `KEYWORDS` and the
 * `CardScript` field names, and the filter is whether the word appears in some card's printed
 * `oracleText`. A field like `removesACreature` is a hint for the bot and names nothing on any
 * card, so it is skipped without anybody having to say so; a keyword printed on a card cannot be.
 *
 * Reads source rather than `dist`, because guards run before the build in CI.
 */
function checkPlayerDocCoversEveryMechanic() {
  let keywordsSrc; let scriptTypesSrc; let decksSrc; let doc;
  try {
    keywordsSrc = readFileSync(join('packages', 'rules-engine', 'src', 'characteristics.ts'), 'utf8');
    scriptTypesSrc = readFileSync(join('packages', 'rules-engine', 'src', 'scriptTypes.ts'), 'utf8');
    decksSrc = readFileSync(join('packages', 'rules-engine', 'src', 'starterDecks.ts'), 'utf8');
    doc = readFileSync(join('claude', 'play-realm-setup.md'), 'utf8');
  } catch {
    return; // not a checkout that has the engine and its docs
  }

  const keywordBlock = /export const KEYWORDS = \[([\s\S]*?)\] as const;/.exec(keywordsSrc);
  const fieldBlock = /export interface CardScript \{([\s\S]*?)\n\}/.exec(scriptTypesSrc);
  if (keywordBlock === null || fieldBlock === null) {
    console.error('[guards] could not read KEYWORDS or CardScript out of the engine source, so the');
    console.error('[guards] player-doc check would pass by seeing nothing. Fix the parse.');
    bad++;
    return;
  }

  const keywords = [...keywordBlock[1].matchAll(/'([a-z ' -]+)'/g)].map((m) => m[1]);
  const fields = [...fieldBlock[1].matchAll(/^ {2}readonly ([a-zA-Z]+)\??:/gm)]
    // `levelUp` is printed "level up", `splitSecond` "split second", and so on.
    .map((m) => m[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());

  /*
    Only what a player can read on a card: the `oracleText` values, and nothing else in the file.

    The first draft lowercased the whole source and asked whether the word appeared anywhere in it,
    which is not the same question and said so immediately — it demanded a cheat-sheet row for
    `decisions`, which is a `CardScript` field and is printed on no card in any game of Magic. It
    was matching the file's own comments. Extracting the quoted `oracleText` values is the question
    that was meant.
  */
  const printed = [...decksSrc.matchAll(/oracleText:\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g)]
    .map((m) => m[1] ?? m[2] ?? '')
    .join('\n')
    .toLowerCase();
  // The cheat sheet is the table; prose elsewhere in the file is not where a player looks.
  const table = doc.split('\n').filter((l) => l.startsWith('| ')).join('\n').toLowerCase();

  /*
    And the control, because this check's passing result is a zero and a broken extraction is also
    a zero. Both halves of the filter are asserted against a mechanic that is known to be printed
    and known to be documented: if `printed` comes back empty every mechanic is filtered out and
    the check passes by seeing nothing, which is the one way it can be silently useless.
  */
  if (!printed.includes('flying') || !table.includes('flying')) {
    console.error('[guards] the player-doc check cannot see "flying" on a card or in the cheat');
    console.error('[guards] sheet, so its extraction is broken and a pass would mean nothing.');
    bad++;
    return;
  }

  const missing = [...new Set([...keywords, ...fields])]
    .filter((m) => m.length > 3 && printed.includes(m) && !table.includes(m))
    .sort();
  if (missing.length > 0) {
    console.error(`[guards] ${missing.length} mechanic(s) printed on cards and absent from the`);
    console.error('[guards] player cheat sheet in claude/play-realm-setup.md:');
    for (const m of missing) console.error(`[guards]   ${m}`);
    console.error('[guards] Add a row to the "What you want to do | How" table, or if it is not');
    console.error('[guards] player-facing, say so in the engine rather than leaving it undocumented.');
    bad += missing.length;
  }
}
checkPlayerDocCoversEveryMechanic();

if (bad) {
  console.error(`[guards] ${bad} violation(s)`);
  process.exit(1);
}
console.log('[guards] OK');
