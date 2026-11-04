/**
 * The built rules engine, with a stale `dist` said out loud rather than left for a reader to notice.
 *
 * Import the engine through this module instead of reaching into `dist` directly:
 *
 *     import { createGame, applyAction } from '../lib/engine.mjs';
 *
 * ## Why the indirection exists
 *
 * The harnesses in `scripts/measure/` import the **built** engine, not its source, because they are
 * plain `.mjs` and the engine is TypeScript. So a run after a source change but before a rebuild
 * measures the previous build — and prints a number that is not wrong, merely about code that is no
 * longer there. That is the most misleading thing a measurement can be, and it happened: D338's
 * `derivable.mjs` printed the pre-change share, to a tenth of a percent, because `dist` was stale.
 *
 * `provenanceLine` was the first answer and is a good one, but it is **opt-in**: 45 of the 52 scripts
 * that import `dist` never called it, so 45 of them could print a number about the wrong build with
 * nothing in their output saying so. A warning you have to remember to ask for is a warning that is
 * missing from exactly the script nobody was thinking carefully about.
 *
 * This module makes it unavoidable. Importing the engine *is* the check, because every one of those
 * scripts has to import the engine to do anything at all.
 *
 * ## What it does, and what it deliberately does not
 *
 * On import it compares `dist/index.js`'s mtime against the newest non-test source file, using the
 * same `distStaleness` that `provenanceLine` prints, so the warning and the line cannot disagree.
 * Stale, or no `dist` at all, and it writes to **stderr**.
 *
 * It does **not** throw, and it does not refuse to load. A harness mid-sweep that dies on import
 * loses the sweep, and the honest reading of a stale build is "this number is about an older
 * engine", not "this run is invalid" — the same judgement D353 made about refusing a token
 * mid-resolution. stderr rather than stdout so a run piped into a file keeps its measurement clean
 * while the warning still reaches the terminal.
 *
 * It does not rebuild anything either. A measurement script that silently rebuilds the thing it is
 * measuring is a worse idea than a stale number, because then nobody knows which build produced
 * which row.
 */
import { distStaleness, DIST, SRC } from './provenance.mjs';

const age = distStaleness();
if (age === null) {
  process.stderr.write(
    `\n  !! ${DIST} does not exist, so this run has no engine to measure.\n`
    + '     Build it first:  pnpm --filter @grimore/rules-engine build\n\n',
  );
} else if (age.stale) {
  const built = new Date(age.builtAt).toISOString().slice(0, 19);
  const changed = new Date(age.newestSourceAt).toISOString().slice(0, 19);
  process.stderr.write(
    `\n  !! STALE ENGINE: ${DIST} was built ${built}Z,\n`
    + `     but ${SRC} has a change from ${changed}Z.\n`
    + '     Whatever this run prints is an honest measurement of the PREVIOUS build.\n'
    + '     Rebuild and run it again:  pnpm --filter @grimore/rules-engine build\n\n',
  );
}

export * from '../../packages/rules-engine/dist/index.js';
