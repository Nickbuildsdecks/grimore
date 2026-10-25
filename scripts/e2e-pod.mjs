/**
 * Four browsers, one game of Commander.
 *
 * The pod sibling of `e2e-arena.mjs`, and the acceptance test for the format the product is named
 * after. The engine has played thousands of pods in `playout.test.ts` and the server has seated
 * four since it shipped, but every browser suite here opened two contexts — so the four-player
 * *interface* had been reasoned about and never looked at. That gap is where the two bugs this
 * suite was written to catch were living: a commander that never said it was castable, and an
 * attack that could only ever be aimed at the lowest-numbered opponent.
 *
 * What it asserts, beyond "the game finishes":
 *
 *   - four seats join one table on one code, at 40 life, each with its commander in the command zone
 *   - every seat is asked for an opening hand at the same time
 *   - one player's table hides all three opponents' hands, not just the one next to them
 *   - a commander is cast *from the command zone* through the real UI, and the table says it can be
 *   - an attack can be sent at a chosen opponent, and two attacks at two different ones
 *   - a deal is offered, read, accepted and shown on both tables, and binds nothing
 *   - commander damage is shown as the engine's count, with no button to contradict it
 *   - a player who concedes is marked out and the other three play on
 *   - the game reaches one survivor, and all four are told
 *   - four seats fit a phone
 *
 * Run it yourself (the launcher starts both servers):
 *   PLAY_HOST=127.0.0.1 node scripts/play.mjs &
 *   node scripts/e2e-pod.mjs
 *
 * Screenshots land in SHOT_DIR (default ./e2e-shots/pod), so a failure can be looked at.
 */
import path from 'node:path';
import {
  chromium, check, setShotDir, summarize, shot, waitFor, tid, cardsIn, has, text, textOf, tap,
  press, readNumber, expectEventually, isMyMove, makeMove, notePrompts, noteMove,
  watchForReactWarnings,
} from './lib/table-driver.mjs';

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'pod');
const HEADED = process.env.HEADED === '1';
/**
 * How many clicks the four players get between them.
 *
 * Larger than the two-player budget, and not by a little: a pod is four turns to the round, three
 * opponents to kill, and 40 life each. The engine's own pods run 60–90 turns.
 */
const MAX_MOVES = Number.parseInt(process.env.MAX_MOVES ?? '2400', 10);
/** One deck each, in seat order. Four different decks is the interesting case. */
const DECKS = (process.env.DECKS ?? 'ember-rush,verdant-guard,tidal-mind,rot-harvest').split(',');
/** Who sits down. The first is the host. */
const NAMES = ['Nick', 'Ana', 'Boris', 'Cleo'];

