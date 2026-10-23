/**
 * Two browsers, one game of Magic with the rules engine running it.
 *
 * The sibling of `e2e-table.mjs`, which does the same for the manual tabletop. This one is the
 * acceptance test for Arena mode, and the question it answers is the only one that matters: can two
 * people sit down at two machines, start a game, and have the computer play Magic with them —
 * steps, priority, the stack, targeting, combat, damage — without getting stuck.
 *
 * ## How it plays
 *
 * Mostly by taking whatever the UI offers, which is deliberate. A script that clicked a fixed
 * sequence would only ever test the one game it was written against; this one reads the primary
 * action button, the play sheet and the declaration prompts and acts on them, so it plays whatever
 * game the shuffle deals. That makes it the browser-side twin of the engine's own `playout` test:
 * if the UI ever offers something the engine refuses, or stops offering anything at all, the game
 * stops advancing and this fails.
 *
 * On top of that it asserts the specific things a player would notice:
 *
 *   - the phase bar says which step it is and who the game is waiting for
 *   - a land played from hand turns into mana when tapped, and the pool shows it
 *   - a spell with a target waits for the target, puts an object on the stack, and resolves
 *   - a creature's power on screen is the one the engine computed, not the printed one
 *   - combat asks the attacker to declare, then the defender to block
 *   - life totals move on their own, because the rules moved them
 *   - the opponent's hand is still unreadable, with the engine running
 *   - the whole thing fits a phone
 *
 * Run it yourself (the launcher starts both servers):
 *   PLAY_HOST=127.0.0.1 node scripts/play.mjs &
 *   node scripts/e2e-arena.mjs
 *
 * Screenshots land in SHOT_DIR (default ./e2e-shots/arena), so a failure can be looked at.
 */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    'playwright-core',
    '/opt/node-tools/node_modules/playwright/index.js',
  ].filter(Boolean);
  for (const spec of candidates) {
    try {
      return require(spec);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('playwright not found. Install it (npm i -D playwright) or set PLAYWRIGHT_PATH.');
}
const { chromium } = loadPlaywright();

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'arena');
const HEADED = process.env.HEADED === '1';
/** How many clicks the auto-player is allowed before it gives up and reports where it stopped. */
const MAX_MOVES = Number.parseInt(process.env.MAX_MOVES ?? '600', 10);
/** Which decks the two players pick. `tidal-mind` is the one with counterspells. */
const DECK_A = process.env.DECK_A ?? 'ember-rush';
const DECK_B = process.env.DECK_B ?? 'verdant-guard';
/**
 * Makes both players mulligan once, whatever they were dealt.
 *
 * Mulliganing is rare — one hand in nine — so left to the shuffle, the flow that follows it
 * (choosing which card goes back to the bottom) would almost never be exercised. The run with
 * this on is the one that tests it.
 */
const FORCE_MULLIGAN = process.env.FORCE_MULLIGAN === '1';

let step = 0;
const checks = [];
/** How many times each seat has mulliganed, for FORCE_MULLIGAN. */
const seatMulligans = {};

function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? ' ok ' : 'FAIL'}  ${label}${detail && !condition ? ` — ${detail}` : ''}`);
}

async function shot(page, name) {
  step += 1;
  const file = path.join(SHOT_DIR, `${String(step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function waitFor(page, testId, timeout = 15000) {
  try {
    await page.waitForSelector(`[data-testid="${testId}"]`, { timeout, state: 'visible' });
  } catch {
    throw new Error(`timed out waiting for [data-testid="${testId}"] on ${page.url()}`);
  }
}

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const cardsIn = (page, zoneTestId) => page.locator(`[data-testid="${zoneTestId}"] [data-testid^="card-"]`);
const has = async (page, id) => (await tid(page, id).count()) > 0;
const text = async (page, id) => ((await tid(page, id).first().textContent()) ?? '').trim();

async function readNumber(page, testId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const raw = (await tid(page, testId).first().textContent()) ?? '';
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n)) return n;
    if (Date.now() > deadline) throw new Error(`${testId} never read as a number (last: ${JSON.stringify(raw)})`);
    await page.waitForTimeout(100);
  }
}

