/**
 * Why a counterspell sits in hand: the window, the mana, and the choice.
 *
 * Three decks' records are capped by the same sentence, written down three times in this project's
 * own notes: holding mana for an answer is half the plan of Tidal Mind, Skyward Writ and Arc
 * Tempest, and the bot cannot do it. Two terms were built for it and both were deleted (untapped
 * mana in D68, an answer priced above a generic card in D69), and the corrected conclusion in
 * `bot.ts` is a mechanism claim nobody has ever measured: *"it is often tapped out when the moment
 * comes, and valuing untapped mana does not fix that, because what the mana bought instead was
 * worth more."*
 *
 * The first half of that is checkable. **A counterspell's life has six ends**, and which one it
 * meets decides what kind of fix would help:
 *
 * - **cast** — the window opened, the mana was there, and the bot spent it.
 * - **covered** — the spell was countered, by a *different* answer in the same hand. Nothing was
 *   declined; this is the same decision counted twice, and the unit below is why.
 * - **passed** — the window opened on a move this seat was making, the mana was there, and the bot
 *   chose something else. A judgement problem: the evaluation preferred the alternative. Only an
 *   evaluation change helps.
 * - **unseen** — the pair was only ever seen on a move this seat was not making, so there was no
 *   decision to get wrong.
 * - **no mana** — an opponent's spell was on the stack, the bot held priority, and it could not
 *   pay. A *tempo* problem, and the one the deleted terms were aiming at.
 * - **no target** — the bot held priority with mana and nothing the card could legally point at,
 *   which for "counter target creature spell" is most of the game.
 *
 * **The middle two were added after the first reading was published, and they corrected it.** The
 * original four folded both into `passed`, which is the one column a conclusion gets drawn from, and
 * the inflation was large: Skyward Writ read 16% passed where the true figure is 1%. Both have the
 * same cause — the unit here is right for *could this card have been cast* and wrong for *what did
 * this seat decide* — and the two reclassification passes at the end of `duel` are where the
 * difference is paid back. D168 and D170 in `claude/decisions-log.md` carry the corrected numbers.
 *
 * Read off `legalActions`, which is the same function the table and the bot read, so a window is
 * counted exactly when the engine would have offered the play. The reasons come from its `blocked`
 * list — the text a player sees under an unplayable card — so this harness invents no judgement of
 * its own about affordability.
 *
 * **What this cannot tell you** is whether a window the bot passed on was worth taking. "A spell
 * was on the stack and the counter was affordable" says nothing about whether countering a Rampant
 * Growth is a good idea, and D69 is the finding that it is not: the bot will counter anything it
 * can pay for. The spell names are printed for that reason — the shape of the list is the evidence,
 * not the totals.
 *
 * It also cannot see a window the engine never offered because the bot had already tapped out
 * *earlier in its own turn*: that shows up here as "no mana", correctly, but this harness does not
 * say what the mana went on. `cast-counts` on the same deck is the other half of that question.
 */
import {
  applyAction, createGame, botAction, legalActions, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'tidal-mind';
/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
/*
  `BotOptions` for the subject's seat, as JSON, so the instrument can price its own fix.

  Handed to the subject only. The field plays the default bot either way, because a rule about
  holding mana for a counterspell is a rule about the decks that hold counterspells and the
  question here is what it does for *this* deck:

    BOT='{"reserveForAnswers":true}' SUBJECT=tidal-mind node scripts/measure/held-answers.mjs
*/
const BOT = JSON.parse(process.env.BOT ?? '{}');

/*
  What counts as an answer: a card whose text points at something already on the stack.

  Matched on the oracle text rather than a list of names, so a card added to the pool tomorrow is
  measured without anybody remembering to come back here. "counter target" catches the five hard
  counters, the two conditional ones, Soul Manipulation's first mode and Squelch's ability-only
  version; Chalice of the Void's "counter it" is deliberately not caught, because a permanent that
  answers spells by sitting there is not a card anybody holds mana for.
*/
const isAnswer = (def) => def !== undefined && /counter target/i.test(def.oracleText ?? '');

const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name;
const defOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? ''];

