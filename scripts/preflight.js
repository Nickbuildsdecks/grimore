#!/usr/bin/env node
// Grimore pre-deploy preflight (added 2026-08-12).
//
// Catches the class of breakage that has hurt this repo before: AI-edit *truncations* and
// duplicate declarations that make a whole file fail to parse (the app.js / sandbox.js
// SyntaxErrors), plus CSS blocks left brace-unbalanced by a chopped edit. Runs with plain
// Node — no dependencies, no server, no browser. Wire it into deploy (see package.json
// "preflight") so a parse-broken file never ships.
//
// Exit code 0 = clean; non-zero = at least one hard failure (blocks deploy).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IGNORE_DIRS = new Set(['node_modules', '.git', 'web', 'gcp-export', 'scratch', 'dist', '.agents', '.vscode']);

function walk(dir, exts, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.isDirectory()) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walk(full, exts, acc);
    } else if (exts.some(e => ent.name.endsWith(e))) {
      acc.push(full);
    }
  }
  return acc;
}

const rel = p => path.relative(ROOT, p);
let hardFailures = 0;
let warnings = 0;

// 1) node --check every .js (skips node_modules/web). Catches SyntaxErrors incl. truncations
//    and duplicate declarations that abort the whole file at parse time.
const jsFiles = walk(ROOT, ['.js'], []).filter(f => !f.endsWith('.min.js'));
console.log(`[preflight] node --check on ${jsFiles.length} JS file(s)...`);
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    hardFailures++;
    const msg = (e.stderr ? e.stderr.toString() : e.message).split('\n').slice(0, 3).join('\n');
    console.error(`  FAIL  ${rel(f)}\n${msg}`);
  }
}

// 2) Brace / paren / bracket balance on CSS. A chopped @media or rule leaves an unmatched
//    brace (the style.css:885 orphaned-brace class of damage). String/comment-aware scan.
function cssBalance(src) {
  let depth = 0, minDepth = 0, inStr = null, inComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inComment) { if (c === '*' && n === '/') { inComment = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '*') { inComment = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < minDepth) minDepth = depth; }
  }
  return { depth, minDepth };
}
const cssFiles = walk(ROOT, ['.css'], []);
console.log(`[preflight] brace-balance on ${cssFiles.length} CSS file(s)...`);
for (const f of cssFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const { depth, minDepth } = cssBalance(src);
  if (depth !== 0 || minDepth < 0) {
    hardFailures++;
    console.error(`  FAIL  ${rel(f)}  (net brace depth ${depth}, min depth ${minDepth} — expected 0 / >=0)`);
  }
}

// 3) Emoji scan on shipped UI (warning only — the project bans UI emoji, but some glyphs are
//    functional, so this reports rather than blocks). Helps track the no-emoji sweep.
const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;
const uiFiles = [...walk(path.join(ROOT, 'public'), ['.js', '.html'], [])];
let emojiHits = 0;
for (const f of uiFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) if (emojiRe.test(lines[i])) emojiHits++;
}
if (emojiHits > 0) { warnings++; console.log(`[preflight] WARN: ${emojiHits} line(s) with emoji glyphs in public/ (no-emoji sweep pending).`); }

console.log(`\n[preflight] done — ${hardFailures} hard failure(s), ${warnings} warning(s).`);
if (hardFailures > 0) {
  console.error('[preflight] BLOCKED: fix the failures above before deploying.');
  process.exit(1);
}
console.log('[preflight] OK.');