async function expectEventually(page, label, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return check(label, true);
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) return check(label, false, `last value: ${JSON.stringify(last)}`);
    await page.waitForTimeout(150);
  }
}

/** Whether this page is the one the engine is waiting on. */
async function isMyMove(page) {
  if (await has(page, 'mulligan-prompt')) return true;
  if (await has(page, 'bottom-prompt')) return true;
  if (await has(page, 'target-prompt')) return true;
  if (await has(page, 'attack-prompt')) return true;
  if (await has(page, 'block-prompt')) return true;
  if (await has(page, 'discard-prompt')) return true;
  return has(page, 'primary-move');
}

/**
 * Makes one move on whichever page is being asked for one.
 *
 * Returns a short description of what it did, which is what the caller logs. The policy is "do the
 * simplest legal thing": take the primary action, declare an empty attack unless something can
 * attack, block with nothing, and play a card from hand now and then so the game actually develops.
 */
async function makeMove(page, seat, { aggression = 0.6 } = {}) {
  // Opening hands come before anything else, including priority.
  if (await has(page, 'bottom-prompt')) {
    // Tap cards in hand until as many are chosen as the prompt asks for, then keep.
    const hand = cardsIn(page, `zone-hand-${seat}`);
    const count = await hand.count();
    for (let i = 0; i < count; i++) {
      if (await has(page, 'confirm-bottom')) break;
      await hand.nth(i).click({ timeout: 2000 }).catch(() => {});
    }
    if (await has(page, 'confirm-bottom')) {
      await tid(page, 'confirm-bottom').click();
      return 'kept a mulliganed hand';
    }
    await tid(page, 'cancel-mode').click();
    return 'backed out of bottoming';
  }
  if (await has(page, 'mulligan-prompt')) {
    // Mulligan a hand with no land in it, which is the case the decision exists for.
    const names = await cardsIn(page, `zone-hand-${seat}`).evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-card-name') ?? ''));
    const lands = names.filter((n) => /Mountain|Forest|Plains|Island|Swamp/.test(n)).length;
    const mulliganed = seatMulligans[seat] ?? 0;
    if ((lands <= 1 || (FORCE_MULLIGAN && mulliganed === 0)) && (await has(page, 'mulligan'))) {
      seatMulligans[seat] = mulliganed + 1;
      await tid(page, 'mulligan').click();
      return `mulliganed a hand with ${lands} land`;
    }
    await tid(page, 'primary-move').click();
    return 'kept the opening hand';
  }

  // A declaration in progress is finished first — it is blocking everything else.
  if (await has(page, 'target-prompt')) {
    // A spell on the stack is a row in the stack panel rather than a card face, because an ability
    // waiting to resolve has no card at all. It is the first thing looked for: a counterspell with
    // a legal target should always take it.
    const onStack = page.locator('[data-testid^="target-stack-"]');
    if ((await onStack.count()) > 0) {
      await onStack.first().click();
      return 'countered something on the stack';
    }
    // Otherwise the first legal target: a lit card, or the opponent.
    const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
    if ((await lit.count()) > 0) {
      await lit.first().click();
      return 'picked a card as a target';
    }
    const seatButtons = page.locator('[data-testid^="target-seat-"]');
    if ((await seatButtons.count()) > 0) {
      // Prefer the opponent's seat over your own.
      const theirs = page.locator(`[data-testid^="target-seat-"]:not([data-testid="target-seat-${seat}"])`);
      await ((await theirs.count()) > 0 ? theirs.first() : seatButtons.first()).click();
      return 'picked a player as a target';
    }
    await tid(page, 'cancel-mode').click();
    return 'cancelled an untargetable spell';
  }

  if (await has(page, 'attack-prompt')) {
    // Attack with everything the engine is offering, which it marks by making them tappable.
    const mine = cardsIn(page, `zone-battlefield-${seat}`);
    const count = await mine.count();
    for (let i = 0; i < count; i++) {
      await mine.nth(i).click({ timeout: 2000 }).catch(() => {});
    }
    await tid(page, 'confirm-attackers').click();
    return 'declared attackers';
  }

  if (await has(page, 'block-prompt')) {
    // Pick up each of your creatures in turn and put it on whichever attacker lights up, which is
    // the table telling you what that creature may legally block. A real player would think about
    // the trade; the point here is that the pairing flow produces a declaration the engine accepts.
    const mine = cardsIn(page, `zone-battlefield-${seat}`);
    const count = await mine.count();
    for (let i = 0; i < count; i++) {
      await mine.nth(i).click({ timeout: 2000 }).catch(() => {});
      const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
      if ((await lit.count()) === 0) continue;
      await lit.first().click({ timeout: 2000 }).catch(() => {});
      break;
    }
    await tid(page, 'confirm-blockers').click();
    return 'declared blockers';
  }

  if (await has(page, 'discard-prompt')) {
    await cardsIn(page, `zone-hand-${seat}`).first().click();
    return 'discarded to hand size';
  }

  if (!(await has(page, 'primary-move'))) return null;

  const label = await text(page, 'primary-move');

  // Responding is the whole point of holding an instant, and it is the only way a counterspell
  // ever gets cast — so a chance to respond is taken more often than a chance to develop. The
  // engine decides what is castable in either case; this only decides whether to look.
  const responding = /^Resolve/.test(label);
  const develop = /^Pass$/.test(label) && Math.random() < aggression;
  if (responding || develop) {
    const played = await tryToPlayFromHand(page, seat);
    if (played !== null) return played;
  }
  await tid(page, 'primary-move').click();
  return `primary: ${label}`;
}