async function main() {
  await setShotDir(SHOT_DIR);
  const browser = await chromium.launch({ headless: !HEADED });
  const pageErrors = [];
  const reactWarnings = [];
  const badRequests = [];
  const EXPECTED_FAILURES = [/\/api\//, /\/logo\.svg/];

  /** One browser context each, because a seat is held per browser, not per tab. */
  const players = [];
  for (let seat = 0; seat < 4; seat++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    const who = NAMES[seat];
    page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
    watchForReactWarnings(page, who, reactWarnings);
    page.on('response', (res) => {
      if (res.status() < 400) return;
      if (EXPECTED_FAILURES.some((re) => re.test(res.url()))) return;
      badRequests.push(`${who}: ${res.status()} ${res.url()}`);
    });
    players.push({ page, seat, who });
  }
  const host = players[0];

  try {
    // ── Four people sit down at one table ───────────────────────────────────────────────────────
    await host.page.goto(BASE);
    await waitFor(host.page, 'lobby');
    await tid(host.page, 'player-name').fill(host.who);
    await tid(host.page, 'format-commander').click();
    await tid(host.page, 'create-table').click();
    await waitFor(host.page, 'pregame');
    const code = (await tid(host.page, 'table-code').textContent())?.trim() ?? '';

    for (const p of players.slice(1)) {
      await p.page.goto(BASE);
      await waitFor(p.page, 'lobby');
      await tid(p.page, 'player-name').fill(p.who);
      await tid(p.page, 'join-code').fill(code);
      await tid(p.page, 'join-table').click();
      await waitFor(p.page, 'pregame');
    }
    await expectEventually(host.page, 'four players join one table on one code', async () =>
      (await host.page.locator('[data-testid^="lobby-seat-"]').count()) === 4);
    await shot(host.page, 'four-seats');

    for (const p of players) await tid(p.page, 'ready').click();
    await waitFor(host.page, `deck-${DECKS[0]}`);
    for (const p of players) await tid(p.page, `deck-${DECKS[p.seat]}`).click();

    // ── Hand the pod to the rules engine ────────────────────────────────────────────────────────
    await expectEventually(host.page, 'the host is offered a pod run by the rules engine', async () =>
      (await has(host.page, 'start-engine')) && (await tid(host.page, 'start-engine').isEnabled()));
    await tid(host.page, 'start-engine').click();
    for (const p of players) await waitFor(p.page, 'table');

    // Every seat decides its opening hand at once — nobody holds priority yet (CR 103.4).
    for (const p of players) {
      await expectEventually(p.page, `${p.who} is asked for an opening hand`, async () =>
        (await has(p.page, 'phase-bar')) && (await has(p.page, 'mulligan-prompt')));
    }
    await shot(host.page, 'four-opening-hands');

    // ── A Commander table, not a duel with extra chairs ─────────────────────────────────────────
    await expectEventually(host.page, 'all four seats start at 40 life', async () => {
      const lives = [];
      for (let s = 0; s < 4; s++) lives.push(await readNumber(host.page, `life-${s}`));
      return lives.every((l) => l === 40) ? true : JSON.stringify(lives);
    });
    await expectEventually(host.page, 'every seat has a commander in the command zone', async () => {
      const counts = [];
      for (let s = 0; s < 4; s++) counts.push(await cardsIn(host.page, `zone-command-${s}`).count());
      return counts.every((c) => c === 1) ? true : JSON.stringify(counts);
    });
    // The command zone is public, so the host can read all four commanders by name — which is the
    // one zone where that is correct, and worth asserting next to the hidden-hand claim below.
    const commanders = [];
    for (let s = 0; s < 4; s++) {
      const name = await cardsIn(host.page, `zone-command-${s}`).first().getAttribute('data-card-name');
      commanders.push(name ?? '');
    }
    check('and each commander is named on the table for everybody', commanders.every((n) => n.length > 0),
      JSON.stringify(commanders));

    // ── Hidden information holds against three opponents, not one ───────────────────────────────
    const seen3 = [];
    for (const other of [1, 2, 3]) {
      const cards = await cardsIn(host.page, `zone-hand-${other}`).evaluateAll((els) =>
        els.map((e) => ({ hidden: e.getAttribute('data-hidden'), name: e.getAttribute('data-card-name') })));
      seen3.push({ other, count: cards.length, leaked: cards.filter((c) => c.hidden !== 'true' || c.name) });
    }
    check(
      'one player’s table hides all three opponents’ hands',
      seen3.every((s) => s.count >= 4 && s.leaked.length === 0),
      JSON.stringify(seen3).slice(0, 200),
    );

    // Settle all four hands before the first turn begins.
    for (const p of players) {
      for (let i = 0; i < 8 && (await isMyMove(p.page)); i++) {
        if (!(await has(p.page, 'mulligan-prompt')) && !(await has(p.page, 'bottom-prompt'))) break;
        await makeMove(p.page, p.seat);
        await p.page.waitForTimeout(150);
      }
    }
    await expectEventually(host.page, 'the first turn begins once all four hands are settled', async () => {
      for (const p of players) if (await has(p.page, 'mulligan-prompt')) return false;
      return has(host.page, 'step-label');
    }, 20000);

    /*
      ── A deal, struck through the real UI ──────────────────────────────────────────────────────

      Done here, before a single turn has been played, because it is the one thing at this table
      that needs no board: two players agreeing to leave each other alone is available from the
      moment everybody is seated. Driven by hand rather than left to `makeMove` for the same
      reason the attack spread is — nothing the driver does would ever think to offer a deal.

      The claim is the whole round trip: the host offers, the deal reaches the other player in the
      words the log will use, they accept, and *both* tables show it. A pact that one of the two
      players could not see would be worse than no pact at all.
    */
    const partner = players[1];
    await press(host.page, 'open-deals');
    await waitFor(host.page, 'pact-sheet');
    await shot(host.page, 'offering-a-deal');
    check('the table offers a deal to each opponent by name',
      (await host.page.locator('[data-testid^="offer-"]').count()) >= 3);
    await press(host.page, `offer-${partner.seat}-truce-until-your-turn`);
    await expectEventually(partner.page, 'the deal reaches the other player, in words', async () => {
      if (!(await has(partner.page, 'pact-prompt'))) return false;
      const words = await text(partner.page, 'pact-prompt');
      return /will not attack each other/.test(words) ? true : words;
    });
    await shot(partner.page, 'a-deal-on-the-table');
    await press(partner.page, 'pact-accept');
    await expectEventually(host.page, 'and once it is accepted both tables say so', async () => {
      const mine = await has(host.page, `pact-${partner.seat}`);
      const theirs = await has(partner.page, `pact-${host.seat}`);
      if (!mine || !theirs) return JSON.stringify({ mine, theirs });
      return /truce/.test(await text(host.page, `pact-${partner.seat}`));
    });
    await shot(host.page, 'a-deal-nobody-is-enforcing');
    // And nothing is enforced: the table never refuses an attack because of it, which the attack
    // spread below would catch, and the engine's own suite asserts case by case.

    // ── Play it out ─────────────────────────────────────────────────────────────────────────────
    const seen = {
      land: false, stack: false, attackers: false, blockers: false, lifeChanged: false,
      decided: false, searched: false, scried: false, arrows: false, swung: false, modal: false, turnsPassed: 0, x: false, xCast: null,
      /** A commander cast through the UI from the command zone. */
      commanderCast: false,
      /** A commander that died and was back in its command zone afterwards (CR 903.9). */
      commanderReturned: false,
      /** Attacks aimed at more than one seat over the game. */
      attackedSeats: new Set(),
      /** A seat marked out while the rest kept playing. */
      eliminated: false,
      playedOnAfterElimination: false,
      commanderBadge: false,
      /** The defender buttons' own text, which is the threat read a pod turn is decided on. */
      attackReads: [],
      /** Whether "all at them" was pressed, and whether every attack landed on one player. */
      allAtTried: false,
      allAtWorked: false,
    };
    let lastTurn = await readNumber(host.page, 'turn');
    let moves = 0;
    let finished = false;
    let idle = 0;

    while (moves < MAX_MOVES) {
      if (await has(host.page, 'game-over')) {
        finished = true;
        break;
      }
      // Whoever is being asked for something. In a pod that can be several players at once —
      // several defenders each owe a block — so they are all offered a move each pass.
      const actors = [];
      for (const p of players) if (await isMyMove(p.page)) actors.push(p);
      if (actors.length === 0) {
        idle += 1;
        if (idle > 80) break;
        await host.page.waitForTimeout(200);
        moves += 1;
        continue;
      }
      idle = 0;

      for (const actor of actors) {
        if (await has(actor.page, 'attack-prompt')) {
          seen.attackers = true;
          // Who this declaration can be sent at, which is the thing that did not exist before.
          const seats = actor.page.locator('[data-testid^="attack-seat-"]');
          const aims = await seats.count();
          if (aims > 1 && !seen.aimShot) {
            seen.aimShot = true;
            await shot(actor.page, 'choosing-who-to-attack');
          }
          /*
            What each of those buttons says about the player behind it.

            The threat read is the whole pod decision — their life, and what they have left to
            block with — and it is only worth anything if it is on the button that sends you
            there. Collected rather than asserted here, because a seat whose life has not moved
            and whose board is empty is a legitimately sparse read.
          */
          if (aims > 0 && seen.attackReads.length < 6) {
            seen.attackReads.push(...(await seats.evaluateAll((els) =>
              els.map((e) => (e.textContent ?? '').trim()))));
          }
          /*
            "All at them", once in the run, driven by hand.

            Two creatures tapped at two different players, then one press, and every attack should
            be on one of them. Done here and not in `makeMove` because the driver deliberately
            scatters its attacks — the spread is a property this suite checks — so proving the
            opposite needs its own turn, and this takes exactly one.
          */
          const mine = cardsIn(actor.page, `zone-battlefield-${actor.seat}`);
          if (!seen.allAtTried && aims > 1 && (await mine.count()) >= 2) {
            await tap(seats.nth(0));
            await tap(mine.nth(0));
            await tap(seats.nth(1));
            await tap(mine.nth(1));
            // The button only exists once two creatures are actually attacking, and the two taps
            // above may have landed on a land or a creature the engine will not let attack. So the
            // claim is made only when the situation was reached, and a turn where it was not is
            // simply tried again on the next declaration rather than failing.
            if (await has(actor.page, 'aim-all')) {
              seen.allAtTried = true;
              await press(actor.page, 'aim-all');
              const after = await seats.evaluateAll((els) =>
                els.map((e) => (e.textContent ?? '').trim()));
              // One button carries the whole swing, and no other carries any of it. The count is
              // the trailing "· N" the button appends for the attacks aimed at it.
              const counts = after.map((t) => {
                const m = /·\s*(\d+)(?:\s*·\s*lethal)?$/.exec(t);
                return m === null ? 0 : Number.parseInt(m[1], 10);
              });
              seen.allAtWorked = counts.filter((n) => n > 0).length === 1
                && Math.max(...counts) >= 2;
              await shot(actor.page, 'all-at-one-player');
            }
            await press(actor.page, 'confirm-attackers');
            moves += 1;
            continue;
          }
        }
        if (await has(actor.page, 'block-prompt')) seen.blockers = true;
        await notePrompts(seen, actor.page, actor.seat);

        // A commander is cast from the command zone, which no other card in the game is, and
        // which `makeMove` never tries because it only ever looks at the hand.
        if (!seen.commanderCast && (await has(actor.page, 'primary-move'))
          && /^Pass$/.test(await text(actor.page, 'primary-move'))) {
          const cast = await tryCommander(actor.page, actor.seat, seen);
          if (cast) {
            moves += 1;
            continue;
          }
        }

        const did = await makeMove(actor.page, actor.seat, { aggression: 0.8 });
        moves += 1;
        await noteMove(seen, actor.page, did);
        if (did !== null && moves % 25 === 0) console.log(`      move ${moves}: ${actor.who} ${did}`);
        if (did === null) {
          check('every prompt the table shows can be answered', false,
            `${actor.who} stuck at ${await text(actor.page, 'step-label')} on turn ${await readNumber(host.page, 'turn')}`);
          moves = MAX_MOVES;
          break;
        }
        await actor.page.waitForTimeout(40);
      }

      // ── What the board says happened ──────────────────────────────────────────────────────────
      // Who is being attacked, read off the board the way a player reads it: an attacking creature
      // carries a badge naming its defender. That badge is also the thing being tested — before it
      // existed nothing on the table said which of three opponents a creature was attacking.
      for (const badge of await host.page.locator('[data-testid^="card-"]').evaluateAll((els) =>
        els.map((e) => /attacking ([^\n]+)/.exec(e.textContent ?? '')?.[1] ?? ''))) {
        if (badge !== '') seen.attackedSeats.add(badge.trim());
      }
      if (!seen.land && (await cardsIn(host.page, 'zone-battlefield-0').count()) > 0) seen.land = true;
      if (!seen.stack && (await host.page.locator('[data-testid^="stack-"]').count()) > 0) seen.stack = true;
      if (!seen.lifeChanged) {
        for (let s = 0; s < 4; s++) {
          if ((await readNumber(host.page, `life-${s}`)) !== 40) {
            seen.lifeChanged = true;
            break;
          }
        }
      }
      // A commander back in its command zone after its owner cast it (CR 903.9). All a browser can
      // see of that rule is the zone emptying and filling again, so that is what is watched: the
      // casting seat's command zone has to go empty first, or an uncast commander sitting there
      // would read as a return.
      if (seen.commanderCast && !seen.commanderReturned && seen.castBySeat !== undefined) {
        const held = await cardsIn(host.page, `zone-command-${seen.castBySeat}`).count();
        if (held === 0) seen.commandZoneEmptied = true;
        else if (seen.commandZoneEmptied === true) {
          seen.commanderReturned = true;
          await shot(host.page, 'commander-back-in-the-command-zone');
        }
      }
      if (!seen.eliminated) {
        for (let s = 0; s < 4; s++) {
          if (/out \(/.test(await text(host.page, `seat-${s}`))) {
            seen.eliminated = true;
            seen.eliminatedAt = await readNumber(host.page, 'turn');
            await shot(host.page, 'a-seat-is-out');
            break;
          }
        }
      }
      const turn = await readNumber(host.page, 'turn');
      if (turn > lastTurn) {
        seen.turnsPassed += turn - lastTurn;
        lastTurn = turn;
        if (seen.eliminated && !(await has(host.page, 'game-over'))) seen.playedOnAfterElimination = true;
      }
    }

    console.log(`      played ${moves} moves over ${seen.turnsPassed} turn changes`);
    check('the pod keeps advancing — the engine never gets stuck with four seats', seen.turnsPassed >= 8,
      JSON.stringify({ ...seen, attackedSeats: [...seen.attackedSeats] }));
    check('a land played from hand reaches the battlefield', seen.land);
    check('a spell or ability goes on the stack and resolves', seen.stack);
    check('life totals move because the rules moved them', seen.lifeChanged);
    check('combat asks the attacking player to declare', seen.attackers);
    // Only when a creature actually attacked: an empty declaration draws no arrow, and the table
    // asks for one on every turn somebody has a creature. See the arena suite for the long version.
    if (seen.swung) {
      check('an attack is drawn on the board, from the creature to whichever seat it is aimed at',
        seen.arrows);
    }
    if (seen.blockers) check('and asks a defending player to block', true);
    else console.log('      (no block was called for in this game — combat.test.ts covers that path)');

    // The two claims this suite exists for.
    if (seen.commanderCast) {
      check('a commander is cast from the command zone through the real UI', true);
      check('and the command zone says the commander is playable', seen.commanderBadge);
    } else {
      check('a commander is cast from the command zone through the real UI', false,
        `the command zone was read ${seen.cmdLooks ?? 0} times and never said playable; `
        + `last read: ${seen.cmdText ?? '(never looked)'}`);
    }
    if (seen.x) {
      check('an X spell asks how big it is, and is cast for what was chosen', Boolean(seen.xCast),
        seen.xCast ?? 'the prompt appeared but no cast came out of it');
    }
    if (seen.commanderReturned) {
      check('a commander that died is back in its command zone (CR 903.9)', true);
    } else if (seen.commanderCast) {
      console.log('      (no commander died in this game — cards.test.ts asserts the return deterministically)');
    }
    if (seen.attackedSeats.size > 1) {
      check('attacks are sent at more than one opponent over the game', true,
        `seats ${[...seen.attackedSeats].join(',')}`);
    } else {
      console.log(`      (attacks only ever went at ${[...seen.attackedSeats].join(',') || 'nobody'} `
        + '— the engine asserts the spread deterministically in playout.test.ts)');
    }

    // ── The table read: what each seat can hit you with ────────────────────────────────────────
    /*
      The two numbers a pod turns on, on screen for every seat that has creatures. Checked here
      rather than in a unit test as well as it, because what matters is that they are *visible* on
      a four-player board — the arithmetic is asserted in `arena.test.ts`.
    */
    const reads = await host.page.locator('[data-testid^="board-"]').evaluateAll((els) =>
      els.map((e) => (e.textContent ?? '').trim()));
    if (reads.length > 0) {
      check('each seat with a board says how much power it has', reads.every((t) => /^board \d+/.test(t)),
        JSON.stringify(reads));
    } else {
      console.log('      (no seat had a creature when the board was read — arena.test.ts asserts the read)');
    }

    /*
      The read on the button that sends the attack: their life, and what is left to block with.

      Asserted as "every read names a life total", because the rest of it is conditional on the
      board — a seat with nothing untapped correctly says nothing about blockers. The arithmetic,
      and the strict rule for calling an attack lethal, are pinned in `arena.test.ts`.
    */
    if (seen.attackReads.length > 0) {
      check('each player you can attack says what going at them is walking into',
        seen.attackReads.every((t) => /\s\d+/.test(t)), JSON.stringify(seen.attackReads.slice(0, 4)));
    } else {
      console.log('      (no attack had more than one possible defender in this game)');
    }
    if (seen.allAtTried) {
      check('“all at them” sends every declared attack at one player', seen.allAtWorked);
    } else {
      console.log('      (never had two creatures and two defenders at once to send everything at '
        + 'one player — arena.test.ts pins the reducer)');
    }

    // ── Commander damage is the engine's count, with nothing to contradict it ───────────────────
    const cmdCells = await host.page.locator('[data-testid^="cmd-dmg-"]').evaluateAll((els) =>
      els.map((e) => ({ tag: e.tagName.toLowerCase(), text: (e.textContent ?? '').trim() })));
    check(
      'commander damage is shown for each opponent and cannot be tapped while the engine is running',
      cmdCells.length === 3 && cmdCells.every((c) => c.tag !== 'button' && /cmd \d+/.test(c.text)),
      JSON.stringify(cmdCells),
    );

    // ── A seat going out does not take the table with it ───────────────────────────────────────
    if (!finished) {
      // Nobody has died yet, so one player concedes: that is the only way to reach the state from
      // a browser inside a sane budget, and the claim — the other three play on — is the same one.
      const quitter = players[3];
      if (await has(quitter.page, 'concede')) {
        // Two taps: the button arms on the first and acts on the second, so a misclick does not
        // end somebody's game.
        await tid(quitter.page, 'concede').click();
        await expectEventually(quitter.page, 'conceding asks to be confirmed rather than acting on one tap', async () =>
          /really/i.test(await text(quitter.page, 'concede')));
        await tid(quitter.page, 'concede').click();
        await expectEventually(host.page, 'a player who concedes is marked out on everybody’s table', async () =>
          /out \(/.test(await text(host.page, `seat-${quitter.seat}`)));
        seen.eliminated = true;
        await shot(host.page, 'three-left');
      }
    }

    // ── Finish it ───────────────────────────────────────────────────────────────────────────────
    if (!finished) {
      let stuck = 0;
      for (let i = 0; i < MAX_MOVES * 2 && !(await has(host.page, 'game-over')); i++) {
        const actors = [];
        for (const p of players) if (await isMyMove(p.page)) actors.push(p);
        if (actors.length === 0) {
          stuck += 1;
          if (stuck > 80) break;
          await host.page.waitForTimeout(200);
          continue;
        }
        stuck = 0;
        for (const actor of actors) {
          await notePrompts(seen, actor.page, actor.seat);
          const did = await makeMove(actor.page, actor.seat, { aggression: 0.9 });
          await noteMove(seen, actor.page, did);
          if (did === null) {
            check('every prompt the table shows can be answered', false,
              `${actor.who} stuck at ${await text(actor.page, 'step-label')}`);
            stuck = 999;
            break;
          }
          await actor.page.waitForTimeout(30);
        }
        if (stuck === 999) break;
        const turn = await readNumber(host.page, 'turn');
        if (turn > lastTurn) {
          lastTurn = turn;
          if (seen.eliminated) seen.playedOnAfterElimination = true;
          if (turn % 10 === 0) console.log(`      finishing — turn ${turn}`);
        }
      }
      finished = await has(host.page, 'game-over');
    }
    if (seen.eliminated) {
      check('the other players keep playing after a seat is out', seen.playedOnAfterElimination,
        `eliminated on turn ${seen.eliminatedAt ?? '?'}, now turn ${await readNumber(host.page, 'turn')}`);
    }
    check('the pod reaches one survivor through the real UI', finished,
      finished ? '' : `stopped at ${await text(host.page, 'step-label')} turn ${await readNumber(host.page, 'turn')}`);
    if (finished) {
      const over = await text(host.page, 'game-over');
      check('and the winner is named', /wins/.test(over), over.slice(0, 80));
      for (const p of players.slice(1)) {
        await expectEventually(p.page, `${p.who} is told the same result`, async () =>
          /wins/.test(await text(p.page, 'game-over')));
      }
      await shot(host.page, 'pod-over');
    }

    // ── Four seats on a phone ───────────────────────────────────────────────────────────────────
    await host.page.setViewportSize({ width: 390, height: 844 });
    await host.page.waitForTimeout(400);
    const overflow = await host.page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('a four-seat table fits a phone with no sideways scrolling', overflow <= 1, `overflow ${overflow}px`);
    const barVisible = await host.page.evaluate(() => {
      const bar = document.querySelector('[data-testid="arena-bar"]');
      if (!bar) return 'missing';
      const box = bar.getBoundingClientRect();
      return box.left >= -1 && box.right <= window.innerWidth + 1 ? 'ok' : `clipped (${box.left}..${box.right})`;
    });
    check('and the engine’s control bar stays fully on screen', barVisible === 'ok', String(barVisible));
    await shot(host.page, 'phone-pod');

    const refusals = [];
    for (const p of players) {
      if (await has(p.page, 'table-error')) refusals.push(`${p.who}: ${await text(p.page, 'table-error')}`);
    }
    check('the engine never refused anything a table offered', refusals.length === 0, refusals.join(' | '));
    check('no uncaught errors in any of the four browsers', pageErrors.length === 0, pageErrors.join(' | '));
    check('no React warnings in any of the four browsers', reactWarnings.length === 0, reactWarnings.join(' | '));
    check('no failed requests other than the API this table does not need', badRequests.length === 0,
      badRequests.join(' | '));
  } catch (err) {
    check('the run completed without throwing', false, err.message);
    for (const p of players) await shot(p.page, `${p.who.toLowerCase()}-at-failure`).catch(() => {});
  } finally {
    await browser.close();
  }

  summarize();
}

/**
 * Taps the commander in its own command zone and casts it if the table offers that.
 *
 * Its own function because the command zone is the one place a spell is cast from that is not the
 * hand, so the shared driver never looks there — and because the badge is the thing being checked
 * as much as the cast is: a commander the table does not mark playable is a commander a player
 * never finds.
 */
async function tryCommander(page, seat, seen) {
  const card = cardsIn(page, `zone-command-${seat}`).first();
  if ((await card.count()) === 0) return false;
  const badges = (await card.textContent()) ?? '';
  if (!/playable/i.test(badges)) {
    // Recorded rather than ignored: "the commander was never castable" is a claim about the
    // engine, and this is the only place that can tell it apart from "the table never said so".
    seen.cmdLooks = (seen.cmdLooks ?? 0) + 1;
    seen.cmdText = badges.replace(/\s+/g, ' ').slice(0, 120);
    return false;
  }
  seen.commanderBadge = true;
  await card.click();
  await waitFor(page, 'play-sheet', 5000);
  const options = page.locator('[data-testid^="play-"]:not([data-testid="play-sheet"]):not([data-testid="play-sheet-close"])');
  const choices = await options.count();
  if (choices === 0) {
    await tid(page, 'play-sheet-close').click();
    return false;
  }
  const label = ((await options.first().textContent()) ?? '').trim().replace(/\s+/g, ' ');
  await options.first().click();
  seen.commanderCast = true;
  seen.castBySeat = seat;
  await shot(page, 'casting-a-commander');
  console.log(`      cast a commander from the command zone: ${label.slice(0, 60)}`);
  return true;
}

await main();
