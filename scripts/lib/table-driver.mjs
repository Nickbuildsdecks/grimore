/**
 * The shared driver behind the browser suites: how to find things on a Play Realm table, and how
 * to make whatever move the table is asking for.
 *
 * Extracted from `e2e-arena.mjs` when `e2e-pod.mjs` needed the same hands — four browsers playing
 * Commander ask for exactly the same moves as two playing a duel, and a second copy of this policy
 * would have drifted from the first inside a week. Nothing here knows how many players there are.
 *
 * The important piece is `makeMove`: it reads the prompts on screen and does the simplest legal
 * thing, so a suite built on it plays whatever game the shuffle deals rather than a fixed sequence.
 * If the table ever offers something the engine refuses, the game stops advancing and the caller
 * notices. The counterpart in the engine is `playout.test.ts`, which does the same with no browser.
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

/** Where screenshots land, and how many have been taken. Set once by the suite. */
let shotDir = path.join('e2e-shots');
let step = 0;
export async function setShotDir(dir) {
  shotDir = dir;
  await mkdir(dir, { recursive: true });
}
export { chromium };

export const checks = [];
/** How many times each seat has mulliganed, for `forceMulligan`. */
const seatMulligans = {};
/** Whether this run has already photographed a free cast on offer. See `makeMove`. */
let shotAnOffer = false;

/**
 * Prints the tally and sets the exit code.
 *
 * Every suite ends the same way, and the one thing that must not vary is that a failure exits
 * non-zero — a suite that printed its failures and exited 0 would be green in CI.
 */
export function summarize() {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${shotDir}/`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

export function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? ' ok ' : 'FAIL'}  ${label}${detail && !condition ? ` — ${detail}` : ''}`);
}

