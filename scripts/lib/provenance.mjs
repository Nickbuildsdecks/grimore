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
 * - **When `dist` was built.** The harnesses import the built engine, not the source, so a stale
 *   `dist` is a run of code the commit does not describe. The mtime is the only thing that catches
 *   it.
 *
 * Deliberately not a JSON blob: it goes at the top of a run whose other output is a line of plain
 * text per pass, and a reader scanning a scrollback for "what was this" should find it in one line
 * rather than parse it.
 *
 * In `scripts/lib/` rather than `scripts/measure/` because `README.md` lists that directory as the
 * instruments, and a helper sitting in it reads as one.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

/** A short git output, or `''` if git cannot answer — never a throw, because this is a log line. */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * `vars` is the environment this run actually read, as `{ SEEDS: 3, ALWAYS: '' }` — the caller's own
 * constants rather than a sweep of `process.env`, so a renamed variable shows up as a changed line
 * instead of being silently dropped.
 */
export function provenanceLine(vars = {}, distPath = 'packages/rules-engine/dist/index.js') {
  const commit = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain']) === '' ? 'clean' : 'DIRTY';
  let built = 'no dist';
  try {
    built = `${statSync(distPath).mtime.toISOString().slice(0, 19)}Z`;
  } catch { /* left as 'no dist', which is itself the answer */ }
  const named = Object.entries(vars)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `  [${commit === '' ? 'no git' : commit} ${dirty}, dist built ${built}] ${named}`;
}
