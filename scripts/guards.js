// CI guards for the v2 workspaces: no emoji in source/UI, no raw hex colors outside packages/theme.
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
if (bad) {
  console.error(`[guards] ${bad} violation(s)`);
  process.exit(1);
}
console.log('[guards] OK');
