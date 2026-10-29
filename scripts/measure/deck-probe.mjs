/**
 * A deck list against the field, stock versus a variant built here — for a change nobody intends
 * to ship.
 *
 * Nothing here touches the repository: the stock arm is whatever `STARTER_DECKS` says today and
 * the variant is built from it in memory. That is the point — a change can be priced before it is
 * written, so the source only ever carries slot changes the instrument has already approved, and
 * a question like "how much of this deck's record is the cards and how much is the pilot" can be
 * asked without a commit that answers it wrongly.
 *
 * CHANGE is "Name:+1,Other:-2" as in deck-swap. A card the change adds need not already be in the
 * subject deck: its definition is looked up anywhere in the pool, which is where every card lives.
 *
 * COMMANDER names a card to lead the variant instead of the deck's own, which is the one question
 * this harness could not ask: every deck's write-up calls its commander "the half a deck list
 * cannot be", and until now that claim was unmeasured. Point it at a legend whose text is *dead* in
 * the subject deck — Balan in a deck with no Equipment — and the difference is what the real
 * commander is worth.
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
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
const SEEDS = Number(process.env.SEEDS ?? 17);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  "Name:+1,Other:-1", or "Name:+1;Other:-1" when a name has a comma in it.

  Which every legendary creature does — "Adeliz, the Cinder Wind", "Nissa, Voice of Zendikar" — and
  a comma-separated list cannot express one: splitting on the comma turned the card into two names
  and the probe refused both. So a `;` anywhere in the string makes `;` the separator, which keeps
  every invocation this project has already written down working and makes the rest expressible.
*/
const CHANGE = (process.env.CHANGE ?? '')
  .split((process.env.CHANGE ?? '').includes(';') ? ';' : ',')
  .filter(Boolean)
  .map((part) => {
    const at = part.lastIndexOf(':');
    return { name: part.slice(0, at).trim(), delta: Number(part.slice(at + 1)) };
  });

const defNamed = (name) => Object.values(STARTER_DECKS)
  .flatMap((d) => d.cards).find((e) => e.card.name === name)?.card;

const COMMANDER = process.env.COMMANDER ?? '';

function variant() {
  const stock = STARTER_DECKS[SUBJECT];
  const cards = [];
  for (const entry of stock.cards) {
    const change = CHANGE.find((c) => c.name === entry.card.name);
    const count = entry.count + (change?.delta ?? 0);
    if (count > 0) cards.push({ card: entry.card, count });
  }
  for (const change of CHANGE) {
    if (change.delta <= 0) continue;
    if (stock.cards.some((e) => e.card.name === change.name)) continue;
    const card = defNamed(change.name);
    if (card === undefined) throw new Error(`no card named ${change.name} in the pool`);
    cards.push({ card, count: change.delta });
  }
  if (COMMANDER === '') return { ...stock, cards };
  const lead = Object.values(STARTER_DECKS).map((d) => d.commander).find((c) => c?.name === COMMANDER)
    ?? defNamed(COMMANDER);
  if (lead === undefined) throw new Error(`no card named ${COMMANDER} in the pool`);
  return { ...stock, cards, commander: lead };
}

const FIELD = ALL.filter((id) => id !== SUBJECT);
const VARIANT = variant();
const size = (d) => d.cards.reduce((n, e) => n + e.count, 0);
console.log(`stock ${size(STARTER_DECKS[SUBJECT])} cards, variant ${size(VARIANT)} cards`);
if (size(VARIANT) !== size(STARTER_DECKS[SUBJECT])) {
  console.log('!! the two lists are not the same size, so this measures deck size too');
}

/*
  `BotOptions` for both seats, as JSON, so a slot can be priced with a bot rule turned on.

  The question it exists for: a card the bot plays badly measures as a bad card, and the two are
  only separable by pricing the slot twice. Terminus cost Skyward Writ thirty games of 288 with the
  bot casting every one it was offered (D204); the same probe with `sparesItsOwnBoard` on says how
  much of that was the card. Default empty, so a published probe means what it has always meant.

    BOT='{"sparesItsOwnBoard":true}' SUBJECT=skyward-writ node scripts/measure/deck-probe.mjs
*/
const BOT = JSON.parse(process.env.BOT ?? '{}');

function duel(seed, decks, ctx) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  const host = { isHost: true, ...ctx };
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, BOT);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  return s.finished ? s.winnerSeat : null;
}

/**
 * The subject's record against the field, and against each deck in it.
 *
 * The per-opponent split is what says *why* a change worked: a trim that wins fifty more games
 * against the two fastest decks and none against the slowest is a change about aggression, and
 * one that wins five everywhere is a change about card quality. Without the split both read as
 * one number.
 */
function record(ctx) {
  let won = 0; let lost = 0; let draw = 0;
  const each = new Map(FIELD.map((id) => [id, { won: 0, lost: 0 }]));
  for (let i = 0; i < SEEDS; i++) {
    for (const other of FIELD) {
      const row = each.get(other);
      const first = duel(SEED0 + i, [SUBJECT, other], ctx);
      if (first === 0) { won += 1; row.won += 1; } else if (first === 1) { lost += 1; row.lost += 1; } else draw += 1;
      const second = duel(SEED0 + i, [other, SUBJECT], ctx);
      if (second === 1) { won += 1; row.won += 1; } else if (second === 0) { lost += 1; row.lost += 1; } else draw += 1;
    }
  }
  return { won, lost, draw, each };
}

const before = record({});
console.log(`stock:   ${before.won}-${before.lost}${before.draw ? ` (${before.draw} unfinished)` : ''}`);
const after = record({ decks: { [SUBJECT]: VARIANT } });
console.log(`variant: ${after.won}-${after.lost}${after.draw ? ` (${after.draw} unfinished)` : ''}`);
for (const other of FIELD) {
  const b = before.each.get(other); const a = after.each.get(other);
  const move = a.won - b.won;
  console.log(`  ${b.won}-${b.lost} -> ${a.won}-${a.lost}  ${move >= 0 ? '+' : ''}${move}  v ${other}`);
}