/** One row per answer card: where its windows went. */
const rows = new Map();
const row = (name) => {
  const got = rows.get(name) ?? {
    cast: 0, covered: 0, passed: 0, unseen: 0, noMana: 0, noTarget: 0, other: 0,
  };
  rows.set(name, got);
  return got;
};
/** What the bot countered, and what it declined, by the spell's own name. */
const countered = new Map();
const declined = new Map();
/** What was on the stack the moments it could not pay — the "what beat it while it was tapped out" list. */
const tappedOut = new Map();
/*
  The mana value of what it countered against what it let through.

  Which is the crudest possible proxy for "was that worth a card" and still the one number that
  separates the two failures this instrument can see. D69 found the bot will counter anything it
  can pay for, because by its evaluation countering is a gain and the counterspell in hand is
  priced as any other card — so if the reservation rule works, the *next* thing to go wrong is a
  Counterspell spent on a Rampant Growth while a Shivan Dragon resolves next turn. A deck
  countering an average mana value below what it declines is doing exactly that.

  It is a proxy and it is named as one: a one-mana Swords to Plowshares aimed at the only creature
  holding the board is worth more than a five-mana creature nobody needed to answer, and no
  arithmetic here knows that.
*/
const mv = { countered: [], declined: [] };
/*
  What the two answers looked like, for the judgement question that follows this one.

  Once the reservation rule lets the bot pay, the windows it *declines* become the interesting
  ones — and "declined 15 of them" says nothing about whether declining was right. So each
  decision is recorded with four things about it a card could read: whether the spell was a
  creature, its mana value, whether the bot was ahead on creatures, and whether it was ahead on
  life. If one of them separates the two lists, that is a candidate for a fact-about-the-board
  filter in the family `preventionCanMatter` belongs to. If none does, the separating thing is what
  the spell *does* — which no arithmetic here can read, and which is worth establishing before
  anybody writes a weight for it.
*/
const shape = { countered: [], declined: [] };
/*
  What the bot did *instead* of countering, which is the question the four facts above cannot
  answer.

  "It declined fifteen windows" is a number; "it cast a Vampire Nighthawk instead" is a diagnosis.
  The action is recorded as the bot's own choice at the moment the window was open, by name, so the
  list says whether the declines are a judgement worth fixing (it spent the mana on something
  small) or the search being right (it countered something else, or the mana went on a threat).
*/
const instead = new Map();
const bumpName = (map, name) => map.set(name, (map.get(name) ?? 0) + 1);

