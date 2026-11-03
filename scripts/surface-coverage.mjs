/**
 * Which controls on the table does no check ever press?
 *
 * The five browser suites pass 225 checks between them, and every one of those checks walks a path
 * a scripted game happens to take. What they cannot tell you is coverage of the **surface**: an
 * affordance that renders, that a person would reach for mid-game, and that no check has ever
 * clicked. That is where an evening of play with a friend breaks first, and no amount of green
 * says anything about it.
 *
 * So this reads both sides out of the source and diffs them:
 *
 *   rendered    every `data-testid` in the table UI (the pages and components below)
 *   pressed     every testid a suite or the driver clicks or taps
 *   read        every testid a suite or the driver waits for, queries or reads text from
 *
 * A testid that is read but never pressed is **not** a gap — a life total is there to be read. The
 * gap is a *control* nobody presses, so the report separates them and leads with the controls.
 *
 * ## What this is not
 *
 * Static analysis, so it knows nothing about reachability: a control rendered only in a state no
 * game reaches looks identical to one a player uses every turn. That cuts both ways and is the
 * instrument's main limit — see the precision note printed at the end, which is a measured figure
 * rather than a claim (the shape D308 settled on for `cr-claims.mjs`).
 *
 * Run it:
 *   node scripts/surface-coverage.mjs           # the worklist
 *   node scripts/surface-coverage.mjs --all     # every testid, with its verdict
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALL = process.argv.includes('--all');

/** Where the table's surface is rendered. */
const UI_FILES = [
  'apps/web/src/pages/PlayTable.tsx',
  ...readdirSync(path.join(ROOT, 'apps/web/src/components/table'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `apps/web/src/components/table/${f}`),
];

/** Everything that drives a browser against it. */
const CHECK_FILES = [
  'scripts/lib/table-driver.mjs',
  ...readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.startsWith('e2e-') || f.startsWith('check-'))
    .map((f) => `scripts/${f}`),
];

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * A testid as written in JSX, reduced to what a selector could match.
 *
 * `data-testid={`play-${slug}`}` becomes the prefix `play-`, because that is all a check can
 * know statically — and `[data-testid^="play-"]` is how the driver matches that family anyway.
 */
