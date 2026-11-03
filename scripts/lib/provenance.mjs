/**
 * One line that says what produced a measurement.
 *
 * **This exists because of four numbers that cannot be checked** (#278, D298). The clock's pod win
 * rate was accumulated over eighteen chunks into a ledger of seed ranges and margins, and when
 * `pod-unfinished.mjs` replayed the three chunks that had undecided pods in them, two of one
 * chunk's six and both of another's did not reproduce. The candidates were an engine difference
 * between then and now, or an `ALWAYS=` setting on those runs — and **neither was checkable,
 * because the rows recorded seeds and margins and nothing else.** A long measurement with rows
 * nobody can replay is the same fault as a harness that swallows a throw: the number survives and
 * the thing that would let you audit it does not.
 *
 * So the harness prints its own provenance rather than trusting whoever copies the result into a
 * ledger to write it down. **A line the instrument prints is a line the ledger cannot omit.**
 *
 * Four things, and each is here because leaving it out loses something:
 *
 * - **The arms, as JSON.** The one thing a win rate is *about*, and the one most easily lost: a
 *   margin with no arm beside it is a number with no question.
 * - **Every input that changes which games are played.** `SEED0` and `SEEDS` say which, `ALWAYS`
 *   changes the decks at the table, `MOVES` changes when a game is given up on. The caller names
 *   them, because only the caller knows which of its own variables matter.
 * - **The commit, and whether the tree was dirty.** A commit identifies the build only when the
 *   tree is clean; a `dirty` reading says outright that the hash does not pin what ran, which is a
 *   more useful thing to read six weeks later than a hash that quietly does not mean what it says.
 * - **When `dist` was built, and whether it is stale.** The harnesses import the built engine, not
 *   the source, so a stale `dist` is a run of code the commit does not describe.
 *
 *   The mtime alone was what this printed first, on the reasoning that it "is the only thing that
 *   catches it". It is not, quite: it is the only thing that *could* catch it, and catching it was
 *   left to a reader noticing that one timestamp precedes another. **That failed in practice, on
 *   me.** `derivable.mjs` was run straight after a source change that widened what the derivation
 *   accepts, and it printed the share from before the change — the same 48 of 360 to a tenth of a
 *   percent — because `dist` had not been rebuilt. Nothing was wrong with the number; it was an
 *   honest measurement of the previous build, which is the most misleading thing a measurement can
 *   be. So the comparison is done here now, and the line says `STALE` outright.
 *
 * Deliberately not a JSON blob: it goes at the top of a run whose other output is a line of plain
 * text per pass, and a reader scanning a scrollback for "what was this" should find it in one line
 * rather than parse it.
 *
 * In `scripts/lib/` rather than `scripts/measure/` because `README.md` lists that directory as the
 * instruments, and a helper sitting in it reads as one.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A short git output, or `''` if git cannot answer — never a throw, because this is a log line. */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * The newest mtime among the engine's own sources, or 0 when they cannot be read.
 *
 * Test files are left out on purpose: changing one does not change what `dist` contains, and an
 * instrument that cried stale after every test edit would be ignored within a day.
 */
function newestSource(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSource(path));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch { /* a file that vanished between the listing and the stat is not a staleness signal */ }
  }
  return newest;
}

/**
 * `vars` is the environment this run actually read, as `{ SEEDS: 3, ALWAYS: '' }` — the caller's own
 * constants rather than a sweep of `process.env`, so a renamed variable shows up as a changed line
 * instead of being silently dropped.
 */
export function provenanceLine(
  vars = {},
  distPath = 'packages/rules-engine/dist/index.js',
  srcDir = 'packages/rules-engine/src',
) {
  const commit = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain']) === '' ? 'clean' : 'DIRTY';
  let built = 'no dist';
  try {
    const dist = statSync(distPath).mtimeMs;
    built = `${new Date(dist).toISOString().slice(0, 19)}Z`;
    const source = newestSource(srcDir);
    /*
      Said outright rather than left as two timestamps to compare. A tie is not stale: a build
      finishing in the same millisecond as the last source write is the normal case on a fast
      machine, and calling that stale would be the instrument crying wolf.
    */
    if (source > dist) built += ` STALE(src ${new Date(source).toISOString().slice(0, 19)}Z)`;
  } catch { /* left as 'no dist', which is itself the answer */ }
  const named = Object.entries(vars)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `  [${commit === '' ? 'no git' : commit} ${dirty}, dist built ${built}] ${named}`;
}