function duel(seed, decks, mine) {
  const ctx = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, ctx);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, ctx);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, ctx);

  /*
    One window per (stack object, card in hand), decided once at the end rather than on sight.

    A spell sits on the stack across several of this loop's moves — both seats pass, triggers
    resolve above it — so a key is needed or a single Shock counts as four windows. Deciding on
    sight was the first shape and it was **wrong in the one direction that mattered**: if the bot
    spent that moment on another instant and cast the counter a moment later, the window had
    already been written down as "affordable, passed". Casting is therefore allowed to overwrite
    a pass on the same window, and nothing else is, so the counts are settled when the game is.
  */
  const windows = new Map();
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, seat === mine ? BOT : {});
    if (action === null) break;

    /*
      A window, which is the whole measurement: an opponent's object on the stack, and what this
      seat would be offered about it.

      **Asked counterfactually, and that is the finding rather than a shortcut.** `legalActions`
      returns an empty list of plays to a seat that does not hold priority, and the first version of
      this harness therefore saw almost nothing: across 24 games there were 163 moments with an
      opponent's spell on the stack and the subject seat was offered priority in **3** of them. That
      is not a bug, it is auto-pass doing its job — it passes for a seat whose only legal move is to
      pass, inside the same applied action, so a seat that cannot afford its counterspell never
      appears as a decision at all. Which means the 160 moments the harness could not see are
      exactly the ones it exists to explain.

      So the question is put to the engine with `priority` moved to this seat: *if you were asked
      right now, what would you offer and what would you refuse?* Nothing is applied, the state is
      a local copy, and the answer comes from the same function the table reads — so the four
      buckets below are the engine's own judgement, not this file's.

      The opponent's own spells only. A seat holding priority over *its own* spell is the ordinary
      case — every cast gives its caster priority back — and a counterspell has no business
      pointing at it, so counting those would bury the real windows under three times as many that
      were never windows at all.
    */
    const top = s.stackOrder[s.stackOrder.length - 1];
    const object = top === undefined ? undefined : s.stackObjects[top];
    if (seat !== undefined && object !== undefined && object.controller !== mine
      && s.pendingChoice === null && s.pendingDecision === null && s.pendingPayment === null
      && s.pendingDiscard === null) {
      const asked = s.priority === mine ? legalActions(s, mine) : legalActions({ ...s, priority: mine }, mine);
      const spell = s.cardDefs[object.cardKey]?.name ?? nameOf(s, object.source) ?? 'an ability';
      const spellDef = s.cardDefs[object.cardKey];
      /*
        The board as the bot saw it, counted the cheap way: creatures either side and both life
        totals. Power would describe a board better and is deliberately not used — the question is
        whether a *simple* fact separates the two decisions, and a head count is the simplest there
        is. If a head count separates them, a better measure will too.
      */
      const mineCreatures = Object.values(s.instances).filter((i) => i.zone === 'battlefield'
        && i.zoneSeat === mine && /creature/i.test(s.cardDefs[i.defKey]?.typeLine ?? '')).length;
      const theirCreatures = Object.values(s.instances).filter((i) => i.zone === 'battlefield'
        && i.zoneSeat !== mine && /creature/i.test(s.cardDefs[i.defKey]?.typeLine ?? '')).length;
      /*
        The bot's own move at this moment, in the words the action uses. Only meaningful when this
        seat is the one acting — a window observed on the opponent's move is a window this seat was
        never asked about, and `— not asked` says so rather than attributing somebody else's play.
      */
      const chose = seat !== mine ? '— not asked'
        : action.type === 'auto:cast' || action.type === 'auto:playLand'
          ? `${action.type === 'auto:cast' ? 'cast' : 'played'} ${nameOf(s, action.card) ?? '?'}`
          : action.type;
      const board = {
        creature: /creature/i.test(spellDef?.typeLine ?? ''),
        cmc: spellDef?.cmc ?? 0,
        aheadOnBoard: mineCreatures > theirCreatures,
        aheadOnLife: (s.seats[mine]?.life ?? 0) > (s.seats[1 - mine]?.life ?? 0),
      };
      /*
        One window per (spell on the stack, card in hand), counted once.

        A spell sits on the stack across several of this loop's moves — both seats pass, triggers
        resolve above it — so without this key a single Shock would be counted four or five times,
        and a deck that held one counter all game would read as a deck with twenty windows.
      */
      const held = new Set();
      for (const play of asked.plays) {
        const def = defOf(s, play.card);
        if (!isAnswer(def) || held.has(play.card)) continue;
        held.add(play.card);
        const key = `${top}:${play.card}`;
        const casting = seat === mine && action.type === 'auto:cast' && action.card === play.card;
        const already = windows.get(key);
        if (already === undefined) {
          windows.set(key, {
            card: def.name, spell, object: top, cmc: s.cardDefs[object.cardKey]?.cmc ?? 0,
            how: casting ? 'cast' : 'passed', board, chose, asked: seat === mine,
          });
        } else if (casting && already.how === 'passed') {
          already.how = 'cast';
          already.chose = chose;
        } else if (!already.asked && seat === mine) {
          /*
            A window first seen on the opponent's move, seen again on this seat's own.

            The loop looks at every move, and most moves are not this seat's — so the first sighting
            of a spell on the stack is usually one where this seat was not the one acting. Recording
            that sighting as the decision attributes somebody else's move to it: the first reading
            of this harness said the bot "declined" fifteen windows and nine of them were moments it
            was never asked about. The later sighting is the real decision, so it wins.
          */
          already.asked = true;
          already.chose = chose;
          already.how = casting ? 'cast' : 'passed';
        }
      }
      for (const entry of asked.blocked) {
        const def = defOf(s, entry.card);
        if (!isAnswer(def) || held.has(entry.card)) continue;
        held.add(entry.card);
        const key = `${top}:${entry.card}`;
        if (windows.has(key)) continue;
        const how = /not enough mana/.test(entry.reason)
          ? 'noMana'
          : /legally target|legal target/.test(entry.reason) ? 'noTarget' : 'other';
        windows.set(key, {
          card: def.name, spell, cmc: s.cardDefs[object.cardKey]?.cmc ?? 0, how,
        });
      }
    }

    const before = s.stateVersion;
    try { s = applyAction(s, action, ctx); } catch { break; }
    if (s.stateVersion === before) break;
  }

  /*
    A window the deck answered with a *different* card is not a decline, and the first reading of
    this harness said it was.

    One window per (spell, answer in hand) is the right unit for "could this card have been cast",
    and it double-counts the decision: a hand with a Counterspell and a Cancel facing one spell is
    two windows, and spending either one leaves the other looking passed over. Skyward Writ's
    "affordable and passed" column read 16% and **26 of its 31 declines were `cast Counterspell`**
    — the deck countering the spell with the other card in its hand. So a window whose spell was
    answered by any of this deck's answers is `covered`, and `passed` now means what it says.
  */
  const answered = new Set([...windows.values()].filter((w) => w.how === 'cast').map((w) => w.object));
  for (const w of windows.values()) {
    if (w.how === 'passed' && answered.has(w.object)) w.how = 'covered';
    /*
      And a window this seat was never actually offered is not a decline either.

      The loop looks at every move and most are the opponent's, so a (spell, answer) pair is
      usually first seen on a move this seat was not making. Where a later sighting on its own move
      exists, that one wins — but sometimes there is none: a trigger goes on the stack above the
      spell and the pair gets a new key, or the bot spends the mana first and the answer stops being
      affordable. Counting those as declines inflated the number: eight of Tidal Mind's fourteen
      "declines" were moments it was never asked about.
    */
    else if (w.how === 'passed' && w.asked !== true) w.how = 'unseen';
    row(w.card)[w.how] += 1;
    if (w.how === 'cast' || w.how === 'passed') {
      bumpName(w.how === 'cast' ? countered : declined, w.spell);
      mv[w.how === 'cast' ? 'countered' : 'declined'].push(w.cmc);
      if (w.board !== undefined) shape[w.how === 'cast' ? 'countered' : 'declined'].push(w.board);
      if (w.how === 'passed' && w.chose !== undefined) bumpName(instead, w.chose);
    } else if (w.how === 'unseen') {
      // Not a decision, so it is not in `declined` either — only in its own column.
    } else if (w.how === 'noMana') {
      bumpName(tappedOut, w.spell);
    }
  }
}

