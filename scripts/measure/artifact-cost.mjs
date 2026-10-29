/*
  What happens to an artifact cost: is it offered, is it taken, and what did it eat?

  The pool has one — the Arcbound Ravager's "Sacrifice an artifact" — and three different questions
  were asked about it across D221 and D222, each of which the one before could not answer.

  1. **Is it taken?** D221: offered 437 times across 48 games, activated 0. That counted the
     *windows*, which is how a zone problem (ninjutsu, D219) is told from a judgement problem.
  2. **What was on offer?** D222: the windows were the wrong unit. At all 434 of them the only
     artifact on offer was the Ravager itself, and the Equipment that appeared was already attached
     89 times and idle once — so the bot was mostly not refusing good food, there mostly was none.
  3. **Was eating it right?** Also D222, and the question that sent `feedsArtifacts` back to off:
     four of the four artifacts it ate had a creature standing by that could have carried them, and
     two were Loxodon Warhammers.

  All three in one pass, because they are one pass: the same 48 games, read three ways.

    node scripts/measure/artifact-cost.mjs
    BOT='{"feedsArtifacts":true}' node scripts/measure/artifact-cost.mjs
    AUDIT=1 node scripts/measure/artifact-cost.mjs

  `AUDIT=1` prints every artifact in the pool with its abilities, statics and triggers instead of
  playing anything, which is the reading that settled the question: there is no spent artifact here.
  It is also the reading that killed the obvious fix — a syntactic "no activated ability and no
  static" test passes an Obelisk of Urd, whose +2/+2 lives in an enters-the-battlefield choice.
*/
import {
  applyAction, botAction, characteristicsOf, createGame, legalActions, scriptFor, seatsToAct,
  STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'forge-alliance';
const SEED0 = Number(process.env.SEED0 ?? 3300);
const SEEDS = Number(process.env.SEEDS ?? 2);
const BOT = JSON.parse(process.env.BOT ?? '{}');
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const FIELD = Object.keys(STARTER_DECKS).filter((d) => d !== SUBJECT);
const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name;

/*
  Every artifact in the pool, with what its script actually has on it.

  Printed rather than asserted, because the point is to be read: the five rows it comes back in
  (Equipment, Vehicle, mana source, standing answer, anthem) are the argument that this is a deck
  question. `statics` is deliberately shown beside `triggers` — the Obelisk's anthem is in neither.
*/
if (process.env.AUDIT === '1') {
  const seen = new Map();
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const entry of deck.cards) {
      if (!entry.card.typeLine.toLowerCase().includes('artifact')) continue;
      const script = scriptFor(entry.card.name);
      seen.set(entry.card.name, {
        creature: entry.card.typeLine.toLowerCase().includes('creature'),
        cmc: entry.card.cmc,
        abilities: script?.abilities?.length ?? 0,
        statics: script?.statics?.length ?? 0,
        triggers: script?.triggers?.length ?? 0,
      });
    }
  }
  console.log(`${seen.size} artifacts in the pool`);
  for (const [name, v] of [...seen].sort()) {
    console.log(`  ${name.padEnd(24)} ${v.creature ? 'creature' : '        '}`
      + ` cmc ${v.cmc}  abilities ${v.abilities}  statics ${v.statics}  triggers ${v.triggers}`);
  }
  process.exit(0);
}

const c = {
  games: 0, cast: 0, offered: 0, ate: 0, ateWithACarrier: 0, equips: 0,
  onOffer: { selfOnly: 0, attached: 0, idle: 0 }, eaten: {},
};

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    for (const [a, b] of [[SUBJECT, other], [other, SUBJECT]]) {
      const host = { isHost: true };
      let s = createGame({
        id: `g${c.games}`, format: 'modern', players: PLAYERS, seed: SEED0 + c.games,
      });
      s = applyAction(s, { type: 'deck:load', by: 0, seat: 0, deckId: a }, host);
      s = applyAction(s, { type: 'deck:load', by: 1, seat: 1, deckId: b }, host);
      s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
      s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);
      const me = a === SUBJECT ? 0 : 1;
      // One window per step, because the row is on offer for every priority inside it and counting
      // each would be counting the engine's auto-passing rather than the player's chances.
      const seen = new Set();
      for (let m = 0; m < 3000 && !s.finished; m++) {
        if (s.priority === me) {
          const row = legalActions(s, me).plays.find((p) => p.sacrificeKind === 'artifact');
          const key = `${s.turn}:${s.step}`;
          if (row !== undefined && !seen.has(key)) {
            seen.add(key);
            c.offered += 1;
            let idle = 0, attached = 0, others = 0;
            for (const id of row.sacrificeOptions) {
              const inst = s.instances[id];
              if (inst === undefined) continue;
              if (characteristicsOf(s, inst).isCreature) continue;
              others += 1;
              if (inst.attachedTo !== null) attached += 1; else idle += 1;
            }
            if (others === 0) c.onOffer.selfOnly += 1;
            c.onOffer.attached += attached;
            c.onOffer.idle += idle;
          }
        }
        const seat = seatsToAct(s)[0];
        if (seat === undefined) break;
        const action = botAction(s, seat, BOT);
        if (action === null) break;
        if (seat === me && action.type === 'auto:cast'
          && nameOf(s, action.card) === 'Arcbound Ravager') c.cast += 1;
        if (seat === me && action.type === 'auto:activate') {
          if (nameOf(s, action.card) === 'Arcbound Ravager' && action.sacrifice !== undefined) {
            const fodder = nameOf(s, action.sacrifice);
            c.ate += 1;
            c.eaten[fodder] = (c.eaten[fodder] ?? 0) + 1;
            /*
              Somewhere else to go: a creature this seat controls other than the fodder. That is the
              filter every Equipment in this deck equips on and every Vehicle crews with, so a board
              with one is a board where using the card was the alternative to eating it.
            */
            const carriers = Object.values(s.instances).filter((inst) =>
              inst.zone === 'battlefield' && inst.zoneSeat === me && inst.id !== action.sacrifice
              && characteristicsOf(s, inst).isCreature);
            if (carriers.length > 0) c.ateWithACarrier += 1;
          }
          // Equips, as the play the eating might be displacing. Counted off the offered row's own
          // words rather than the card's type, so a new Equipment needs nothing added here.
          const play = legalActions(s, seat).plays.find((p) =>
            p.card === action.card && p.abilityIndex === (action.abilityIndex ?? 0));
          if (play !== undefined && /^Equip/.test(play.description)) c.equips += 1;
        }
        s = applyAction(s, action, host);
      }
      c.games += 1;
    }
  }
}

console.log(`${SUBJECT} v the field, ${c.games} games, bot ${JSON.stringify(BOT)}`);
console.log(`  Ravagers cast                     ${c.cast}`);
console.log(`  windows the row was offered in     ${c.offered}`);
console.log(`    of those, nothing but itself     ${c.onOffer.selfOnly}`);
console.log(`    other artifacts on offer, attached ${c.onOffer.attached}`);
console.log(`    other artifacts on offer, idle     ${c.onOffer.idle}`);
console.log(`  artifacts eaten                    ${c.ate}`);
console.log(`    with a carrier standing by       ${c.ateWithACarrier}`);
console.log(`    by name                          ${JSON.stringify(c.eaten)}`);
console.log(`  equips activated                   ${c.equips}`);