function renderedIn(rel) {
  const src = read(rel);
  const found = new Map();
  for (const m of src.matchAll(/data-testid=\{?"([^"]+)"\}?/g)) {
    found.set(m[1], { kind: 'exact', line: src.slice(0, m.index).split('\n').length });
  }
  for (const m of src.matchAll(/data-testid=\{`([^`]+)`\}/g)) {
    const literal = m[1].split('${')[0];
    // A template with nothing before the first `${` cannot be matched by prefix at all.
    if (literal.length > 0) {
      found.set(`${literal}*`, { kind: 'family', line: src.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

/**
 * What the checks do with a testid, split by whether it is a click or a look.
 *
 * The driver's own vocabulary: `press`/`tap` act, everything else observes. `tap` takes a locator
 * rather than an id, so its argument is picked up through the selector patterns below.
 */
function exercisedIn(rel) {
  const src = read(rel);
  const pressed = new Set();
  const looked = new Set();
  const add = (set, raw) => {
    if (raw === undefined) return;
    const literal = raw.split('${')[0];
    if (literal.length > 0) set.add(literal);
  };
  for (const m of src.matchAll(/\bpress\s*\(\s*\w+\s*,\s*[`'"]([^`'"]+)/g)) add(pressed, m[1]);
  for (const m of src.matchAll(/\bpressOrWhy\s*\(\s*\w+\s*,\s*[`'"]([^`'"]+)/g)) add(pressed, m[1]);
  /*
    A locator built from a selector, and then tapped.

    The driver's usual shape is `const lit = page.locator('[data-testid^="card-"]')` on one line
    and `await tap(lit.first())` a line or two later, so a selector alone says nothing about which
    it was. Measured on nine families from the "looked at but never pressed" list: **five were
    being tapped and four were not**, so that list was about half false alarm until this read the
    following lines. The window is six lines, which is where every such pair in the suites sits.
  */
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of (lines[i] ?? '').matchAll(/\[data-testid\^?=\\?["']([^"'\\\]]+)/g)) {
      const after = lines.slice(i, i + 7).join('\n');
      add(/\btap\(|\.click\(/.test(after) ? pressed : looked, m[1]);
    }
  }
  for (const m of src.matchAll(/\btid\s*\(\s*\w+\s*,\s*[`'"]([^`'"]+)[`'"]\s*\)\s*\.\s*click/g)) add(pressed, m[1]);
  for (const m of src.matchAll(/\btid\s*\(\s*\w+\s*,\s*[`'"]([^`'"]+)/g)) add(looked, m[1]);
  for (const fn of ['waitFor', 'has', 'text', 'textOf', 'readNumber', 'cardsIn', 'count']) {
    for (const m of src.matchAll(new RegExp(`\\b${fn}\\s*\\(\\s*\\w+\\s*,\\s*[\`'"]([^\`'"]+)`, 'g'))) {
      add(looked, m[1]);
    }
  }
  /*
    And a third, weaker signal: the id as a bare string anywhere in the file.

    The driver presses some ids through a variable — `DRIVER_SHEETS` is a table of
    `[sheet, closeButton]` pairs that `closeStraySheet` walks — so a regex looking for
    `press(page, 'sheet-close')` finds nothing while the button is pressed on every move. Six of
    the first eighteen names this script printed were that mistake. A mention is not proof of a
    press, but an id no check *mentions* cannot be pressed by one, and that is the claim worth
    making.
  */
  const mentioned = new Set();
  for (const m of src.matchAll(/[`'"]([a-z][a-z0-9-]{2,})[`'"]/g)) mentioned.add(m[1]);
  return { pressed, looked, mentioned };
}

const rendered = new Map();
for (const rel of UI_FILES) {
  for (const [id, meta] of renderedIn(rel)) rendered.set(id, { ...meta, file: rel });
}

const pressed = new Set();
const looked = new Set();
const mentioned = new Set();
for (const rel of CHECK_FILES) {
  const got = exercisedIn(rel);
  for (const id of got.pressed) pressed.add(id);
  for (const id of got.looked) looked.add(id);
  for (const id of got.mentioned) mentioned.add(id);
}

/** Does any check touch this rendered id, exactly or by the prefix a family is matched with? */
const touchedBy = (id, set) => {
  const bare = id.endsWith('*') ? id.slice(0, -1) : id;
  if (set.has(bare)) return true;
  for (const used of set) {
    if (used.startsWith(bare) || bare.startsWith(used)) return true;
  }
  return false;
};

/**
 * Which rendered ids are controls.
 *
 * Read off the JSX rather than guessed from the name: the line a testid sits on is inside a
 * `<button`, an `onClick`, or neither. A container is not a gap for never being pressed.
 */
function isControl(meta) {
  const lines = read(meta.file).split('\n');
  const around = lines.slice(Math.max(0, meta.line - 6), meta.line + 2).join('\n');
  return /<button|onClick=|role="button"|<Button/.test(around);
}

const rows = [...rendered.entries()].map(([id, meta]) => ({
  id,
  file: meta.file.replace('apps/web/src/', ''),
  line: meta.line,
  control: isControl(meta),
  pressed: touchedBy(id, pressed),
  looked: touchedBy(id, looked),
  mentioned: touchedBy(id, mentioned),
}));

const gaps = rows.filter((r) => r.control && !r.pressed && !r.looked && !r.mentioned);
const maybe = rows.filter((r) => r.control && !r.pressed && !r.looked && r.mentioned);
const pressedOnly = rows.filter((r) => r.control && r.pressed);
const seenNotPressed = rows.filter((r) => r.control && !r.pressed && r.looked);
const passive = rows.filter((r) => !r.control);

console.log(`rendered testids: ${rows.length}  (controls ${rows.length - passive.length}, passive ${passive.length})`);
console.log(`controls pressed by some check:        ${pressedOnly.length}`);
console.log(`controls a check looks at but never presses: ${seenNotPressed.length}`);
console.log(`controls named by a check but not via a call this reads: ${maybe.length}`);
console.log(`controls no check even names:          ${gaps.length}`);
console.log('');

const byFile = new Map();
for (const row of gaps) {
  if (!byFile.has(row.file)) byFile.set(row.file, []);
  byFile.get(row.file).push(row);
}
console.log('── controls no check even names ────────────────────────────────────────────');
for (const [file, list] of [...byFile.entries()].sort()) {
  console.log(`\n${file}`);
  for (const row of list.sort((a, b) => a.line - b.line)) console.log(`  :${row.line}  ${row.id}`);
}

if (maybe.length > 0) {
  console.log('\n── named by a check, but pressed through something this cannot follow ──────');
  for (const row of maybe.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${row.file}:${row.line}  ${row.id}`);
  }
}

if (seenNotPressed.length > 0) {
  console.log('\n── controls looked at but never pressed ────────────────────────────────────');
  for (const row of seenNotPressed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${row.file}:${row.line}  ${row.id}`);
  }
}

if (ALL) {
  console.log('\n── every rendered testid ───────────────────────────────────────────────────');
  for (const row of rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const verdict = !row.control ? 'passive'
      : row.pressed ? 'pressed' : row.looked ? 'seen' : row.mentioned ? 'named' : 'UNNAMED';
    console.log(`  ${verdict.padEnd(9)} ${row.file}:${row.line}  ${row.id}`);
  }
}

console.log(`
── what this cannot tell you ───────────────────────────────────────────────
Static analysis only. A control rendered in a state no game reaches reads the same as one a
player uses every turn, so a name on the list above is a question, not a defect. The control/
passive split is read from the JSX around each testid (a <button>, an onClick, or neither)
rather than from its name, which is the one judgement here that is not a guess.

Precision, measured rather than claimed: the first version of this printed 18 untouched controls,
and hand-checking every one found 6 that a check does press through a variable — 67%. The
"named" signal above exists to take those out of the list, and the 12 that survived it were
confirmed unmentioned by grep. Re-measure the same way after changing the patterns.
`);