let games = 0;
for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other], 0); games += 1;
    duel(SEED0 + i, [other, SUBJECT], 1); games += 1;
  }
}

const pad = (n, w) => String(n).padStart(w);
console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log('');
console.log('what happened the moment an answer could have been cast:');
console.log('   cast  covered  passed  unseen  no mana  no target  other   card');
const totals = { cast: 0, covered: 0, passed: 0, unseen: 0, noMana: 0, noTarget: 0, other: 0 };
for (const [name, r] of [...rows.entries()].sort((a, b) => b[1].cast - a[1].cast)) {
  for (const k of Object.keys(totals)) totals[k] += r[k];
  console.log(`${pad(r.cast, 7)} ${pad(r.covered, 8)} ${pad(r.passed, 7)} ${pad(r.unseen, 7)} ${pad(r.noMana, 8)} ${pad(r.noTarget, 10)} ${pad(r.other, 6)}   ${name}`);
}
const all = Object.values(totals).reduce((a, b) => a + b, 0);
console.log(`${pad(totals.cast, 7)} ${pad(totals.covered, 8)} ${pad(totals.passed, 7)} ${pad(totals.unseen, 7)} ${pad(totals.noMana, 8)} ${pad(totals.noTarget, 10)} ${pad(totals.other, 6)}   — all of them`);
if (all > 0) {
  const pc = (n) => `${Math.round((100 * n) / all)}%`;
  console.log('');
  console.log(`of ${all} windows: ${pc(totals.cast)} cast, ${pc(totals.covered)} answered by another card, `
    + `${pc(totals.passed)} affordable and genuinely declined, ${pc(totals.unseen)} never offered, `
    + `${pc(totals.noMana)} could not pay, ${pc(totals.noTarget)} nothing to point at`);
}

const top = (map, n = 8) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `${k} ${v}`).join(', ');
console.log('');
const mean = (xs) => (xs.length === 0 ? null : (xs.reduce((a, b) => a + b, 0) / xs.length));
const both = mean(mv.countered);
const other = mean(mv.declined);
if (both !== null || other !== null) {
  console.log(`mana value countered ${both === null ? '—' : both.toFixed(1)}`
    + ` against declined ${other === null ? '—' : other.toFixed(1)}`
    + '   (a proxy, not a judgement — see the note in this file)');
}
console.log('');
/*
  The four facts, side by side. A fact that is 50% on both sides separates nothing.
*/
const share = (rows, key) => (rows.length === 0 ? '—'
  : `${Math.round((100 * rows.filter((r) => r[key]).length) / rows.length)}%`);
const meanOf = (rows, key) => (rows.length === 0 ? '—'
  : (rows.reduce((a, r) => a + r[key], 0) / rows.length).toFixed(1));
if (shape.countered.length + shape.declined.length > 0) {
  console.log('');
  console.log('and what the two decisions looked like:');
  console.log(`                        countered (${shape.countered.length})   declined (${shape.declined.length})`);
  console.log(`  the spell was a creature   ${share(shape.countered, 'creature').padStart(6)}        ${share(shape.declined, 'creature').padStart(6)}`);
  console.log(`  its mana value             ${meanOf(shape.countered, 'cmc').padStart(6)}        ${meanOf(shape.declined, 'cmc').padStart(6)}`);
  console.log(`  ahead on creatures         ${share(shape.countered, 'aheadOnBoard').padStart(6)}        ${share(shape.declined, 'aheadOnBoard').padStart(6)}`);
  console.log(`  ahead on life              ${share(shape.countered, 'aheadOnLife').padStart(6)}        ${share(shape.declined, 'aheadOnLife').padStart(6)}`);
}
console.log('');
console.log('');
console.log('instead of countering, it:', top(instead, 10) || '—');
console.log('');
console.log('countered:    ', top(countered) || '—');
console.log('declined:     ', top(declined) || '—');
console.log('tapped out on:', top(tappedOut) || '—');