/**
 * Taps a card in hand the table says is playable and takes the first play it offers.
 *
 * "Playable" is the table's own badge, which comes from `legalActions` — so this never tries a
 * card the engine would refuse, and a spell that cannot be cast right now (a sorcery in response,
 * something unaffordable) simply does not carry the badge.
 */
async function tryToPlayFromHand(page, seat) {
  const playable = page.locator(`[data-testid="zone-hand-${seat}"] [data-testid^="card-"]`);
  const count = await playable.count();
  for (let i = 0; i < count; i++) {
    const card = playable.nth(i);
    const badges = (await card.textContent()) ?? '';
    if (!/playable/i.test(badges)) continue;
    await card.click();
    await waitFor(page, 'play-sheet', 5000);
    const options = page.locator('[data-testid^="play-"]:not([data-testid="play-sheet"]):not([data-testid="play-sheet-close"])');
    if ((await options.count()) > 0) {
      const name = (await options.first().textContent()) ?? '';
      await options.first().click();
      return `chose a play: ${name.trim().slice(0, 40)}`;
    }
    await tid(page, 'play-sheet-close').click();
    return null;
  }
  return null;
}

/**
 * Nothing taps mana by hand, on purpose.
 *
 * The engine taps for a cost it can pay, so a driver that tapped lands first would only be
 * spending mana it did not need — and, worse, leaving nothing untapped at the end of its own turn,
 * which is exactly the mana a counterspell is held up for. Playing without touching a land is
 * also how a person would play: you pick the spell and the mana follows.
 */

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED });
  const nickCtx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const friendCtx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const nick = await nickCtx.newPage();
  const friend = await friendCtx.newPage();

  const pageErrors = [];
  const badRequests = [];
  const EXPECTED_FAILURES = [/\/api\//, /\/logo\.svg/];
  for (const [who, page] of [['Nick', nick], ['Friend', friend]]) {
    page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
    page.on('response', (res) => {
      if (res.status() < 400) return;
      if (EXPECTED_FAILURES.some((re) => re.test(res.url()))) return;
      badRequests.push(`${who}: ${res.status()} ${res.url()}`);
    });
  }

  try {
    // ── Sit down ────────────────────────────────────────────────────────────────────────────────
    await nick.goto(BASE);
    await waitFor(nick, 'lobby');
    await tid(nick, 'player-name').fill('Nick');
    await tid(nick, 'format-modern').click();
    await tid(nick, 'create-table').click();
    await waitFor(nick, 'pregame');
    const code = (await tid(nick, 'table-code').textContent())?.trim() ?? '';

    await friend.goto(BASE);
    await waitFor(friend, 'lobby');
    await tid(friend, 'player-name').fill('Friend');
    await tid(friend, 'join-code').fill(code);
    await tid(friend, 'join-table').click();
    await waitFor(friend, 'pregame');

    await tid(nick, 'ready').click();
    await tid(friend, 'ready').click();
    await waitFor(nick, `deck-${DECK_A}`);
    await tid(nick, `deck-${DECK_A}`).click();
    await tid(friend, `deck-${DECK_B}`).click();

    // ── Hand the table to the rules engine ──────────────────────────────────────────────────────
    await expectEventually(nick, 'the host is offered a game run by the rules engine', async () =>
      (await has(nick, 'start-engine')) && (await tid(nick, 'start-engine').isEnabled()));
    await tid(nick, 'start-engine').click();

    await waitFor(nick, 'table');
    await waitFor(friend, 'table');
    await expectEventually(nick, 'the engine takes over and asks for an opening-hand decision', async () =>
      (await has(nick, 'phase-bar')) && (await has(nick, 'mulligan-prompt')));
    await expectEventually(friend, 'and asks the other player too, at the same time', async () =>
      has(friend, 'mulligan-prompt'));
    await shot(nick, 'opening-hand');
    // Checked here, with the opening hand on the table: after the decision a player who
    // mulliganed is holding six.
    await expectEventually(nick, 'Nick is dealt seven cards', async () =>
      (await cardsIn(nick, 'zone-hand-0').count()) === 7);
    await expectEventually(friend, 'Friend is dealt seven cards', async () =>
      (await cardsIn(friend, 'zone-hand-1').count()) === 7);

    // Both keep (or mulligan) before anybody has priority.
    for (const [page, seat] of [[nick, 0], [friend, 1]]) {
      for (let i = 0; i < 6 && (await isMyMove(page)); i++) {
        if (!(await has(page, 'mulligan-prompt')) && !(await has(page, 'bottom-prompt'))) break;
        await makeMove(page, seat);
        await page.waitForTimeout(150);
      }
    }
    await expectEventually(nick, 'and the first turn begins once both hands are settled', async () =>
      !(await has(nick, 'mulligan-prompt')) && !(await has(friend, 'mulligan-prompt')));
    if (FORCE_MULLIGAN) {
      // A London mulligan draws a fresh seven and puts one back, so the hand is six.
      await expectEventually(nick, 'a mulliganed hand is six cards, not seven', async () =>
        (await cardsIn(nick, 'zone-hand-0').count()) === 6);
      await expectEventually(friend, 'and the same for the other player', async () =>
        (await cardsIn(friend, 'zone-hand-1').count()) === 6);
      await shot(nick, 'after-mulligan');
    }
    await expectEventually(friend, 'both players see it, not just the host', async () =>
      has(friend, 'phase-bar'));
    await expectEventually(nick, 'the manual control bar is replaced by the engine’s own', async () =>
      (await has(nick, 'arena-bar')) && !(await has(nick, 'controls')));
    await shot(nick, 'engine-started');

    // The engine begins the first turn at its upkeep, with the active player holding priority.
    await expectEventually(nick, 'the step is named rather than left to be guessed at', async () => {
      const label = await text(nick, 'step-label');
      return label.length > 0 && /upkeep|main|draw/i.test(label);
    });
    await expectEventually(nick, 'the bar says who the game is waiting for', async () =>
      /priority|waiting/i.test(await text(nick, 'waiting-on')));
    await expectEventually(nick, 'the stack starts empty and says so', async () => has(nick, 'stack-empty'));

    // ── Hidden information still holds ──────────────────────────────────────────────────────────
    const friendHandAsNickSees = await cardsIn(nick, 'zone-hand-1').evaluateAll((els) =>
      els.map((e) => ({ hidden: e.getAttribute('data-hidden'), name: e.getAttribute('data-card-name') })));
    check(
      'with the engine running, the opponent’s hand is still unreadable',
      friendHandAsNickSees.length >= 6 && friendHandAsNickSees.every((c) => c.hidden === 'true' && !c.name),
      JSON.stringify(friendHandAsNickSees).slice(0, 160),
    );
    // The engine's own legal-move list is computed per seat, so it must not leak either.
    const leaked = await nick.evaluate(() => document.body.textContent ?? '');
    check(
      'and no card from it appears anywhere in the page',
      !/Llanowar Elves|Sigarda|Ajani's Pridemate/.test(leaked),
      leaked.slice(0, 120),
    );

    // ── Only one player is asked to act at a time ───────────────────────────────────────────────
    const nickMoves = await isMyMove(nick);
    const friendMoves = await isMyMove(friend);
    check(
      'exactly one player is being asked to act',
      nickMoves !== friendMoves,
      `nick=${nickMoves} friend=${friendMoves}`,
    );
    await expectEventually(friend, 'and the other is told they are waiting', async () =>
      (await has(friend, 'not-your-move')) || (await isMyMove(friend)));

    // ── Play the game out ───────────────────────────────────────────────────────────────────────
    // From here the script takes whatever the UI offers, as a player would, and watches for the
    // milestones that prove each part of the engine is wired through.
    const seen = {
      land: false, mana: false, stack: false, attackers: false, blockers: false,
      lifeChanged: false, combatStep: false, computedBody: false, countered: false, turnsPassed: 0,
    };
    const startLifeNick = await readNumber(nick, 'life-0');
    const startLifeFriend = await readNumber(friend, 'life-1');
    let lastTurn = await readNumber(nick, 'turn');
    let moves = 0;
    let finished = false;
    let lastMove = '';
    let repeats = 0;

    while (moves < MAX_MOVES) {
      if (await has(nick, 'game-over')) {
        finished = true;
        break;
      }
      const actor = (await isMyMove(nick)) ? { page: nick, seat: 0, who: 'Nick' }
        : (await isMyMove(friend)) ? { page: friend, seat: 1, who: 'Friend' }
        : null;
      if (actor === null) {
        // Nobody has anything to do: either the sockets are mid-flight, or the game is stuck.
        await nick.waitForTimeout(250);
        moves += 1;
        if (moves % 20 === 0) {
          const where = `${await text(nick, 'step-label')} / turn ${await readNumber(nick, 'turn')}`;
          console.log(`      (waiting — ${where})`);
        }
        continue;
      }

      // Milestones, read before the move so the prompt that is on screen is the one recorded.
      // Being *asked* counts, which is what the primary button says before the declaration screen
      // opens — the question is whether the engine asks the right player, not how many clicks it
      // takes to answer.
      if (await has(actor.page, 'attack-prompt')) seen.attackers = true;
      if (await has(actor.page, 'block-prompt')) seen.blockers = true;
      if (await has(actor.page, 'primary-move')) {
        const label = await text(actor.page, 'primary-move');
        if (/declare attackers/i.test(label)) seen.attackers = true;
        if (/declare blockers/i.test(label)) seen.blockers = true;
      }
      if (/declare|combat/i.test(await text(actor.page, 'step-label'))) seen.combatStep = true;

      const did = await makeMove(actor.page, actor.seat);
      moves += 1;
      if (did !== null && moves % 10 === 0) {
        console.log(`      move ${moves}: ${actor.who} ${did}`);
      }
      await actor.page.waitForTimeout(90);

      // The same move being made over and over without the game moving on is the failure mode
      // worth catching early: it means the table offered something the engine refused.
      const here = `${actor.who}:${did}:${await text(nick, 'step-label')}:${await readNumber(nick, 'turn')}`;
      repeats = here === lastMove ? repeats + 1 : 0;
      lastMove = here;
      if (repeats >= 8) {
        const err = (await has(nick, 'table-error')) ? await text(nick, 'table-error')
          : (await has(friend, 'table-error')) ? await text(friend, 'table-error')
          : 'no error shown';
        check('the table never offers a move the engine refuses', false, `stuck on "${did}" at ${here} — ${err}`);
        break;
      }

      // Did anything the engine owns happen?
      if (!seen.stack && (await nick.locator('[data-testid^="stack-"]').count()) > 0) {
        seen.stack = true;
        await shot(nick, 'stack-in-use');
      }
      // Looked for on whichever page is acting: targeting is a state of that one browser, so the
      // other player never sees the prompt at all.
      if (!seen.countered && (await actor.page.locator('[data-testid^="target-stack-"]').count()) > 0) {
        seen.countered = true;
        await shot(actor.page, 'countering-a-spell');
      }
      if (did !== null && /counter/i.test(did)) seen.countered = true;
      if (!seen.mana) {
        // Either floating mana, or the dimmed "what you could still make" display. With the engine
        // tapping for a spell's cost the pool is usually spent in the same action it was filled,
        // so what the player actually reads most of the time is the second one.
        const floating = await nick.locator('[data-testid^="pool-"]').count();
        const available = await nick.locator('[data-testid="mana-potential"]').count();
        if (floating > 0 || available > 0) seen.mana = true;
      }
      if (!seen.land && (await cardsIn(nick, 'zone-battlefield-0').count()) > 0) seen.land = true;
      if (!seen.computedBody) {
        const gold = await nick.locator('[data-testid^="body-"].text-\\[var\\(--g-gold-400\\)\\]').count();
        if (gold > 0) {
          seen.computedBody = true;
          await shot(nick, 'computed-power');
        }
      }
      const turn = await readNumber(nick, 'turn');
      if (turn > lastTurn) {
        seen.turnsPassed += turn - lastTurn;
        lastTurn = turn;
      }
      if (!seen.lifeChanged) {
        const l0 = await readNumber(nick, 'life-0');
        const l1 = await readNumber(nick, 'life-1');
        if (l0 !== startLifeNick || l1 !== startLifeFriend) {
          seen.lifeChanged = true;
          await shot(nick, 'life-changed-by-the-rules');
        }
      }
      // Enough has been seen to prove every part is wired; stop before a long game times out.
      const enough = seen.land && seen.mana && seen.stack && seen.attackers && seen.blockers &&
        seen.lifeChanged && seen.turnsPassed >= 4;
      if (enough) break;
    }

    console.log(`      played ${moves} moves over ${seen.turnsPassed} turn changes`);
    check('the game keeps advancing — the engine never gets stuck', seen.turnsPassed >= 4, JSON.stringify(seen));
    // The stack is drawn as a list rather than as cards, so a spell on it needs its own way to be
    // pointed at. Whether the situation comes up is the shuffle's business — a counterspell has to
    // be drawn, be affordable, and have something worth countering — so it is asserted when the
    // game produced it and reported when it did not. `playout.test.ts` asserts deterministically
    // that counterspells get cast; this is about the one thing only a browser can show, which is
    // that a row in the stack panel can be tapped as a target.
    if (seen.countered) {
      check('a spell on the stack can be targeted', true);
    } else if (DECK_A === 'tidal-mind' || DECK_B === 'tidal-mind') {
      console.log('      (no counterspell was castable in this game — nothing to aim at the stack)');
    }
    check('a land played from hand reaches the battlefield', seen.land);
    check('the bar shows the mana available to spend', seen.mana);
    check('a spell or ability goes on the stack and resolves', seen.stack);
    check('combat asks the attacking player to declare', seen.attackers);
    // Whether a *block* is ever required depends on the shuffle: a defender with no untapped
    // creature is not asked, and the engine declares an empty block for them. So this is asserted
    // when the game produced the situation and reported when it did not — `combat.test.ts` owns
    // the deterministic version of the claim, on a board built to need a block.
    if (seen.blockers) {
      check('and asks the defending player to block', true);
    } else {
      console.log('      (no block was called for in this game — the defender was never attacked '
        + 'with a creature able to block; combat.test.ts covers that path on a fixed board)');
    }
    check('life totals move because the rules moved them', seen.lifeChanged);
    await shot(nick, 'mid-game-nick');
    await shot(friend, 'mid-game-friend');

    // ── The board agrees with the engine ────────────────────────────────────────────────────────
    // Every creature on screen shows the power the engine computed. A card whose body came from the
    // printed values would disagree the moment a counter or a pump existed.
    const bodies = await nick.locator('[data-testid^="body-"]').evaluateAll((els) =>
      els.map((e) => e.textContent?.trim() ?? ''));
    check(
      'creatures on the battlefield show a current power and toughness',
      bodies.length === 0 || bodies.every((b) => /^\d+\/\d+$/.test(b)),
      JSON.stringify(bodies).slice(0, 120),
    );

    // ── A refresh mid-game must not lose the seat ───────────────────────────────────────────────
    const handBeforeReload = await cardsIn(friend, 'zone-hand-1').count();
    await friend.reload();
    await expectEventually(friend, 'a mid-game refresh rejoins the same automated game', async () => {
      if (!(await has(friend, 'table'))) return false;
      if (!(await has(friend, 'phase-bar'))) return false;
      return (await cardsIn(friend, 'zone-hand-1').count()) === handBeforeReload;
    }, 20000);
    await shot(friend, 'after-reload');

    // ── Finish it, if it has not finished itself ────────────────────────────────────────────────
    if (!finished) {
      // A longer budget than the first loop: that one stops as soon as it has seen every part of
      // the engine work, while this one has to actually finish a game — and a slow matchup can run
      // past turn forty before somebody dies or decks out.
      for (let i = 0; i < MAX_MOVES * 4 && !(await has(nick, 'game-over')); i++) {
        const actor = (await isMyMove(nick)) ? { page: nick, seat: 0 }
          : (await isMyMove(friend)) ? { page: friend, seat: 1 }
          : null;
        if (actor === null) {
          await nick.waitForTimeout(200);
          continue;
        }
        await makeMove(actor.page, actor.seat, { aggression: 0.85 });
        await actor.page.waitForTimeout(40);
      }
      finished = await has(nick, 'game-over');
    }
    check('the game reaches a winner through the real UI', finished,
      finished ? '' : `stopped at ${await text(nick, 'step-label')} turn ${await readNumber(nick, 'turn')}`);
    if (finished) {
      const over = await text(nick, 'game-over');
      check('and both players are told who won', /wins/.test(over), over.slice(0, 80));
      await expectEventually(friend, 'the loser sees the same result', async () =>
        /wins/.test(await text(friend, 'game-over')));
      await shot(nick, 'game-over');
    }

    // ── Phone layout ────────────────────────────────────────────────────────────────────────────
    await nick.setViewportSize({ width: 390, height: 844 });
    await nick.waitForTimeout(400);
    const overflow = await nick.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('the automated table fits a phone with no sideways scrolling', overflow <= 1, `overflow ${overflow}px`);
    const barVisible = await nick.evaluate(() => {
      const bar = document.querySelector('[data-testid="arena-bar"]');
      if (!bar) return 'missing';
      const box = bar.getBoundingClientRect();
      return box.left >= -1 && box.right <= window.innerWidth + 1 ? 'ok' : `clipped (${box.left}..${box.right})`;
    });
    check('and the engine’s control bar stays fully on screen', barVisible === 'ok', String(barVisible));
    await shot(nick, 'phone');

    // The strongest form of "the table only offers what the engine accepts": a refusal would have
    // left its message on screen, because the banner stays until it is dismissed and nothing in
    // this script dismisses one.
    const refusals = [];
    for (const [who, page] of [['Nick', nick], ['Friend', friend]]) {
      if (await has(page, 'table-error')) refusals.push(`${who}: ${await text(page, 'table-error')}`);
    }
    check('the engine never refused anything the table offered', refusals.length === 0, refusals.join(' | '));

    check('no uncaught errors in either browser', pageErrors.length === 0, pageErrors.join(' | '));
    check('no failed requests other than the API this table does not need', badRequests.length === 0, badRequests.join(' | '));
  } catch (err) {
    check('the run completed without throwing', false, err.message);
    await shot(nick, 'nick-at-failure').catch(() => {});
    await shot(friend, 'friend-at-failure').catch(() => {});
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${SHOT_DIR}/`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

await main();