export async function shot(page, name) {
  step += 1;
  const file = path.join(shotDir, `${String(step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/**
 * React's own complaints, which are not uncaught errors and so slipped past every suite.
 *
 * `pageerror` only fires for an exception nobody caught. A render loop is not that: React logs
 * "Maximum update depth exceeded" to the console and carries on, so a table that spent its whole
 * combat step re-rendering instead of answering taps passed "no uncaught errors" every time. It
 * was found by reading the dev server's log by hand — 7,555 of them in one run of the suites —
 * which is not a thing to rely on twice.
 *
 * Push into `sink`; assert it is empty at the end of the run.
 */
const REACT_COMPLAINTS = [
  /Maximum update depth exceeded/,
  /Cannot update a component/,
  /change in the order of Hooks/,
  /unique "key" prop/,
  /^Warning:/,
];

export function watchForReactWarnings(page, who, sink) {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const body = message.text();
    if (!REACT_COMPLAINTS.some((re) => re.test(body))) return;
    const line = who === '' ? body : `${who}: ${body}`;
    // One line per distinct complaint: a render loop produces thousands of identical ones.
    if (!sink.includes(line)) sink.push(line);
  });
}

export async function waitFor(page, testId, timeout = 15000) {
  try {
    await page.waitForSelector(`[data-testid="${testId}"]`, { timeout, state: 'visible' });
  } catch {
    throw new Error(`timed out waiting for [data-testid="${testId}"] on ${page.url()}`);
  }
}

export const tid = (page, id) => page.locator(`[data-testid="${id}"]`);

/**
 * Presses a control, and says whether the press landed.
 *
 * Bounded on purpose. A table that four seats are all acting on re-renders the control bar under
 * the cursor, and Playwright's default click waits thirty seconds for an element to hold still —
 * so a button that was replaced between "it is here" and "click it" used to end the whole run with
 * a stack trace instead of a move. Caught in a solo pod: "element was detached from the DOM,
 * retrying" for thirty seconds, in a game that was otherwise going fine.
 *
 * Two tries at two seconds, because the second try is against the re-rendered button and nearly
 * always works. A press that still will not land is not a failure to report from here: the callers
 * carry on and their own idle detectors say so if the table has really stopped.
 */
export async function tap(locator) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await locator.click({ timeout: 2000 });
      return true;
    } catch {
      /* The board moved: try the same locator once more, then give up quietly. */
    }
  }
  return false;
}

export async function press(page, id) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await tid(page, id).first().click({ timeout: 2000 });
      return true;
    } catch {
      if (!(await has(page, id))) return false;
    }
  }
  return false;
}
export const cardsIn = (page, zoneTestId) => page.locator(`[data-testid="${zoneTestId}"] [data-testid^="card-"]`);
export const has = async (page, id) => (await tid(page, id).count()) > 0;
/**
 * The text of an element, or '' when it is not there.
 *
 * Bounded for the same reason the clicks are: Playwright waits thirty seconds for an element by
 * default, and a read of something that has just been re-rendered away used to end a whole run
 * with "locator.textContent: Timeout 30000ms exceeded" — on a game that was going fine. A caller
 * that genuinely needs the text gets '' and fails its own check with its own message, which says
 * more than a stack trace from inside the driver.
 */
/** The text of a locator, or '' when reading it times out. See `text`. */
export const textOf = async (locator) => {
  try {
    return ((await locator.textContent({ timeout: 2000 })) ?? '').trim();
  } catch {
    return '';
  }
};

export const text = async (page, id) => {
  try {
    return ((await tid(page, id).first().textContent({ timeout: 2000 })) ?? '').trim();
  } catch {
    return '';
  }
};

export async function readNumber(page, testId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const raw = await text(page, testId);
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n)) return n;
    if (Date.now() > deadline) throw new Error(`${testId} never read as a number (last: ${JSON.stringify(raw)})`);
    await page.waitForTimeout(100);
  }
}

/**
 * Waits for a predicate to come true and says whether it did, without making a check of its own.
 *
 * `expectEventually` reports its own result, which is right for most waits; this one is for the
 * cases where the caller wants to say *what* failed with numbers the predicate cannot see.
 */
export async function expectEventuallyTrue(page, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* A locator that is mid-rerender: try again. */
    }
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(150);
  }
}

export async function expectEventually(page, label, predicate, timeout = 12000) {
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
export async function isMyMove(page) {
  if (await has(page, 'mulligan-prompt')) return true;
  // Every prompt that blocks the control bar belongs on this list, including the ones that are
  // *this browser's* own half-finished interaction rather than something the engine is waiting
  // for — while one is open the bar shows no primary action, so a prompt left off here reads as
  // "nobody has anything to do" and the suite waits out its idle budget on a game that is fine.
  if (await has(page, 'x-prompt')) return true;
  if (await has(page, 'decide-prompt')) return true;
  if (await has(page, 'choose-prompt')) return true;
  if (await has(page, 'feed-prompt')) return true;
  if (await has(page, 'bottom-prompt')) return true;
  if (await has(page, 'target-prompt')) return true;
  if (await has(page, 'attack-prompt')) return true;
  if (await has(page, 'block-prompt')) return true;
  if (await has(page, 'order-prompt')) return true;
  if (await has(page, 'discard-prompt')) return true;
  if (await has(page, 'ward-prompt')) return true;
  // And a dredge, which stops the table for a seat that is only owed a draw.
  if (await has(page, 'dredge-prompt')) return true;
  /*
    A free cast on offer, which stops the table for the seat that may take it.

    On this list for exactly the reason the comment above gives: the control bar shows no primary
    action while a cascade hit is waiting — nobody holds priority — so without this line a table
    mid-cascade reads as "nobody has anything to do" and the suite waits out its idle budget on a
    game that is fine. Which is what happened the first time this was run: the game stopped at turn
    seven, one move after a Bloodbraid Elf was cast.
  */
  if (await has(page, 'offered-cast-prompt')) return true;
  return has(page, 'primary-move');
}
/**
 * Makes one move on whichever page is being asked for one.
 *
 * Returns a short description of what it did, which is what the caller logs. The policy is "do the
 * simplest legal thing": take the primary action, declare an empty attack unless something can
 * attack, block with nothing, and play a card from hand now and then so the game actually develops.
 *
 * `abilities` adds one thing to that policy — activating an ability of a permanent — and is off by
 * default because an ability spends mana a spell wanted. See `tryToPlayFromHand`.
 */
export async function makeMove(
  page, seat, { aggression = 0.6, forceMulligan = false, abilities = false } = {},
) {
  // Opening hands come before anything else, including priority.
  if (await has(page, 'bottom-prompt')) {
    // Tap cards in hand until as many are chosen as the prompt asks for, then keep.
    const hand = cardsIn(page, `zone-hand-${seat}`);
    const count = await hand.count();
    for (let i = 0; i < count; i++) {
      if (await has(page, 'confirm-bottom')) break;
      await tap(hand.nth(i));
    }
    if (await has(page, 'confirm-bottom')) {
      await press(page, 'confirm-bottom');
      return 'kept a mulliganed hand';
    }
    await press(page, 'cancel-mode');
    return 'backed out of bottoming';
  }
  if (await has(page, 'mulligan-prompt')) {
    // Mulligan a hand with no land in it, which is the case the decision exists for.
    const names = await cardsIn(page, `zone-hand-${seat}`).evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-card-name') ?? ''));
    const lands = names.filter((n) => /Mountain|Forest|Plains|Island|Swamp/.test(n)).length;
    const mulliganed = seatMulligans[seat] ?? 0;
    if ((lands <= 1 || (forceMulligan && mulliganed === 0)) && (await has(page, 'mulligan'))) {
      seatMulligans[seat] = mulliganed + 1;
      await press(page, 'mulligan');
      return `mulliganed a hand with ${lands} land`;
    }
    await press(page, 'primary-move');
    return 'kept the opening hand';
  }

  /*
    A ward, answered before anything else for the same reason a mid-resolution question is: the
    spell is on the stack and nobody holds priority until this is settled.

    Paid rather than declined, because a driver that always declines would never once exercise the
    payment — and the payment is the half with mana in it. The engine's own tests cover declining
    and cover the case where the cost cannot be met at all.
  */
  if (await has(page, 'ward-prompt')) {
    const prompt = await text(page, 'ward-prompt');
    // Shot *before* pressing, because the thing worth a picture is the question: two buttons and
    // the sentence naming what is countered if you decline. Taken after, the first version of this
    // caught the feed line reporting a creature that had already died.
    await shot(page, 'a-ward-being-paid');
    await press(page, 'ward-pay');
    return `paid a ward: ${prompt}`;
  }

  /*
    A dredge, which is the only question here about a card nobody played (CR 702.52a).

    **Taken** rather than declined, for the reason the ward above is paid: a driver that always
    declined would never once exercise the mill, and the mill is the half with the library in it.
    Declining is the branch the engine's own tests cover, and it has one of its own there precisely
    because it is the easier half to get wrong.
  */
  if (await has(page, 'dredge-prompt')) {
    const prompt = await text(page, 'dredge-prompt');
    // Shot before pressing, because the question is the picture: the card named, the price in
    // cards, and the two answers.
    await shot(page, 'a-dredge-offered');
    /*
      Whether the bar is also offering a **standing** answer, reported rather than pressed.

      The setting is the thing that stops this question being asked twenty times in a game, and the
      place it has to be reachable from is here — beside the question it is about. Reported so a run
      can require it without the driver changing a preference mid-game, which would make every
      later move a different test.
    */
    const standing = (await has(page, 'dredge-standing'))
      ? ` [standing: ${(await text(page, 'dredge-standing')).trim()}]`
      : '';
    await press(page, 'dredge-take');
    return `took a dredge: ${prompt}${standing}`;
  }

  // A card that stopped mid-resolution to ask this player something blocks everything, including
  // the player whose spell it is. Answered before priority is even looked at.
  if (await has(page, 'decide-prompt')) {
    const prompt = await text(page, 'decide-prompt');
    /*
      A question whose answer is a **word** has no cards to light at all.

      An Obelisk of Urd asks for a creature type and a Voice of All asks for a colour, and the
      table draws the options as buttons rather than lighting the board — so a driver that only
      knows how to tap cards finds nothing lit, reports the table as stuck, and is right to: that
      is precisely the check that caught this. First option in the list, which is the order the
      card offers them in and the one a bot would take.
    */
    if (await has(page, 'decide-options')) {
      const words = page.locator('[data-testid^="decide-option-"]');
      const count = await words.count();
      if (count > 0) {
        /*
          Not always the first, for the same reason the play rows are not: a driver that always took
          option one would only ever exercise option one, and would look identical to a table that
          could not offer the others.

          **Extort is what made this matter.** Its question is "Decline" or "Pay {W/B}", with
          Decline first because that is what a bot falls back on — so a driver that always took the
          first word could never once pay an optional cost through the table, which is the whole of
          what that keyword does.
        */
        const pick = Math.floor(Math.random() * count);
        const word = (await textOf(words.nth(pick))).replace(/\s+/g, ' ').trim();
        await tap(words.nth(pick));
        return `chose a word: ${word} — ${prompt.replace(/\s+/g, ' ').slice(0, 90)}`;
      }
    }
    /*
      A question whose answer is a **number** — "Pay how much life?" on a Toxic Deluge — and one
      whose answer is a **target** for something else on the stack — "Point the copy somewhere
      else?" on a Twincast or a Strionic Resonator.

      Both draw buttons rather than lighting the board, exactly as the word question does, and both
      were added to the table before this driver knew them: a pod reported "stuck at Draw" with a
      Resonator's copy waiting to be aimed, which is this check working rather than a table that
      had broken. The largest number and the last target are taken on purpose — the first target is
      **Leave it**, and a driver that always declined would never once exercise the re-aiming.
    */
    if (await has(page, 'decide-numbers')) {
      const numbers = page.locator('[data-testid^="decide-number-"]');
      if ((await numbers.count()) > 0) {
        await tap(numbers.last());
        return `chose a number: ${prompt}`;
      }
    }
    if (await has(page, 'decide-targets')) {
      const targets = page.locator('[data-testid^="decide-target-"]');
      if ((await targets.count()) > 0) {
        await tap(targets.last());
        return `pointed a copy: ${prompt}`;
      }
    }
    /*
      A **player** as part of the answer, which only proliferate asks for (CR 701.27a).

      Every other question at this table is answered with cards, so a driver that only taps lit
      cards would press Confirm on an empty answer and report it as answered — which is exactly
      what it did: a poisoned opponent is the whole point of the keyword and the one candidate with
      no card to light. Seat strips are pressed first, then the lit permanents below, so one answer
      can hold both kinds.
    */
    let chosePlayer = false;
    const seatPicks = page.locator('[data-testid^="target-seat-"]');
    for (let i = 0, seatCount = await seatPicks.count(); i < seatCount; i++) {
      await tap(seatPicks.nth(i));
      chosePlayer = true;
      // An exact count sends itself, and a seat can be the whole of it.
      if (!(await has(page, 'decide-prompt'))) return `chose a player: ${prompt}`;
    }
    const answered = chosePlayer ? 'chose a player' : 'answered';
    // The candidates are lit wherever they are — hand, battlefield, graveyard, or the library,
    // which is the one zone the table draws only while a search is open.
    for (let pick = 0; pick < 4; pick++) {
      const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
      if ((await lit.count()) === 0) break;
      await tap(lit.first());
      // An exact count sends itself; a range needs confirming, and "choose nothing" is an answer.
      if (!(await has(page, 'decide-prompt'))) return `${answered}: ${prompt}`;
      if (await has(page, 'confirm-decision')) {
        await press(page, 'confirm-decision');
        return `${answered}: ${prompt}`;
      }
    }
    if (await has(page, 'confirm-decision')) {
      await press(page, 'confirm-decision');
      return chosePlayer ? `chose a player: ${prompt}` : `answered with nothing: ${prompt}`;
    }
    // Nothing lit and nothing to confirm: the table is asking a question it is not showing an
    // answer to, which stops the game — a defect to report rather than wait out.
    return null;
  }

  // How big is the Fireball? Asked before the targets, so it blocks everything after it.
  if (await has(page, 'x-prompt')) {
    const options = page.locator('[data-testid^="pick-x-"]');
    const count = await options.count();
    if (count > 1) {
      // Not always the largest, which is what the table opens on: an X spell cast for its maximum
      // every time would never exercise the picker, and X=0 is a legal cast worth seeing work.
      await tap(options.nth(Math.floor(Math.random() * count)));
    }
    const label = await text(page, 'confirm-x');
    await press(page, 'confirm-x');
    return `chose ${label}`;
  }

  if (await has(page, 'feed-prompt')) {
    /*
      An ability whose cost is paid with a permanent: the ones that can pay for it are lit.

      The prompt's own words travel back in the label, the way the offered-cast branch does it,
      because what the bar *says* here is a claim worth checking rather than a detail. There are
      three costs behind this one mode now — a creature sacrificed, an unblocked attacker returned
      to hand, and an artifact sacrificed — and the sentence is the only thing on screen that tells
      the player which of the three they are about to do. A run that said "fed a sacrifice outlet"
      could not tell "tap a creature to sacrifice" from the same words over a ninjutsu swap, which
      would be telling the player they are losing a creature they are getting back.
    */
    const said = (await text(page, 'feed-prompt')).replace(/\s+/g, ' ').slice(0, 160);
    const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
    if ((await lit.count()) > 0) {
      await tap(lit.first());
      return `fed a sacrifice outlet: ${said}`;
    }
    await press(page, 'cancel-mode');
    return `backed out of a sacrifice: ${said}`;
  }

  // A triggered ability waiting to be aimed blocks everything, so it is answered first. The board
  // lights its legal targets the same way a spell's does.
  if (await has(page, 'choose-prompt')) {
    /*
      The prompt's own words, carried back with the answer, for the reason the feed prompt's are:
      "aimed a trigger" is true of every trigger in the pool, and a scenario checking that a
      *particular* one was answered through the table can do nothing with it. The words are the
      ability's own description, which is the thing a player reads.
    */
    const words = await textOf(
      page.locator('[data-testid="choose-prompt"] > span').first(),
    ).then((s) => s.replace(/\s+/g, ' ').trim())
      .catch(() => '');
    const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
    if ((await lit.count()) > 0) {
      await tap(lit.first());
      return `aimed a trigger: ${words}`;
    }
    const seatButtons = page.locator('[data-testid^="target-seat-"]');
    if ((await seatButtons.count()) > 0) {
      await tap(seatButtons.first());
      return `aimed a trigger at a player: ${words}`;
    }
    /*
      Declining, for a trigger whose targets are optional — "up to one target artifact creature"
      (CR 702.43b) is legal with none, so a board with nothing to point at still has an answer.

      Checked after the lit cards rather than before them, because declining a trigger that *could*
      hit something is a worse play than taking it, and this driver takes the simplest legal move
      rather than the cleverest. It is only ever pressed when there was nothing lit at all.
    */
    if (await has(page, 'confirm-choice')) {
      await press(page, 'confirm-choice');
      return `declined an optional trigger: ${words}`;
    }
    // Nothing lit anywhere and nothing to decline: the table is asking for a target it is not
    // showing, which is a defect in the table rather than something to wait out.
    return null;
  }

  // A declaration in progress is finished first — it is blocking everything else.
  if (await has(page, 'target-prompt')) {
    // A spell on the stack is a row in the stack panel rather than a card face, because an ability
    // waiting to resolve has no card at all. It is the first thing looked for: a counterspell with
    // a legal target should always take it.
    const onStack = page.locator('[data-testid^="target-stack-"]');
    if ((await onStack.count()) > 0) {
      await tap(onStack.first());
      return 'countered something on the stack';
    }
    // Otherwise the first legal target: a lit card, or the opponent.
    const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
    if ((await lit.count()) > 0) {
      await tap(lit.first());
      return 'picked a card as a target';
    }
    const seatButtons = page.locator('[data-testid^="target-seat-"]');
    if ((await seatButtons.count()) > 0) {
      // Prefer the opponent's seat over your own.
      const theirs = page.locator(`[data-testid^="target-seat-"]:not([data-testid="target-seat-${seat}"])`);
      await tap((await theirs.count()) > 0 ? theirs.first() : seatButtons.first());
      return 'picked a player as a target';
    }
    await press(page, 'cancel-mode');
    return 'cancelled an untargetable spell';
  }

  if (await has(page, 'attack-prompt')) {
    // Attack with everything the engine is offering, which it marks by making them tappable.
    //
    // In a pod the prompt also offers who to attack, and each creature is aimed before it is
    // tapped — at random, because the thing being tested is that the table can send attacks in
    // different directions at once. With two players there is nothing to choose and this does
    // nothing at all.
    // Players *and* planeswalkers: an attack can be aimed at either (CR 506.2), and the suites
    // only ever exercise what the driver is willing to click.
    const aims = page.locator('[data-testid^="attack-seat-"], [data-testid^="attack-walker-"]');
    const seats = await aims.count();
    const mine = cardsIn(page, `zone-battlefield-${seat}`);
    const count = await mine.count();
    for (let i = 0; i < count; i++) {
      if (seats > 1) {
        await tap(aims.nth(Math.floor(Math.random() * seats)));
      }
      await tap(mine.nth(i));
    }
    /*
      How many actually went, which matters to whoever reads this back.

      Every creature in the row is tapped, and the ones the engine did not light do nothing — so a
      declare-attackers step with nothing able to attack still ends in a confirm, and used to
      report the same "declared attackers" as a real swing. The arena suite demands an attack arrow
      whenever that string comes back, and an empty declaration cannot draw one: a check that can
      only fail, waiting three seconds to do it. The prompt counts them out loud ("3 attacking"),
      so the driver reads the number rather than inventing one.
    */
    const prompt = await text(page, 'attack-prompt');
    const chosen = Number.parseInt(/(\d+) attacking/.exec(prompt)?.[1] ?? '0', 10);
    await press(page, 'confirm-attackers');
    return chosen > 0 ? `declared ${chosen} attackers` : 'declared no attackers';
  }

  if (await has(page, 'block-prompt')) {
    /*
      Pick up each of your creatures in turn and put it on whichever attacker lights up, which is
      the table telling you what that creature may legally block. A real player would think about
      the trade; the point here is that the pairing flow produces a declaration the engine accepts.

      Two blockers rather than one, when there are two. One was enough to prove the pairing worked
      and left two whole rules unreached by any browser: ganging up on an attacker, and the damage
      assignment order it then asks the *attacking* player for (CR 509.2). A suite that never
      double-blocks never sees either.
    */
    const mine = cardsIn(page, `zone-battlefield-${seat}`);
    const count = await mine.count();
    let placed = 0;
    for (let i = 0; i < count && placed < 2; i++) {
      await tap(mine.nth(i));
      const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
      if ((await lit.count()) === 0) continue;
      await tap(lit.first());
      placed += 1;
    }
    await press(page, 'confirm-blockers');
    return placed > 1 ? 'declared blockers, two on one' : 'declared blockers';
  }

  if (await has(page, 'order-prompt')) {
    /*
      Reached about one solo-pod run in three: the bots gang up on an attacker (D88) and the player
      is then asked which of the blockers the damage goes to first.

      The damage assignment order (CR 509.2), which is the attacking player's.

      The blockers are on somebody *else's* side of the board, and the engine only asks when the
      order can change which of them die — so the driver taps every card on every battlefield and
      lets the reducer keep the ones that belong to an order it was asked about. The confirm button
      stays disabled until every owed order is complete, which is what makes "tap everything" a
      legal answer rather than a guess.
    */
    const rows = page.locator('[data-testid^="zone-battlefield-"]');
    const rowCount = await rows.count();
    for (let r = 0; r < rowCount; r++) {
      const cards = rows.nth(r).locator('[data-testid^="card-"]');
      const count = await cards.count();
      for (let i = 0; i < count; i++) await tap(cards.nth(i));
    }
    await press(page, 'confirm-order');
    return 'assigned combat damage';
  }

  if (await has(page, 'discard-prompt')) {
    await tap(cardsIn(page, `zone-hand-${seat}`).first());
    return 'discarded to hand size';
  }

  /*
    A free cast on offer, taken rather than declined (CR 702.85a).

    The table is stopped, nobody holds priority, and this is the only move there is — so it is
    taken rather than declined, on the same reasoning as the ward above: a driver that always
    declined would never once cast a spell for nothing, and the engine's own tests cover the
    decline. Declining is the fallback, for a hit with no legal target.

    **Below every prompt that is this browser's own half-finished interaction**, which is where the
    first version of this got it wrong. A cascade into an Aura opens the targeting prompt while the
    offer is still on the table, so a branch placed above `target-prompt` pressed "Cast it" again
    instead of choosing what to enchant — forty moves of a Bloodbraid Elf cascading into the same
    Rancor, which is what the browser suite is for.
  */
  if (await has(page, 'offered-cast-prompt')) {
    const prompt = await text(page, 'offered-cast-prompt');
    /*
      Shot once, before the answer, because the thing worth a picture is the offer: the sentence
      naming what cascaded into what, beside a card in exile with a Cast row on it.

      Once per run rather than once per cascade. A deck built to cascade offers several a game and
      the first version wrote one file each — seventy-six of them in a run, all of the same bar.
    */
    if (!shotAnOffer) {
      shotAnOffer = true;
      await shot(page, 'a-cast-on-offer');
    }
    /*
      The button first, the card second.

      The bar offers "Cast it" whenever there is exactly one way to cast the hit, which is the
      common case and the one a person would press. The exile row is the fallback and the only path
      for a hit with modes or halves, where the bar deliberately offers no menu of its own.
    */
    /*
      The whole sentence, near enough: the keyword that made the offer is the **last** word of it.

      It used to be cut at eighty characters, which reads fine in a log and threw away the one word
      a scenario matches on — "Thunderous Wrath is the first card you drew this turn: you may cast
      it for {R} (miracle)" is 88 characters, so `LIST=miracle` counted none of its own offers.
    */
    const said = prompt.replace(/\s+/g, ' ').slice(0, 160);
    if (await has(page, 'offered-cast-take')) {
      await press(page, 'offered-cast-take');
      return `took a free cast: ${said}`;
    }
    /*
      The card itself, for a hit with modes or halves that the bar will not choose between.
      Exile first because that is where cascade and madness put it, then the hand, which is where
      **miracle** leaves it: the offer is made on a card that was just drawn and never moved.
    */
    const played = (await tryToPlayFromZone(page, `zone-exile-${seat}`))
      ?? (await tryToPlayFromZone(page, `zone-hand-${seat}`));
    if (played !== null) return `took a free cast: ${said}`;
    /*
      And declining, which is the fallback — when there is one to press.

      A **suspended** card's cast cannot be declined (CR 702.62c), so the bar draws no Decline for
      it and this branch would be looking for a button that is deliberately not there. Reported
      rather than pressed blindly, because a run that reaches here on a mandatory offer has found
      something real: a cast the table cannot make and cannot refuse.
    */
    if (!(await has(page, 'offered-cast-decline'))) return `could not answer an offer: ${said}`;
    await press(page, 'offered-cast-decline');
    return `declined a free cast: ${said}`;
  }


  /*
    Nothing to do after all.

    Not a defect, and reporting it as one was wrong: between "is it this page's move" and here,
    another player can act and take the move away — which in a pod, where four browsers are
    reading the same table, happens on its own. Caught exactly that way: "Nick stuck at Declare
    blockers on turn 33" in a game that then carried on and finished normally.

    A prompt that genuinely cannot be answered still returns null, from the branches above that
    find a question with nothing lit and nothing to confirm. A table that has actually stopped
    shows up in the callers' own idle and repeat detectors, which say so more accurately than a
    single missing button can.
  */
  if (!(await has(page, 'primary-move'))) return 'the moment passed';

  const label = await text(page, 'primary-move');

  // Responding is the whole point of holding an instant, and it is the only way a counterspell
  // ever gets cast — so a chance to respond is taken more often than a chance to develop. The
  // engine decides what is castable in either case; this only decides whether to look.
  const responding = /^Resolve/.test(label);
  const develop = /^Pass$/.test(label) && Math.random() < aggression;
  if (responding || develop) {
    const played = await tryToPlayFromHand(page, seat, abilities);
    if (played !== null) return played;
  }
  await press(page, 'primary-move');
  return `primary: ${label}`;
}

/**
 * Records what a prompt on screen proves the engine can do.
 *
 * Shared by both play loops on purpose. It used to live only in the first one, and most of a game
 * is played in the *finishing* loop — so a modal spell cast after the first loop stopped was never
 * seen, and three whole arena runs reported "no modal spell was castable" while three Charms sat in
 * the deck. An observation that watches only the first half of a game is worse than none, because
 * it reads as a fact about the whole game.
 */
export async function notePrompts(seen, page, seat) {
  if (await has(page, 'x-prompt')) seen.x = true;
  // Combat drawn on the board rather than described beside it: an arrow from each attacker to the
  // player it is aimed at. Looked for here because this runs on whichever page is acting, and in
  // a pod the defender is as likely to be the one looking at it as the attacker.
  if (seen.arrows !== true && (await page.locator('[data-testid^="arrow-a-"]').count()) > 0) {
    seen.arrows = true;
    await shot(page, 'combat-arrows');
  }
  /*
    A spell that divides a quantity among its targets (CR 601.2d).

    The prompt counts down what is left to spend, and that readout is the only thing on screen that
    proves a division can be built a tap at a time — the engine's own tests build one by hand, so
    they cannot tell whether the board can be asked for one.
  */
  if (seen.divided !== true && (await has(page, 'divide-left'))) {
    seen.divided = true;
    await shot(page, 'dividing-damage');
  }
  if (await has(page, 'decide-prompt')) {
    seen.decided = true;
    // A question whose answer is a word, screenshotted the once: the options are the only thing on
    // screen that answers it, so a run where this never appears is a run that never proved the
    // buttons are there.
    if (seen.chose !== true && (await has(page, 'decide-options'))) {
      seen.chose = true;
      await shot(page, 'choosing-a-word');
    }
    if (await has(page, `zone-scry-${seat}`)) {
      if (!seen.scried) await shot(page, 'scrying');
      seen.scried = true;
    }
    if (await has(page, `zone-library-${seat}`)) {
      if (!seen.searched) await shot(page, 'searching-a-library');
      seen.searched = true;
    }
  }
}

/** Records what the move just made proves. `did` is whatever `makeMove` reported. */
export async function noteMove(seen, page, did) {
  if (did === null) return;
  /*
    The attack arrows, sampled the one moment they are certainly on screen.

    `notePrompts` also looks for them, but only when some page is being asked for something — and a
    defender with no legal block is never asked, so the engine can be through combat and into the
    next turn before anybody looks. That is a sampled observation reported as a fact about the
    game, which is how a run came back saying no attack was ever drawn in a game full of attacks.
  */
  // A spell cast out of a graveyard, which is the one play on the table that is not in the hand or
  // on the board. Sampled rather than required: it needs the card drawn, cast, and the mana for
  // the second casting, which is a game the shuffle has to produce.
  if (/from your graveyard/.test(did) && seen.flashback !== true) {
    seen.flashback = true;
    await shot(page, 'cast-out-of-the-graveyard');
  }
  // A ward paid, which is the one prompt in the game that belongs to the player who did *not*
  // stop the table. Sampled for the same reason flashback is: it needs the warded creature on the
  // board and an opponent with something that targets it.
  if (/^paid a ward/.test(did) && seen.ward !== true) seen.ward = true;
  /*
    A spell cast for nothing, which is the one play on the table with no cost at all.

    Sampled like flashback and the ward: it needs a cascade card drawn, cast, and a cheap enough
    nonland card on top of the library — a game the shuffle has to produce. The cascade scenario in
    the solo suite stacks a deck that produces it nearly every game, and `LIST=cascade` is what
    turns the sample into a requirement.
  */
  if (/^(took|declined) a free cast/.test(did) && seen.freeCast !== true) seen.freeCast = true;
  /*
    The damage assignment order (CR 509.2), which only happens when a creature is blocked by two or
    more — so it is a *sampled* observation and not something a run can be required to see.
    Recorded when it happens and reported only then, which is how the scry and the library search
    are handled: a check that can fail for a board the game never built is a check that says
    nothing about the code.
  */
  if (did === 'assigned combat damage') {
    if (seen.ordered !== true) await shot(page, 'assigning-combat-damage');
    seen.ordered = true;
  }
  /*
    A **non-empty** attack, which is not the same as a declaration, and not the same as an attack
    anybody could have seen.

    `declared 0 attackers` is a real and frequent answer — every turn where the only creatures on
    the board are summoning-sick — and it used to set `seen.swung`, which made the arena suite's
    arrow check unguardable: the suite asks for an arrow "only when a creature actually attacked"
    and this said one had. It failed on a game whose single declaration was empty, three runs after
    a deck change moved the shuffle, and the game it failed on was fine. One character class.

    **And a non-empty declaration still is not enough**, which is the second time this flag has
    been too generous. With auto-pass on, declaring attackers against a defender with no legal
    block runs the whole of combat inside one applied action: blockers, damage, end of combat. The
    browser renders the board *after* that, so there is no moment at which an arrow exists to be
    found — and the check then cannot pass however patient it is. So the flag is set from what was
    observable rather than from what was declared: the arrow was seen, or the table is still
    sitting in a combat step where it should have been. A declaration that ran past combat in one
    action is counted separately and reported, like every other sampled observation here.
  */
  if (/^declared [1-9]\d* attackers$/.test(did) && seen.arrows !== true) {
    /*
      Waited for, briefly, rather than read the instant the action returns.

      The overlay measures the board from the DOM, so an arrow appears a render *after* the view
      carrying the attack: React renders the new board, an effect measures where the cards landed,
      and that measurement is what draws the line. Reading immediately is a race.

      It used to be a race this always won, for a bad reason. `CombatArrows` re-measured on every
      render and set state each time, which was an infinite render loop (see D73) — so the arrow
      was being redrawn continuously and was always there a moment later. Fixing the loop made the
      overlay measure once, which is correct, and turned this line into a coin flip: it passed four
      runs and then failed one. Patience is what the claim actually needs: a second was not enough
      on a machine running another suite beside this one — which is a fact about the box, not about
      the overlay — so it waits three.
    */
    for (let i = 0; i < 20 && seen.arrows !== true; i += 1) {
      if ((await page.locator('[data-testid^="arrow-a-"]').count()) > 0) {
        seen.arrows = true;
        await shot(page, 'combat-arrows');
        break;
      }
      await page.waitForTimeout(150);
    }
    if (seen.arrows === true) {
      seen.swung = true;
    } else {
      const label = (await page.locator('[data-testid="step-label"]').first().textContent()) ?? '';
      if (/attack|block|damage|combat/i.test(label)) seen.swung = true;
      else seen.swungPastCombat = (seen.swungPastCombat ?? 0) + 1;
    }
  }
  if (/^chose X = \d+$/.test(did)) seen.xCast = did;
  // A modal spell's play is labelled "Cast X — <the mode>", the only play label with an em dash.
  if (/chose a play: Cast .+ — /.test(did)) {
    if (!seen.modal) await shot(page, 'casting-a-mode');
    seen.modal = true;
  }
}

/**
 * Taps a card in hand the table says is playable and takes one of the plays it offers.
 *
 * "Playable" is the table's own badge, which comes from `legalActions` — so this never tries a
 * card the engine would refuse, and a spell that cannot be cast right now (a sorcery in response,
 * something unaffordable) simply does not carry the badge.
 *
 * The card is chosen at random from the playable ones rather than left to right. Left to right
 * means the leftmost playable card every single time, which is almost always a land or the
 * cheapest creature — so a card further along in hand could sit there for a whole game and never
 * be cast. That is not a theoretical worry: it is why two full arena runs cast no modal spell at
 * all while three copies of a Charm sat in the deck.
 */
export async function tryToPlayFromHand(page, seat, abilities = false) {
  /*
    The hand first, then the graveyard, which is the second zone a spell can be cast from.

    Flashback made the graveyard a row with plays in it, and a driver that only ever tapped the
    hand would have left the whole mechanic unexercised in a browser — the engine's own suite would
    pass and the thing a player does would never have been done. Both rows mark a castable card
    the same way ("playable"), so the same badge-driven loop works on either.
  */
  return (await tryToPlayFromZone(page, `zone-hand-${seat}`))
    ?? (await tryToPlayFromZone(page, `zone-graveyard-${seat}`))
    /*
      And exile, which is the third. A foretold card, a creature back from its adventure and a
      cascade hit all wait there, and all three are marked playable the same way — so a driver
      that stopped at the graveyard left every card in the pool that is cast from exile
      unexercised in a browser.
    */
    ?? (await tryToPlayFromZone(page, `zone-exile-${seat}`))
    /*
      And the battlefield, which is where every **activated ability** lives — only when the caller
      asks for it.

      This is the one zone no browser suite had ever played from: no run had pressed an equip, a
      crew, a monstrosity, a regenerate or a Contagion Clasp's proliferate, because the board did
      not badge a permanent as playable and this loop only taps what carries the badge.

      Off by default, and the cascade scenario is why. The first version tried the board for every
      caller and `LIST=cascade` immediately stopped casting Bloodbraid Elves: that deck has three
      River Boas, a tap on one regenerates it for {G}, and a Forest spent on a shield nobody needed
      is a Forest the four-mana Elf wanted. Pressing an arbitrary ability is not "the simplest legal
      thing" — it is a *scenario*, so the scenario asks for it.
    */
    ?? (abilities ? await tryToPlayFromZone(page, `zone-battlefield-${seat}`) : null);
}

/**
 * Taps the first card in one zone that says it is playable, and takes one of its plays.
 *
 * **The badge is read off the slot and the tap lands on the card inside it**, which is two
 * locators where it used to be one, and the split is the whole point. A card's badges are drawn on
 * its *slot* — the wrapper that is portrait normally and landscape when the permanent is tapped —
 * rather than inside the card itself, because a card turns a quarter turn when it taps and
 * anything inside it turns with it: badges nested in the card rendered "1/2 ATTACKING FRIEND"
 * running up the side.
 *
 * That move broke this loop, and the failure is worth recording because it looked like anything
 * but a CSS change. This read `textContent` of the **card** and matched /playable/, so the moment
 * the badge left the card every card in every zone read as unplayable, the driver fell through to
 * `primary-move` on every turn, and a whole arena run played twenty turns of nothing but Pass and
 * discard-to-hand-size. Four end-of-run assertions failed — a land reaching the battlefield, the
 * mana bar, attackers being declared, life moving — and not one of them named a badge.
 *
 * So the coupling is explicit now rather than accidental: the slot carries what the card *says*,
 * the card is what you press.
 */
async function tryToPlayFromZone(page, zone) {
  const slots = page.locator(`[data-testid="${zone}"] [data-testid^="slot-"]`);
  const count = await slots.count();
  const order = [...Array(count).keys()].sort(() => Math.random() - 0.5);
  for (const i of order) {
    const slot = slots.nth(i);
    const badges = await textOf(slot);
    if (!/playable/i.test(badges)) continue;
    const card = slot.locator('[data-testid^="card-"]').first();
    await tap(card);
    /*
      The sheet may not open, and that is not a failure.

      The tap can land on a card the table has just re-rendered away — a creature that died, a
      hand that shrank — and the whole run used to end there with "timed out waiting for
      play-sheet" on a game that was going fine. A card that cannot be opened is a card this move
      does not play.
    */
    if ((await waitFor(page, 'play-sheet', 2500).then(() => true, () => false)) === false) return null;
    const options = page.locator('[data-testid^="play-"]:not([data-testid="play-sheet"]):not([data-testid="play-sheet-close"])');
    const choices = await options.count();
    if (choices > 0) {
      // Not always the first. A modal spell is one play per mode and a permanent can have several
      // abilities, so a driver that always took the top option would only ever exercise mode one
      // — and would look identical to a table that could not offer the others.
      const pick = options.nth(Math.floor(Math.random() * choices));
      const name = await textOf(pick);
      await tap(pick);
      return `chose a play: ${name.replace(/\s+/g, ' ').slice(0, 70)}`;
    }
    await press(page, 'play-sheet-close');
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
