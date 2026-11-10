import { describe, expect, it } from 'vitest';
import { compileCard, fullyCompiled } from './compile.js';
import { STARTER_DECKS } from './starterDecks.js';
import { customDeck } from './customDeck.js';
import { CLUE_TOKEN, isKeywordDeclaration, scriptFor } from './scripts.js';
import { zoneKey, type CardDef } from './cards.js';
import {
  CREATURE_TYPES, KEYWORD_BLOCK_RULES, cardHasSubtype, characteristicsOf, hasSubtype, isCreatureType,
  isDevoidLine,
  keywordBlockRules, printedBlockerLimit, printedBlocksLimit, printedCombatStatics, printedKeywords,
  printedToxic,
  printedLandwalk,
} from './characteristics.js';
import type { CardDataRow } from './fromCardData.js';
import { addCounters, pump, tap, type EffectContext } from './effects.js';
import type { AbilityDef, TargetSpec, TriggerDef } from './scriptTypes.js';
import type { GameState, SeatIndex } from './types.js';
import type { Target } from './turnTypes.js';
import { arena, find, ids, nameOf } from './testkit.js';
import { legalTargets } from './targeting.js';

/**
 * Every card in the pool, by name — the compiler's ground truth.
 *
 * These are real cards with real printed text, each with a script a person wrote by reading that
 * text. So compiling the text and comparing against the script is the only check that can tell a
 * compiler that read the card from one that produced something plausible.
 */
const POOL = new Map<string, CardDef>();
for (const deck of Object.values(STARTER_DECKS)) {
  for (const entry of deck.cards) POOL.set(entry.card.name, entry.card);
  if (deck.commander) POOL.set(deck.commander.name, deck.commander);
}

/**
 * A pool card that is **partly** read: some lines compile and at least one does not.
 *
 * Named rather than searched for, so the test below says which card it is about. Obelisk of Urd
 * prints three lines — "Convoke", which this compiler reads into a cost, and two it does not: "As
 * Obelisk of Urd enters the battlefield, choose a creature type." and "Creatures you control of the
 * chosen type get +2/+2." The pair is what hybrid automation (D362) is for, and the card needs
 * **two** readers rather than one, which is part of why it was chosen.
 *
 * **It is expected to stop being true**, and it has twice. D447 moved it off Mystic Remora, whose
 * sentence that increment learned to read; D528 moved it off **Contagion Clasp**, whose only unread
 * line was "{4}, {T}: Proliferate." until proliferate joined the clause vocabulary. Each time the
 * test failed loudly, which is the right failure: whoever reads the line moves this constant to
 * another partly-read card and says so.
 *
 * The next candidates, measured rather than guessed — 12 pool cards satisfy this test's four
 * assertions, and the most durable after this one are Willbender (a retarget on a turned-face-up
 * trigger) and Thing in the Ice (a two-sentence line ending in a transform).
 */
const PARTLY_READ_CARD = 'Obelisk of Urd';

/** A card's own printed data, as the row an importer would hand over. */
function rowFor(name: string): CardDataRow {
  const def = POOL.get(name);
  if (def === undefined) throw new Error(`${name} is not in the pool`);
  return {
    name: def.name,
    type_line: def.typeLine,
    oracle_text: def.oracleText,
    mana_cost: def.manaCost,
    cmc: def.cmc,
    colors: [...def.colors],
    power: def.power ?? null,
    toughness: def.toughness ?? null,
    loyalty: def.loyalty ?? null,
    layout: def.faces === undefined ? 'normal' : def.faces.kind,
  };
}

/** The compiled script, or a thrown failure — so a test never silently reads `undefined`. */
function compiledScript(name: string) {
  const result = compileCard(rowFor(name));
  if (!result.ok) throw new Error(`${name} did not compile at all: ${result.why}`);
  return result;
}

describe('compileCard, against the cards a person wrote by hand', () => {
  /*
    The table of keywords whose printed line is the whole instruction, and the card in the pool that
    proves each one. Every row is a card whose hand-written script sets exactly these fields for
    this keyword — which is what `keywordScriptFor` is copied from, and what it must not drift from.

    `fields` names the script keys the keyword is responsible for. The assertion is deep equality on
    those keys against the hand-written script, except `triggers`, which hold closures and are
    compared by their `on` and `description` — see the trigger-shape test below.
  */
  const KEYWORDS: readonly { card: string; keyword: string; fields: readonly string[] }[] = [
    { card: 'Young Wolf', keyword: 'Undying', fields: [] },
    { card: 'Bloodbraid Elf', keyword: 'Cascade', fields: [] },
    { card: 'Grapeshot', keyword: 'Storm', fields: [] },
    { card: 'Basilica Screecher', keyword: 'Extort', fields: [] },
    /*
      The three ability words whose whole instruction is their own reminder text (D425). No field at
      all: each builds a trigger, and the trigger-shape test below is what compares them — these
      rows are here for the half the table does assert, which is that the printed line is reported
      as compiled rather than quietly dropped.
    */
    { card: 'Guardians of Akrasa', keyword: 'Exalted', fields: [] },
    { card: 'Cloudfin Raptor', keyword: 'Evolve', fields: [] },
    { card: 'Goblin Wardriver', keyword: 'Battle cry', fields: [] },
    { card: 'Sudden Shock', keyword: 'Split second', fields: ['splitSecond'] },
    { card: 'Pyromatics', keyword: 'Replicate', fields: ['replicate'] },
    { card: 'Mystic Remora', keyword: 'Cumulative upkeep', fields: ['cumulativeUpkeep'] },
    { card: 'Arcbound Worker', keyword: 'Modular', fields: ['modular', 'entersWith'] },
    { card: 'Calciderm', keyword: 'Vanishing', fields: ['vanishing', 'entersWith'] },
    { card: 'Blastoderm', keyword: 'Fading', fields: ['fading', 'entersWith'] },
    /*
      The alternative ways to cast a card: one printed cost, one script field, and one card in the
      pool whose hand-written script sets exactly that field for it. Grouped in the reader for the
      same reason they are grouped here — the shape is identical and the only thing that varies is
      which field the cost lands in.
    */
    { card: 'Think Twice', keyword: 'Flashback', fields: ['flashback'] },
    { card: 'Fiery Temper', keyword: 'Madness', fields: ['madness'] },
    { card: 'Thunderous Wrath', keyword: 'Miracle', fields: ['miracle'] },
    { card: 'Saw It Coming', keyword: 'Foretell', fields: ['foretell'] },
    { card: 'Skewer the Critics', keyword: 'Spectacle', fields: ['spectacle'] },
    { card: 'Capsize', keyword: 'Buyback', fields: ['buyback'] },
    { card: 'Mardu Scout', keyword: 'Dash', fields: ['dash'] },
    { card: 'Ninja of the Deep Hours', keyword: 'Ninjutsu', fields: ['ninjutsu'] },
    // The ones whose argument is a number, a word, or nothing at all.
    { card: 'Gurmag Angler', keyword: 'Delve', fields: ['delve'] },
    { card: 'Frogmite', keyword: 'Affinity for artifacts', fields: ['affinity'] },
    { card: 'Shambling Shell', keyword: 'Dredge', fields: ['dredge'] },
    /*
      Both suspend cards, because one is not enough: Rift Bolt is `Suspend 1` and a reader that
      ignored the printed number and always wrote 1 passed its row. Search for Tomorrow is
      `Suspend 2`.
    */
    { card: 'Rift Bolt', keyword: 'Suspend', fields: ['suspend'] },
    { card: 'Search for Tomorrow', keyword: 'Suspend', fields: ['suspend'] },
    { card: 'Woe Strider', keyword: 'Escape', fields: ['escape'] },
    { card: 'Distortion Strike', keyword: 'Rebound', fields: ['rebound'] },
    // Morph and echo, read through the same `keywordWithCost` the whole-card path uses.
    // Megamorph, as printed: this pool had it as a plain morph until D571 read its Oracle row.
    { card: 'Ainok Survivalist', keyword: 'Megamorph', fields: ['morph'] },
    { card: 'Hidden Dragonslayer', keyword: 'Megamorph', fields: ['morph'] },
    { card: 'Mogg War Marshal', keyword: 'Echo', fields: ['echo'] },
    // Crew is an ability rather than a declaration, so it has its own test below: an `AbilityDef`
    // holds a closure, and two closures are never deep-equal however identical their behaviour.
  ];

  for (const { card, keyword, fields } of KEYWORDS) {
    it(`reads ${keyword} off ${card} exactly as the hand-written script sets it`, () => {
      const written = scriptFor(card);
      expect(written, `${card} has no hand-written script to compare against`).toBeDefined();
      const compiled = compiledScript(card);
      expect(compiled.script, `${card} compiled to no script at all`).toBeDefined();

      for (const field of fields) {
        expect(
          (compiled.script as unknown as Record<string, unknown>)[field],
          `${card}: compiled ${field} does not match the hand-written one`,
        ).toEqual((written as unknown as Record<string, unknown>)[field]);
      }

      // The keyword's own line is reported as compiled, by its printed text.
      const line = compiled.compiled.find((l) => l.toLowerCase().startsWith(keyword.toLowerCase()));
      expect(line, `${card}: the ${keyword} line is not in the compiled list`).toBeDefined();
    });
  }

  /*
    The three keywords that are useless without their counters.

    This is the test for the trap `keywordScriptFor`'s docblock names: `vanishingTrigger(4)` is
    conditioned on there being a time counter, and the counters come from `entersWith`. A compiler
    that emitted the trigger alone would build a Calciderm that never dies — a card strictly worse
    than one left to be moved by hand. Asserted as a number rather than "is defined", because the
    count has to match the printed one.
  */
  it.each([
    ['Arcbound Worker', '+1/+1', 1],
    ['Calciderm', 'time', 4],
    ['Blastoderm', 'fade', 3],
  ])('%s arrives with the counters its clock counts down', (card, counter, amount) => {
    const script = compiledScript(card as string).script as unknown as
      { entersWith?: { counter: string; amount: number }; triggers?: readonly unknown[] };
    expect(script.entersWith).toEqual({ counter, amount });
    expect(script.triggers?.length, `${card} has no trigger to spend them`).toBeGreaterThan(0);
  });

  it('builds the same triggers, by what they watch and what they say', () => {
    /*
      Closures cannot be compared, so the comparison is each trigger's `on` and `description` — the
      two fields that say *when it fires* and *what it does*, both of which come from the builder
      rather than from the card. A compiler calling a different builder, or the same one with a
      different argument, fails here.
    */
    const shape = (s: unknown) =>
      ((s as { triggers?: readonly { on?: unknown; description?: string }[] }).triggers ?? [])
        .map((t) => `${JSON.stringify(t.on)} ${t.description ?? ''}`);

    for (const card of [
      'Young Wolf', 'Bloodbraid Elf', 'Grapeshot', 'Arcbound Worker', 'Calciderm', 'Blastoderm',
      // D425's three, where the trigger is the whole keyword: `alone: true` on exalted, the
      // intervening-if on evolve and the bare `attacks` on battle cry all show up in `on`.
      'Guardians of Akrasa', 'Cloudfin Raptor', 'Goblin Wardriver',
    ]) {
      const written = shape(scriptFor(card));
      const compiled = shape(compiledScript(card).script);
      // The hand-written card may have triggers from *other* lines too; every compiled trigger has
      // to appear among them, which is the direction that catches an invented one.
      for (const trigger of compiled) {
        expect(written, `${card}: compiled a trigger the hand-written script does not have`)
          .toContain(trigger);
      }
      expect(compiled.length, `${card} compiled no triggers`).toBeGreaterThan(0);
    }
  });

  it('counts a keyword line the engine reads off the card itself as compiled, and emits nothing for it', () => {
    /*
      `characteristicsOf` calls `printedKeywords(def.oracleText)` with no script involved, so
      "Flying" is already running on an unscripted card. Counting it as uncompiled would understate
      coverage; restating it in the script would be a second source for one fact.
    */
    const screecher = compiledScript('Basilica Screecher');
    expect(screecher.compiled).toContain('Flying');
    expect((screecher.script as unknown as Record<string, unknown> | undefined)?.['keywords'])
      .toBeUndefined();
  });

  it('names the lines it could not read, rather than refusing the card', () => {
    /*
      **Retired subject (D447).** This test used **Mystic Remora** and asserted
      `fullyCompiled(remora)` was `false`, with the comment "Mystic Remora is cumulative upkeep plus
      one triggered ability. The keyword compiles; the sentence does not, and the card is still a
      card." Its sentence is "Whenever an opponent casts a noncreature spell, you may draw two
      cards", and D447 reads it — so the Remora is now compiled whole and cannot demonstrate a card
      that is only partly read. The claim is not weakened, it is **relocated**: the assertions below
      are the same four, on a card that still has an unread line.

      Remora keeps its own test above, which pins the half that has not changed — that the keyword
      line compiles into `cumulativeUpkeep`.
    */
    const partly = compiledScript(PARTLY_READ_CARD);
    expect(partly.source).toBe('lines');
    expect(fullyCompiled(partly)).toBe(false);
    expect(partly.unread.length).toBeGreaterThan(0);
    expect(partly.unread.every((u) => u.why === 'no-reader')).toBe(true);
    // And the printed data survived regardless, which is what hybrid mode plays with.
    expect(partly.def.name).toBe(PARTLY_READ_CARD);
    expect(partly.def.oracleText.length).toBeGreaterThan(0);
  });

  it('hands a whole-card derivation straight back, rather than re-deriving it', () => {
    // A Mountain is `cardFromData`'s business and this module does not second-guess it.
    const mountain = compiledScript('Mountain');
    expect(mountain.source).toBe('whole-card');
    expect(fullyCompiled(mountain)).toBe(true);
    /*
      `mana-source` rather than `basic-land`, and the difference is the row rather than the card.
      `cardFromData` calls a land `basic-land` only when its mana comes *entirely* from its basic
      land type with no printed ability to read (CR 305.6) — which is the shape Scryfall sends,
      where a Mountain's `oracle_text` is empty. The pool's own Mountain spells `{T}: Add {R}.` out
      in its `oracleText`, so a row built from it has a mana line to parse and lands one branch
      over. Asserted as what it is: a reading about this row, not a claim about Mountains.
    */
    expect(mountain.kind).toBe('mana-source');
    expect(POOL.get('Mountain')?.oracleText).toContain('Add {R}');
  });

  it('still returns the printed data for a card it can read nothing of', () => {
    const bolt = compileCard({
      name: 'Nothing Compilable', type_line: 'Sorcery', mana_cost: '{R}', cmc: 1,
      oracle_text: 'Do something no reader here understands at all.', colors: ['R'],
    });
    expect(bolt.ok).toBe(true);
    if (!bolt.ok) return;
    expect(bolt.source).toBe('printed-only');
    expect(bolt.script).toBeUndefined();
    expect(bolt.compiled).toEqual([]);
    expect(bolt.unread).toEqual([
      { line: 'Do something no reader here understands at all.', why: 'no-reader' },
    ]);
  });

  /*
    ── Triggered abilities: compared by what they DO, not by what they say ────────────────────────

    The keyword tests above compare fields, which works because a keyword's fragment is data. A
    triggered ability's is a closure, and two closures cannot be compared — so the check that
    matters is **behavioural**: run the compiled effect and the hand-written one against the same
    game state and assert the resulting states are identical.

    That is a stronger test than comparing `description` strings, and it has to be, because the pool
    is not consistent about descriptions: Kitchen Finks stores the clause ("you gain 2 life") and
    Aether Hub stores the whole printed line including the "When ~ enters the battlefield" part that
    `on` already carries. Comparing those strings would fail on a compiler that was right.
  */
  describe('the effects it builds do what the hand-written ones do', () => {
    /**
     * A context both effects are handed, so the comparison is about the effects and nothing else.
     *
     * The `as EffectContext` cast is the thing D362 warns about — a cast is a claim the compiler
     * stops checking — so it is worth saying why it is sound here rather than hoping. Both sides
     * receive **the same object**, so a field this omits is a field neither effect can read, and
     * the comparison stays a comparison. It would be unsound if the two effects were given
     * different contexts, or if the assertion were about the context instead of the output.
     */
    const contextOn = (state: GameState, seat: SeatIndex, source: string): EffectContext =>
      ({ state, controller: seat, source } as unknown as EffectContext);

    /** The one ETB trigger a card's hand-written script has whose clause this compiler reads. */
    const etbOf = (script: unknown) =>
      ((script as { triggers?: readonly { on?: { kind?: string }; effect?: unknown }[] }).triggers
        ?? []).filter((t) => t.on?.kind === 'etb');

    /*
      Seat 1 holds a card, and that detail is load-bearing rather than scenery.

      The first version of this test used a bare `arena()`, whose hands are empty — so Ravenous
      Rats' "each opponent discards a card at random" discarded nothing, both effects returned the
      state unchanged, and `toEqual` passed on two functions that had done nothing. A comparison
      between two no-ops is not evidence. The non-vacuity assertion below is what caught it, and
      the fixture is what fixes it: the effect has to have something to do.
    */
    const board = () => arena({ hands: { 1: ['Grizzly Bears'] } });

    it.each([
      ['Kitchen Finks', 'you gain 2 life'],
      ['Elvish Visionary', 'draw a card'],
      ['Aether Hub', 'you get {E}'],
    ])('%s: the compiled effect leaves the same state as the written one', (card) => {
      const written = etbOf(scriptFor(card as string));
      expect(written.length, `${card as string} has no hand-written ETB trigger`).toBe(1);
      const compiled = etbOf(compiledScript(card as string).script);
      expect(compiled.length, `${card as string} compiled no ETB trigger`).toBe(1);

      const base = board();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = (compiled[0]!.effect as (c: EffectContext) => GameState)(ctx);
      const theirs = (written[0]!.effect as (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual(theirs);
      // And it is not vacuous: the effect has to have changed something about the state.
      expect(mine).not.toEqual(base);
    });

    it('defers a draw so a dredge can replace it, which is what drawLater is for', () => {
      /*
        `drawLater`'s docblock allows itself only for "a draw that is the last thing the card does",
        and says a compiler cannot tell that apart from a draw something reads afterwards. This one
        can, because it matches the clause only when the clause is the draw and nothing else — so
        the condition holds by construction. Checked here as the observable difference between the
        two primitives: `draw` takes the card now, `drawLater` records a draw owed.
      */
      const visionary = etbOf(compiledScript('Elvish Visionary').script);
      const base = arena();
      const after = (visionary[0]!.effect as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      /*
        `drawsOwed` is a flat list of seat indices, one entry per card owed — not a count per seat.
        Read as `drawsOwed[0]` it would be the *seat* that is owed the first card, which for seat 0
        is the number 0, and `?? 0` would have hidden the mistake behind a passing-looking compare.
      */
      expect(after.drawsOwed.filter((seat) => seat === 0)).toHaveLength(1);
      // Nothing left the library yet, which is the whole point of the deferral.
      expect(Object.keys(after.instances).length).toBe(Object.keys(base.instances).length);
    });

    it('reads the trigger it built as watching its own arrival, spelled out', () => {
      // `who` defaults to 'self' in `automation.ts`, so `{ kind: 'etb' }` means the same thing —
      // but a generated script is read by people, so it says which one it means.
      const finks = etbOf(compiledScript('Kitchen Finks').script);
      expect(finks[0]!.on).toEqual({ kind: 'etb', who: 'self' });
    });

    it('leaves a clause it cannot read alone, rather than compiling half of it', () => {
      /*
        The example has moved once already: it was "exile target creature", and D404 reads that, so
        the row is now Rest in Peace's sweep — a clause with no reader and no near miss. The
        property is the one that has not changed: a line this module cannot read is **reported**,
        and the card is a manual object inside an automated game (D362), rather than compiling the
        half of it that does read.
      */
      const banisher = compileCard({
        name: 'Reader Test', type_line: 'Creature — Human', mana_cost: '{3}', cmc: 3,
        power: '2', toughness: '2', colors: [],
        oracle_text: 'When Reader Test enters the battlefield, exile all cards from all graveyards.',
      });
      expect(banisher.ok).toBe(true);
      if (!banisher.ok) return;
      expect(banisher.script).toBeUndefined();
      expect(banisher.unread).toEqual([
        {
          line: 'When Reader Test enters the battlefield, exile all cards from all graveyards.',
          why: 'no-reader',
        },
      ]);
    });

    it('reads a count printed as a word and as a digit', () => {
      // Magic writes a count as a word when it is a number of objects and as a digit when it is an
      // amount, so both forms turn up in one pool: "draw two cards", "you gain 2 life".
      const words = compileCard({
        name: 'Word Count', type_line: 'Creature — Human', mana_cost: '{3}', cmc: 3,
        power: '1', toughness: '1', colors: [],
        oracle_text: 'When Word Count enters the battlefield, draw two cards.',
      });
      expect(words.ok && words.unread).toEqual([]);
      const base = arena();
      const trigger = etbOf((words as { script?: unknown }).script)[0]!;
      const after = (trigger.effect as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      expect(after.drawsOwed.filter((seat) => seat === 0)).toHaveLength(2);
    });
  });

  /*
    ── Spells, and the targets they point with ───────────────────────────────────────────────────

    An instant or sorcery has no trigger: its text is one resolution, stored as `onResolve` plus
    whatever it has to point at. So the comparison against a hand-written spell has three parts, and
    the third is the one that would be easiest to leave out.
  */
  describe('spells: the resolution, the target spec, and the bot hints', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    it('Doom Blade points at a nonblack creature in both readings (D576)', () => {
      /*
        Out of the row below since it gained a filter: `toEqual` compares a filter by identity, and
        the compiled card builds its own. So the two are compared by what they admit.
      */
      const written = (field(scriptFor('Doom Blade'), 'targets') as readonly TargetSpec[])[0]!;
      const compiled = (field(compiledScript('Doom Blade').script, 'targets') as readonly TargetSpec[])[0]!;
      expect([compiled.kind, compiled.description]).toEqual([written.kind, written.description]);
      expect(compiled.description).toBe('target nonblack creature');
      const board = arena({
        decks: { 0: 'rot-harvest', 1: 'rot-harvest' },
        battlefield: { 1: ['Drudge Skeletons', 'Centaur Courser'] },
      });
      const black = find(board, 1 as SeatIndex, 'battlefield', 'Drudge Skeletons');
      const green = find(board, 1 as SeatIndex, 'battlefield', 'Centaur Courser');
      for (const spec of [written, compiled]) {
        expect(spec.filter!(board, { kind: 'card', id: black }, 0 as SeatIndex, 'x')).toBe(false);
        expect(spec.filter!(board, { kind: 'card', id: green }, 0 as SeatIndex, 'x')).toBe(true);
      }
    });

    it.each([
      ['Lightning Bolt'],
      ['Giant Growth'],
      ['Unsummon'],
      ['Divination'],
    ])('%s points at what the hand-written spell points at', (card) => {
      const written = scriptFor(card as string);
      const compiled = compiledScript(card as string).script;
      expect(compiled, `${card as string} compiled to no script`).toBeDefined();
      expect(field(compiled, 'targets')).toEqual(field(written, 'targets'));
    });

    /*
      The bot hints, which are the same trap D364 found on Calciderm, in a second place.

      `Doom Blade` sets `removesACreature: true` and `Giant Growth` sets `expiresAtEndOfTurn: true`
      beside their effects: do not cast this with nothing of theirs to point at, and hold this for
      the combat. A compiler that emitted only the effect would build a card that **works** and
      **plays badly** — and that is worse than an unread line, because an unread line is flagged for
      a human to play by hand (D362) and a badly played one is flagged nowhere.
    */
    it.each([
      ['Doom Blade', 'removesACreature'],
      ['Giant Growth', 'expiresAtEndOfTurn'],
    ])('%s carries its %s hint, as the hand-written card does', (card, flag) => {
      const written = scriptFor(card as string);
      expect(field(written, flag as string), `${card as string} does not set ${flag as string}`).toBe(true);
      expect(field(compiledScript(card as string).script, flag as string)).toBe(true);
    });

    /*
      `friendly` cannot be read off the target phrase — "target creature" is the same four words on
      a Doom Blade and a Giant Growth — so it is a fact about the effect. D252 added the flag
      because the bot's default is "the enemy and the enemy's creatures", which means a pump that
      forgets it buffs the creature it is about to kill. Wrong in a way nothing refuses.
    */
    it('marks a pump friendly and removal hostile, which the phrase alone cannot say', () => {
      const growth = field(compiledScript('Giant Growth').script, 'targets') as
        readonly { friendly?: boolean }[];
      const blade = field(compiledScript('Doom Blade').script, 'targets') as
        readonly { friendly?: boolean }[];
      expect(growth[0]?.friendly).toBe(true);
      expect(blade[0]?.friendly).toBeUndefined();
    });

    it.each([
      ['Lightning Bolt'],
      ['Doom Blade'],
      ['Giant Growth'],
      ['Unsummon'],
    ])('%s resolves to the same state as the hand-written spell', (card) => {
      const base = arena({ battlefield: { 1: ['Grizzly Bears'] }, turn: 3 });
      const victim = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: victim }]);
      const mine = (field(compiledScript(card as string).script, 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      const theirs = (field(scriptFor(card as string), 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous: pointing a removal spell at a creature has to change the board.
      expect(mine).not.toEqual(base);
    });

    it('compiles a spell whole or not at all, never half of it', () => {
      /*
        The invariant, with an example whose second clause genuinely has no reader.

        This test used to use "Scry 1, then draw a card.", which was unreadable when the spell path
        took one clause and refused anything longer. That restriction is gone — the parts compose
        now — so the example stopped testing the invariant and started testing the restriction. The
        invariant is what matters: **all of a spell's resolution, or none of it.**

        The example has been changed once more, and for the same reason as last time: it was
        "Draw two cards, then discard two cards." — Faithless Looting — and D413 reads that card
        whole now, so the row stopped testing the invariant and started asserting a gap that had
        closed. The invariant is what matters and it has not moved: **all of a spell's resolution,
        or none of it.**

        "Draw two cards, then put a card from your hand on top of your library." is the same shape
        with a second clause this module genuinely cannot read. A compiler that drew the cards and
        skipped the rest would be a strictly better Divination — a wrong card rather than an unread
        one, and wrong in a way nothing at the table would flag.
      */
      const text = 'Draw two cards, then put a card from your hand on top of your library.';
      const half = compileCard({
        name: 'Half Reader', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: text,
      });
      expect(half.ok).toBe(true);
      if (!half.ok) return;
      expect(half.script).toBeUndefined();
      expect(half.source).toBe('printed-only');
      expect(half.unread).toEqual([{ line: text, why: 'no-reader' }]);
    });

    it('runs a composed resolution in printed order, each part on the state before it', () => {
      /*
        Two clauses in one sentence, which is how Magic writes a sequence.

        What this proves, stated precisely rather than generously: the state is **threaded**. Both
        effects are present in the result, so a composition that handed every part the original
        state and returned the last one's output would lose the life gain, and one that returned the
        first's would lose the draw. Checked by breaking the reduce both ways — this test and the
        two-line one below both fail.

        What it does **not** prove is order-sensitivity, and the two clauses are the reason: gaining
        life and owing a draw are independent, so running them in either order leaves the same
        state. Nothing in the current vocabulary has an order-observable pair — a scry reorders a
        library the deferred draw has not touched yet — so there is no test for order here, and
        saying so is better than implying one.
      */
      const sequence = compileCard({
        name: 'Ordered', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: 'You gain 2 life, then draw a card.',
      });
      expect(sequence.ok).toBe(true);
      if (!sequence.ok) return;
      expect(sequence.unread).toEqual([]);

      const base = arena();
      const after = (field(sequence.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life + 2);
      expect(after.drawsOwed.filter((seat) => seat === 0)).toHaveLength(1);
    });

    it('composes a spell written across two lines, when both of them read', () => {
      const twoLines = compileCard({
        name: 'Two Liner', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: 'Draw two cards.\nYou gain 2 life.',
      });
      expect(twoLines.ok).toBe(true);
      if (!twoLines.ok) return;
      expect(twoLines.unread).toEqual([]);
      const base = arena();
      const after = (field(twoLines.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // In hand rather than owed, because a clause follows the draw: see the draw-position test
      // below for why the reading depends on what comes after it.
      expect(after.zones[zoneKey(0 as SeatIndex, 'hand')]).toHaveLength(2);
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life + 2);
    });

    it('refuses a spell whose two halves each want their own target', () => {
      /*
        `CardScript.targets` is one list for the whole spell, filled once before resolution. Two
        parts each wanting a target of their own — "Target creature you control fights target
        creature you don't control" is the printed shape — would silently be handed the **same**
        target by a composition that merged them. A wrong card, not an unread one, so it is refused.
      */
      const two = compileCard({
        name: 'Two Targets', type_line: 'Instant', mana_cost: '{2}{B}', cmc: 3, colors: ['B'],
        oracle_text: 'Destroy target creature.\nReturn target creature to its owner\u2019s hand.',
      });
      expect(two.ok).toBe(true);
      if (!two.ok) return;
      expect(two.script).toBeUndefined();
      expect(two.unread).toHaveLength(2);
    });
  });

  /*
    ── The vocabulary this stage added ────────────────────────────────────────────────────────────

    Five target phrases and the families they unlock, each checked against the card in the pool that
    prints it. The point of comparing against a hand-written spec rather than against a literal is
    that a literal is something this test and the compiler could both be wrong about in the same
    way; the hand-written spec is what the engine has been playing for 130 tasks.
  */
  describe('the target phrases and effect families this stage added', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    /*
      The four whose spec is identical to the hand-written one, object for object.

      `Mizzium Mortars` is the strongest of them: its hand-written spec is
      `{ ...TARGET_CREATURE, description: "target creature you don't control", filter:
      creatureYouDontControl }`, and the compiler reaches the same filter *function* — not a copy of
      it — so `toEqual` is comparing the real thing rather than two descriptions of it.
    */
    it.each([
      ['Counterspell'],
      ['Tome Scour'],
      ['Raise Dead'],
      ['Murder'],
      ['Mizzium Mortars'],
    ])('%s points at exactly the spec the hand-written spell points at', (card) => {
      const written = scriptFor(card as string);
      const compiled = compiledScript(card as string).script;
      expect(compiled, `${card as string} compiled to no script`).toBeDefined();
      expect(field(compiled, 'targets')).toEqual(field(written, 'targets'));
    });

    /*
      The typed-permanent phrases, whose filter is a function the compiler builds rather than one it
      can borrow — so the spec is compared by what a player reads and the filter by what it admits.

      Both halves matter and for different reasons. Admitting the artifact is what makes the card
      castable at all; **rejecting the creature** is what stops a Disenchant pointing at a Grizzly
      Bears, which is a card that works and is not the card. A filter that returned `true` would
      pass a test that only checked the first half.
    */
    it('builds a filter for "target artifact or enchantment" that admits one and refuses a creature', () => {
      const written = scriptFor('Disenchant');
      const spec = (field(compiledScript('Disenchant').script, 'targets') as
        readonly TargetSpec[])[0]!;
      const theirs = (field(written, 'targets') as readonly TargetSpec[])[0]!;
      expect(spec.kind).toBe(theirs.kind);
      expect(spec.description).toBe(theirs.description);

      const board = arena({ battlefield: { 0: ['Bonesplitter'], 1: ['Grizzly Bears'] } });
      const equipment = find(board, 0 as SeatIndex, 'battlefield', 'Bonesplitter');
      const bear = find(board, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const admits = (id: string) =>
        spec.filter?.(board, { kind: 'card', id }, 0 as SeatIndex) ?? false;
      expect(admits(equipment)).toBe(true);
      expect(admits(bear)).toBe(false);
      // And the hand-written filter agrees on both, which is what makes this a comparison.
      expect(theirs.filter?.(board, { kind: 'card', id: equipment }, 0 as SeatIndex)).toBe(true);
      expect(theirs.filter?.(board, { kind: 'card', id: bear }, 0 as SeatIndex)).toBe(false);
    });

    it('reads a phrase printed with a typographic apostrophe, which 23 pool cards use', () => {
      /*
        `plain` normalises the apostrophe, and this is the test that makes that claim falsifiable.

        The pool spells the same construct both ways — Unsummon prints "its owner's hand" with an
        ASCII apostrophe, Journey to Nowhere prints "its owner’s control" with a typographic one,
        21 cards to 23. Every card the compiler reads today happens to be in the ASCII half, so
        deleting `plain` broke nothing and passed all 59 tests, which is exactly the kind of
        unpinned claim this file exists to catch. The bulk corpus #318 imports is the typographic
        half, so the reader has to work on text spelled that way, and here it is spelled that way.
      */
      const curly = compileCard({
        name: 'Curly Unsummon', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: 'Return target creature to its owner\u2019s hand.',
      });
      expect(curly.ok).toBe(true);
      if (!curly.ok) return;
      expect(curly.unread).toEqual([]);
      // The same spec the ASCII-spelled Unsummon in the pool compiles to.
      expect(field(curly.script, 'targets')).toEqual(field(scriptFor('Unsummon'), 'targets'));
    });

    it('mills the player the hand-written Tome Scour mills, the same number of cards', () => {
      const base = arena();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 1 as SeatIndex }]);
      const mine = (field(compiledScript('Tome Scour').script, 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      const theirs = (field(scriptFor('Tome Scour'), 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous: five cards left seat 1's library, and the count is read rather than assumed.
      expect(mine.zones[zoneKey(1 as SeatIndex, 'graveyard')]).toHaveLength(5);
      expect(mine).not.toEqual(base);
    });

    it('returns the creature card the hand-written Raise Dead returns', () => {
      // Seat 0's default deck has no Grizzly Bears, and `arena` pulls a named card out of that
      // seat's library; the controller has to be the seat holding the graveyard this points into.
      const base = arena({ decks: { 0: 'verdant-guard' }, graveyard: { 0: ['Grizzly Bears'] } });
      const dead = find(base, 0 as SeatIndex, 'graveyard', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: dead }]);
      const mine = (field(compiledScript('Raise Dead').script, 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      const theirs = (field(scriptFor('Raise Dead'), 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous: the card is in hand afterwards and out of the graveyard.
      expect(mine.zones[zoneKey(0 as SeatIndex, 'hand')]).toContain(dead);
      expect(mine.zones[zoneKey(0 as SeatIndex, 'graveyard')]).not.toContain(dead);
    });

    /*
      Counterspell's effect is compared by its spec and not by resolving it, and the reason is worth
      stating rather than leaving as a gap: countering needs a spell on the stack, and `arena` builds
      boards, not stacks. The hand-written effect is already exercised against a real stack by the
      whole-game playout tests; what this stage could get wrong is the *spec* — pointing a
      counterspell at a creature on the battlefield rather than at an object on the stack — and that
      is what the equality above checks. Writing a resolution check that passed because
      `counterSpell` no-ops on a card that is not on the stack would be a check that cannot fail.
    */
    it('reads "destroy target creature" as removal the bot will hold, and a Disenchant as not', () => {
      /*
        `removesACreature` is advice to the bot: do not cast this with nothing of theirs to point
        at. It is true of Murder and false of Disenchant, and the printed sentences differ only in
        the target phrase — so a compiler that set the flag for the whole `destroy` family would
        have the bot holding a Disenchant for a board of creatures it cannot answer.
      */
      expect(field(scriptFor('Murder'), 'removesACreature')).toBe(true);
      expect(field(compiledScript('Murder').script, 'removesACreature')).toBe(true);
      expect(field(scriptFor('Disenchant'), 'removesACreature')).toBeUndefined();
      expect(field(compiledScript('Disenchant').script, 'removesACreature')).toBeUndefined();
    });

    it('composes a spell printed as two sentences on one line, as Thought Scour is', () => {
      /*
        "Target player mills two cards. Draw a card." — one printed line, two clauses, and before
        this stage the resolution reader split only on `, then `, so the whole line went unread.

        ## The one place the compiler and the hand-written card genuinely differ

        Compared clause by clause rather than by state equality, because the two **do** differ and
        hiding that behind a looser assertion would be the worse choice. The hand-written Thought
        Scour calls `draw`; the compiler calls `drawLater`, which owes the card instead of putting
        it in hand. Both are legal and several hand-written cards use the deferred form; it is the
        better of the two here, because only a deferred draw can be replaced by a dredge
        (CR 702.52a), and `composeEffects` now refuses a deferred draw anywhere but last, which is
        the condition `drawLater` requires.

        So what is asserted is that both halves happen, in both scripts, with the same numbers —
        and that the difference is *when the card arrives*, not what the card does.
      */
      const compiled = compiledScript('Thought Scour');
      expect(compiled.unread).toEqual([]);
      const base = arena();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 1 as SeatIndex }]);
      const mine = (field(compiled.script, 'onResolve') as (c: EffectContext) => GameState)(ctx);
      const theirs = (field(scriptFor('Thought Scour'), 'onResolve') as
        (c: EffectContext) => GameState)(ctx);

      // The mill: identical, and read rather than assumed.
      expect(mine.zones[zoneKey(1 as SeatIndex, 'graveyard')]).toHaveLength(2);
      expect(theirs.zones[zoneKey(1 as SeatIndex, 'graveyard')]).toHaveLength(2);
      // The draw: one card either owed or held, one card each way, and neither state is the base.
      expect(mine.drawsOwed.filter((seat) => seat === 0)).toHaveLength(1);
      expect(theirs.zones[zoneKey(0 as SeatIndex, 'hand')]).toHaveLength(1);
      expect(mine).not.toEqual(base);
    });

    it('draws now when a clause follows the draw, and owes the card when none does', () => {
      /*
        The one family that is read two ways, and the reason is `drawLater`: it owes the card rather
        than putting it in hand, which is the better primitive (only a deferred draw can be replaced
        by a dredge, CR 702.52a) and is only safe where nothing after it needs to see what was
        drawn.

        The first version of this guard refused any card whose draw was not last, which turned a
        dependency hazard into a coverage hole and broke a card — "Draw two cards. You gain 2 life."
        — that was never in danger. Offering both readings costs nothing and is right in both
        positions: "Draw a card. Scry 2." really does draw before it scries.

        **Which half of the script to read moved in D418**, and the reason is this very fixture. A
        question is asked before the resolution runs, so a composition now splits at its first
        question: the draw goes to `beforeDecisions` and the scry — whose own effect is the identity
        — leaves no `onResolve` at all. The claim this row makes is unchanged and is now true of a
        real player rather than only of the clause order: the card is **in hand** before the scry is
        offered, where before the split the question was planned against a hand that had not grown.
      */
      const drawFirst = compileCard({
        name: 'Draw Then Scry', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: 'Draw a card. Scry 2.',
      });
      expect(drawFirst.ok).toBe(true);
      if (!drawFirst.ok) return;
      expect(drawFirst.unread).toEqual([]);

      const base = arena();
      const after = (field(drawFirst.script, 'beforeDecisions') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // Drawn, not owed: the scry that follows has to be looking at the library the draw left.
      expect(after.zones[zoneKey(0 as SeatIndex, 'hand')]).toHaveLength(1);
      expect(after.drawsOwed.filter((seat) => seat === 0)).toHaveLength(0);
      // And nothing is left to run afterwards, because the scry is the whole of what remains.
      expect(field(drawFirst.script, 'onResolve')).toBeUndefined();

      // And the control, the same two clauses the other way round: nothing follows the draw, so it
      // is owed — which is what Thought Scour above relies on.
      const drawLast = compileCard({
        name: 'Scry Then Draw', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: 'Scry 2. Draw a card.',
      });
      expect(drawLast.ok).toBe(true);
      if (!drawLast.ok) return;
      const owed = (field(drawLast.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      expect(owed.zones[zoneKey(0 as SeatIndex, 'hand')]).toHaveLength(0);
      expect(owed.drawsOwed.filter((seat) => seat === 0)).toHaveLength(1);
    });
  });

  /*
    ── A keyword nobody implemented is not an unread sentence ─────────────────────────────────────
  */
  it.each([
    ['Mogg War Marshal', 'Echo {1}{R} — pay it or sacrifice this permanent'],
    ['Distortion Strike', 'cast it from exile without paying its mana cost'],
  ])('%s gets the trigger its keyword is half of', (card, description) => {
    /*
      Found by breaking the readers: dropping `echoTrigger` from the echo row and `reboundCast`
      from the rebound row left every test green. Both keywords are a declaration **plus** a
      trigger — an echo cost the game never asks for, a rebound that never offers the second cast —
      and the declaration on its own compared equal to the hand-written field, which is the only
      thing the table above looks at.

      Asserted in the direction the table cannot: a trigger the hand-written card has must be among
      the compiled ones. The table's own trigger test runs the other way, so that a compiler which
      *invents* a trigger fails, and both directions are needed.
    */
    const shape = (s: unknown) =>
      ((s as { triggers?: readonly { description?: string }[] }).triggers ?? [])
        .map((t) => t.description ?? '');
    expect(shape(scriptFor(card as string)), `${card as string}: not the hand-written description`)
      .toContain(description as string);
    expect(shape(compiledScript(card as string).script), `${card as string}: trigger not compiled`)
      .toContain(description as string);
  });

  describe('soulbond, a team pump and an opponent-only phrase', () => {
    const field = (script: unknown, key: string): unknown =>
      (script as Record<string, unknown> | undefined)?.[key];

    it.each([
      ['Trusted Forcemage'],
      ['Wolfir Silverheart'],
    ])('%s reads its soulbond off both printed lines', (card) => {
      /*
        The bonus is on the second line, which is why `keywordScriptFor` refused the keyword on its
        own: a number guessed from the word "Soulbond" would be invented (D259). Both lines together
        are the mechanic, so the shape emits both halves — the declaration and `soulbondTriggers` —
        or neither.
      */
      const compiled = compiledScript(card as string);
      expect(field(compiled.script, 'soulbond'))
        .toEqual(field(scriptFor(card as string), 'soulbond'));
      // And the pairing triggers, without which the bonus has nothing to hang from.
      const descriptions = (script: unknown) =>
        ((field(script, 'triggers') ?? []) as readonly { description?: string }[])
          .map((t) => t.description ?? '');
      for (const written of descriptions(scriptFor(card as string))) {
        expect(descriptions(compiled.script), `${card as string}: missing "${written}"`)
          .toContain(written);
      }
      // Two printed lines, both accounted for: these two cards are nothing else.
      expect(compiled.unread).toEqual([]);
      expect(fullyCompiled(compiled)).toBe(true);
    });

    it('refuses the soulbond that hands out an ability instead of a body', () => {
      /*
        Tandem Lookout's pair does not get bigger, it draws a card — "each of those creatures has
        'Whenever this creature deals damage to an opponent, draw a card'". The pool declares that as
        `grants: [0]` against a `grantedTriggers` entry, and nothing here can build one. Compiling
        it as a pair that gets *nothing* would be a card that works and does half of what it says.
      */
      const lookout = compiledScript('Tandem Lookout');
      expect(field(lookout.script, 'soulbond')).toBeUndefined();
      expect(lookout.unread.map((u) => u.line).some((l) => /^Soulbond$/i.test(l))).toBe(true);
    });

    it("reads Master of Pearls' turn-up, which pumps the team rather than a list", () => {
      /*
        `pumpTeam` and not `pump` over the creatures currently out: the scope is "creatures you
        control" as a continuous effect, so a creature that arrives later in the turn is not
        included and one that leaves does not carry the bonus away. Comparing the boards is what
        tells the two apart.
      */
      const base = arena({
        decks: { 0: 'forge-alliance' }, battlefield: { 0: ['Elite Vanguard', 'Doomed Traveler'] },
        turn: 3,
      });
      const source = find(base, 0 as SeatIndex, 'battlefield', 'Elite Vanguard');
      const ctx = { state: base, controller: 0 as SeatIndex, source, targets: [] } as
        unknown as EffectContext;
      const only = (script: unknown) =>
        ((field(script, 'triggers') ?? []) as readonly TriggerDef[])
          .find((t) => t.description === 'creatures you control get +2/+2 until end of turn');
      const written = only(scriptFor('Master of Pearls'));
      const compiled = only(compiledScript('Master of Pearls').script);
      expect(written, 'no hand-written turn-up').toBeDefined();
      expect(compiled, 'compiled no turn-up').toBeDefined();
      if (written === undefined || compiled === undefined) return;
      expect(compiled.on).toEqual(written.on);
      expect(compiled.effect(ctx)).toEqual(written.effect(ctx));
      expect(compiled.effect(ctx), 'the team pump changed nothing').not.toEqual(base);
    });

    it("reads Ainok Survivalist's phrase, which may not point at your own Sol Ring", () => {
      /*
        The restriction is the card. This trigger is **mandatory**, so a morph turned up on a board
        with nothing else on it would have to destroy its controller's own artifact — which is why
        the hand-written filter tests the controller as well as the two types, and why a compiled
        version with only the types would be a strictly worse card that never refuses.

        The filter is a closure, so what is compared is the printed description and then the filter
        itself, run against one artifact on each side of the table.
      */
      const spec = (script: unknown) =>
        ((field(script, 'triggers') ?? []) as readonly TriggerDef[])
          .flatMap((t) => t.targets ?? [])[0];
      const written = spec(scriptFor('Ainok Survivalist'));
      const compiled = spec(compiledScript('Ainok Survivalist').script);
      expect(written, 'no hand-written target').toBeDefined();
      expect(compiled, 'compiled no target').toBeDefined();
      if (written === undefined || compiled === undefined) return;
      expect(compiled.description).toBe(written.description);

      const base = arena({
        decks: { 0: 'forge-alliance', 1: 'forge-alliance' },
        battlefield: { 0: ['Bonesplitter'], 1: ['Bonesplitter', 'Elite Vanguard'] },
        turn: 3,
      });
      const mine = find(base, 0 as SeatIndex, 'battlefield', 'Bonesplitter');
      const theirs = find(base, 1 as SeatIndex, 'battlefield', 'Bonesplitter');
      // An opponent's **creature**, which is the row that tests the types rather than the side.
      const theirBody = find(base, 1 as SeatIndex, 'battlefield', 'Elite Vanguard');
      for (const [label, filter] of [['hand-written', written.filter], ['compiled', compiled.filter]] as const) {
        expect(filter, `${label}: no filter at all`).toBeDefined();
        expect(filter?.(base, { kind: 'card', id: theirs }, 0 as SeatIndex, 'c1'), `${label}: theirs`)
          .toBe(true);
        expect(filter?.(base, { kind: 'card', id: mine }, 0 as SeatIndex, 'c1'), `${label}: mine`)
          .toBe(false);
        expect(
          filter?.(base, { kind: 'card', id: theirBody }, 0 as SeatIndex, 'c1'),
          `${label}: an opponent's creature is not an artifact or an enchantment`,
        ).toBe(false);
      }
    });
  });

  describe('statics, a Fog and a library search, against the hand-written ones', () => {
    const field = (script: unknown, key: string): unknown =>
      (script as Record<string, unknown> | undefined)?.[key];

    it.each([
      // `Creatures you control get +1/+1.` — the whole card.
      ['Glorious Anthem'],
      // `Other creatures you control get +1/+0.` — the word "other" is the scope, and Judith is a
      // 2/2: collapse the two scopes and she becomes a 3/2.
      ['Judith, the Scourge Diva'],
    ])('%s builds the static the hand-written card builds', (card) => {
      expect(field(compiledScript(card as string).script, 'statics'))
        .toEqual(field(scriptFor(card as string), 'statics'));
    });

    it('reads the two scopes apart, which is what the word "other" is for', () => {
      /*
        Asserted directly as well as through the equality above, because the two scopes differ by
        one word in the print and by one string in the script — the kind of pair where a passing
        deep-equality can hide a reader that got both rows from the same branch.
      */
      const scopes = (card: string) =>
        (field(compiledScript(card).script, 'statics') as readonly { scope: string }[])
          .map((entry) => entry.scope);
      expect(scopes('Glorious Anthem')).toEqual(['controller-creatures']);
      expect(scopes('Judith, the Scourge Diva')).toEqual(['other-controller-creatures']);
    });

    it('accumulates two printed statics instead of calling them a conflict', () => {
      /*
        No card in the pool prints two, which is exactly why this is a fixture: `statics` was added
        to the accumulating set *before* a card needed it, and an untested mechanism is the one that
        is wrong when the corpus finally reaches it. Two anthems is a legal, ordinary card, and the
        wrong answer here is `field-conflict` on the second line — which is what `merge` reported
        for `abilities` until a pain land found it (D378).
      */
      const twice = compileCard({
        name: 'Nonesuch', type_line: 'Enchantment', mana_cost: '{3}{W}', cmc: 4, colors: ['W'],
        oracle_text: 'Creatures you control get +1/+1.\nOther creatures you control get +0/+1.',
      });
      expect(twice.ok).toBe(true);
      if (!twice.ok) return;
      expect(twice.unread).toEqual([]);
      expect(field(twice.script, 'statics')).toEqual([
        { scope: 'controller-creatures', effect: { power: 1, toughness: 1 } },
        { scope: 'other-controller-creatures', effect: { toughness: 1 } },
      ]);
    });

    it.each([['Fog'], ['Holy Day']])('%s prevents the combat and says so to the bot', (card) => {
      /*
        Two fields, and the second is not decoration: nothing in the engine reads `preventsDamage`,
        the bot does. A Fog without it works perfectly and gets cast into an empty board, which is
        the same trap as `protectsACreature` (D379) and `removesACreature` before it.
      */
      expect(field(compiledScript(card as string).script, 'preventsDamage')).toBe(true);
      const base = arena({ battlefield: { 1: ['Grizzly Bears'] }, turn: 3 });
      const ctx = { state: base, controller: 0 as SeatIndex, source: 'c1', targets: [] } as
        unknown as EffectContext;
      const mine = (field(compiledScript(card as string).script, 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual((field(scriptFor(card as string), 'onResolve') as
        (c: EffectContext) => GameState)(ctx));
      expect(mine, 'preventing nothing').not.toEqual(base);
    });

    it.each([
      // Tutor to hand, with no filter at all.
      ['Diabolic Tutor', 'Search your library for a card'],
      // And onto the battlefield tapped, with the basic-land filter.
      ['Rampant Growth', 'Search your library for a basic land card'],
    ])('%s asks the search the hand-written card asks', (card, prompt) => {
      /*
        Compared field by field rather than deep: Rampant Growth's decision carries a `filter`
        closure. The fields here are the whole of the question a player is shown — who is asked,
        which zone, what it says, and how many cards may be taken — and `min: 0` is the one that
        matters most, because a search you may decline is a different card from one you may not.

        The printed "then shuffle" is deliberately absent from both: `searchYourLibrary` shuffles
        when the search ends, and `clausesOf` hands the bare word to a reader that does nothing.
      */
      const only = (script: unknown) =>
        (field(script, 'decisions') as readonly Record<string, unknown>[] | undefined)?.[0];
      const mine = only(compiledScript(card as string).script);
      const written = only(scriptFor(card as string));
      expect(mine, `${card as string}: compiled no decision`).toBeDefined();
      expect(written, `${card as string}: no hand-written decision`).toBeDefined();
      for (const key of ['who', 'from', 'prompt', 'min', 'max']) {
        expect(mine?.[key], `${card as string}: ${key}`).toEqual(written?.[key]);
      }
      expect(mine?.['prompt']).toBe(prompt as string);
      // The filter travels with the question, and only one of the two cards has one.
      expect(typeof mine?.['filter']).toBe(typeof written?.['filter']);
    });
  });

  it('reads Crew off the Vehicle the pool crews, closures and all', () => {
    /*
      The one keyword row that is an **ability** rather than a declaration, so it cannot be deep
      compared: an `AbilityDef` holds a closure. What is compared instead is everything that is not
      one — the cost, the printed description and `animates` — plus the board the effect leaves,
      which is where a different builder or a different argument would show up.

      `animates: true` is in the comparison deliberately. It is the bot rule that travels with crew
      (do not press this unless there is an attack or a block to make), and a Vehicle that animates
      itself at a random moment has spent its crew for nothing. Same family as D364's hints.
    */
    const written = ((scriptFor('Sky Skiff') as unknown as
      { abilities?: readonly AbilityDef[] }).abilities ?? [])[0];
    const compiled = ((compiledScript('Sky Skiff').script as unknown as
      { abilities?: readonly AbilityDef[] }).abilities ?? [])[0];
    expect(written, 'no hand-written crew ability').toBeDefined();
    expect(compiled, 'compiled no crew ability').toBeDefined();
    if (written === undefined || compiled === undefined) return;
    expect(compiled.cost).toEqual(written.cost);
    expect(compiled.description).toBe(written.description);
    expect(compiled.animates).toBe(written.animates);

    const base = arena({
      decks: { 0: 'forge-alliance' }, battlefield: { 0: ['Sky Skiff'] }, turn: 3,
    });
    const source = find(base, 0 as SeatIndex, 'battlefield', 'Sky Skiff');
    const ctx = { state: base, controller: 0 as SeatIndex, source, targets: [] } as
      unknown as EffectContext;
    expect(compiled.effect?.(ctx)).toEqual(written.effect?.(ctx));
    expect(compiled.effect?.(ctx), 'crewing changed nothing').not.toEqual(base);
  });

  describe('keyword declarations, which are a different kind of incomplete', () => {
    it('reads the resolution of a spell whose keyword line it cannot build, and names the keyword', () => {
      /*
        Before `isKeywordDeclaration`, a keyword line fell into the resolution, and the resolution
        is all-or-nothing — so a damage clause this module reads perfectly well was refused by a
        line that is not part of resolving the spell at all. Four pool spells were refused that way.

        The example used to be Thunderous Wrath's `Miracle {R}`, which is now read, so it is a
        keyword the compiler **deliberately** refuses instead: `Kicker {4}`, whose payoff is printed
        on another line. Both halves of the property still hold — the resolution is read, and the
        keyword is reported as the option the card is missing rather than as a broken resolution.
      */
      const kicked = compileCard({
        name: 'Nonesuch', type_line: 'Instant', mana_cost: '{R}', cmc: 1, colors: ['R'],
        oracle_text: 'Kicker {4}\nNonesuch deals 2 damage to any target.',
      });
      expect(kicked.ok).toBe(true);
      if (!kicked.ok) return;
      expect(kicked.script).toBeDefined();
      expect(kicked.unread).toEqual([{ line: 'Kicker {4}', why: 'unimplemented-keyword' }]);
      expect(kicked.compiled).toEqual(['Nonesuch deals 2 damage to any target.']);

      // And Thunderous Wrath, which was this test's example, now compiles whole.
      const wrath = compiledScript('Thunderous Wrath');
      expect(wrath.unread).toEqual([]);
      expect(fullyCompiled(wrath)).toBe(true);
    });

    it('still refuses a spell whose unread line is a sentence, not a keyword', () => {
      /*
        The other side of the same coin, and the one that must not move. A keyword is a cost or a
        modifier, so skipping it leaves a card that plays with one option missing. A sentence is a
        step of the resolution, so skipping it leaves a card that resolves and silently does less
        than it prints — with nothing flagged, which is worse than not reading it at all (D362).
      */
      const half = compileCard({
        name: 'Keyword And A Sentence', type_line: 'Instant', mana_cost: '{R}', cmc: 1,
        colors: ['R'],
        /*
          The sentence was a Fog until the Fog clause became readable, then an edict until that one
          did — which is the right kind of churn and the reason this fixture names its own text
          rather than borrowing a card's: a sentence nothing reads today is a moving target, and the
          property is about the two kinds of unread line rather than about any particular one.
        */
        oracle_text: 'Kicker {4}\nExchange control of two target creatures.',
      });
      expect(half.ok).toBe(true);
      if (!half.ok) return;
      expect(half.script).toBeUndefined();
      expect(half.unread).toEqual([
        { line: 'Kicker {4}', why: 'unimplemented-keyword' },
        { line: 'Exchange control of two target creatures.', why: 'no-reader' },
      ]);
    });

    it('does not mistake an ability word for a keyword, which would throw its ability away', () => {
      /*
        `Magecraft — Whenever you cast or copy an instant or sorcery spell, …` is one triggered
        ability with a label on the front. Treating the line as a declaration would drop the whole
        trigger and report it as a missing option, which is the wrong half of the distinction this
        test exists to hold.
      */
      expect(isKeywordDeclaration('Magecraft — Whenever you cast an instant spell, draw a card'))
        .toBe(false);
      expect(isKeywordDeclaration('Destroy target creature.')).toBe(false);
      expect(isKeywordDeclaration('Prevent all combat damage that would be dealt this turn.'))
        .toBe(false);
      // And the shapes it does recognise, including the two that end in an exclamation mark and a
      // line that lists several keywords at once.
      expect(isKeywordDeclaration('Miracle {R}')).toBe(true);
      expect(isKeywordDeclaration('Equip {1}')).toBe(true);
      expect(isKeywordDeclaration('Enchant creature')).toBe(true);
      expect(isKeywordDeclaration('Flying, first strike')).toBe(true);
      expect(isKeywordDeclaration('For Mirrodin!')).toBe(true);
      // Not a keyword the rules define, so not a declaration — a one-word line is not enough.
      expect(isKeywordDeclaration('Sacrifice')).toBe(false);
    });

    it('counts a keyword with no builder apart from a sentence with no reader', () => {
      /*
        Mizzium Mortars is the pool's clearest case: its printed half compiles, so the card plays,
        and `Overload {6}{R}{R}` is the option it is missing. A badge built on `unread` alone would
        say "move this card by hand" about a card the engine is running.
      */
      const mortars = compiledScript('Mizzium Mortars');
      expect(mortars.script).toBeDefined();
      expect(mortars.unread.map((u) => u.why)).toEqual(['unimplemented-keyword']);
      expect(mortars.unread[0]?.line).toBe('Overload {3}{R}{R}{R}');
    });
  });
  /*
    ── The trigger shapes ────────────────────────────────────────────────────────────────────────

    Until this stage one prologue existed, "When ~ enters the battlefield", so every effect the
    compiler could read was reachable from exactly one place on a card. The table of shapes
    multiplies the effect vocabulary the way composition did (D369): no new effect, much more
    coverage.

    Each row below is a card in the pool that prints that prologue, and the check is the same one
    the rest of this file makes: the compiled trigger has to watch what the hand-written one watches
    and do what it does. Nothing here asserts a literal `on` object — the expected value is read off
    the hand-written card, so a shape copied wrongly fails even if both this test and the compiler
    agree about what the wrong answer looks like.
  */
  describe('trigger shapes, each against the card in the pool that prints it', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets } as unknown as EffectContext);

    /** The deck each card lives in, so `arena` can pull it out of that seat's library. */
    const DECK_OF = new Map<string, string>();
    for (const [id, deck] of Object.entries(STARTER_DECKS)) {
      for (const entry of deck.cards) if (!DECK_OF.has(entry.card.name)) DECK_OF.set(entry.card.name, id);
    }

    const watching = (script: unknown, kind: string) =>
      ((script as { triggers?: readonly TriggerDef[] }).triggers ?? [])
        .find((t) => t.on.kind === kind);

    /*
      `who: 'self'` dropped from both sides before comparing.

      `automation.ts` states it: "`self` is the default, which is why every script written before
      this one still means what it meant." So `{ kind: 'dies' }` and `{ kind: 'dies', who: 'self' }`
      are the same event, and the pool spells it both ways — 30 of its etb triggers bare, 7
      explicit. Normalising the one documented default is what lets this compare the whole `on`
      object rather than only its `kind`, which is the comparison that would have missed a compiler
      emitting `by: 'opponent'` where the card says `by: 'you'`.
    */
    const event = (on: TriggerDef['on']) => {
      const { who, ...rest } = on as { who?: string };
      return JSON.stringify(who === 'self' ? rest : on);
    };

    const ROWS: readonly {
      card: string;
      kind: string;
      /** Set up the board so the effect is observable — see Thermo-Alchemist. */
      prepare?: (state: GameState, source: string) => GameState;
      /** The card says "you may" (D574): both readings are asked the same question first. */
      may?: string;
    }[] = [
      { card: 'Goblin Arsonist', kind: 'dies', may: 'Have it deal 1 damage to any target?' },
      { card: 'Borderland Marauder', kind: 'attacks' },
      // `deals-damage` since D566: the Oracle text is "deals damage to an opponent".
      { card: 'Thieving Magpie', kind: 'deals-damage' },
      { card: 'City of Brass', kind: 'becomes-tapped' },
      { card: 'Guttersnipe', kind: 'spell-cast' },
      { card: 'Firebrand Archer', kind: 'spell-cast' },
      { card: "Ajani's Pridemate", kind: 'life-gained' },
      // Untapping an untapped permanent changes nothing, so both effects would return the state
      // unchanged and `toEqual` would pass on two no-ops. Tapped first, which is also the only
      // board on which the printed card does anything.
      { card: 'Thermo-Alchemist', kind: 'spell-cast', prepare: (state, source) => tap(state, source, true) },
    ];

    it.each(ROWS.map((row) => [row.card, row] as const))(
      '%s fires on what the hand-written card fires on, and does the same thing',
      (_name, row) => {
        const written = watching(scriptFor(row.card), row.kind);
        const mine = watching(compiledScript(row.card).script, row.kind);
        expect(mine, `${row.card}: compiled no trigger watching ${row.kind}`).toBeDefined();
        expect(written, `${row.card}: the hand-written card has no ${row.kind} trigger`).toBeDefined();
        if (mine === undefined || written === undefined) return;
        expect(event(mine.on)).toEqual(event(written.on));

        const deck = DECK_OF.get(row.card);
        expect(deck, `${row.card} is in no deck`).toBeDefined();
        let base = arena({
          decks: { 0: deck! }, battlefield: { 0: [row.card], 1: ['Grizzly Bears'] }, turn: 3,
        });
        const source = find(base, 0 as SeatIndex, 'battlefield', row.card);
        if (row.prepare !== undefined) base = row.prepare(base, source);

        // A trigger that points at something is handed a player, which every spec in these rows
        // admits; one that points at nothing is handed an empty list, as the engine would.
        const targets: readonly Target[] = mine.targets === undefined
          ? []
          : [{ kind: 'player', seat: 1 as SeatIndex }];
        const bare = contextOn(base, 0 as SeatIndex, source, targets);
        const prompts = (t: TriggerDef) => (t.decisions ?? []).map((d) => (typeof d === 'function' ? '' : d.prompt));
        expect(prompts(mine)).toEqual(row.may === undefined ? [] : [row.may]);
        expect(prompts(written)).toEqual(prompts(mine));
        // A "may" does nothing on a no, in either reading, and both are then given the yes.
        if (row.may !== undefined) {
          const no = { ...bare, decisions: [{ ids: [], option: 'No' }] } as unknown as EffectContext;
          expect(mine.effect(no)).toEqual(base);
          expect(written.effect(no)).toEqual(base);
        }
        const ctx = row.may === undefined
          ? bare
          : { ...bare, decisions: [{ ids: [], option: 'Yes' }] } as unknown as EffectContext;
        expect(mine.effect(ctx)).toEqual(written.effect(ctx));
        // Not vacuous: the printed trigger has to change the board on this fixture.
        expect(mine.effect(ctx), `${row.card}: the effect changed nothing`).not.toEqual(base);
      },
    );

    it('reads "you may have it deal" as the plain clause with a question in front (D574)', () => {
      /*
        The causative is the only way a card can print an optional effect whose subject is not the
        player, and 54 corpus lines do. Checked on a synthetic card against the same card without
        the "may", because that is the claim: nothing differs but the question. Named subject
        rather than "it", so both spellings of the subject are covered between this and the
        Goblin Arsonist row above.
      */
      const card = (text: string) => compileCard({
        name: 'Cinder Wretch', type_line: 'Creature — Elemental', mana_cost: '{1}{R}', cmc: 2,
        colors: ['R'], power: '2', toughness: '1', oracle_text: text,
      });
      const trigger = (text: string): TriggerDef => {
        const read = card(text);
        expect(fullyCompiled(read), text).toBe(true);
        return (read as { script: { triggers: readonly TriggerDef[] } }).script.triggers[0]!;
      };
      const may = trigger('When Cinder Wretch dies, you may have Cinder Wretch deal 1 damage to any target.');
      const must = trigger('When Cinder Wretch dies, Cinder Wretch deals 1 damage to any target.');
      expect(may.decisions).toEqual([{
        who: 'controller', prompt: 'Have Cinder Wretch deal 1 damage to any target?', options: ['Yes', 'No'],
      }]);
      expect(must.decisions ?? []).toEqual([]);
      expect(may.targets?.map((t) => t.description)).toEqual(must.targets?.map((t) => t.description));

      const base = arena({ decks: { 0: 'ember-rush' }, battlefield: { 0: ['Goblin Arsonist'] }, turn: 3 });
      const bare = contextOn(
        base, 0 as SeatIndex, find(base, 0 as SeatIndex, 'battlefield', 'Goblin Arsonist'),
        [{ kind: 'player', seat: 1 as SeatIndex }],
      );
      const answered = (option: string) =>
        ({ ...bare, decisions: [{ ids: [], option }] } as unknown as EffectContext);
      expect(may.effect(answered('No'))).toEqual(base);
      expect(may.effect(answered('Yes'))).toEqual(must.effect(bare));
      expect(may.effect(answered('Yes'))).not.toEqual(base);
      // A priced "may" names its effect after "If you do", so the causative is not looked for there.
      expect(fullyCompiled(card(
        'When Cinder Wretch dies, you may pay {1}. If you do, have Cinder Wretch deal 1 damage to any target.',
      ))).toBe(false);
    });

    it('reads one line that prints two events as two triggers', () => {
      /*
        "When ~ enters the battlefield or dies" is two triggered abilities sharing one effect
        (CR 603.1), so it is two `TriggerDef`s and not one event that means both. Checked on a
        synthetic card because the pool's only instance of the shape — Mogg War Marshal — makes a
        token, and token creation has no reader yet, so the card refuses for a different reason.
      */
      const both = compileCard({
        name: 'Comes And Goes', type_line: 'Creature — Spirit', mana_cost: '{2}', cmc: 2,
        colors: [], power: '1', toughness: '1',
        oracle_text: 'When Comes And Goes enters the battlefield or dies, you gain 2 life.',
      });
      expect(both.ok).toBe(true);
      if (!both.ok) return;
      expect(both.unread).toEqual([]);
      const triggers = (both.script as { triggers?: readonly TriggerDef[] } | undefined)?.triggers;
      expect(triggers?.map((t) => t.on.kind)).toEqual(['etb', 'dies']);
      // And both carry the effect, rather than one of them being an empty shell.
      const base = arena();
      for (const trigger of triggers ?? []) {
        const after = trigger.effect(contextOn(base, 0 as SeatIndex, 'c1'));
        expect(after.seats[0]!.life).toBe(base.seats[0]!.life + 2);
      }
    });

    it('reads "sacrifice ~" only with the end step in front of it, flag and all', () => {
      /*
        This test was written as a **refusal** and has become an acceptance, which is worth the
        churn note. Ball Lightning is "At the beginning of the end step, sacrifice Ball Lightning",
        and it also sets `leavesAtEndOfTurn: true` — its own comment: "the trigger below is what
        happens, and the flag is how the bot knows it is coming. Without it the evaluation holds
        the creature back to protect it."

        The property it has always pinned is that **the flag belongs to the pair**, not to the
        clause: a sacrifice at end of turn means the creature is leaving, a sacrifice on some other
        trigger does not. While nothing read the pair, that property was expressed by leaving the
        line unread. D402 reads the pair as one line's shape and emits both halves, so the same
        property is now expressed by what is emitted — and the sibling refusal, "Whenever ~
        attacks, sacrifice ~", is what keeps the clause from being read on its own.
      */
      const ball = compiledScript('Ball Lightning');
      expect(ball.unread).toEqual([]);
      expect(ball.script).toHaveProperty('leavesAtEndOfTurn', true);
      expect(scriptFor('Ball Lightning')).toHaveProperty('leavesAtEndOfTurn', true);
    });
  });
  /*
    ── Tokens: the one family whose characteristics are the sentence ─────────────────────────────

    A token has no printed card to look up, so "a 1/1 white Spirit creature token with flying" *is*
    its definition, and the pool's twenty hand-written token constants are that sentence
    transcribed. The comparison is therefore the strictest one in this file: resolve both effects
    and compare whole game states, which covers the created instance and the `CardDef` registered
    for it — name, type line, power, toughness, colours and oracle text alike.
  */
  describe('tokens, compared against the hand-written token definitions', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
    ): EffectContext => ({ state, controller: seat, source, targets: [] } as unknown as EffectContext);

    const watching = (script: unknown, kind: string) =>
      ((script as { triggers?: readonly TriggerDef[] }).triggers ?? [])
        .find((t) => t.on.kind === kind);

    it.each([
      // Spirit, 1/1 white with flying — the token whose keyword has to survive the round trip.
      ['Doomed Traveler', 'dies'],
      // Zombie, 2/2 black and no keywords: the control for the keyword case.
      ['Doomed Dissenter', 'dies'],
      // Goblin, 1/1 red, from a line that prints *two* events.
      ['Mogg War Marshal', 'etb'],
      // Drake, 2/2 blue with flying, off a cast trigger rather than a zone change.
      ['Talrand, Sky Summoner', 'spell-cast'],
      // Elemental, 1/1 red, the same shape on a different colour and subtype.
      ['Young Pyromancer', 'spell-cast'],
    ])('%s creates the token the hand-written card creates', (card, kind) => {
      const written = watching(scriptFor(card as string), kind as string);
      const mine = watching(compiledScript(card as string).script, kind as string);
      expect(mine, `${card as string}: compiled no ${kind as string} trigger`).toBeDefined();
      expect(written, `${card as string}: no hand-written ${kind as string} trigger`).toBeDefined();
      if (mine === undefined || written === undefined) return;

      const base = arena();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const ours = mine.effect(ctx);
      const theirs = written.effect(ctx);
      // Whole-state equality: the token's def is registered on the state, so this compares every
      // characteristic of it, not just the fact that something arrived.
      expect(ours).toEqual(theirs);
      // Not vacuous: a creature really is on the battlefield afterwards.
      expect(ours.zones[zoneKey(0 as SeatIndex, 'battlefield')]?.length ?? 0).toBeGreaterThan(0);
    });

    it('creates as many as the line says, by the word the card prints', () => {
      /*
        "Create two 1/1 white Soldier creature tokens" — the count is a word, as `countFrom`'s
        docblock explains it always is for a number of objects. Raise the Alarm is the pool's
        instance; the assertion is the number, because a reader that dropped the count and made one
        would pass every other check in this file.
      */
      const alarm = compiledScript('Raise the Alarm');
      expect(alarm.unread).toEqual([]);
      const base = arena();
      const after = ((alarm.script as { onResolve?: (c: EffectContext) => GameState } | undefined)
        ?.onResolve)?.({ state: base, controller: 0 as SeatIndex, source: 'c1', targets: [] } as unknown as EffectContext);
      expect(after).toBeDefined();
      expect(after?.zones[zoneKey(0 as SeatIndex, 'battlefield')]).toHaveLength(2);
    });

    it.each([
      /*
        Both counted grammars have now **left** this list: "Create X … tokens, where X is …" went
        with D392's board count, and "… for each <thing>" with D396's singular one. What is left is
        every row about the **token**, not about how many of it there are — which is the useful
        division, because a count is arithmetic and a token's own text is a second card.
      */
      // A granted ability, not a keyword: `printedKeywords` reads nothing out of it.
      ['Create a 1/1 black Pest creature token with "When this creature dies, you gain 1 life."'],
      /*
        "Create a Treasure token." **left** this list, and the reason is worth keeping where the
        refusal was. It was refused for having no printed power and toughness and carrying rules
        text of its own — which is true of every named token and is exactly why describing one from
        its reminder text is forbidden (D259). The reading that replaced the refusal does not
        describe it: it looks `TREASURE_TOKEN` up, the definition D243 wrote. A named token the
        engine has no definition for is still refused, and the test above says so.
      */
      ["Create a token that's a copy of target creature you control."],
      // A keyword the engine cannot read back would be a token that silently lacks it.
      ['Create a 1/1 white Spirit creature token with soaring.'],
    ])('refuses %s', (text) => {
      const refused = compileCard({
        name: 'Token Maker', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: text as string,
      });
      expect(refused.ok).toBe(true);
      if (!refused.ok) return;
      expect(refused.script, `read a token out of: ${text as string}`).toBeUndefined();
      expect(refused.unread.map((u) => u.why)).toEqual(['no-reader']);
    });
  });
  /*
    ── Attachments: the first shape read from two lines at once ──────────────────────────────────

    `Enchant creature` alone is an Aura that attaches and does nothing; `Enchanted creature gets
    +2/+0` alone is a bonus with nothing to attach it to. Neither line is a unit and the pair is,
    which makes this the compiler's first whole-card shape rather than another entry in a per-line
    table. See `attachmentScriptFor`.

    `aura` and `equipBonus` are plain data with no closures in them, so these compare by deep
    equality against the hand-written card — the strictest comparison available, and the one that
    catches a dropped keyword, a wrong sign, or a `friendly` flag on the wrong side.
  */
  describe('Auras and Equipment, against the hand-written attachments', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    it.each([
      // `gets +2/+0`: the zero component omitted, as `sizeBonus` does for a pump.
      ['Bonesplitter'],
      // A bonus and two granted keywords in one line.
      ['Loxodon Warhammer'],
      // Keywords with no size change at all.
      ['Basilisk Collar'],
      // `is indestructible`, which is a keyword spelled as a sentence.
      ['Darksteel Plate'],
    ])('%s carries the equip bonus the hand-written Equipment carries', (card) => {
      const written = scriptFor(card as string);
      const compiled = compiledScript(card as string).script;
      expect(compiled, `${card as string} compiled to no script`).toBeDefined();
      expect(field(compiled, 'equipBonus')).toEqual(field(written, 'equipBonus'));
    });

    it.each([
      // `has shroud`.
      ['Robe of Mirrors'],
      // `has flying`, on a card whose third line is an ETB trigger the per-line path reads.
      ['Angelic Gift'],
      // `gets +2/+0 and has trample`, plus a to-graveyard trigger on the third line.
      ['Rancor'],
    ])('%s builds the aura the hand-written card builds', (card) => {
      const written = scriptFor(card as string);
      const compiled = compiledScript(card as string).script;
      expect(compiled, `${card as string} compiled to no script`).toBeDefined();
      expect(field(compiled, 'aura')).toEqual(field(written, 'aura'));
    });

    it('reads Pacifism as removal, aimed at the enemy, as the hand-written card does', () => {
      /*
        The one case where the two facts the phrase cannot carry both matter at once. Every Aura in
        the pool prints the same `Enchant creature`; Angelic Gift's target is `friendly` and
        Pacifism's is not, and Pacifism also sets `removesACreature` — because an Aura that stops a
        creature attacking or blocking **is** removal, and a bot that does not know that holds it
        for nothing (D252, D364).

        Both are read off the bonus rather than off the phrase: `can't attack or block` harms.
      */
      const written = scriptFor('Pacifism');
      const compiled = compiledScript('Pacifism').script;
      expect(field(compiled, 'aura')).toEqual(field(written, 'aura'));
      expect(field(written, 'removesACreature')).toBe(true);
      expect(field(compiled, 'removesACreature')).toBe(true);
      // And the control, on the same printed phrase: a helpful Aura is aimed at your own side and
      // is not removal.
      expect((field(compiled, 'aura') as { target?: { friendly?: boolean } }).target?.friendly)
        .toBeUndefined();
      expect((field(compiledScript('Angelic Gift').script, 'aura') as
        { target?: { friendly?: boolean } }).target?.friendly).toBe(true);
    });

    it('attaches an Aura whose granted ability it cannot read, and still flags the line', () => {
      /*
        **Retired claim (D456), and this row is the argument it lost.**

        It read "refuses an Aura that grants a quoted ability rather than a keyword", and said of
        Ophidian Eye — `Enchanted creature has "Whenever this creature deals damage to a player,
        draw a card."` — that "a reader that dropped the quoted text would be an Aura you can cast,
        that attaches, and that silently grants nothing. So the pair is refused and the card is
        reported unread, which is what gets it played by hand (D362)."

        The half that is still true is that the quoted ability must not be invented: it is not read,
        and the line below is still asserted unread. The half that was wrong is **"silently"**. The
        badge *is* the flag, and with the attachment refused the card was flagged and also
        unplayable — the engine had no attachment for a person to make, so "played by hand" was not
        available either. Measured across the corpus: **738 legal Auras had no attachment of any
        kind**, 581 of them because of exactly this rule.

        So the attachment ships and the line keeps its badge, which is what D362 promises for every
        other card type.
      */
      /*
        Ophidian Eye was this row's card while the pool gave it that sentence. It prints a trigger
        of its own, which reads (D575), so the row moved to a card that does print a quoted
        ability nothing reads yet: Mark of Sakiko, from its Oracle row.
      */
      const mark = compileCard({
        name: 'Mark of Sakiko', type_line: 'Enchantment — Aura', mana_cost: '{1}{G}', cmc: 2,
        colors: ['G'], layout: 'normal',
        oracle_text: 'Enchant creature\nEnchanted creature has "Whenever this creature deals combat damage to a player, add that much {G}. Until end of turn, you don\'t lose this mana as steps and phases end."',
      } as never);
      expect(mark.ok).toBe(true);
      if (!mark.ok) return;
      const aura = field(mark.script, 'aura') as { target?: { description?: string } } | undefined;
      expect(aura?.target?.description).toBe('enchant creature');
      // And it grants nothing, rather than guessing at the quoted text.
      expect((aura as { effect?: Record<string, unknown> } | undefined)?.effect).toEqual({});
      expect(mark.unread.map((u) => u.line)).toContain(
        'Enchanted creature has "Whenever this creature deals combat damage to a player, add that much {G}. Until end of turn, you don\'t lose this mana as steps and phases end."',
      );
    });

    it('reads Ophidian Eye whole: an Aura of its own trigger, aimed at your own attacker (D575)', () => {
      /*
        The printed card, and the one hint the compiler now reads off a trigger. "Whenever
        enchanted creature deals damage to an opponent" pays the Aura's controller when the host
        connects, so the Aura belongs on their own creature and on one that can attack. 14 legal
        Auras print the sentence and all 14 are that card.
      */
      const eye = compiledScript('Ophidian Eye');
      expect(fullyCompiled(eye)).toBe(true);
      expect(field(eye.script, 'aura')).toEqual(field(scriptFor('Ophidian Eye'), 'aura'));
      expect((field(eye.script, 'aura') as { target: Record<string, unknown> }).target)
        .toMatchObject({ friendly: true, helpsInCombat: true });
      // The control: an Aura watching its creature **die** says nothing about whose creature.
      const dies = compileCard({
        name: 'Parting Gift', type_line: 'Enchantment — Aura', mana_cost: '{B}', cmc: 1, colors: ['B'],
        layout: 'normal', oracle_text: 'Enchant creature\nWhen enchanted creature dies, you draw two cards.',
      } as never);
      expect(dies.ok).toBe(true);
      if (!dies.ok) return;
      const target = (field(dies.script, 'aura') as { target: Record<string, unknown> }).target;
      expect(target['friendly']).toBeUndefined();
      expect(target['helpsInCombat']).toBeUndefined();
    });

    it('emits both halves or neither, never half an attachment', () => {
      /*
        The invariant, on the two shapes that would break it. A declaration with no second line at
        all is an Aura that attaches and does nothing; a static line with no declaration is a bonus
        with nothing to attach it to. Either one emitted alone is a card that **works and does
        nothing**, which is worse than an unread card, because an unread card is flagged and a blank
        Aura is not.

        D437 narrowed the first half and this row is why it stayed narrow. The bonus line became
        *optional* so that an Aura whose other line is a trigger could be read at all — Bequeathal
        is 1 of 29 legal Auras in that shape — and the first attempt dropped the requirement
        entirely, which made this row fail at once: `Enchant creature` as the whole card compiled to
        an Aura that attaches and does nothing. The rule is now "some other printed line", not "a
        bonus line".
      */
      const noBonus = compileCard({
        name: 'Blank Aura', type_line: 'Enchantment — Aura', mana_cost: '{W}', cmc: 1,
        colors: ['W'], oracle_text: 'Enchant creature',
      });
      expect(noBonus.ok).toBe(true);
      if (noBonus.ok) expect(noBonus.script).toBeUndefined();

      const noDeclaration = compileCard({
        name: 'Floating Bonus', type_line: 'Enchantment — Aura', mana_cost: '{W}', cmc: 1,
        colors: ['W'], oracle_text: 'Enchanted creature gets +2/+2.',
      });
      expect(noDeclaration.ok).toBe(true);
      if (noDeclaration.ok) expect(noDeclaration.script).toBeUndefined();

      const noEquipCost = compileCard({
        name: 'Unequippable', type_line: 'Artifact — Equipment', mana_cost: '{1}', cmc: 1,
        colors: [], oracle_text: 'Equipped creature gets +2/+0.',
      });
      expect(noEquipCost.ok).toBe(true);
      if (noEquipCost.ok) expect(noEquipCost.script).toBeUndefined();
    });

    it('writes no bonus for a keyword the engine would not read back, and still equips', () => {
      /*
        **Retired claim (D456).** This asserted `script` was `undefined` — no equip ability at all —
        for an Equipment printing a keyword `printedKeywords` does not recognise.

        The validation itself is unchanged and is still the point: the bonus's keywords are read by
        `printedKeywords`, so the reader asks that function whether the text it is about to write
        down yields the keywords the line named, exactly as `tokenEffect` does. "Has soaring" grants
        nothing, so **no bonus is written**.

        What changed is that refusing the bonus no longer refuses the equip ability with it. An
        Equipment that moves onto a creature and grants nothing is a complete, playable mechanic
        with a flagged line — the same reading D433 gave Armory of Iroas, which prints no bonus at
        all — and it beats a card that cannot be equipped and is flagged anyway.
      */
      const nonsense = compileCard({
        name: 'Soaring Blade', type_line: 'Artifact — Equipment', mana_cost: '{1}', cmc: 1,
        colors: [], oracle_text: 'Equipped creature has soaring.\nEquip {1}',
      });
      expect(nonsense.ok).toBe(true);
      const script = (nonsense.ok ? nonsense.script : undefined) as
        Record<string, unknown> | undefined;
      // The equip ability is there, and the bonus it would have granted is empty.
      expect(script?.['abilities']).toHaveLength(1);
      expect(script?.['equipBonus']).toEqual({});
      /*
        And the ability describes what it **does** — attach — rather than quoting a bonus it is not
        granting. A description read off the printed line here would put "has soaring" on a button
        that grants nothing.
      */
      expect((script?.['abilities'] as readonly { description?: string }[])[0]?.description)
        .toBe('Equip {1} — attach it to a creature you control');
      expect((nonsense.ok ? nonsense.unread : []).map((u) => u.line))
        .toContain('Equipped creature has soaring.');
    });
  });
  /*
    ── The prologues that watch somebody else's permanent ────────────────────────────────────────

    `who` and `of` are where most of the pool's etb and dies triggers live, and the English that
    distinguishes them is exact: "another creature" is not "a creature you control" is not
    "~ or another creature". Soul Warden's own comment makes the first distinction load-bearing —
    *"'Another' and not 'any': a Soul Warden does not gain you life for itself."*

    A reader that collapsed them would build a card that triggers off its own arrival when the print
    says it does not: wrong in a way nothing refuses, and invisible except in a life total. So the
    expected `on` is read off the hand-written card, whole, with only the one documented default
    normalised away.
  */
  describe('the prologues that watch another permanent', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
    ): EffectContext => ({ state, controller: seat, source, targets: [] } as unknown as EffectContext);

    const event = (on: TriggerDef['on']) => {
      const { who, ...rest } = on as { who?: string };
      return JSON.stringify(who === 'self' ? rest : on);
    };
    const watching = (script: unknown, kind: string) =>
      ((script as { triggers?: readonly TriggerDef[] }).triggers ?? [])
        .find((t) => t.on.kind === kind);

    /** The deck each card lives in, so `arena` can pull it out of that seat's library. */
    const DECK_OF = new Map<string, string>();
    for (const [id, deck] of Object.entries(STARTER_DECKS)) {
      for (const entry of deck.cards) if (!DECK_OF.has(entry.card.name)) DECK_OF.set(entry.card.name, id);
    }

    it.each([
      // "Whenever another creature enters the battlefield" — who: 'another', not 'any'.
      ['Soul Warden', 'etb'],
      // "Whenever a creature you control enters the battlefield" — who: 'any', of: 'you'.
      ['Impact Tremors', 'etb'],
      // The same shape again on a different clause, which is what makes it a shape and not a card.
      ['Impassioned Orator', 'etb'],
      // "Whenever you draw a card" — `by` left at its default, as the hand-written card spells it.
      ['Chasm Skulker', 'draws'],
    ])('%s watches exactly what the hand-written card watches', (card, kind) => {
      const written = watching(scriptFor(card as string), kind as string);
      const mine = watching(compiledScript(card as string).script, kind as string);
      expect(mine, `${card as string}: compiled no ${kind as string} trigger`).toBeDefined();
      expect(written, `${card as string}: no hand-written ${kind as string} trigger`).toBeDefined();
      if (mine === undefined || written === undefined) return;
      expect(event(mine.on)).toEqual(event(written.on));

      /*
        And it does the same thing: a shape copied right onto a clause read wrong is still wrong.

        The card is put on the battlefield and **its own id** used as the source, which is not
        decoration. Chasm Skulker's clause puts a counter on itself, and with a made-up source id
        `addCounters` is a no-op — so both effects returned the state unchanged and `toEqual` passed
        on two no-ops. The non-vacuity assertion below caught it; this is the D366 family turning up
        for the third time, and the third time a deliberate guard rather than luck found it.
      */
      const deck = DECK_OF.get(card as string);
      expect(deck, `${card as string} is in no deck`).toBeDefined();
      const base = arena({ decks: { 0: deck! }, battlefield: { 0: [card as string] }, turn: 3 });
      const source = find(base, 0 as SeatIndex, 'battlefield', card as string);
      const ctx = contextOn(base, 0 as SeatIndex, source);
      expect(mine.effect(ctx)).toEqual(written.effect(ctx));
      expect(mine.effect(ctx), `${card as string}: the effect changed nothing`).not.toEqual(base);
    });

    it('does not read "another" as "any", which is a card triggering off its own arrival', () => {
      /*
        The distinction stated as an assertion rather than left to the table above: Soul Warden's
        `who` is `another` and Impact Tremors' is `any`. Both print "enters the battlefield" and the
        only difference is the English in front of it.
      */
      const warden = watching(compiledScript('Soul Warden').script, 'etb');
      const tremors = watching(compiledScript('Impact Tremors').script, 'etb');
      expect((warden?.on as { who?: string }).who).toBe('another');
      expect((tremors?.on as { who?: string }).who).toBe('any');
      expect((tremors?.on as { of?: string }).of).toBe('you');
    });
  });

  /*
    ── Exile until this leaves ───────────────────────────────────────────────────────────────────
  */
  describe('exile-until-leaves, the removal that gives the permanent back', () => {
    const triggerKinds = (script: unknown) =>
      ((script as { triggers?: readonly TriggerDef[] }).triggers ?? []).map((t) => t.on.kind);
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    it.each([
      // One printed line, the return inside its `until` clause.
      ['Banisher Priest'],
      ['Conclave Tribunal'],
      // "another target nonland permanent", so the card cannot exile itself.
      ['Banishing Light'],
      // "You may exile target nonland permanent an opponent controls" (D575).
      ['Angel of Sanctions'],
      // Two printed lines, the return as its own sentence.
      ['Journey to Nowhere'],
    ])('%s emits both the exile and the return', (card) => {
      const compiled = compiledScript(card as string);
      expect(compiled.script, `${card as string} compiled to no script`).toBeDefined();
      // Both triggers, in that order: an exile with nothing to return it is permanent exile
      // printed as temporary, and a `leaves` trigger with nothing exiled is dead text.
      expect(triggerKinds(compiled.script)).toEqual(expect.arrayContaining(['etb', 'leaves']));
      // Pointing at what the hand-written card points at, by what a player reads.
      const mine = (field(compiled.script, 'triggers') as readonly TriggerDef[])
        .find((t) => t.on.kind === 'etb');
      const theirs = (field(scriptFor(card as string), 'triggers') as readonly TriggerDef[])
        .find((t) => t.on.kind === 'etb');
      expect(mine?.targets?.[0]?.kind).toBe(theirs?.targets?.[0]?.kind);
      expect(mine?.targets?.[0]?.description).toBe(theirs?.targets?.[0]?.description);
    });

    it('reads a bare exile as permanent exile, and emits no return for it', () => {
      /*
        The one rule here that is about correctness rather than coverage, and the second test in
        this file to turn from a refusal into an acceptance without its property changing.

        A printed `exile target creature` ETB with neither an `until ~ leaves` clause nor a `leaves`
        line is **permanent exile**. Emitting the pair for it would hand back a creature the print
        says is gone for good — a card that works and is a different, weaker card. While no clause
        reader could read `exile target creature` at all, that was expressed by leaving the line
        unread; D404 reads the sentence as what it says, so it is now expressed by what comes out:
        one trigger, on `etb`, and **no `leaves` trigger at all**.
      */
      const permanent = compileCard({
        name: 'Gone For Good', type_line: 'Creature — Avatar', mana_cost: '{3}{W}', cmc: 4,
        colors: ['W'], power: '2', toughness: '2',
        oracle_text: 'When Gone For Good enters the battlefield, exile target creature.',
      });
      expect(permanent.ok).toBe(true);
      if (!permanent.ok) return;
      expect(permanent.unread).toEqual([]);
      expect(triggerKinds(permanent.script)).toEqual(['etb']);
    });

    it('reads "an opponent controls" on Banishing Light, which is also what stops it exiling itself (D576)', () => {
      /*
        Checked through the filter, not the description. The pool had "another target nonland
        permanent", whose "another" was all that stopped an Oblivion-Ring-shaped card answering
        itself. The printed phrase does that and more: nothing of its controller's is a target.
      */
      const light = compiledScript('Banishing Light');
      const spec = ((field(light.script, 'triggers') as readonly TriggerDef[])
        .find((t) => t.on.kind === 'etb')?.targets ?? [])[0];
      expect(spec).toBeDefined();
      expect(spec?.description).toBe('target nonland permanent an opponent controls');
      const board = arena({ battlefield: { 0: ['Mountain', 'Raging Goblin'], 1: ['Forest', 'Grizzly Bears'] } });
      const theirs = find(board, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const theirLand = find(board, 1 as SeatIndex, 'battlefield', 'Forest');
      const mine = find(board, 0 as SeatIndex, 'battlefield', 'Raging Goblin');
      const admits = (id: string) => spec?.filter?.(board, { kind: 'card', id }, 0 as SeatIndex, 'some-other-id') ?? false;
      // An opponent's creature: yes. Their land: no, because it says nonland. Anything of mine: no.
      expect(admits(theirs)).toBe(true);
      expect(admits(theirLand)).toBe(false);
      expect(admits(mine)).toBe(false);
    });
  });
  /*
    ── Activated abilities: the third place a clause can live ────────────────────────────────────

    A clause has had two homes — a trigger's resolution and a spell's. This is the third, and it is
    the same multiplying change the trigger table was (D372): almost no new vocabulary, much more
    coverage, because every effect this module can already read becomes reachable from an ability.
  */
  describe('activated abilities, against the hand-written ones', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
    ): EffectContext => ({ state, controller: seat, source, targets: [] } as unknown as EffectContext);

    const DECK_OF = new Map<string, string>();
    for (const [id, deck] of Object.entries(STARTER_DECKS)) {
      for (const entry of deck.cards) if (!DECK_OF.has(entry.card.name)) DECK_OF.set(entry.card.name, id);
    }

    /** The ability with this printed description, from either script. */
    const abilityNamed = (script: unknown, description: string) =>
      ((script as { abilities?: readonly AbilityDef[] }).abilities ?? [])
        .find((a) => a.description === description);

    it.each([
      // A mana ability: `produces` and **no effect at all**, which is what makes it a mana ability.
      ['Mutavault', '{T}: Add {C}.'],
      ['Mind Stone', '{T}: Add {C}.'],
    ])('%s builds the mana ability the hand-written card builds', (card, description) => {
      const written = abilityNamed(scriptFor(card as string), description as string);
      const mine = abilityNamed(compiledScript(card as string).script, description as string);
      expect(written, `${card as string}: no hand-written "${description as string}"`).toBeDefined();
      expect(mine, `${card as string}: compiled no "${description as string}"`).toBeDefined();
      if (written === undefined || mine === undefined) return;
      expect(mine.cost).toEqual(written.cost);
      expect(mine.produces).toEqual(written.produces);
      /*
        And no effect, which is not a detail. The engine reads `produces` and resolves a mana
        ability without ever calling a function (CR 605); an ability that added to the pool through
        an `effect` would be one the mana system cannot see, so it would never pay for anything.
      */
      expect(mine.effect).toBeUndefined();
      expect(written.effect).toBeUndefined();
    });

    it.each([
      // `{B}: Regenerate ~` — a mana cost with no tap.
      ['Drudge Skeletons', '{B}: Regenerate Drudge Skeletons.'],
      ['River Boa', '{G}: Regenerate River Boa.'],
      // `{R}: ~ gets +1/+0 until end of turn.` — the self-pump clause, reached from an ability.
      ['Shivan Dragon', '{R}: Shivan Dragon gets +1/+0 until end of turn.'],
    ])('%s pays the printed cost and does what the hand-written ability does', (card, description) => {
      const written = abilityNamed(scriptFor(card as string), description as string);
      const mine = abilityNamed(compiledScript(card as string).script, description as string);
      expect(written, `${card as string}: no hand-written "${description as string}"`).toBeDefined();
      expect(mine, `${card as string}: compiled no "${description as string}"`).toBeDefined();
      if (written === undefined || mine === undefined) return;
      expect(mine.cost).toEqual(written.cost);

      // On a real board with the card's own id as the source: both of these clauses act on
      // themselves, so a made-up id would make both effects no-ops and compare equal on nothing.
      const deck = DECK_OF.get(card as string);
      expect(deck, `${card as string} is in no deck`).toBeDefined();
      const base = arena({ decks: { 0: deck! }, battlefield: { 0: [card as string] }, turn: 3 });
      const source = find(base, 0 as SeatIndex, 'battlefield', card as string);
      const ctx = contextOn(base, 0 as SeatIndex, source);
      expect(mine.effect).toBeDefined();
      expect(mine.effect?.(ctx)).toEqual(written.effect?.(ctx));
      expect(mine.effect?.(ctx), `${card as string}: the ability changed nothing`).not.toEqual(base);
    });

    it('refuses a cost it would have to drop a component of', () => {
      /*
        The clearest case in this module of a reading that would be worse than no reading. An
        ability that is free when the print says it eats a creature is not a cheaper card, it is a
        different one — and nothing at the table would flag it, because the ability works.

        So a cost component this reader cannot express refuses the whole line rather than being
        skipped. A counter removal and a discard of *another* card are both in the pool and both
        refused here.

        A life payment is deliberately **not** in this list: `AbilityCost.life` exists and the
        engine honours it, so that component is said rather than dropped. The test below pins that
        from the other side. An earlier draft of this test asserted a life cost was refused and
        failed against `cardFromData`, which was already reading one correctly — which is how the
        distinction between "cannot be expressed" and "this reader does not read it" was found.

        **Retired row (D446).** This list used to open with
        `'{B}{G}, Sacrifice another creature: You gain 1 life.'`, and the claim above read
        "`Sacrifice another creature`, a counter removal and a discard are all in the pool and all
        refused here." That stopped being true when D446 taught the cost reader
        `AbilityCost.sacrifice`: "Sacrifice another creature" is now expressible, so it is read
        rather than refused, and its row moved to the D446 table below. The rule the test states is
        unchanged — a component with no field on `AbilityCost` refuses the line — and the two rows
        left are the ones that still have no field. The row was retired here rather than deleted
        because the old claim named a card shape that now reads, and a reader comparing the two
        increments should be able to see why.
      */
      for (const text of [
        'Remove a +1/+1 counter from Nonesuch: Draw a card.',
        '{1}, Discard a card: Draw a card.',
      ]) {
        const refused = compileCard({
          name: 'Nonesuch', type_line: 'Creature — Horror', mana_cost: '{2}{B}', cmc: 3,
          colors: ['B'], power: '2', toughness: '2', oracle_text: text,
        });
        expect(refused.ok).toBe(true);
        if (!refused.ok) return;
        expect(refused.script, `read an ability out of: ${text}`).toBeUndefined();
      }
    });

    it('reads a pain land, whose two abilities cost different things', () => {
      /*
        The card this stage unlocked, and the reason the life component is read at all.

        `cardFromData` refuses this land outright — `foldManaLines` builds **one** cost for every
        mana line a permanent has, and documents that it would rather refuse a card whose lines
        disagree than flatten "free" and "costs a life" into either one. A line reader does not have
        to choose: two printed lines are two abilities. So what is asserted here is the pair of
        costs, in printed order, and that neither line went unread.
      */
      const land = compileCard({
        name: 'Ache Land', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        oracle_text: '{T}: Add {C}.\n{T}, Pay 1 life: Add {B}.',
      });
      expect(land.ok).toBe(true);
      if (!land.ok) return;
      expect(land.unread).toEqual([]);
      expect((land.script as { abilities?: readonly AbilityDef[] } | undefined)?.abilities
        ?.map((ability) => ability.cost))
        .toEqual([{ tap: true }, { tap: true, life: 1 }]);
    });

    it('reads a run of symbols as a sum, not as one mana', () => {
      /*
        `Add {C}{C}` is two mana and one ability — the Sol Ring reading `parseManaLine` corrected
        for the whole-card reader, re-pinned here because this reader is a second implementation of
        it and a sum truncated to its first symbol is a permanent that taps for one.

        Not a ground-truth row against a hand-written card: every sum in the pool is on a card
        `cardFromData` reads whole, so none of them reaches this reader. The card below has a second
        line nothing can read, which is what makes the whole-card path refuse it and hand the mana
        line here. Deliberately asserted anyway, because the gap was found by breaking the branch
        and watching every test stay green.
      */
      const rock = compileCard({
        name: 'Nonesuch', type_line: 'Artifact Creature — Construct', mana_cost: '{4}', cmc: 4,
        colors: [], power: '1', toughness: '3',
        oracle_text: '{T}: Add {C}{C}.\nNonesuch assembles itself from the parts of other things.',
      });
      expect(rock.ok).toBe(true);
      if (!rock.ok) return;
      const ability = ((rock.script as { abilities?: readonly AbilityDef[] } | undefined)
        ?.abilities ?? [])[0];
      expect(ability?.produces).toEqual(['C', 'C']);
      expect(ability?.effect, 'a mana ability resolves without an effect (CR 605)').toBeUndefined();
    });

    it('refuses a cost whose symbols are not mana', () => {
      /*
        `{E}` is energy and `{X}` is announced, and neither is mana this reader can put in
        `AbilityCost.mana`. Both would otherwise pass the "a run of symbols" shape and be read as
        generic — `{E}` silently as one mana, `{X}` as nothing at all — which is the dropped cost
        component again, wearing a symbol instead of a sentence. `parseManaCost` is what catches
        them: it records an unrecognised symbol rather than ignoring it.
      */
      const refusedCost = (text: string) => {
        const card = compileCard({
          name: 'Nonesuch', type_line: 'Artifact', mana_cost: '{3}', cmc: 3, colors: [],
          oracle_text: text,
        });
        return card.ok ? card.script : 'refused-outright';
      };
      expect(refusedCost('{E}, {T}: Draw a card.')).toBeUndefined();
      expect(refusedCost('{X}{R}, {T}: Draw a card.')).toBeUndefined();
      // The same shape with a real mana cost is read, so the refusals above are about the symbols.
      expect(refusedCost('{2}{R}, {T}: Draw a card.')).toBeDefined();
    });

    it('reads a tap and a mana cost together, in either printed order', () => {
      /*
        Both orders are printed, so both are read — and the cost that comes out is the same object
        either way, which is the property worth asserting rather than the two regex branches.
      */
      const costOf = (text: string) => {
        const card = compileCard({
          name: 'Tapper', type_line: 'Artifact', mana_cost: '{3}', cmc: 3, colors: [],
          oracle_text: text,
        });
        if (!card.ok) return undefined;
        return ((card.script as { abilities?: readonly AbilityDef[] } | undefined)?.abilities
          ?? [])[0]?.cost;
      };
      const expected = { mana: '{1}', tap: true };
      expect(costOf('{1}, {T}: You gain 2 life.')).toEqual(expected);
      expect(costOf('{T}, {1}: You gain 2 life.')).toEqual(expected);
    });

    it('does not read "Add {R} or {G}", which is a choice and not one ability', () => {
      /*
        A dual land's two colours are **two abilities** in every hand-written script here, because a
        choice of colour is a choice of which ability to activate. `Add {R}{G}` is two symbols and
        one ability; `Add {R} or {G}` is not, and reading it as `produces: ['R', 'G']` would be a
        land that makes two mana.
      */
      const dual = compileCard({
        name: 'Either Land', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        oracle_text: '{T}: Add {R} or {G}.',
      });
      expect(dual.ok).toBe(true);
      if (!dual.ok) return;
      const abilities = (dual.script as { abilities?: readonly AbilityDef[] } | undefined)?.abilities;
      // Either refused outright, or — if `cardFromData`'s land path claimed it — never as one
      // ability producing both.
      for (const ability of abilities ?? []) {
        expect(ability.produces?.length ?? 0).toBeLessThan(2);
      }
    });
  });
  it('refuses only what is not a single-face card at all', () => {
    expect(compileCard({ name: '', type_line: 'Creature' }).ok).toBe(false);
    expect(compileCard({ name: 'No Types', type_line: '' }).ok).toBe(false);
    expect(compileCard({ name: 'A Token', type_line: 'Creature', layout: 'token' }).ok).toBe(false);
    expect(compileCard({ name: 'Wax // Wane', type_line: 'Instant', layout: 'split' }).ok).toBe(false);
  });

  it('reports two lines fighting over one field instead of letting the last one win', () => {
    /*
      No real card prints both vanishing and fading, which is exactly why this is worth a test: the
      merge has to be safe for a card nobody has thought about yet. Two clocks disagreeing about
      `entersWith` means this module misread one of the lines, and a half-applied second fragment
      would be a creature with the wrong number of counters — wrong in a way the log never explains.
    */
    const both = compileCard({
      name: 'Two Clocks', type_line: 'Creature — Illusion', mana_cost: '{4}', cmc: 4,
      power: '5', toughness: '5', colors: [], oracle_text: 'Vanishing 4\nFading 3',
    });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.compiled).toEqual(['Vanishing 4']);
    expect(both.unread).toEqual([{ line: 'Fading 3', why: 'field-conflict' }]);
    const script = both.script as unknown as
      { entersWith?: { counter: string; amount: number }; fading?: unknown };
    // The first line's counters are intact and the refused fragment left no half of itself behind.
    expect(script.entersWith).toEqual({ counter: 'time', amount: 4 });
    expect(script.fading).toBeUndefined();
  });

  /*
    A keyword granted alongside a pump, which is one printed effect and has to stay one.

    The earlier pump reader took the size and refused any clause that also granted a keyword, with
    a comment saying reading half of it "would be a card that silently does less than it prints".
    That was the right refusal and the wrong end state: `pump` takes the size and the keywords in
    one `PumpOptions`, and the pool writes them that way — so reading both is the same single call
    the hand-written cards make.
  */
  describe('a keyword granted with a pump, against the hand-written ones', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext =>
      ({ state, controller: seat, source, targets } as unknown as EffectContext);

    /** One field off either script, without naming a shape the compiler may not fill. */
    const field = (script: unknown, key: string): unknown =>
      (script as Record<string, unknown> | undefined)?.[key];

    const resolveOf = (script: unknown) =>
      field(script, 'onResolve') as ((c: EffectContext) => GameState) | undefined;

    it.each([
      // `protectFromRemoval`: +2/+2 and +0/+3, both granting hexproof.
      ['Blossoming Defense'],
      ['Dive Down'],
      // The grant that is not protection: +1/+0 and infect.
      ['Tainted Strike'],
    ])('%s resolves to the same board as the hand-written spell', (card) => {
      /*
        The target is one of **your own** creatures for all three, which is what makes this check
        worth running on a real board: a pump plus a grant lands two continuous effects, and the
        board afterwards is the only place to see both.
      */
      const base = arena({
        decks: { 0: 'blight-vector' }, battlefield: { 0: ['Glistener Elf'] }, turn: 3,
      });
      const mine = find(base, 0 as SeatIndex, 'battlefield', 'Glistener Elf');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: mine }]);
      const compiled = resolveOf(compiledScript(card as string).script);
      const written = resolveOf(scriptFor(card as string));
      expect(compiled, `${card as string} compiled no resolution`).toBeDefined();
      expect(written, `${card as string} has no hand-written resolution`).toBeDefined();
      if (compiled === undefined || written === undefined) return;
      expect(compiled(ctx)).toEqual(written(ctx));
      // Not vacuous: a pump and a grant on a real creature has to change the board.
      expect(compiled(ctx)).not.toEqual(base);
    });

    it('carries the protection hint on a hexproof trick, not the pump hint', () => {
      /*
        The two hints say different things to the bot, and the pool draws the line itself:
        `protectFromRemoval` sets `protectsACreature` and deliberately not `expiresAtEndOfTurn`.
        "Hold this until something threatens a creature of yours" is not "hold this for the
        combat", and the measurement behind the first — 64 cast, 60 with nothing on the stack and
        no combat — is why it exists. So the compiled card has to agree with the hand-written one,
        or it is a card that works and plays badly, which is worse than an unread line (D362).
      */
      for (const card of ['Blossoming Defense', 'Dive Down']) {
        const compiled = compiledScript(card).script;
        expect(field(compiled, 'protectsACreature'), `${card}: no protection hint`).toBe(true);
        expect(field(scriptFor(card), 'protectsACreature')).toBe(true);
        expect(field(compiled, 'expiresAtEndOfTurn'), `${card}: told to wait for combat`)
          .toBeUndefined();
        expect(field(scriptFor(card), 'expiresAtEndOfTurn')).toBeUndefined();
      }
      /*
        Tainted Strike was here asserting `expiresAtEndOfTurn: true`, and that was wrong — the
        assertion encoded the reader rather than the card, because it never compared against the
        hand-written script, which carries **no** spell flag. Corrected in D412, and the row that
        replaced it is "does not tell the bot to hold a bonus whose value is in the attack", which
        asserts both readings agree. Kept here is the half this block is about: a grant that is not
        protection does not claim to be one.
      */
      expect(field(compiledScript('Tainted Strike').script, 'protectsACreature')).toBeUndefined();
      expect(field(scriptFor('Tainted Strike'), 'protectsACreature')).toBeUndefined();
    });

    it("reads Renegade Freighter's attack trigger, which pumps and grants in one call", () => {
      /*
        The self form of the same clause, and the one place in the pool where it is hand-written on
        a trigger rather than a spell: "Whenever Renegade Freighter attacks, it gets +1/+1 and gains
        trample until end of turn." Its own id is the source, because the clause acts on itself and
        a made-up one would make both effects no-ops (D366, D372, D377).
      */
      const written = ((scriptFor('Renegade Freighter') as unknown as
        { triggers?: readonly TriggerDef[] }).triggers ?? [])[0];
      const compiled = ((compiledScript('Renegade Freighter').script as unknown as
        { triggers?: readonly TriggerDef[] }).triggers ?? [])[0];
      expect(written, 'no hand-written attack trigger').toBeDefined();
      expect(compiled, 'compiled no attack trigger').toBeDefined();
      if (written === undefined || compiled === undefined) return;
      expect(compiled.on).toEqual(written.on);

      const base = arena({
        decks: { 0: 'forge-alliance' }, battlefield: { 0: ['Renegade Freighter'] }, turn: 3,
      });
      const source = find(base, 0 as SeatIndex, 'battlefield', 'Renegade Freighter');
      const ctx = contextOn(base, 0 as SeatIndex, source);
      expect(compiled.effect(ctx)).toEqual(written.effect(ctx));
      expect(compiled.effect(ctx), 'the trigger changed nothing').not.toEqual(base);
    });

    it("reads a grant with no size change, as Skithiryx's haste ability is written", () => {
      /*
        `{B}: Skithiryx gains haste until end of turn.` — the same `pump` call with only `keywords`
        in it. Worth reading as its own shape rather than as a pump of `+0/+0`, which `sizeBonus`
        refuses and should go on refusing: a card printing `+0/+0` would be a pump that does
        nothing, and this one is not a pump at all.
      */
      /*
        Matched by **cost**, not by description, and that is the card's doing: the print says
        "Skithiryx, the Blight Dragon gains haste" and the hand-written description says
        "Skithiryx". The compiler echoes the printed line, as every reader here does, so the two
        descriptions differ by design and the cost is what identifies the ability.
      */
      const abilityOf = (script: unknown) =>
        ((script as { abilities?: readonly AbilityDef[] }).abilities ?? [])
          .find((a) => a.cost.mana === '{B}');
      const written = abilityOf(scriptFor('Skithiryx, the Blight Dragon'));
      const compiled = abilityOf(compiledScript('Skithiryx, the Blight Dragon').script);
      expect(written, 'no hand-written haste ability').toBeDefined();
      expect(compiled, 'compiled no haste ability').toBeDefined();
      if (written === undefined || compiled === undefined) return;
      expect(compiled.description).toBe('{B}: Skithiryx, the Blight Dragon gains haste until end of turn.');

      /*
        The source is another creature on the board rather than the Dragon itself, because
        Skithiryx is a **commander** and does not start in a library for `arena` to place. The
        clause reads `c.source` and nothing else about the Dragon, so any permanent on the
        battlefield exercises it — and the non-vacuity check below is what proves it did.
      */
      const base = arena({
        decks: { 0: 'blight-vector' }, battlefield: { 0: ['Glistener Elf'] }, turn: 3,
      });
      const source = find(base, 0 as SeatIndex, 'battlefield', 'Glistener Elf');
      const ctx = contextOn(base, 0 as SeatIndex, source);
      expect(compiled.effect?.(ctx)).toEqual(written.effect?.(ctx));
      expect(compiled.effect?.(ctx), 'the ability changed nothing').not.toEqual(base);
    });

    it('refuses a word the engine has no keyword for', () => {
      /*
        `isKeyword` is the gate, and this is why it has to be: the engine's keyword list is what
        `characteristicsOf` consults, so a grant of something not in it would compile to a creature
        that gains nothing — and a spell that looks like it worked. Protection from a colour is the
        real card this guards against; the engine models it, but not as a keyword a pump can grant.

        The second row was **flanking** until D554 gave the engine that keyword, at which point this
        test was asserting the past (D516) and failed as it should. Phasing stands in now: a keyword
        the rules define and nothing here models, which is the property the row needs.
      */
      for (const text of [
        'Target creature gets +2/+2 and gains protection from red until end of turn.',
        'Target creature gets +2/+2 and gains phasing until end of turn.',
      ]) {
        const spell = compileCard({
          name: 'Nonesuch', type_line: 'Instant', mana_cost: '{G}', cmc: 1, colors: ['G'],
          oracle_text: text,
        });
        expect(spell.ok).toBe(true);
        if (!spell.ok) return;
        expect(spell.script, `read a grant out of: ${text}`).toBeUndefined();
        expect(spell.unread).toEqual([{ line: text.replace(/\n$/, ''), why: 'no-reader' }]);
      }
    });

    it('aims an infect grant at a creature that can attack, as the pool does', () => {
      /*
        Tainted Strike's hand-written spec is `TARGET_ATTACKER_HELPED`, and `helpsInCombat` is why:
        infect changes what *damage* does, so a creature that can never attack gains nothing from
        it. The compiled spec has to carry it or the bot will happily put infect on a Wall — the
        mistake D252 made with Ophidian Eye, in the same shape.

        Asserted as whole-spec equality, which is the strongest form available here and is only
        possible because the printed phrase ("target creature") and the hint are now both read.
      */
      const specOf = (script: unknown) =>
        (field(script, 'targets') as readonly TargetSpec[] | undefined)?.[0];
      const mine = specOf(compiledScript('Tainted Strike').script);
      expect(mine).toEqual(specOf(scriptFor('Tainted Strike')));
      expect(mine?.helpsInCombat, 'infect aimed at anything that can be targeted').toBe(true);

      /*
        And not on the hexproof pair, which is the other half of `helpsInCombat`'s own rule: a bonus
        is only "for the attack" when its whole value is, and hexproof is as useful on a blocker.

        **The `friendly` half of this row changed in D419.** It used to record a difference — the
        compiler set the flag on every helpful phrase and `protectFromRemoval` left it off — and
        said the difference was moot because the filter already restricts the candidates. That was
        right, and carrying it meant `compiled-vs-written.test.ts` had three cards on its list
        for ever over a field neither reading uses. So the hand-written cards carry it too now, and
        this asserts the agreement rather than noting the gap.
      */
      const defence = specOf(compiledScript('Blossoming Defense').script);
      expect(defence?.helpsInCombat).toBeUndefined();
      expect(defence?.friendly).toBe(true);
      expect(specOf(scriptFor('Blossoming Defense'))?.friendly).toBe(true);
    });
  });
  describe('the answers: countering, the sweeper, and a discard somebody else chooses', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
      targets: readonly Target[] = [], decisions: readonly { readonly ids: readonly string[] }[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets, decisions } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    /*
      The counter family, compared spec for spec against the four cards that print it.

      Every filter here is the function the hand-written card already uses — `isCreatureSpell` was
      lifted out of Essence Scatter for exactly this — so `toEqual` is comparing the real thing and
      not two descriptions of it. That matters most on Squelch: `kind: 'ability'` without
      `isActivatedAbility` is a Squelch that can also answer a triggered ability, which is a
      strictly better card than the one printed, and only an identical filter rules it out.

      Disallow is the one whose phrase is supplied rather than captured: the card prints "counter
      target spell, activated ability, or triggered ability" and the spec is described "target spell
      or ability". If the compiler ever starts echoing the printed list into the description, this
      equality is what notices.
    */
    it.each([
      ['Essence Scatter'],
      ['Negate'],
      ['Squelch'],
      ['Disallow'],
    ])('%s points at exactly the spec the hand-written card points at', (card) => {
      const written = scriptFor(card as string);
      const compiled = compiledScript(card as string).script;
      expect(compiled, `${card as string} compiled to no script`).toBeDefined();
      expect(field(compiled, 'targets')).toEqual(field(written, 'targets'));
    });

    /*
      The guard, which is the part of an open target phrase that can go wrong.

      `counter (target .+)` will happily capture "target creature", and `targetSpecFrom` will
      happily return a spec for it — a permanent on the battlefield, whose id would then be handed
      to `counterSpell`. `pointsAtTheStack` is what refuses it, and this is the sentence that proves
      the refusal rather than assuming it: real printed English, read by the regex, rejected by the
      guard. Deleting the guard makes this test fail.
    */
    it.each([
      ['Counter target creature.'],
      ['Counter target player.'],
    ])('refuses %s, which is a sentence no card prints and the stack cannot take', (text) => {
      const odd = compileCard({
        name: 'Not A Counterspell', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: text as string,
      });
      expect(odd.ok).toBe(true);
      if (!odd.ok) return;
      expect(odd.script).toBeUndefined();
      expect(odd.unread).toEqual([{ line: text as string, why: 'no-reader' }]);
    });

    /*
      Squelch, whose line the counter family reads and whose second sentence was already readable —
      so the card compiles whole, which is the point of reading a family rather than a sentence.
    */
    it('reads both of Squelch’s sentences, so the card compiles whole', () => {
      const compiled = compiledScript('Squelch');
      expect(compiled.unread).toEqual([]);
      expect(compiled.compiled).toEqual([
        'Counter target activated ability.',
        'Draw a card.',
      ]);
    });

    /*
      The sweeper, compared by resolving it on a board with creatures on both sides.

      This one *can* be resolved, unlike a counterspell: a wrath needs a battlefield, which is
      exactly what `arena` builds. See the counter family above for why its effect is compared by
      spec instead — `counterSpell` no-ops on a card that is not on the stack, so a resolution check
      for it would be a check that cannot fail.
    */
    it('sweeps the board the hand-written Day of Judgment sweeps', () => {
      const base = arena({
        battlefield: { 0: ['Monastery Swiftspear'], 1: ['Grizzly Bears'] }, turn: 3,
      });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = (field(compiledScript('Day of Judgment').script, 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      const theirs = (field(scriptFor('Day of Judgment'), 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous, and not one-sided: a creature of each seat's died, including the caster's own.
      expect(mine.zones[zoneKey(0 as SeatIndex, 'graveyard')]).toHaveLength(1);
      expect(mine.zones[zoneKey(1 as SeatIndex, 'graveyard')]).toHaveLength(1);
      expect(mine).not.toEqual(base);
    });

    /*
      And the hint it deliberately does not carry.

      `removesACreature` means "do not cast this with nothing of theirs to point at", which is
      advice about a spell that needs a target. A wrath needs none, and whether casting it is right
      is the position rather than a property of the card — so Day of Judgment sets no flag and
      neither does the compiled reading. A compiler that set it for everything with "destroy" in the
      sentence would have the bot treating a wrath as spot removal.
    */
    it('gives the sweeper no removal hint, which the hand-written card does not either', () => {
      expect(field(scriptFor('Day of Judgment'), 'removesACreature')).toBeUndefined();
      expect(field(compiledScript('Day of Judgment').script, 'removesACreature')).toBeUndefined();
      // The control: the same verb with a target phrase does carry it.
      expect(field(compiledScript('Murder').script, 'removesACreature')).toBe(true);
    });

    /*
      The discard, which is the first clause this module reads whose reading is a **question**.

      Two things are asserted and the second is the card: the spec list matches Mind Rot's, and the
      chooser is the *target player*. `who: 'controller'` would compile, resolve, and ask the caster
      to discard their own cards — a card that works and is a different card — so the chooser is
      pinned by name as well as by equality, because an equality alone would follow the hand-written
      card if that ever changed too.
    */
    it('asks the discarding player, as the hand-written Mind Rot does', () => {
      const written = scriptFor('Mind Rot');
      const compiled = compiledScript('Mind Rot').script;
      expect(field(compiled, 'decisions')).toEqual(field(written, 'decisions'));
      expect(field(compiled, 'targets')).toEqual(field(written, 'targets'));
      const asked = (field(compiled, 'decisions') as readonly { who: string; min: number }[])[0];
      expect(asked?.who).toBe('target-player');
      expect(asked?.min).toBe(2);
    });

    it('puts the cards the discarding player chose into the graveyard, as the written card does', () => {
      // Seat 1's own cards, chosen by seat 1, discarded into seat 1's graveyard.
      const base = arena({ hands: { 1: ['Grizzly Bears', 'Giant Growth'] } });
      const chosen = [
        find(base, 1 as SeatIndex, 'hand', 'Grizzly Bears'),
        find(base, 1 as SeatIndex, 'hand', 'Giant Growth'),
      ];
      const ctx = contextOn(
        base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 1 as SeatIndex }], [{ ids: chosen }],
      );
      const mine = (field(compiledScript('Mind Rot').script, 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      const theirs = (field(scriptFor('Mind Rot'), 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous: both named cards left the hand for the graveyard.
      expect(mine.zones[zoneKey(1 as SeatIndex, 'graveyard')]).toEqual(chosen);
      expect(mine.zones[zoneKey(1 as SeatIndex, 'hand')]).toEqual([]);
    });

    /*
      The prompt is the printed words, not a number turned back into words.

      "Discard a card" and "Discard two cards" are both printed, and a prompt built from the count
      would say "Discard 1 cards". Mind Rot pins the plural; the synthetic row pins the singular,
      which nothing in the pool prints.
    */
    it('writes the prompt from the printed count and its noun, singular included', () => {
      const one = compileCard({
        name: 'One Card Rot', type_line: 'Sorcery', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: 'Target player discards a card.',
      });
      expect(one.ok).toBe(true);
      if (!one.ok) return;
      expect(one.unread).toEqual([]);
      expect(field(one.script, 'decisions')).toEqual([
        { who: 'target-player', from: 'hand', prompt: 'Discard a card', min: 1, max: 1 },
      ]);
    });
  });
  describe('the burn that may not kill a creature', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    /*
      "Target player or planeswalker" — `any target` with the creatures taken out, and the omission
      is what makes a one-mana three-damage spell printable at all.

      The phrase needed a `TargetSpec.kind` of its own before it could be read: `player` loses the
      planeswalker half and `any` gains a creature the card may not touch, and both are a different
      card. Both pool cards that print it carried `TARGET_PLAYER` until this stage, so neither could
      be pointed at a planeswalker — with four of them in the pool. `scripts.test.ts` has the rules
      half of that fix; this is the compiler reading the phrase.
    */
    it.each([
      ['Lava Spike'],
      ['Lava Axe'],
    ])('%s points at exactly the spec the hand-written card points at', (card) => {
      const compiled = compiledScript(card as string);
      expect(compiled.unread).toEqual([]);
      expect(field(compiled.script, 'targets')).toEqual(field(scriptFor(card as string), 'targets'));
    });

    it('keeps "any target" distinct from it, which is the whole difference between the two cards', () => {
      const spike = (field(compiledScript('Lava Spike').script, 'targets') as
        readonly TargetSpec[])[0]!;
      const bolt = (field(compiledScript('Lightning Bolt').script, 'targets') as
        readonly TargetSpec[])[0]!;
      expect(spike.kind).toBe('player-or-planeswalker');
      expect(bolt.kind).toBe('any');
    });
  });

  describe('modal spells, chosen as the spell is cast', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    interface Mode {
      readonly description: string;
      readonly targets?: readonly TargetSpec[];
      readonly effect: (c: EffectContext) => GameState;
      readonly expiresAtEndOfTurn?: boolean;
      readonly removesACreature?: boolean;
      // The third mode-level bot hint, added when Healing Salve began to compile (D488).
      readonly preventsDamage?: boolean;
    }
    const modal = (script: unknown) =>
      field(script, 'modal') as { modes: readonly Mode[]; min?: number; max?: number } | undefined;

    const compiledModal = (name: string) => {
      const compiled = compiledScript(name);
      expect(compiled.unread, `${name} left lines unread`).toEqual([]);
      const read = modal(compiled.script);
      expect(read, `${name} compiled to no modal`).toBeDefined();
      return read!;
    };

    /*
      The two modal cards in the pool whose every bullet this module can read, compared mode by mode
      against the hand-written card.

      Compared field by field rather than with one `toEqual` on the whole `modal`, because each
      mode's `effect` is a function and two functions that do the same thing are not equal.
      Everything that can be compared is: how many modes, the printed description of each, and the
      spec it points at — and the specs are identical objects, since `isCreatureSpell`,
      `yourGraveyardCreature` and `yourGraveyardLand` are one function each now rather than a copy
      per card.
    */
    it.each([
      ['Soul Manipulation'],
      ['Grim Discovery'],
    ])('%s reads mode for mode like the hand-written card', (card) => {
      const mine = compiledModal(card as string);
      const theirs = modal(scriptFor(card as string))!;
      expect(mine.modes).toHaveLength(theirs.modes.length);
      expect(mine.min).toBe(theirs.min);
      expect(mine.max).toBe(theirs.max);
      mine.modes.forEach((mode, i) => {
        expect(mode.description).toBe(theirs.modes[i]!.description);
        expect(mode.targets).toEqual(theirs.modes[i]!.targets);
      });
    });

    it('reads "Choose one or both" as min 1 max 2, which is what both cards store', () => {
      // Pinned by name as well as by equality: `max: 1` would make it a charm, a different card.
      expect(compiledModal('Soul Manipulation').min).toBe(1);
      expect(compiledModal('Soul Manipulation').max).toBe(2);
    });

    /*
      The land half of the graveyard return, which is the phrase this stage added — and the reason
      Grim Discovery compiles at all.
    */
    it('returns the land card the hand-written Grim Discovery returns', () => {
      // A land in seat 0's own graveyard; the controller has to be the seat holding it.
      const base = arena({ graveyard: { 0: ['Mountain'] } });
      const land = find(base, 0 as SeatIndex, 'graveyard', 'Mountain');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: land }]);
      const mine = compiledModal('Grim Discovery').modes[1]!.effect(ctx);
      const theirs = modal(scriptFor('Grim Discovery'))!.modes[1]!.effect(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous: the land is in hand afterwards and out of the graveyard.
      expect(mine.zones[zoneKey(0 as SeatIndex, 'hand')]).toContain(land);
      expect(mine.zones[zoneKey(0 as SeatIndex, 'graveyard')]).not.toContain(land);
    });

    /*
      Whole or not at all, with the three pool cards that prove it.

      Each has one bullet this module cannot read — Selesnya Charm exiles a creature by power,
      Golgari Charm regenerates a team, Healing Salve prevents damage — and each is refused
      **entirely**, header and all. Reading the other bullets and shipping them as the card's modes
      would be a spell that works and is a strictly different, better spell than the one printed:
      `legalActions` offers a play per legal combination of modes, so a charm missing its third mode
      is a charm whose third mode nobody can choose, with nothing at the table to say so.
    */
    it('reads Healing Salve whole, which was the last pool card refusing a bullet', () => {
      /*
        This row has now emptied three times, exactly as its own note said it would. Golgari Charm
        left when its regenerate mode was read; **Selesnya Charm** left with D404's exile-by-power;
        and **Healing Salve** left with D488's prevention reader. No pool card holds the property
        any more — the synthetic row below it does, which is why that row was written.

        So this row is inverted rather than deleted: it asserted that the whole card was refused,
        and it now asserts that the whole card is read. Both directions matter, and keeping the card
        here keeps the note's history attached to it.
      */
      const compiled = compiledScript('Healing Salve');
      expect(compiled.source).toBe('lines');
      expect(compiled.unread).toEqual([]);
      const modes = modal(compiled.script)!.modes;
      expect(modes).toHaveLength(2);
      // And the mode-level bot hint, which the hand-written card has always carried.
      expect(modes[1]!.preventsDamage).toBe(true);
      expect(modes[0]!.preventsDamage).toBeUndefined();
    });

    it('refuses a synthetic charm whose third bullet has no reader, header and all', () => {
      /*
        The property, owned by text of its own rather than by a card somebody may teach the
        compiler to read: two readable modes and one that is not, refused **entirely**. Reading the
        two and shipping them as the card's modes would be a spell that works and is a strictly
        different, better spell — `legalActions` offers a play per legal combination of modes, so a
        charm missing its third mode is a charm whose third mode nobody can choose, with nothing at
        the table to say so.
      */
      const charm = compileCard({
        name: 'Made Up Charm', type_line: 'Instant', mana_cost: '{G}', cmc: 1, colors: ['G'],
        oracle_text: 'Choose one —\n• You gain 3 life.\n• Draw a card.\n'
          + '• The table applauds politely.',
      });
      expect(charm.ok).toBe(true);
      if (!charm.ok) return;
      expect(charm.script).toBeUndefined();
      expect(charm.unread).toHaveLength(4);
      expect(charm.unread[0]!.line).toMatch(/^Choose one/);
    });

    /** A synthetic modal card, for the headers and flags the pool does not print. */
    const synthetic = (text: string) => compileCard({
      name: 'Made Up Charm', type_line: 'Instant', mana_cost: '{G}', cmc: 1, colors: ['G'],
      oracle_text: text,
    });

    it('reads "Choose one" with no min or max, which is what they default to', () => {
      const one = synthetic('Choose one —\n• You gain 3 life.\n• Draw a card.');
      expect(one.ok).toBe(true);
      if (!one.ok) return;
      expect(one.unread).toEqual([]);
      const read = modal(one.script)!;
      expect(read.modes).toHaveLength(2);
      expect(read.min).toBeUndefined();
      expect(read.max).toBeUndefined();
      // And that is the shape Selesnya Charm stores for the same header.
      expect(modal(scriptFor('Selesnya Charm'))!.min).toBeUndefined();
    });

    /*
      The headers that are not read, refused rather than guessed at.

      "Choose two" over three modes is `min: 2, max: 2`; entwine and escalate are different again.
      Each is a different number of modes taken, and a header read as the wrong one is a card that
      takes the wrong number — so an unrecognised header refuses the card, which leaves its lines
      flagged for a human (D362) instead of silently halving the spell.
    */
    it.each([
      ['Choose two —'],
      ['Choose one. You may choose the same mode more than once —'],
    ])('refuses the header %s rather than guessing how many modes it takes', (header) => {
      const odd = synthetic(`${header as string}\n• You gain 3 life.\n• Draw a card.`);
      expect(odd.ok).toBe(true);
      if (!odd.ok) return;
      expect(odd.script).toBeUndefined();
      expect(odd.unread).toHaveLength(3);
    });

    it('puts a pump’s wear-off on the mode that wears off, not on the card', () => {
      /*
        `ModeDef.expiresAtEndOfTurn` exists because a charm's other modes are not pumps — its own
        docblock says so, naming Selesnya Charm. So the flag has to travel from the bullet's reading
        onto that bullet's mode, and a compiler that merged it onto the card would tell the bot to
        hold the whole spell for a combat when the rest of it is not a combat trick.
      */
      const charm = synthetic(
        'Choose one —\n• Target creature gets +2/+2 until end of turn.\n• You gain 3 life.',
      );
      expect(charm.ok).toBe(true);
      if (!charm.ok) return;
      expect(charm.unread).toEqual([]);
      expect(modal(charm.script)!.modes[0]!.expiresAtEndOfTurn).toBe(true);
      expect(modal(charm.script)!.modes[1]!.expiresAtEndOfTurn).toBeUndefined();
      // On the mode, and not on the card.
      expect(field(charm.script, 'expiresAtEndOfTurn')).toBeUndefined();
    });

    it('drops a destroy mode’s removal hint, which the shape cannot hold and does not need', () => {
      /*
        The one flag dropped rather than refused, and the argument is structural rather than a
        judgement: `removesACreature` means "do not cast this with nothing of theirs to point at",
        and `ModalDef` offers one play per legal combination of modes, so a combination whose
        targets cannot be filled is never offered. The destroy mode is therefore already unavailable
        on an empty board — the whole of what the flag buys — and `ModeDef` has no slot for it, so a
        person writing this card by hand would drop it too.
      */
      const charm = synthetic('Choose one —\n• Destroy target creature.\n• You gain 3 life.');
      expect(charm.ok).toBe(true);
      if (!charm.ok) return;
      expect(charm.unread).toEqual([]);
      expect(modal(charm.script)!.modes[0]!.removesACreature).toBeUndefined();
      expect(field(charm.script, 'removesACreature')).toBeUndefined();
    });

    it('refuses a mode whose hint the shape cannot hold and nothing else enforces', () => {
      /*
        The other half of the rule above. "Gets +0/+3 and gains hexproof" reads as a protection
        trick — `protectsACreature`, hold this until something threatens one of your creatures —
        and that is advice about *timing*, which no mode combination enforces the way a mandatory
        target does. `ModeDef` cannot carry it, so the card is refused rather than shipped with the
        hint quietly gone.
      */
      const trick = synthetic(
        'Choose one —\n• Target creature gets +0/+3 and gains hexproof until end of turn.'
        + '\n• You gain 3 life.',
      );
      expect(trick.ok).toBe(true);
      if (!trick.ok) return;
      expect(trick.script).toBeUndefined();
      expect(trick.unread).toHaveLength(3);
    });
  });
  describe('the drain and the edict, against the cards that print them', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
      targets: readonly Target[] = [], decisions: readonly { readonly ids: readonly string[] }[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets, decisions } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[0];

    /*
      "Each opponent loses 1 life and you gain 1 life" — one effect joined by "and", not two
      clauses, which is why `clausesOf` does not split on the word: "gets +2/+2 and gains trample"
      is one effect too, and a splitter that broke on "and" would cut that in half.

      Compared by resolving both readings on the same board, because the drain's whole content is
      arithmetic on life totals: two seats' totals and the caster's, which is what the assertions
      below read.
    */
    it('leaves Cruel Celebrant’s printed trigger unread, and says so (D576)', () => {
      /*
        This card was in the row below while the pool gave it Zulaport Cutthroat's sentence. It
        prints "Whenever Cruel Celebrant or another creature or planeswalker you control dies", a
        subject no reader takes yet, so the compiler refuses the line and the card is the
        hand-written one. Asserted so the refusal is a known state and not a silent one.
      */
      const celebrant = compiledScript('Cruel Celebrant');
      expect(celebrant.unread.map((u) => u.line).join()).toContain('or another creature or planeswalker you control dies');
      expect(triggerOf(celebrant.script)).toBeUndefined();
    });

    it.each([
      ['Zulaport Cutthroat'],
    ])('%s drains the table exactly as the hand-written trigger does', (card) => {
      const base = arena();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = triggerOf(compiledScript(card as string).script)!.effect(ctx);
      const theirs = triggerOf(scriptFor(card as string))!.effect(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous, and pointed the right way: the opponent lost the life and the caster gained it.
      expect(mine.seats[1]!.life).toBe(base.seats[1]!.life - 1);
      expect(mine.seats[0]!.life).toBe(base.seats[0]!.life + 1);
    });

    it('drains the player Blood Artist points at, and nobody else', () => {
      const base = arena();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 1 as SeatIndex }]);
      const mine = triggerOf(compiledScript('Blood Artist').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Blood Artist'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      expect(field(compiledScript('Blood Artist').script, 'triggers')).toBeDefined();
      expect(triggerOf(compiledScript('Blood Artist').script)!.targets)
        .toEqual(triggerOf(scriptFor('Blood Artist'))!.targets);
      expect(mine.seats[1]!.life).toBe(base.seats[1]!.life - 1);
      expect(mine.seats[0]!.life).toBe(base.seats[0]!.life + 1);
    });

    /*
      The two numbers are read separately rather than assumed equal. Every drain in this pool prints
      the same number twice, so reading one of them twice would pass every ground-truth test above
      while asserting a symmetry the text does not promise.
    */
    it('reads the two halves of an asymmetric drain as the two numbers printed', () => {
      const greedy = compileCard({
        name: 'Greedy Drain', type_line: 'Sorcery', mana_cost: '{2}{B}', cmc: 3, colors: ['B'],
        oracle_text: 'Each opponent loses 3 life and you gain 1 life.',
      });
      expect(greedy.ok).toBe(true);
      if (!greedy.ok) return;
      expect(greedy.unread).toEqual([]);
      const base = arena();
      const after = (field(greedy.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life - 3);
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life + 1);
    });

    it('reads a drain with no gain at all, which is the same clause without its tail', () => {
      const bleed = compileCard({
        name: 'Plain Bleed', type_line: 'Sorcery', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: 'Each opponent loses 2 life.',
      });
      expect(bleed.ok).toBe(true);
      if (!bleed.ok) return;
      expect(bleed.unread).toEqual([]);
      const base = arena();
      const after = (field(bleed.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life - 2);
      // And no life gained, which is the half the card does not print.
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life);
    });

    /*
      The edict, which is a question and not an effect — and whose `who` is the card.

      "Each player" includes the caster and "each opponent" does not: one word of the reader, and a
      completely different card. Fleshbag Marauder prints the first; the test for the second is
      synthetic, because the pool's only "each opponent sacrifices" is a Saga chapter whose other
      two chapters this module cannot read.
    */
    it('asks every player, as the hand-written Fleshbag Marauder does', () => {
      const mine = triggerOf(compiledScript('Fleshbag Marauder').script)!;
      const theirs = triggerOf(scriptFor('Fleshbag Marauder'))!;
      const asked = (mine.decisions as readonly { who: string; from: string; min: number }[])[0];
      const written = (theirs.decisions as readonly { who: string; from: string; min: number }[])[0];
      expect(asked?.who).toBe(written?.who);
      expect(asked?.who).toBe('each-player');
      expect(asked?.from).toBe('battlefield');
      expect(asked?.min).toBe(1);
    });

    it('asks only the opponents when the card says "each opponent"', () => {
      const edict = compileCard({
        name: 'One Sided Edict', type_line: 'Sorcery', mana_cost: '{1}{B}', cmc: 2, colors: ['B'],
        oracle_text: 'Each opponent sacrifices a creature.',
      });
      expect(edict.ok).toBe(true);
      if (!edict.ok) return;
      expect(edict.unread).toEqual([]);
      expect((field(edict.script, 'decisions') as readonly { who: string }[])[0]?.who)
        .toBe('each-opponent');
    });

    it('only offers a creature to sacrifice, which is what the filter is for', () => {
      /*
        The filter decides what may be given up, and a missing one would let a player sacrifice a
        land to an edict — which is not the card. Compared against the hand-written filter on the
        same board so both answers come from the same objects.
      */
      const board = arena({ battlefield: { 1: ['Grizzly Bears', 'Forest'] }, turn: 3 });
      const bear = find(board, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const forest = find(board, 1 as SeatIndex, 'battlefield', 'Forest');
      const spec = (triggerOf(compiledScript('Fleshbag Marauder').script)!
        .decisions as readonly { filter?: (s: GameState, id: string) => boolean }[])[0]!;
      const written = (triggerOf(scriptFor('Fleshbag Marauder'))!
        .decisions as readonly { filter?: (s: GameState, id: string) => boolean }[])[0]!;
      expect(spec.filter?.(board, bear)).toBe(true);
      expect(spec.filter?.(board, forest)).toBe(false);
      expect(written.filter?.(board, bear)).toBe(true);
      expect(written.filter?.(board, forest)).toBe(false);
    });

    it('puts the sacrificed creatures in the graveyard, as the hand-written card does', () => {
      const board = arena({ battlefield: { 1: ['Grizzly Bears'] }, turn: 3 });
      const bear = find(board, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(board, 0 as SeatIndex, 'c1', [], [{ ids: [bear] }]);
      const mine = triggerOf(compiledScript('Fleshbag Marauder').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Fleshbag Marauder'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      expect(mine.zones[zoneKey(1 as SeatIndex, 'graveyard')]).toContain(bear);
    });

    /*
      "Target player gains 3 life" — Healing Salve's first mode, and the clause whose sign is the
      reason `friendly` exists. The bot's default is "the enemy and the enemy's creatures", so a
      heal without the flag is a Healing Salve cast on the opponent.
    */
    it('marks a heal friendly, which a drain pointed at the same kind of target is not', () => {
      const heal = compileCard({
        name: 'Plain Heal', type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
        oracle_text: 'Target player gains 3 life.',
      });
      const drain = compileCard({
        name: 'Plain Drain', type_line: 'Instant', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: 'Target player loses 2 life and you gain 2 life.',
      });
      expect(heal.ok && drain.ok).toBe(true);
      if (!heal.ok || !drain.ok) return;
      expect(heal.unread).toEqual([]);
      expect(drain.unread).toEqual([]);
      expect((field(heal.script, 'targets') as readonly TargetSpec[])[0]?.friendly).toBe(true);
      expect((field(drain.script, 'targets') as readonly TargetSpec[])[0]?.friendly).toBeUndefined();

      // And it heals the player it points at, not the caster.
      const base = arena();
      const after = (field(heal.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 1 as SeatIndex }]),
      );
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life + 3);
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life);
    });
  });
  describe('the shrinking sweep, the combat filter, and the untapper', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    interface Mode {
      readonly description: string;
      readonly targets?: readonly TargetSpec[];
      readonly effect: (c: EffectContext) => GameState;
    }
    const modesOf = (script: unknown) =>
      (field(script, 'modal') as { modes: readonly Mode[] } | undefined)?.modes;

    /*
      Golgari Charm, which this file's own comment calls "the card that was not scriptable".

      All three of its modes read now: a sweep that shrinks, a typed destroy, and regenerating the
      team. The two untargeted ones are compared by resolving both readings on the same board; the
      typed one is compared by what a player reads and by what its filter admits, because
      `permanentOfTypes` builds a fresh closure per call and two closures that do the same thing are
      not equal.
    */
    it('reads all three of Golgari Charm’s modes, in the printed order', () => {
      const compiled = compiledScript('Golgari Charm');
      expect(compiled.unread).toEqual([]);
      const mine = modesOf(compiled.script)!;
      const theirs = modesOf(scriptFor('Golgari Charm'))!;
      expect(mine.map((m) => m.description)).toEqual(theirs.map((m) => m.description));
    });

    it('shrinks every creature on the table, the caster’s own included', () => {
      /*
        `pumpAll` and not `pumpTeam`, which is the whole of why this mode is a decision rather than
        a free sweep — so the test puts a creature on each side and reads both.
      */
      const base = arena({
        battlefield: { 0: ['Monastery Swiftspear'], 1: ['Grizzly Bears'] }, turn: 3,
      });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = modesOf(compiledScript('Golgari Charm').script)![0]!.effect(ctx);
      const theirs = modesOf(scriptFor('Golgari Charm'))![0]!.effect(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous: an effect exists, and it is one effect over the whole board.
      expect(mine.effects.length).toBe(1);
      expect(mine).not.toEqual(base);
    });

    it('regenerates each creature its caster controls, and nobody else’s', () => {
      const base = arena({
        battlefield: { 0: ['Monastery Swiftspear'], 1: ['Grizzly Bears'] }, turn: 3,
      });
      const mine = modesOf(compiledScript('Golgari Charm').script)![2]!
        .effect(contextOn(base, 0 as SeatIndex, 'c1'));
      const theirs = modesOf(scriptFor('Golgari Charm'))![2]!
        .effect(contextOn(base, 0 as SeatIndex, 'c1'));
      expect(mine).toEqual(theirs);
      // Not vacuous, and one-sided: the caster's creature has a shield and the opponent's does not.
      const ours = find(base, 0 as SeatIndex, 'battlefield', 'Monastery Swiftspear');
      const theirCreature = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      expect(mine.instances[ours]!.counters['regeneration']).toBe(1);
      expect(mine.instances[theirCreature]!.counters['regeneration']).toBeUndefined();
    });

    it('reads the sign of a mass size change rather than assuming it shrinks', () => {
      const anthem = compileCard({
        name: 'Mass Anthem', type_line: 'Instant', mana_cost: '{G}', cmc: 1, colors: ['G'],
        oracle_text: 'All creatures get +1/+1 until end of turn.',
      });
      expect(anthem.ok).toBe(true);
      if (!anthem.ok) return;
      expect(anthem.unread).toEqual([]);
      const base = arena({ battlefield: { 1: ['Grizzly Bears'] }, turn: 3 });
      const after = (field(anthem.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // The bonus is read off the printed sign, so this is a pump and not Golgari Charm's sweep.
      expect(after.effects[0]?.power).toBe(1);
      expect(after.effects[0]?.toughness).toBe(1);
    });

    it('refuses a mass size change of zero, which is a sentence that does nothing', () => {
      const nothing = compileCard({
        name: 'Mass Nothing', type_line: 'Instant', mana_cost: '{G}', cmc: 1, colors: ['G'],
        oracle_text: 'All creatures get +0/+0 until end of turn.',
      });
      expect(nothing.ok).toBe(true);
      if (!nothing.ok) return;
      expect(nothing.script).toBeUndefined();
      expect(nothing.unread).toHaveLength(1);
    });

    /*
      Divine Verdict's phrase, which is the only filter in this module that reads the **combat**
      rather than the board — so the spec is identical to the hand-written one, function included,
      because `attackingOrBlocking` is now one shared const rather than a copy per card.
    */
    it('points at exactly the spec the hand-written Divine Verdict points at', () => {
      const compiled = compiledScript('Divine Verdict');
      expect(compiled.unread).toEqual([]);
      expect(field(compiled.script, 'targets')).toEqual(field(scriptFor('Divine Verdict'), 'targets'));
      // And it is removal, which is the hint the destroy family adds for a creature target.
      expect(field(compiled.script, 'removesACreature')).toBe(true);
    });

    it('refuses a creature that is not in combat, which is what makes the phrase narrow', () => {
      const board = arena({ battlefield: { 1: ['Grizzly Bears'] }, turn: 3 });
      const bear = find(board, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const spec = (field(compiledScript('Divine Verdict').script, 'targets') as
        readonly TargetSpec[])[0]!;
      // Nothing is attacking on this board, so the one creature on it is not a legal target.
      expect(spec.filter?.(board, { kind: 'card', id: bear }, 0 as SeatIndex)).toBe(false);
    });

    /*
      The untapper, and the field that makes it safe to read.

      `untapsOnly` tells the bot this ability can put the board back exactly where it found it.
      Without it the bot can tap and untap for ever — the loop #124 was opened for — so this is not
      a missing hint but a hang, and it is why the clause carries `abilityFlags` rather than being
      refused the way a mode's lost hint refuses a card (D388).
    */
    it('carries untapsOnly, as the hand-written Kiora’s Follower does', () => {
      const compiled = compiledScript("Kiora's Follower");
      expect(compiled.unread).toEqual([]);
      const mine = (field(compiled.script, 'abilities') as readonly AbilityDef[])[0]!;
      const theirs = (field(scriptFor("Kiora's Follower"), 'abilities') as readonly AbilityDef[])[0]!;
      expect(mine.untapsOnly).toBe(true);
      expect(theirs.untapsOnly).toBe(true);
      expect(mine.cost).toEqual(theirs.cost);
      expect(mine.description).toBe(theirs.description);
    });

    it('aims the untap at your own board, and not at the permanent doing the untapping', () => {
      const compiled = compiledScript("Kiora's Follower");
      const spec = ((field(compiled.script, 'abilities') as readonly AbilityDef[])[0]!
        .targets as readonly TargetSpec[])[0]!;
      const written = ((field(scriptFor("Kiora's Follower"), 'abilities') as readonly AbilityDef[])[0]!
        .targets as readonly TargetSpec[])[0]!;
      expect(spec.description).toBe(written.description);
      // Untapping an opponent's land is a card thrown away; the bot's default aim is the enemy.
      expect(spec.friendly).toBe(true);
      expect(written.friendly).toBe(true);

      /*
        "Another": the source itself is refused and another permanent is not. Two Mountains rather
        than two named cards, because `arena` pulls each name out of that seat's own library and
        ember-rush has no Island — so the ids come from the battlefield listing instead of by name.
      */
      const board = arena({ battlefield: { 0: ['Mountain', 'Mountain'] }, turn: 3 });
      const [first, second] = [...ids(board, 0 as SeatIndex, 'battlefield')];
      const admits = (filter: TargetSpec['filter'], id: string) =>
        filter?.(board, { kind: 'card', id }, 0 as SeatIndex, first) ?? false;
      expect(admits(spec.filter, first!)).toBe(false);
      expect(admits(spec.filter, second!)).toBe(true);
      expect(admits(written.filter, first!)).toBe(false);
      expect(admits(written.filter, second!)).toBe(true);
    });

    it('untaps the permanent it points at, as the hand-written ability does', () => {
      const board = arena({ battlefield: { 0: ['Mountain'] }, turn: 3 });
      const mountain = find(board, 0 as SeatIndex, 'battlefield', 'Mountain');
      const tapped = tap(board, mountain);
      // Not vacuous from the other end either: the land really is tapped before the ability runs.
      expect(tapped.instances[mountain]!.tapped).toBe(true);
      const ctx = contextOn(tapped, 0 as SeatIndex, 'c1', [{ kind: 'card', id: mountain }]);
      const mine = (field(compiledScript("Kiora's Follower").script, 'abilities') as
        readonly AbilityDef[])[0]!.effect!(ctx);
      const theirs = (field(scriptFor("Kiora's Follower"), 'abilities') as
        readonly AbilityDef[])[0]!.effect!(ctx);
      expect(mine).toEqual(theirs);
      expect(mine.instances[mountain]!.tapped).toBe(false);
    });

    it('refuses "untap target player", which is not a permanent', () => {
      const odd = compileCard({
        name: 'Odd Untapper', type_line: 'Artifact', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: '{T}: Untap target player.',
      });
      expect(odd.ok).toBe(true);
      if (!odd.ok) return;
      expect(odd.script).toBeUndefined();
      expect(odd.unread).toEqual([{ line: '{T}: Untap target player.', why: 'no-reader' }]);
    });
  });
  describe('counts read off the board, and the grammars that want them', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
      subjectCounters?: Readonly<Record<string, number>>,
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [], subjectCounters,
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    /*
      Krenko, whose printed count is a tribe: "where X is the number of Goblins you control".

      `creaturesOfSubtype` is the function his hand-written ability already used — it was
      `goblinCount` until this needed it — so the two count the same creatures rather than being two
      readings of one sentence.
    */
    it('makes as many Goblins as Krenko’s hand-written ability makes', () => {
      const base = arena({
        decks: { 0: 'ember-rush' },
        battlefield: { 0: ['Goblin Arsonist', 'Raging Goblin', 'Monastery Swiftspear'] },
        turn: 3,
      });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = (field(compiledScript('Krenko, Mob Boss').script, 'abilities') as
        readonly AbilityDef[])[0]!.effect!(ctx);
      const theirs = (field(scriptFor('Krenko, Mob Boss'), 'abilities') as
        readonly AbilityDef[])[0]!.effect!(ctx);
      expect(mine).toEqual(theirs);
      /*
        Two Goblins on the board, so two tokens — and the Swiftspear is the control: a reader that
        counted creatures rather than Goblins would make three, and a reader that counted the tokens
        it had just made would not terminate.
      */
      const made = ids(mine, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(mine, id) === 'Goblin');
      expect(made).toHaveLength(2);
    });

    it('makes nothing at all when the count is nothing, as the hand-written ability does', () => {
      const base = arena({ decks: { 0: 'ember-rush' }, battlefield: { 0: ['Mountain'] }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = (field(compiledScript('Krenko, Mob Boss').script, 'abilities') as
        readonly AbilityDef[])[0]!.effect!(ctx);
      const theirs = (field(scriptFor('Krenko, Mob Boss'), 'abilities') as
        readonly AbilityDef[])[0]!.effect!(ctx);
      expect(mine).toEqual(theirs);
      // The zero guard: the state is untouched rather than asked for no tokens.
      expect(mine).toEqual(base);
    });

    /*
      Chasm Skulker, and the reason the snapshot is read before the live instance.

      Its Squids are counted off the counters it had as it **died**, and by the time a death trigger
      resolves the card is in a graveyard with none at all (CR 608.2h). So `subjectCounters` wins
      where there is one.
    */
    it('counts the counters Chasm Skulker had when it died, not the ones it has now', () => {
      const base = arena({ decks: { 0: 'hollow-tide' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [], { '+1/+1': 3 });
      const mine = triggerOf(compiledScript('Chasm Skulker').script, 1)!.effect(ctx);
      const theirs = (field(scriptFor('Chasm Skulker'), 'triggers') as
        readonly TriggerDef[])[1]!.effect(ctx);
      expect(mine).toEqual(theirs);
      const squids = ids(mine, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(mine, id) === 'Squid');
      expect(squids).toHaveLength(3);
      // The live instance has no counters on this board, so a reader that ignored the snapshot
      // would make none — which is what makes three the discriminating number.
      expect(mine.instances[squids[0]!]).toBeDefined();
    });

    it('falls back to the counters the permanent has when there is no snapshot', () => {
      /*
        The other half of the order, which no pool card exercises: a count asked for while the
        permanent is still on the battlefield. `subjectCounters` is set only by an event about a card
        that left, so everywhere else the live instance is the only answer there is.
      */
      const base = arena({ decks: { 0: 'hollow-tide' }, battlefield: { 0: ['Chasm Skulker'] }, turn: 3 });
      const skulker = find(base, 0 as SeatIndex, 'battlefield', 'Chasm Skulker');
      const grown = addCounters(base, skulker, '+1/+1', 2);
      const after = triggerOf(compiledScript('Chasm Skulker').script, 1)!
        .effect(contextOn(grown, 0 as SeatIndex, skulker));
      const squids = ids(after, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(after, id) === 'Squid');
      expect(squids).toHaveLength(2);
    });

    it('gives the Squid token the islandwalk its line prints', () => {
      /*
        The token clause names a keyword this engine does not keep as a keyword at all: landwalk is a
        land type plus a rule (CR 702.14). `printedLandwalk` reads it off the text now, which is both
        what lets the clause past the token reader's read-back check and what makes the text true for
        a card with no script — the corpus case. The hand-written token gets it from its own script,
        and that test is in scripts.test.ts.
      */
      const base = arena({ decks: { 0: 'hollow-tide' }, turn: 3 });
      const after = triggerOf(compiledScript('Chasm Skulker').script, 1)!
        .effect(contextOn(base, 0 as SeatIndex, 'c1', [], { '+1/+1': 1 }));
      const squid = ids(after, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(after, id) === 'Squid')[0]!;
      expect(characteristicsOf(after, after.instances[squid]!).landwalk).toEqual(['Island']);
    });

    it('reads landwalk off a printed line, and not out of a sentence about it', () => {
      expect(printedLandwalk('Islandwalk')).toEqual(['Island']);
      expect(printedLandwalk('Swampwalk, forestwalk')).toEqual(['Swamp', 'Forest']);
      // A sentence that mentions one grants nothing, which is `printedKeywords`' own rule.
      expect(printedLandwalk('Target creature gains islandwalk until end of turn.')).toEqual([]);
      expect(printedLandwalk('Flying')).toEqual([]);
    });

    /*
      Murderous Redcap: damage equal to its power, read as the trigger resolves.

      The body persist gives back is a 1/1 with a −1/−1 counter, so its power is 0 and the printed
      card deals nothing — which is why the amount cannot be cached and why the zero guard is the
      card rather than defensive programming.
    */
    it('deals damage equal to its power, as the hand-written trigger does', () => {
      const base = arena({
        decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
        battlefield: { 0: ['Murderous Redcap'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const redcap = find(base, 0 as SeatIndex, 'battlefield', 'Murderous Redcap');
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, redcap, [{ kind: 'card', id: bear }]);
      const mine = triggerOf(compiledScript('Murderous Redcap').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Murderous Redcap'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      /*
        Not vacuous, and read off the card rather than written as a literal: the damage is the
        Redcap's live power, and the assertion that it is above zero is what stops this passing on a
        reader that always dealt none. (The card is a 2/2. This pool had it as a 1/1 until D571,
        which is why an earlier version of this comment said persist's second body deals nothing.)
      */
      const power = characteristicsOf(base, base.instances[redcap]!).power;
      expect(power).toBeGreaterThan(0);
      expect(mine.instances[bear]!.damage).toBe(power);
    });

    it('deals nothing when its power is zero', () => {
      const base = arena({
        decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
        battlefield: { 0: ['Murderous Redcap'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const redcap = find(base, 0 as SeatIndex, 'battlefield', 'Murderous Redcap');
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      // Two −1/−1 counters on a 2/2: power 0. Not a board the game leaves standing — state-based
      // actions would bury it — which is fine, because the question is what the reader does with
      // a zero and nothing here runs them.
      const shrunk = addCounters(base, redcap, '-1/-1', 2);
      const ctx = contextOn(shrunk, 0 as SeatIndex, redcap, [{ kind: 'card', id: bear }]);
      const mine = triggerOf(compiledScript('Murderous Redcap').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Murderous Redcap'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      // No damage event at all, which is a different thing from a damage event of zero.
      expect(mine.instances[bear]!.damage).toBe(0);
      expect(mine).toEqual(shrunk);
    });

    /*
      The plural, which is the one place this vocabulary could be wrong rather than incomplete.

      "Elves" has to become "Elf" and "Fungi" has to be refused: a subtype no creature has would
      count zero, and a card that resolves and does nothing is worse than an unread line, because an
      unread line is flagged for a human to play by hand (D362).
    */
    it('derives the singular of a -ves plural, and counts the creatures it names', () => {
      const elves = compileCard({
        name: 'Elf Maker', type_line: 'Sorcery', mana_cost: '{2}{G}', cmc: 3, colors: ['G'],
        oracle_text: 'Create X 1/1 green Elf creature tokens, where X is the number of Elves you control.',
      });
      expect(elves.ok).toBe(true);
      if (!elves.ok) return;
      expect(elves.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'verdant-guard' }, battlefield: { 0: ['Llanowar Elves', 'Grizzly Bears'] }, turn: 3,
      });
      const after = (field(elves.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // One Elf on the board, so one token — and the bear is the control.
      expect(ids(after, 0 as SeatIndex, 'battlefield').filter((id) => nameOf(after, id) === 'Elf'))
        .toHaveLength(1);
    });

    it.each([
      ['the number of Fungi you control'],
      ['the number of Homunculi you control'],
    ])('refuses %s, whose singular this cannot derive', (phrase) => {
      const odd = compileCard({
        name: 'Odd Maker', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: `Create X 1/1 green Elf creature tokens, where X is ${phrase as string}.`,
      });
      expect(odd.ok).toBe(true);
      if (!odd.ok) return;
      expect(odd.script).toBeUndefined();
      expect(odd.unread.map((u) => u.why)).toEqual(['no-reader']);
    });

    it('reads the other three counts the pool spells, each off the right zone', () => {
      const made = (phrase: string) => compileCard({
        name: 'Count Reader', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: `Create X 1/1 green Elf creature tokens, where X is ${phrase}.`,
      });
      const resolve = (phrase: string, state: GameState) => {
        const card = made(phrase);
        expect(card.ok).toBe(true);
        if (!card.ok) throw new Error(`${phrase} did not compile`);
        expect(card.unread).toEqual([]);
        const after = (field(card.script, 'onResolve') as (c: EffectContext) => GameState)(
          contextOn(state, 0 as SeatIndex, 'c1'),
        );
        return ids(after, 0 as SeatIndex, 'battlefield').filter((id) => nameOf(after, id) === 'Elf').length;
      };

      // Three lands, one of which is also a creature the moment it is animated — still a land.
      const lands = arena({ decks: { 0: 'verdant-guard' }, battlefield: { 0: ['Forest', 'Forest', 'Forest'] }, turn: 3 });
      expect(resolve('the number of lands you control', lands)).toBe(3);

      /*
        Two artifacts, and they are two *different* artifacts because Ember Rush runs one
        Bonesplitter now rather than two — the second copy's slot went to Armory of Iroas (D433).
        The claim is unchanged: this counts artifacts you control, and both of these are artifacts.
      */
      const artifacts = arena({ decks: { 0: 'ember-rush' }, battlefield: { 0: ['Bonesplitter', 'Armory of Iroas'] }, turn: 3 });
      expect(resolve('the number of artifacts you control', artifacts)).toBe(2);

      const dead = arena({ decks: { 0: 'rot-harvest' }, graveyard: { 0: ['Shambling Shell'] }, turn: 3 });
      expect(resolve('the number of creature cards in your graveyard', dead)).toBe(1);
    });
  });
  describe('the same count written the other way round: "for each", in the singular', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
    ): EffectContext => ({
      state, controller: seat, source, targets: [], decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    /*
      The two cards in the pool that print this grammar, and they print it about the same zone:
      Izoni makes a body per body, and Lotleth Giant drains a life per body. One count, two
      sentences — which is why the reader is a count rather than two sentence readers.

      Both fixtures put a **non-creature** card in the graveyard beside the creatures. That is the
      control: the clause says "creature card", and a reader that counted the graveyard would read
      three where the card reads two.
    */
    const yard = () => arena({
      decks: { 0: 'rot-harvest', 1: 'ember-rush' },
      graveyard: { 0: ['Shambling Shell', 'Vampire Aristocrat', 'Raise Dead'] },
      turn: 3,
    });

    it('makes an Insect per creature card in the graveyard, as Izoni’s hand-written trigger does', () => {
      const base = yard();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = triggerOf(compiledScript('Izoni, Thousand-Eyed').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Izoni, Thousand-Eyed'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      const insects = ids(mine, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(mine, id) === 'Insect');
      expect(insects).toHaveLength(2);
    });

    it('makes nothing on an empty graveyard, as the hand-written trigger does', () => {
      const base = arena({ decks: { 0: 'rot-harvest', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = triggerOf(compiledScript('Izoni, Thousand-Eyed').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Izoni, Thousand-Eyed'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      expect(mine).toEqual(base);
    });

    it('deals a damage per creature card to target opponent, as Lotleth Giant’s trigger does (D576)', () => {
      const base = yard();
      const ctx = { ...contextOn(base, 0 as SeatIndex, 'c1'), targets: [{ kind: 'player', seat: 1 as SeatIndex }] } as EffectContext;
      const mine = triggerOf(compiledScript('Lotleth Giant').script)!;
      const theirs = triggerOf(scriptFor('Lotleth Giant'))!;
      expect(mine.targets?.map((t) => t.description)).toEqual(['target opponent']);
      expect(theirs.targets?.map((t) => t.description)).toEqual(['target opponent']);
      expect(mine.effect(ctx)).toEqual(theirs.effect(ctx));
      /*
        Two bodies, so two — and the caster's own total is the control twice over: a reader that
        hit "each player" would take it too, and a reader that read the whole graveyard would take
        three.
      */
      const after = mine.effect(ctx);
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life - 2);
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life);
    });

    it('drains nothing on an empty graveyard, because loseLife refuses a non-positive amount', () => {
      const base = arena({ decks: { 0: 'rot-harvest', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = triggerOf(compiledScript('Lotleth Giant').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Lotleth Giant'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      // Not "a loss of zero": the state is the one it was handed, which is why no guard is written.
      expect(mine).toEqual(base);
    });

    it('multiplies the printed amount by the count, which no pool card does', () => {
      /*
        Lotleth Giant's amount is 1, so the pool cannot tell `each * counted` from `counted`. A
        synthetic two makes the multiplication the thing under test: two bodies at two life each is
        four, and a reader that ignored the printed number would take two.
      */
      const card = compileCard({
        name: 'Twice Over', type_line: 'Sorcery', mana_cost: '{3}{B}', cmc: 4, colors: ['B'],
        oracle_text: 'Each opponent loses 2 life for each creature card in your graveyard.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread).toEqual([]);
      const base = yard();
      const after = (field(card.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life - 4);
    });

    it('still reads the flat drain it sits in front of', () => {
      /*
        The per-thing reader is tried first and its prefix is the flat drain's whole sentence, so
        this is the regression that order could cause: the flat form has to come out the other side
        unchanged. Cruel Celebrant and the rest are covered by their own block; this is the
        synthetic case with a two in it, for the same reason as above.
      */
      const card = compileCard({
        name: 'Flat Drain', type_line: 'Sorcery', mana_cost: '{2}{B}', cmc: 3, colors: ['B'],
        oracle_text: 'Each opponent loses 2 life.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread).toEqual([]);
      const base = yard();
      const after = (field(card.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // Two, not four: the graveyard this seat has is not part of this card.
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life - 2);
    });

    /*
      The subtype, which is where the two grammars genuinely differ.

      "the number of Elves you control" names the tribe in the plural and has to have a letter
      taken off; "for each Elf you control" names it as the engine spells it and must not. Reading
      one with the other's rule is a card that resolves and counts nothing — the failure this file
      calls a card that works and is wrong.
    */
    it('counts a tribe named in the singular, without deriving anything', () => {
      const card = compileCard({
        name: 'Elf Counter', type_line: 'Sorcery', mana_cost: '{2}{G}', cmc: 3, colors: ['G'],
        oracle_text: 'Create a 1/1 green Elf creature token for each Elf you control.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'verdant-guard' },
        battlefield: { 0: ['Llanowar Elves', 'Llanowar Elves', 'Grizzly Bears'] },
        turn: 3,
      });
      const after = (field(card.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // Two Elves, so two tokens; the bear is the control, and three would mean "creatures".
      expect(ids(after, 0 as SeatIndex, 'battlefield').filter((id) => nameOf(after, id) === 'Elf'))
        .toHaveLength(2);
    });

    it('refuses a tribe the plural grammar cannot spell, and accepts it in the singular', () => {
      /*
        The pair that makes the split worth having. "Homunculi" is refused outright, because the
        plural rule would have to invent "Homunculu"; the same creature type in the singular is
        read as printed. The refusal is tested next to the acceptance so neither can quietly
        become the other.
      */
      const plural = compileCard({
        name: 'Plural Reader', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: 'Create X 1/1 blue Homunculus creature tokens, where X is the number of Homunculi you control.',
      });
      expect(plural.ok).toBe(true);
      if (plural.ok) expect(plural.script).toBeUndefined();

      const singular = compileCard({
        name: 'Singular Reader', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: 'Create a 1/1 blue Homunculus creature token for each Homunculus you control.',
      });
      expect(singular.ok).toBe(true);
      if (!singular.ok) return;
      expect(singular.unread).toEqual([]);
      /*
        And read **correctly**, which is a stronger claim than compiled: the pool has exactly one
        creature of this type — Aeromunculus, a Homunculus Mutant — so one token is the answer the
        plural rule cannot reach. It would count a type called "Homunculu" and make none.
      */
      const base = arena({
        decks: { 0: 'delta-bloom' },
        battlefield: { 0: ['Aeromunculus', 'Llanowar Elves'] },
        turn: 3,
      });
      const after = (field(singular.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      expect(ids(after, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(after, id) === 'Homunculus')).toHaveLength(1);
    });

    it('refuses a singular tribe in the plural grammar, which is the other half of the rule', () => {
      // "the number of Elf you control" is not English a card prints, and the plural rule's
      // trailing-s requirement is what refuses it rather than counting a type called "El".
      const card = compileCard({
        name: 'Wrong Number', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: 'Create X 1/1 green Elf creature tokens, where X is the number of Elf you control.',
      });
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.script).toBeUndefined();
    });

    it('will not read a per-thing token clause whose printed count is not one', () => {
      /*
        "Create two tokens for each creature card" is a real sentence with a real meaning this
        reader does not implement, so it has to be refused rather than read as one each. An
        unread line is dealt to a human (D362); a halved one is not.
      */
      const card = compileCard({
        name: 'Two Each', type_line: 'Sorcery', mana_cost: '{4}{B}', cmc: 5, colors: ['B'],
        oracle_text: 'Create two 1/1 black Zombie creature tokens for each creature card in your graveyard.',
      });
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.script).toBeUndefined();
    });
  });

  describe('counters a permanent arrives with, and the word that narrows a death trigger', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    const entersWith = (text: string) => compileCard({
      name: 'Arriving Thing', type_line: 'Creature — Avatar', mana_cost: '{X}', cmc: 0,
      colors: [], power: '0', toughness: '0', oracle_text: text,
    });

    /*
      The same compilation's **script**, for the rows that only want to read a field off it.

      `compileCard` returns a union and the `ok: false` arm has no `script` at all, so the four
      acceptance rows below used to write `entersWith(...).script ?? {}` — which vitest happily
      transpiled and the type checker rejects. They sat in this file for days because the gate step
      that would have said so was running nothing (D410). Narrowing once here is what the call sites
      actually mean, and it keeps `entersWith` whole for the refusal rows, which assert on `ok` and
      `unread`.
    */
    const entersWithScript = (text: string): Record<string, unknown> => {
      const compiled = entersWith(text);
      return compiled.ok ? (compiled.script as Record<string, unknown> | undefined) ?? {} : {};
    };

    /*
      Endless One, whose whole card is one sentence about a field the engine has had all along.
      `entersWith` is plain data with no closure in it, so this is deep equality against the
      hand-written card — the strictest comparison available.
    */
    it('reads Endless One’s arrival exactly as the hand-written card declares it', () => {
      const mine = compiledScript('Endless One');
      expect(mine.unread).toEqual([]);
      expect(field(mine.script, 'entersWith')).toEqual(field(scriptFor('Endless One'), 'entersWith'));
      expect(field(mine.script, 'entersWith')).toEqual({ counter: '+1/+1', amount: 'x' });
    });

    it('reads a printed count and a word count, not only X', () => {
      // X is the cast's X; a number or a number-word is itself. Nothing in the pool prints the
      // second form as a sentence, which is why the fixture is synthetic.
      expect(field(entersWithScript('Arriving Thing enters the battlefield with three +1/+1 counters on it.'), 'entersWith'))
        .toEqual({ counter: '+1/+1', amount: 3 });
      expect(field(entersWithScript('Arriving Thing enters the battlefield with a +1/+1 counter on it.'), 'entersWith'))
        .toEqual({ counter: '+1/+1', amount: 1 });
      expect(field(entersWithScript('Arriving Thing enters the battlefield with four ice counters on it.'), 'entersWith'))
        .toEqual({ counter: 'ice', amount: 4 });
      expect(field(entersWithScript('Arriving Thing enters the battlefield with X charge counters on it.'), 'entersWith'))
        .toEqual({ counter: 'charge', amount: 'x' });
    });

    it.each([
      ['three time counters'],
      ['three fade counters'],
    ])('refuses %s, whose countdown lives in a keyword and not in the counters', (counters) => {
      /*
        The one refusal here that is about correctness rather than coverage. Vanishing and fading
        put both halves on the card — the counters and the upkeep trigger that removes one — and
        the keyword reader builds them together (D364). A sentence read on its own would lay the
        counters on a permanent with nothing counting them down, so it would never leave the
        battlefield: a card that works and is better than the print.
      */
      const odd = entersWith(`Arriving Thing enters the battlefield with ${counters as string} on it.`);
      expect(odd.ok).toBe(true);
      if (!odd.ok) return;
      expect(odd.script).toBeUndefined();
      expect(odd.unread.map((u) => u.why)).toEqual(['no-reader']);
    });

    /*
      Judith, and the one word in front of "creature you control" that this row is about.
    */
    it('watches a nontoken death the way Judith’s hand-written trigger watches it', () => {
      const mine = compiledScript('Judith, the Scourge Diva');
      expect(mine.unread).toEqual([]);
      const compiled = triggerOf(mine.script);
      const written = triggerOf(scriptFor('Judith, the Scourge Diva'));
      expect(compiled).toBeDefined();
      expect(written).toBeDefined();
      if (compiled === undefined || written === undefined) return;
      expect(JSON.stringify(compiled.on)).toEqual(JSON.stringify(written.on));
      /*
        Spelled out as well as compared, because the two words this sentence turns on are exactly
        the two a copied shape would get wrong: she triggers on **her own** death (`who: 'any'`,
        not `'another'`), and not on a token's (`nontoken`).
      */
      expect((compiled.on as { who?: string }).who).toBe('any');
      expect((compiled.on as { nontoken?: boolean }).nontoken).toBe(true);
      expect((compiled.on as { of?: string }).of).toBe('you');
    });

    it('deals the damage Judith’s hand-written trigger deals, at the target it is given', () => {
      const base = arena({
        decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
        battlefield: { 0: ['Judith, the Scourge Diva'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const judith = find(base, 0 as SeatIndex, 'battlefield', 'Judith, the Scourge Diva');
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, judith, [{ kind: 'card', id: bear }]);
      const mine = triggerOf(compiledScript('Judith, the Scourge Diva').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Judith, the Scourge Diva'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      // Not vacuous: one damage actually landed on the bear.
      expect(mine.instances[bear]!.damage).toBe(1);
    });

    it('keeps the anthem beside the trigger, which is the line this card nearly lost', () => {
      /*
        Judith's other line is the static that D381 read, and her two lines are read by two
        different readers in `lineScriptFor`'s chain. A card is only whole when both are merged, so
        the anthem is asserted here rather than left to the `unread` check above — "+1/+0 to her
        **other** creatures", which is the scope that makes her a 2/2 and not a 3/2.
      */
      const statics = field(compiledScript('Judith, the Scourge Diva').script, 'statics');
      expect(statics).toEqual(field(scriptFor('Judith, the Scourge Diva'), 'statics'));
      expect((statics as readonly { scope: string }[])[0]!.scope).toBe('other-controller-creatures');
    });
  });

  describe('a clause joined by "and", which is read only after everything else has failed', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    const spell = (text: string) => compileCard({
      name: 'Joined Up', type_line: 'Instant', mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
      oracle_text: text,
    });

    it('draws and loses, as Phyrexian Arena’s hand-written upkeep trigger does', () => {
      const mine = compiledScript('Phyrexian Arena');
      expect(mine.unread).toEqual([]);
      const base = arena({ decks: { 0: 'ashen-rite', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const compiled = triggerOf(mine.script)!.effect(ctx);
      const written = triggerOf(scriptFor('Phyrexian Arena'))!.effect(ctx);
      expect(compiled).toEqual(written);
      /*
        Both halves happened, which is the whole point of the composition: a reader that took the
        first clause and dropped the rest would pass a comparison against nothing.
      */
      expect(compiled.zones[zoneKey(0 as SeatIndex, 'hand')]!.length)
        .toBe(base.zones[zoneKey(0 as SeatIndex, 'hand')]!.length + 1);
      expect(compiled.seats[0]!.life).toBe(base.seats[0]!.life - 1);
    });

    it('reads a conjunction an earlier reader understands as one clause, not two', () => {
      /*
        "gets +2/+2 **and** gains trample" is one `pump` with a keyword in it, read by the grant
        family. Note what this test does **not** prove: moving the fallback to the front of the
        chain leaves it passing, because `conjoinedEffect` returns null on this clause either way —
        its second half, "gains trample until end of turn" with no target in it, is a clause nothing
        can read. A break run established that, and the test below is the one that guards the order.
      */
      const charm = spell('Target creature gets +2/+2 and gains trample until end of turn.');
      expect(charm.ok).toBe(true);
      if (!charm.ok) return;
      expect(charm.unread).toEqual([]);
      expect(field(charm.script, 'targets')).toHaveLength(1);
      // One continuous effect with both halves in it, so both expire together (CR 611.2).
      expect(field(charm.script, 'expiresAtEndOfTurn')).toBe(true);
    });

    it('still reads the announced count that is spent twice in one sentence', () => {
      /*
        The other conjunction that is not a sequence: Nissa's ultimate prints one X and spends it on
        both halves. Split into two clauses, each would want its own count and the `where X is`
        tail would belong to only one of them.
      */
      const counted = spell(
        'You gain X life and draw X cards, where X is the number of lands you control.',
      );
      expect(counted.ok).toBe(true);
      if (!counted.ok) return;
      expect(counted.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'verdant-guard' }, battlefield: { 0: ['Forest', 'Forest'] }, turn: 3,
      });
      const after = (field(counted.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // Two lands: two life and two cards, from one count.
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life + 2);
      expect(after.zones[zoneKey(0 as SeatIndex, 'hand')]!.length)
        .toBe(base.zones[zoneKey(0 as SeatIndex, 'hand')]!.length + 2);
    });

    it('agrees with the hand-written card on every conjunction the pool prints twice over', () => {
      /*
        ## What this replaced, and why the obvious test is a tautology

        The order of `readEffect`'s chain protects an invariant: a conjunction some earlier reader
        understands as **one** clause must keep that reading, rather than being split into two. The
        obvious guard is a sweep asking, for every printed clause with an "and" in it, whether both
        readings can read it — and that sweep cannot be written from outside the compiler, because
        `compileCard` does not say *which* reader read a clause. Once the fallback exists, "reads
        whole" includes the fallback, so every split-readable clause is also whole-readable and the
        sweep reduces to "the fallback exists". Three versions of it were written before that was
        clear; a break run that moved the fallback to the front of the chain left every one of them
        green.

        ## What is observable, and is therefore what is checked

        The sweep's one useful output was its list: the pool prints exactly four conjunctions that
        both readings can reach, and two of them are hand-written cards —

        - Zulaport Cutthroat and Cruel Celebrant: "each opponent loses 1 life and you gain 1 life"
        - Phyrexian Arena: "you draw a card and you lose 1 life"
        - Tatyova, Benthic Druid: "draw a card and you gain 1 life" (behind a prologue nothing reads
          yet, so the card is still a hybrid)

        For the ones with a script to compare against, the two readings **agree** — which is why no
        test can tell them apart, and is the real reason the ordering is safe on this pool rather
        than merely argued. That agreement is what this asserts, against the hand-written card.

        The hazard the ordering guards is therefore a *future* single reader that disagrees with the
        split on the same sentence. Nothing in this suite would catch that, and saying so here is
        better than a test that looks like it would.
      */
      const base = arena({
        decks: { 0: 'rot-harvest', 1: 'ember-rush' },
        battlefield: { 0: ['Zulaport Cutthroat'] },
        turn: 3,
      });
      const source = find(base, 0 as SeatIndex, 'battlefield', 'Zulaport Cutthroat');
      const ctx = contextOn(base, 0 as SeatIndex, source);
      const mine = triggerOf(compiledScript('Zulaport Cutthroat').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Zulaport Cutthroat'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      // Both halves, and in the printed direction: their life down, mine up.
      expect(mine.seats[1]!.life).toBe(base.seats[1]!.life - 1);
      expect(mine.seats[0]!.life).toBe(base.seats[0]!.life + 1);
    });

    it('refuses a conjunction whose halves each want their own target', () => {
      /*
        `targets` is one list per script, so two targeting halves would be handed the same object.
        `composeEffects` already refuses that and this is the conjunction reaching it.
      */
      const two = spell('Destroy target creature and destroy target enchantment.');
      expect(two.ok).toBe(true);
      if (two.ok) expect(two.script).toBeUndefined();
    });

    it('refuses a conjunction with one half nothing can read', () => {
      // All or nothing: a card that drew the card and silently skipped the rest would be worse
      // than an unread line, which is dealt to a human instead (D362).
      const half = spell('You draw a card and the table applauds politely.');
      expect(half.ok).toBe(true);
      if (half.ok) expect(half.script).toBeUndefined();
    });

    it('does not read a list of recipients as a sequence of clauses', () => {
      /*
        Hurricane's phrase, which is where a naive split is most tempting and most wrong: "each
        creature with flying and each player" is one damage event's **recipients**, not two effects.

        This row used to assert that the card stayed *unread*, which was recording a gap as though
        it were a property — the same mistake D419 found four times over. `sweepDestination` reads
        the phrase now (D423), so what is left to guard is the thing that was always the point: the
        "and" is not a clause boundary. Asserted on the board rather than on the shape, because a
        composition that split it would deal the damage to *something* and a shape check would not
        say what.
      */
      const sweep = spell('Joined Up deals 3 damage to each creature with flying and each player.');
      expect(sweep.ok).toBe(true);
      if (!sweep.ok) return;
      expect(sweep.unread).toEqual([]);
      // Nothing is chosen: a sweep is a destination, not a target (see `sweepDestination`).
      expect(field(sweep.script, 'targets')).toBeUndefined();

      const base = arena({
        decks: { 0: 'skyward-writ', 1: 'ember-rush' },
        battlefield: { 0: ['Serra Angel', 'Basilica Guards'] },
        turn: 3,
      });
      const angel = find(base, 0 as SeatIndex, 'battlefield', 'Serra Angel');
      const guards = find(base, 0 as SeatIndex, 'battlefield', 'Basilica Guards');
      const after = (field(sweep.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // The flier is dealt 3 and lives on 4 toughness; the 0/4 that cannot fly is dealt nothing.
      expect(after.instances[angel]!.damage).toBe(3);
      expect(after.instances[guards]!.damage ?? 0).toBe(0);
      // "each player" is every seat, the caster's own included — which is the card.
      expect(after.seats.map((seat) => seat.life))
        .toEqual(base.seats.map((seat) => seat.life - 3));
    });
  });

  describe('the X a spell was cast for, which is a shape and not a clause', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
      x = 0,
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [], x,
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it('deals the X it was cast for, at the target, as Fireball’s hand-written script does', () => {
      const mine = compiledScript('Fireball');
      expect(mine.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'ember-rush', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bear }], 3);
      expect(resolve(mine.script)(ctx)).toEqual(resolve(scriptFor('Fireball'))(ctx));
      // Three, not one and not the creature's toughness: the number the spell was cast for.
      expect(resolve(mine.script)(ctx).instances[bear]!.damage).toBe(3);
      // And it points where the card points.
      expect(field(mine.script, 'targets')).toEqual(field(scriptFor('Fireball'), 'targets'));
    });

    it('deals nothing when X is zero, as the hand-written Fireball does', () => {
      const base = arena({
        decks: { 0: 'ember-rush', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bear }], 0);
      const mine = resolve(compiledScript('Fireball').script)(ctx);
      expect(mine).toEqual(resolve(scriptFor('Fireball'))(ctx));
      // `dealDamage` refuses a non-positive amount, which is why neither card has a zero guard.
      expect(mine).toEqual(base);
    });

    it('sweeps every creature for X, as Savage Twister’s hand-written script does', () => {
      const mine = compiledScript('Savage Twister');
      expect(mine.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'kindle-grove', 1: 'verdant-guard' },
        battlefield: { 0: ['Centaur Courser'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [], 2);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Savage Twister'))(ctx));
      /*
        Both creatures, the caster's own included — which is the card, and the reason this is a
        sweep rather than a target. A reader that used the targeted branch would have hit one.
      */
      const mine1 = find(base, 0 as SeatIndex, 'battlefield', 'Centaur Courser');
      const theirs = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      expect(after.instances[mine1]!.damage).toBe(2);
      expect(after.instances[theirs]!.damage).toBe(2);
      // No target choice at all, so nothing is asked for.
      expect(field(mine.script, 'targets')).toBeUndefined();
    });

    it('owes the controller X cards, as Mind Spring’s hand-written script does', () => {
      const mine = compiledScript('Mind Spring');
      expect(mine.unread).toEqual([]);
      const base = arena({ decks: { 0: 'delta-bloom', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [], 4);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Mind Spring'))(ctx));
      /*
        Owed rather than taken: `drawLater` is the hand-written reading, so the cards arrive as
        moves the controller makes. A reader that called `draw` would pass a hand-size check and
        fail this one.
      */
      expect(after.drawsOwed.length).toBe(base.drawsOwed.length + 4);
      expect(after.zones[zoneKey(0 as SeatIndex, 'hand')]!.length)
        .toBe(base.zones[zoneKey(0 as SeatIndex, 'hand')]!.length);
    });

    it('makes X tokens, as Secure the Wastes’ hand-written script does', () => {
      const mine = compiledScript('Secure the Wastes');
      expect(mine.unread).toEqual([]);
      const base = arena({ decks: { 0: 'forge-alliance', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [], 3);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Secure the Wastes'))(ctx));
      /*
        Three Warriors, and `toEqual` against the hand-written card is the strong part: it compares
        the token's whole definition, so a compiled Warrior of the wrong colour or the wrong size
        would fail here rather than in a count.
      */
      expect(ids(after, 0 as SeatIndex, 'battlefield').filter((id) => nameOf(after, id) === 'Warrior'))
        .toHaveLength(3);
    });

    it('makes nothing for X of zero, as the hand-written script does', () => {
      const base = arena({ decks: { 0: 'forge-alliance', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [], 0);
      const after = resolve(compiledScript('Secure the Wastes').script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Secure the Wastes'))(ctx));
      expect(after).toEqual(base);
    });

    it('still refuses X tokens where the count is a tail rather than the cast', () => {
      /*
        The count is shared with `tokenEffect` and the printed word decides which reading applies:
        `X` with no tail is the cast's X, `X` with a `where X is` tail is a board count (D392), and
        `a … for each` is the per-thing count (D396). A sentence with **both** — an X tail on an X
        spell — is not something a card prints, and the tail wins, which keeps the board count's
        reading rather than silently substituting the cast's.
      */
      const tailed = compileCard({
        name: 'Doubled Count', type_line: 'Sorcery', mana_cost: '{X}{G}', cmc: 1, colors: ['G'],
        oracle_text: 'Create X 1/1 green Elf creature tokens, where X is the number of lands you control.',
      });
      expect(tailed.ok).toBe(true);
      if (!tailed.ok) return;
      expect(tailed.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'verdant-guard' }, battlefield: { 0: ['Forest', 'Forest'] }, turn: 3,
      });
      // Two lands, and X deliberately set to 5: the board count is what the card reads.
      const after = resolve(tailed.script)(contextOn(base, 0 as SeatIndex, 'c1', [], 5));
      expect(ids(after, 0 as SeatIndex, 'battlefield').filter((id) => nameOf(after, id) === 'Elf'))
        .toHaveLength(2);
    });

    it('will not read the same sentence on a permanent, where there is no X to spend', () => {
      /*
        The safety property, and the reason the X reading lives on the spell path rather than in the
        clause vocabulary. A triggered ability's stack object carries no X — `automation.ts` fills
        the context with `object.x ?? 0` — so a clause reader that understood bare X would give this
        creature a trigger that draws **nothing**, for ever, with nothing left unread for a human to
        notice (D362).

        So the line is refused and the card is dealt as a hybrid instead, which is the honest
        outcome.
      */
      const permanent = compileCard({
        name: 'Hopeful Drake', type_line: 'Creature — Drake', mana_cost: '{X}{U}', cmc: 1,
        colors: ['U'], power: '2', toughness: '2',
        oracle_text: 'When Hopeful Drake enters the battlefield, draw X cards.',
      });
      expect(permanent.ok).toBe(true);
      if (!permanent.ok) return;
      expect(permanent.script).toBeUndefined();
      expect(permanent.unread.map((u) => u.why)).toEqual(['no-reader']);
    });

    it('refuses a second sentence that also spends X', () => {
      /*
        Exsanguinate's shape: "Each opponent loses X life. You gain life equal to the life lost this
        way." The second sentence is not an X clause at all — it reads the life actually lost, which
        at a pod is X times the number of opponents — so reading the first and stopping would be a
        drain with the lifegain silently dropped. One clause only, until that second reader exists.
      */
      const two = compileCard({
        name: 'Twin Spend', type_line: 'Sorcery', mana_cost: '{X}{B}', cmc: 1, colors: ['B'],
        oracle_text: 'Twin Spend deals X damage to any target. You gain X life.',
      });
      expect(two.ok).toBe(true);
      if (two.ok) expect(two.script).toBeUndefined();
    });
  });

  describe('statics that are only on while something is true, and the ability word in front', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    /*
      A static is plain data with no closure in it, so these compare by **deep equality** against
      the hand-written card — the strictest comparison available, and the one that catches a wrong
      condition kind, a wrong threshold, or a bonus on the wrong field.
    */
    it.each([
      // Metalcraft on a size: "gets +2/+2 as long as you control three or more artifacts".
      ['Chrome Steed'],
      // And on a grant: "has protection from all colors as long as …", which is the five-colour
      // list rather than a special case (D83).
      ['Etched Champion'],
      // The other condition kind: "as long as ~ is monstrous", which this engine models as a
      // +1/+1 counter on the creature itself (D182).
      ['Fleecemane Lion'],
    ])('%s carries exactly the conditional static the hand-written card declares', (card) => {
      const mine = compiledScript(card as string);
      expect(field(mine.script, 'statics'))
        .toEqual(field(scriptFor(card as string), 'statics'));
      // Not vacuous: there really is one, and it really is conditional.
      const statics = field(mine.script, 'statics') as readonly { effect: { while?: unknown } }[];
      expect(statics).toHaveLength(1);
      expect(statics[0]!.effect.while).toBeDefined();
    });

    it('reads the metalcraft threshold as three, and refuses any other number', () => {
      /*
        The threshold is the card. Every metalcraft card printed says "three or more", so the
        reader takes that phrase and nothing else — a sentence with a different number is a
        different card, and reading it as metalcraft would be a static that turns on at the wrong
        time, with nothing flagged.
      */
      const wrong = compileCard({
        name: 'Nearly Metalcraft', type_line: 'Creature — Construct', mana_cost: '{3}', cmc: 3,
        colors: [], power: '2', toughness: '2',
        oracle_text: 'Nearly Metalcraft gets +2/+2 as long as you control two or more artifacts.',
      });
      expect(wrong.ok).toBe(true);
      if (wrong.ok) expect(wrong.script).toBeUndefined();
    });

    it('refuses a conditional grant whose keyword the engine would ignore', () => {
      // The grant family's argument, in a static: a creature that looks protected and is not is
      // worse than an unread line, which is dealt to a human instead (D362).
      const odd = compileCard({
        name: 'Odd Lion', type_line: 'Creature — Cat', mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
        power: '3', toughness: '3',
        oracle_text: 'As long as Odd Lion is monstrous, it has hexproof and soaring.',
      });
      expect(odd.ok).toBe(true);
      if (odd.ok) expect(odd.script).toBeUndefined();
    });

    it('refuses a conditional protection that is not from every colour', () => {
      /*
        Coverage rather than correctness, and said so: `protectionFrom` is a list, so one colour is
        expressible — but no card in the pool prints a conditional single-colour protection, and a
        reader with no card behind it is a reader nothing has ever run (D57). The phrase this
        accepts is the one Etched Champion prints.
      */
      const narrow = compileCard({
        name: 'Narrow Champion', type_line: 'Creature — Soldier', mana_cost: '{2}', cmc: 2,
        colors: [], power: '1', toughness: '1',
        oracle_text: 'Narrow Champion has protection from red as long as you control three or more artifacts.',
      });
      expect(narrow.ok).toBe(true);
      if (narrow.ok) expect(narrow.script).toBeUndefined();
    });

    /*
      ── The ability word ──────────────────────────────────────────────────────────────────────
    */
    it('fires on the battalion attack the hand-written Firemane Avenger fires on', () => {
      const mine = compiledScript('Firemane Avenger');
      expect(mine.unread).toEqual([]);
      const compiled = triggerOf(mine.script);
      const written = triggerOf(scriptFor('Firemane Avenger'));
      expect(compiled).toBeDefined();
      if (compiled === undefined || written === undefined) return;
      expect(JSON.stringify(compiled.on)).toEqual(JSON.stringify(written.on));
      // Three, which is "this and at least two others" — not two, and not every attack.
      expect((compiled.on as { withAtLeast?: number }).withAtLeast).toBe(3);
    });

    it('deals the damage and gains the life, in the printed order', () => {
      const base = arena({
        decks: { 0: 'forge-alliance', 1: 'verdant-guard' },
        battlefield: { 0: ['Firemane Avenger'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const avenger = find(base, 0 as SeatIndex, 'battlefield', 'Firemane Avenger');
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, avenger, [{ kind: 'card', id: bear }]);
      const mine = triggerOf(compiledScript('Firemane Avenger').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Firemane Avenger'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      /*
        Both halves, which is the conjunction reader (D398) doing the work inside a trigger: the
        damage and the life are one printed sentence joined by "and".
      */
      expect(mine.instances[bear]!.damage).toBe(3);
      expect(mine.seats[0]!.life).toBe(base.seats[0]!.life + 3);
    });

    it('reads a sentence the same with a label in front of it and without', () => {
      /*
        **This row used to assert the opposite of its second half, and D441 retired that.** It read
        "strips only the ability words it knows, and refuses the rest", and its first assertion was
        that `Constellation — <static>` compiled to no script at all, on the argument that a general
        rule would eat a Saga's chapter markers. The hazard was real and the conclusion was not: the
        corpus has 540 distinct labels on 2,733 legal lines, most of the readable ones named on one
        card, so an allow list is a list of cards. `withoutAbilityWord` refuses by rules meaning
        now, and `Constellation` has none — it reads. The refusals have their own table, under "the
        label in front of an ability, which has no rules meaning".

        What survives is the invariant that was always worth asserting, now for **any** label rather
        than for the three the list happened to name: the label changes nothing about the reading.
      */
      const read = (text: string) => compileCard({
        name: 'Plain Steed', type_line: 'Creature — Construct', mana_cost: '{3}', cmc: 3,
        colors: [], power: '2', toughness: '2', oracle_text: text,
      });
      const bare = read('Plain Steed gets +2/+2 as long as you control three or more artifacts.');
      expect(bare.ok).toBe(true);
      if (!bare.ok) return;
      expect(field(bare.script, 'statics')).toBeDefined();

      for (const label of ['Metalcraft', 'Constellation', 'Keen Senses']) {
        const worded = read(
          `${label} — Plain Steed gets +2/+2 as long as you control three or more artifacts.`,
        );
        expect(worded.ok).toBe(true);
        if (!worded.ok) continue;
        expect(worded.unread).toEqual([]);
        expect(field(worded.script, 'statics')).toEqual(field(bare.script, 'statics'));
      }
    });
  });

  describe('a size that is a count, and the creature that sacrifices itself at end of turn', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
    ): EffectContext => ({
      state, controller: seat, source, targets: [], decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    it.each([
      // "power is equal to the number of creature cards in all graveyards and its toughness is
      // equal to that number plus 1" — both, with the toughness one higher.
      ['Lhurgoyf'],
      // "power is equal to the number of instant and sorcery cards in your graveyard" — power
      // only, the printed toughness left alone.
      ['Enigma Drake'],
    ])('%s defines its size exactly as the hand-written card does', (card) => {
      const mine = compiledScript(card as string);
      expect(mine.unread).toEqual([]);
      expect(field(mine.script, 'statics'))
        .toEqual(field(scriptFor(card as string), 'statics'));
    });

    it('reads the size off the board, and not as a printed number', () => {
      /*
        The static is plain data, so the equality above cannot tell a count that is wired up from
        one that is merely shaped right. This asks the engine what the creature is: a Lhurgoyf with
        two creature cards in a graveyard is a 2/3, and a reader that emitted the wrong count — or
        no count at all — would read its printed size instead.
      */
      const base = arena({
        decks: { 0: 'rot-harvest', 1: 'ember-rush' },
        battlefield: { 0: ['Lhurgoyf'] },
        graveyard: { 0: ['Shambling Shell', 'Vampire Aristocrat', 'Raise Dead'] },
        turn: 3,
      });
      const goyf = find(base, 0 as SeatIndex, 'battlefield', 'Lhurgoyf');
      const live = characteristicsOf(base, base.instances[goyf]!);
      // Two creature cards; the sorcery is the control.
      expect(live.power).toBe(2);
      expect(live.toughness).toBe(3);
    });

    it('refuses a count this engine has no data for', () => {
      /*
        `definesSize` names its counts (D57): "cards in your hand" is a real Magic card and not a
        count the engine can take, so the line is refused rather than read as one of the two it
        does have. A card compiled with the wrong count is a creature of the wrong size, every
        turn, with nothing flagged.

        Two arms, because D431 made the printed size matter here. A `*`/`*` whose count went unread
        has **no** size at all, so the whole card is refused: dealing it would put a 0/0 on the
        battlefield and CR 704.5f would bin it before anybody had priority, which is worse than the
        player playing the card by hand. The same text on a card that prints a real 2/2 is kept —
        it is a 2/2 with one line nobody is running, which is exactly D362's trade — and that arm is
        what pins the refusal above to the *count* rather than to the type line.
      */
      const starred = compileCard({
        name: 'Hand Goyf', type_line: 'Creature — Lhurgoyf', mana_cost: '{2}{G}', cmc: 3,
        colors: ['G'], power: '*', toughness: '*',
        oracle_text: 'Hand Goyf’s power is equal to the number of cards in your hand.',
      });
      expect(starred.ok).toBe(false);
      if (!starred.ok) expect(starred.why).toContain('comes from an ability, not a number');

      const sized = compileCard({
        name: 'Hand Goyf', type_line: 'Creature — Lhurgoyf', mana_cost: '{2}{G}', cmc: 3,
        colors: ['G'], power: '2', toughness: '2',
        oracle_text: 'Hand Goyf’s power is equal to the number of cards in your hand.',
      });
      expect(sized.ok).toBe(true);
      if (sized.ok) {
        expect(sized.script).toBeUndefined();
        expect(sized.unread).toHaveLength(1);
        expect(sized.def.power).toBe('2');
      }
    });

    /*
      ── The creature that goes away ───────────────────────────────────────────────────────────
    */
    it.each([
      ['Ball Lightning'],
      ['Hellspark Elemental'],
    ])('%s both sacrifices itself and tells the bot it is going to', (card) => {
      const mine = compiledScript(card as string);
      const written = scriptFor(card as string);
      /*
        **Both halves**, which is the whole reason this is one line's reading and not a prologue
        plus a clause. The trigger alone is a correct rules implementation and a badly played card:
        the evaluation holds a 6/1 back to protect a creature that is dying anyway. D364's rule, in
        its sharpest form.
      */
      expect(field(mine.script, 'leavesAtEndOfTurn')).toBe(true);
      expect(field(mine.script, 'leavesAtEndOfTurn')).toEqual(field(written, 'leavesAtEndOfTurn'));

      const compiled = triggerOf(mine.script);
      expect(compiled).toBeDefined();
      if (compiled === undefined) return;
      // The end step of **any** turn, which is what kills a Ball Lightning cast on somebody else's.
      expect(JSON.stringify(compiled.on)).toEqual(JSON.stringify({ kind: 'step', step: 'end', of: 'any' }));
    });

    it('sacrifices the creature, as the hand-written trigger does', () => {
      const base = arena({
        decks: { 0: 'ember-rush', 1: 'verdant-guard' },
        battlefield: { 0: ['Ball Lightning'] },
        turn: 3,
      });
      const bolt = find(base, 0 as SeatIndex, 'battlefield', 'Ball Lightning');
      const ctx = contextOn(base, 0 as SeatIndex, bolt);
      const mine = triggerOf(compiledScript('Ball Lightning').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Ball Lightning'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      // It really left the battlefield, and really went to its owner's graveyard.
      expect(ids(mine, 0 as SeatIndex, 'battlefield')).not.toContain(bolt);
      expect(ids(mine, 0 as SeatIndex, 'graveyard')).toContain(bolt);
    });

    it('reads the same sacrifice behind a different prologue WITHOUT the flag (D514)', () => {
      /*
        **This row was a refusal until D514.** "Sacrifice ~" had no clause reader, so behind any
        other prologue the line went unread — and the argument for leaving it that way was that
        emitting the trigger *with* `leavesAtEndOfTurn` would be a lie about the card while emitting
        it without the flag would be the badly played creature this pair reader exists to avoid.

        The clause reads now (**15 legal cards** print `When ~ becomes the target of a spell or
        ability, sacrifice it` alone), so the line reads too. What has to stay true is the half that
        was never about the clause: a sacrifice behind another prologue does **not** mean the
        permanent leaves at end of turn, so the flag is absent. 28 legal cards print
        `Whenever ~ attacks, sacrifice …`, and a bot that held one back to protect a creature it was
        about to sacrifice anyway would be reading a flag the card does not have.
      */
      const other = compileCard({
        name: 'Doomed Hound', type_line: 'Creature — Dog', mana_cost: '{R}', cmc: 1, colors: ['R'],
        power: '3', toughness: '1',
        oracle_text: 'Whenever Doomed Hound attacks, sacrifice Doomed Hound.',
      });
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(other.unread.map((u) => u.line)).toEqual([]);
      expect(field(other.script, 'leavesAtEndOfTurn')).toBeUndefined();
      const trigger = triggerOf(other.script);
      expect(trigger?.on.kind).toBe('attacks');
    });

    it('reads "your end step" as its own turn, with the flag (D514)', () => {
      /*
        Also a refusal until D514, and for the same reason — and once the clause read, the choice was
        between this reader, which carries the bot hint, and the generic trigger path, which does
        not. **11 legal cards** print the "your" form against 25 for "the", and the two are different
        cards: `of: 'you'` survives being cast on somebody else's turn and `of: 'any'` does not. So
        the word is read rather than defaulted.
      */
      const mine = compileCard({
        name: 'Polite Lightning', type_line: 'Creature — Elemental', mana_cost: '{R}', cmc: 1,
        colors: ['R'], power: '6', toughness: '1',
        oracle_text: 'At the beginning of your end step, sacrifice Polite Lightning.',
      });
      expect(mine.ok).toBe(true);
      if (!mine.ok) return;
      expect(mine.unread.map((u) => u.line)).toEqual([]);
      expect(field(mine.script, 'leavesAtEndOfTurn')).toBe(true);
      expect(JSON.stringify(triggerOf(mine.script)?.on))
        .toEqual(JSON.stringify({ kind: 'step', step: 'end', of: 'you' }));
    });
  });

  describe('a word that stands for a sentence, mana out of a trigger, and damage divided', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
      division?: readonly number[],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [], division,
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it('investigates by making the engine’s own Clue, as Thraben Inspector does', () => {
      /*
        "Investigate" is one word standing for text the card does not print: create a colourless
        Clue artifact token with "{2}, Sacrifice this artifact: Draw a card" (CR 701.33a). The
        reading is a **call** to the engine's `CLUE_TOKEN` — a definition D243 wrote and tested —
        rather than a transcription, which is the only safe way to read a word like that: inventing
        the token's text here would be inventing the text of a real card (D259).
      */
      const mine = compiledScript('Thraben Inspector');
      expect(mine.unread).toEqual([]);
      const base = arena({ decks: { 0: 'skyward-writ', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const after = triggerOf(mine.script)!.effect(ctx);
      expect(after).toEqual(triggerOf(scriptFor('Thraben Inspector'))!.effect(ctx));
      const clues = ids(after, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(after, id) === 'Clue');
      expect(clues).toHaveLength(1);
    });

    it('adds the printed mana to the pool, as Burning-Tree Emissary does', () => {
      const mine = compiledScript('Burning-Tree Emissary');
      expect(mine.unread).toEqual([]);
      const base = arena({ decks: { 0: 'kindle-grove', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const after = triggerOf(mine.script)!.effect(ctx);
      expect(after).toEqual(triggerOf(scriptFor('Burning-Tree Emissary'))!.effect(ctx));
      /*
        One red and one green, which is the card. The state comparison above would pass on a
        reader that added the same two symbols in the other order — pools are keyed by colour —
        but not on one that added the wrong colours or the wrong number, and this says which.
      */
      expect(after.pools['0']).toMatchObject({ R: 1, G: 1 });
    });

    it('carries makesMana on the spell and not on the creature’s trigger', () => {
      /*
        The bot hint, and the reason `spellFlags` is the right carrier for it. Without `makesMana`
        the search casts a Dark Ritual into nothing: the mana sits in the pool and the position
        after the cast scores no better (#63). But the same clause on **Burning-Tree Emissary** must
        *not* carry it — that card's own comment records the measurement, 46% of copies cast with
        the flag against 101% without, because a 2/2 for two is worth casting on its own.

        `spellFlags` reach the spell path only, so one reader gets both cards right. This defect was
        found by the per-card coverage diff: Dark Ritual started compiling as a side effect of the
        add-mana clause and arrived without its flag — a card that works and plays badly, which is
        the third time that shape has turned up (D364, D394).
      */
      expect(compiledScript('Dark Ritual').script).toHaveProperty('makesMana', true);
      expect(scriptFor('Dark Ritual')).toHaveProperty('makesMana', true);
      expect(field(compiledScript('Burning-Tree Emissary').script, 'makesMana')).toBeUndefined();
      expect(field(scriptFor('Burning-Tree Emissary'), 'makesMana')).toBeUndefined();
    });

    it('drops makesMana from a spell that does something else as well', () => {
      /*
        The field is for a spell whose **whole** effect is mana. One that adds mana and draws a card
        has a visible effect, so the hint would hold it back for a follow-up it does not need.
        Nothing in the pool prints that pair, so this is the first card of its kind being read
        correctly rather than plausibly.
      */
      const mixed = compileCard({
        name: 'Ritual Draw', type_line: 'Instant', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: 'Add {B}{B}. Draw a card.',
      });
      expect(mixed.ok).toBe(true);
      if (!mixed.ok) return;
      expect(mixed.unread).toEqual([]);
      expect(field(mixed.script, 'makesMana')).toBeUndefined();
    });

    it('refuses mana a pool cannot hold', () => {
      /*
        The regex is the validation and admits only the six symbols `addToPool` takes. `{2}` is
        generic mana, which is a thing a *cost* has and not a thing a pool holds, so the clause is
        refused rather than read as some colour.
      */
      for (const text of ['Add {2}.', 'Add {E}.', 'Add one mana of any color.']) {
        const odd = compileCard({
          name: 'Odd Source', type_line: 'Creature — Elemental', mana_cost: '{R}{G}', cmc: 2,
          colors: ['R', 'G'], power: '2', toughness: '2',
          oracle_text: `When Odd Source enters the battlefield, ${text.toLowerCase()}`,
        });
        expect(odd.ok, text).toBe(true);
        if (odd.ok) expect(odd.script, text).toBeUndefined();
      }
    });

    it.each([
      // "3 damage divided as you choose among one, two, or three targets" — three and three.
      ['Arc Lightning', 3, 3],
    ])('%s divides %i damage among up to %i targets, as the hand-written card does', (card, divided, count) => {
      const mine = compiledScript(card as string);
      expect(field(mine.script, 'targets'))
        .toEqual(field(scriptFor(card as string), 'targets'));
      const spec = (field(mine.script, 'targets') as readonly TargetSpec[])[0]!;
      expect(spec.divided).toBe(divided as number);
      expect(spec.count).toBe(count as number);
      // Every lower number in the printed list is a real choice, which is what `optional` says.
      expect(spec.optional).toBe(true);
    });

    it('deals each target its own share, rather than the whole amount to each', () => {
      const base = arena({
        decks: { 0: 'arc-tempest', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears', 'Llanowar Elves'] },
        turn: 3,
      });
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const elf = find(base, 1 as SeatIndex, 'battlefield', 'Llanowar Elves');
      const ctx = contextOn(
        base, 0 as SeatIndex, 'c1',
        [{ kind: 'card', id: bear }, { kind: 'card', id: elf }],
        [2, 1],
      );
      const mine = resolve(compiledScript('Arc Lightning').script)(ctx);
      expect(mine).toEqual(resolve(scriptFor('Arc Lightning'))(ctx));
      /*
        Two and one, not three and three: each target is a separate dealing of damage with its own
        share (CR 601.2d), which is why the effect is one `dealDamage` per target rather than a
        loop over a single amount.
      */
      expect(mine.instances[bear]!.damage).toBe(2);
      expect(mine.instances[elf]!.damage).toBe(1);
    });

    it.each([
      // Nothing in the list is a number, so there is no count to take at all.
      ['any number of targets'],
      /*
        And the case that needs its own row: a readable number **beside** an unreadable word. The
        largest-word rule would happily return two here and read a card whose list it did not
        understand — so every word has to be a number, and a break run that drops that check
        passes the row above and fails this one.
      */
      ['two or many targets'],
    ])('refuses a divided clause printed "among %s"', (list) => {
      // The count comes from the printed list, so a list this cannot read is a count it would
      // have to guess — and a guessed count is a spell that may not be aimed where the card says.
      const odd = compileCard({
        name: 'Vague Bolt', type_line: 'Instant', mana_cost: '{2}{R}', cmc: 3, colors: ['R'],
        oracle_text: `Vague Bolt deals 3 damage divided as you choose among ${list as string}.`,
      });
      expect(odd.ok).toBe(true);
      if (odd.ok) expect(odd.script).toBeUndefined();
    });
  });

  describe('a target chosen by power, read live, and the exile that is not a destruction', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    it('reads the power threshold off the card, which prints two different numbers', () => {
      /*
        Selesnya Charm exiles a creature with power **5** or greater and Hidden Dragonslayer
        destroys one with power **4** or greater. A reader that fixed either number would make one
        of the two point at creatures its print excludes, so the number is read.
      */
      const charm = compiledScript('Selesnya Charm');
      expect(charm.unread).toEqual([]);
      const slayer = compiledScript('Hidden Dragonslayer');
      const slayerSpec = (triggerOf(slayer.script)!.targets ?? [])[0]!;
      expect(slayerSpec.description).toBe('target creature with power 4 or greater an opponent controls');
    });

    it('asks about the creature’s current power, not its printed one', () => {
      /*
        The #319 lesson in a filter that is about a number instead of a type. Both hand-written
        filters say it in a comment: "a 2/2 pumped past five is a legal target and a 6/6 shrunk
        below it is not, which is the whole reason characteristics are computed on demand".

        So this builds both boards. A Grizzly Bears with four +1/+1 counters is a 6/6 and a legal
        target for the charm's five; a Lhurgoyf-sized creature shrunk below four is not a legal
        target for the Dragonslayer's.
      */
      const base = arena({
        decks: { 0: 'forge-alliance', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const spec = (field(compiledScript('Selesnya Charm').script, 'modal') as {
        modes: readonly { targets?: readonly TargetSpec[] }[];
      }).modes[1]!.targets![0]!;
      const filter = spec.filter!;

      // A 2/2 is not a legal target for "power 5 or greater".
      expect(filter(base, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1')).toBe(false);
      // The same creature with four +1/+1 counters on it is a 6/6, and is.
      const grown = addCounters(base, bear, '+1/+1', 4);
      expect(filter(grown, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1')).toBe(true);
      // And the counters really are what moved it, read live rather than off the printed line.
      expect(characteristicsOf(grown, grown.instances[bear]!).power).toBe(6);
      /*
        And the number is **five**, which needs its own board: a 4/4 is refused. Without this the
        test passes on a reader that fixed the threshold at the Dragonslayer's four, which a break
        run proved — 2 is below either number and 6 is above both, so neither of the boards above
        can tell the two cards apart.
      */
      const four = addCounters(base, bear, '+1/+1', 2);
      expect(characteristicsOf(four, four.instances[bear]!).power).toBe(4);
      expect(filter(four, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1')).toBe(false);
    });

    it('will not let the Dragonslayer point at the controller’s own creature', () => {
      // "an opponent controls" is half of that phrase and it is load-bearing: a morph turned face
      // up that could kill its own team is a different card.
      const base = arena({
        decks: { 0: 'skyward-writ', 1: 'verdant-guard' },
        battlefield: { 0: ['Serra Angel'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const mine = find(base, 0 as SeatIndex, 'battlefield', 'Serra Angel');
      const spec = (triggerOf(compiledScript('Hidden Dragonslayer').script)!.targets ?? [])[0]!;
      const filter = spec.filter!;
      // A 4/4 of the controller's own is refused although its power qualifies.
      expect(characteristicsOf(base, base.instances[mine]!).power).toBeGreaterThanOrEqual(4);
      expect(filter(base, { kind: 'card', id: mine }, 0 as SeatIndex, 'c1')).toBe(false);
    });

    it('exiles rather than destroys, and the state matches the hand-written mode', () => {
      /*
        Exile is destroy's sibling and differs where it matters: it is not a destruction, so
        indestructible and regeneration do not answer it (CR 701.19a). The comparison is against
        Selesnya Charm's own second mode.
      */
      const base = arena({
        decks: { 0: 'forge-alliance', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bear }]);
      const modes = (script: unknown) => (field(script, 'modal') as {
        modes: readonly { effect: (c: EffectContext) => GameState }[];
      }).modes;
      const mine = modes(compiledScript('Selesnya Charm').script)[1]!.effect(ctx);
      const theirs = modes(scriptFor('Selesnya Charm'))[1]!.effect(ctx);
      expect(mine).toEqual(theirs);
      // Exiled, not in a graveyard: the difference between this mode and a Doom Blade.
      expect(ids(mine, 1 as SeatIndex, 'graveyard')).not.toContain(bear);
      expect(ids(mine, 1 as SeatIndex, 'battlefield')).not.toContain(bear);
    });

    it('tells the bot the exile removes a creature, and only when it does', () => {
      /*
        The same hint the destroy reader carries, for the same reason: a spell that removes a
        creature should not be cast with nothing of theirs to point at. And only when the target
        really is a creature — an exile aimed at a permanent of any kind would have the bot holding
        it for a board it cannot answer.
      */
      const creature = compileCard({
        name: 'Exile One', type_line: 'Instant', mana_cost: '{1}{W}', cmc: 2, colors: ['W'],
        oracle_text: 'Exile target creature.',
      });
      expect(creature.ok).toBe(true);
      if (creature.ok) expect(creature.script).toHaveProperty('removesACreature', true);

      const permanent = compileCard({
        name: 'Exile Any', type_line: 'Instant', mana_cost: '{1}{W}', cmc: 2, colors: ['W'],
        oracle_text: 'Exile target nonland permanent.',
      });
      expect(permanent.ok).toBe(true);
      if (permanent.ok) expect(field(permanent.script, 'removesACreature')).toBeUndefined();
    });
  });

  describe('an additional cost, which is paid as the spell is cast and not as it resolves', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    it.each([
      // "Destroy target creature" plus the sacrifice — the whole card, both halves.
      ['Bone Splinters'],
      // And the same cost on a card whose resolution is a draw.
      ['Village Rites'],
    ])('%s carries the additional cost the hand-written card declares', (card) => {
      const mine = compiledScript(card as string);
      expect(mine.unread).toEqual([]);
      expect(field(mine.script, 'additionalCost'))
        .toEqual(field(scriptFor(card as string), 'additionalCost'));
      expect(field(mine.script, 'additionalCost')).toEqual({ sacrifice: 'creature' });
    });

    it('keeps the cost out of the resolution', () => {
      /*
        The property that makes this a reader of its own rather than a clause. The sacrifice happens
        as the spell is **cast** (CR 601.2h), so it cannot be responded to and the creature cannot
        be saved in reply. Handing the sentence to `composeEffects` would either refuse the card or
        run the sacrifice on resolution, which is a different card.

        Asserted by resolving Village Rites and watching it draw and **sacrifice nothing**: the
        board is untouched apart from the cards owed.
      */
      const base = arena({
        decks: { 0: 'rot-harvest', 1: 'ember-rush' },
        battlefield: { 0: ['Shambling Shell'] },
        turn: 3,
      });
      const shell = find(base, 0 as SeatIndex, 'battlefield', 'Shambling Shell');
      const after = (field(compiledScript('Village Rites').script, 'onResolve') as
        (c: EffectContext) => GameState)({
          state: base, controller: 0 as SeatIndex, source: 'c1', targets: [], decisions: [],
        } as unknown as EffectContext);
      expect(after.drawsOwed.length).toBe(base.drawsOwed.length + 2);
      expect(ids(after, 0 as SeatIndex, 'battlefield')).toContain(shell);
    });

    it('reads "another creature" as the narrower cost', () => {
      // The field has two values and the difference is a real one: a Village Rites that could eat
      // itself is not a card, but a creature spell with this cost may not sacrifice the creature
      // it is paying for.
      const another = compileCard({
        name: 'Narrow Rites', type_line: 'Instant', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: 'As an additional cost to cast this spell, sacrifice another creature.\nDraw two cards.',
      });
      expect(another.ok).toBe(true);
      if (!another.ok) return;
      expect(another.unread).toEqual([]);
      expect(field(another.script, 'additionalCost')).toEqual({ sacrifice: 'another-creature' });
    });

    it.each([
      ['discard a card'],
      ['pay 3 life'],
      ['exile a creature card from your graveyard'],
    ])('refuses an additional cost of "%s", which the engine cannot express', (cost) => {
      /*
        `additionalCost` holds a sacrifice and nothing else. These are real printed costs, and a
        reader that dropped one would make the spell **cheaper than the card** — the clearest kind
        of card that works and is wrong, and the one a player would notice last.
      */
      const odd = compileCard({
        name: 'Other Cost', type_line: 'Sorcery', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: `As an additional cost to cast this spell, ${cost as string}.\nDraw two cards.`,
      });
      expect(odd.ok).toBe(true);
      if (!odd.ok) return;
      expect(field(odd.script, 'additionalCost')).toBeUndefined();
      // And the line is reported, so the card is dealt as a hybrid rather than cast for less.
      expect(odd.unread.map((u) => u.line)).toContain(
        `As an additional cost to cast this spell, ${cost as string}.`,
      );
    });
  });

  describe('a clause that points at a player', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it('draws and drains the same player, as Sign in Blood does', () => {
      const mine = compiledScript('Sign in Blood');
      expect(mine.unread).toEqual([]);
      expect(field(mine.script, 'targets')).toEqual(field(scriptFor('Sign in Blood'), 'targets'));
      const base = arena({ decks: { 0: 'blight-vector', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 1 as SeatIndex }]);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Sign in Blood'))(ctx));
      /*
        Both halves, at the **target** and not at the caster — which is the whole point of a player
        target: Sign in Blood aimed at an opponent is a very different card from one aimed at you,
        and the compiled reading has to be able to do either.
      */
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life - 2);
      expect(after.zones[zoneKey(1 as SeatIndex, 'hand')]!.length)
        .toBe(base.zones[zoneKey(1 as SeatIndex, 'hand')]!.length + 2);
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life);
    });

    it('is one reader and not two, because both halves aim at one player', () => {
      /*
        `composeEffects` refuses two targeting parts — `targets` is one list per script, so two
        would be handed the same object silently, which is the rule that keeps "target creature
        fights target creature you don't control" honest. Sign in Blood's two halves aim at the
        **same** player on purpose, so the sentence is read whole rather than split by D398's
        conjunction fallback.

        Asserted as the shape: one target spec, and it is the player.
      */
      const targets = field(compiledScript('Sign in Blood').script, 'targets') as
        readonly TargetSpec[];
      expect(targets).toHaveLength(1);
      expect(targets[0]!.kind).toBe('player');
    });

    it('reads a player who gains life, and marks it as help', () => {
      /*
        Healing Salve's first bullet, which the drain-and-heal family (D390) already read — this
        increment nearly shipped a **second** reader for it, and the break run is what found that:
        turning `friendly` off in the new branch changed nothing, because the branch was dead code.
        One reading in one place, as everywhere else in this file; the duplicate was deleted and the
        test stays, pointed at the reader that does the work.

        `friendly` is the flag that stops the bot aiming a lifegain at the player it is trying to
        kill (D252). The card itself is still refused whole: its second mode prevents damage, and
        nothing reads that.
      */
      const salve = compileCard({
        name: 'Plain Salve', type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
        oracle_text: 'Target player gains 3 life.',
      });
      expect(salve.ok).toBe(true);
      if (!salve.ok) return;
      expect(salve.unread).toEqual([]);
      const spec = (field(salve.script, 'targets') as readonly TargetSpec[])[0]!;
      expect(spec.kind).toBe('player');
      expect(spec.friendly).toBe(true);
      const base = arena({ decks: { 0: 'skyward-writ', 1: 'ember-rush' }, turn: 3 });
      const after = resolve(salve.script)(
        contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 0 as SeatIndex }]),
      );
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life + 3);
    });

    it('does nothing when the player it pointed at has gone', () => {
      // A target that left the game is not a target this spell has (CR 800.4a), and both readers
      // answer that with the state they were handed rather than guessing a seat.
      const base = arena({ decks: { 0: 'blight-vector', 1: 'ember-rush' }, turn: 3 });
      const after = resolve(compiledScript('Sign in Blood').script)(
        contextOn(base, 0 as SeatIndex, 'c1', []),
      );
      expect(after).toEqual(base);
    });
  });

  describe('a clause about the player the event was about', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, actor?: SeatIndex,
    ): EffectContext => ({
      state, controller: seat, source, targets: [], decisions: [], actor,
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    it.each([
      // "Whenever an opponent casts a noncreature spell, that player loses 2 life and you gain 2."
      ['Kambal, Consul of Allocation'],
      // "Whenever an opponent draws a card, ~ deals 1 damage to that player" — damage, which is
      // what D407 fixed in the hand-written card while this reading was being written.
      ['Fate Unraveler'],
    ])('%s watches and resolves exactly as the hand-written card does', (card) => {
      const mine = compiledScript(card as string);
      expect(mine.unread).toEqual([]);
      const compiled = triggerOf(mine.script)!;
      const written = triggerOf(scriptFor(card as string))!;
      expect(JSON.stringify(compiled.on)).toEqual(JSON.stringify(written.on));

      const base = arena({ decks: { 0: 'ashen-rite', 1: 'hollow-tide' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', 1 as SeatIndex);
      expect(compiled.effect(ctx)).toEqual(written.effect(ctx));
      // Not vacuous: the opponent really lost life, which is the whole of both cards.
      expect(compiled.effect(ctx).seats[1]!.life).toBeLessThan(base.seats[1]!.life);
    });

    it('reads an absent actor as the controller, which is what the engine means by it', () => {
      /*
        **This assertion was the other way round until D474**, and the entry is worth reading before
        this test is changed again. It used to require that an actorless event, and an event whose
        actor *is* the controller, both do nothing — a guard copied off two "whenever an **opponent**
        …" cards whose trigger cannot fire on their own controller's action, so neither case was
        reachable and the assertion could not fail for a real card.

        Then the cast parse made "whenever **a player** casts…" readable, and Pyrostatic Pillar —
        which damages whoever cast the cheap spell, its controller included — fired, resolved and
        did nothing. The engine's own convention is the fix: `fireTrigger` omits `actor` when the
        actor is the watcher's controller, so **absent means me**, which `EffectContext.actor` and
        Ruric Thar's `?? c.controller` both already said.

        The two contexts below are therefore the same state spelled two ways, and the first thing
        asserted is that they agree. What keeps a *spell* out of this reader is the next test, and
        what keeps a prologue with no player at all out of it is the one after that.

        **Only Fate Unraveler can show it is not a no-op**, and that is the cards rather than the
        test: Kambal's clause takes two life off "that player" and gives two to "you", so with one
        seat answering both it nets to nothing. Fate Unraveler's is damage in one direction, so the
        controller's own life goes down and the reading is visible.
      */
      const base = arena({ decks: { 0: 'ashen-rite', 1: 'hollow-tide' }, turn: 3 });
      for (const card of ['Kambal, Consul of Allocation', 'Fate Unraveler']) {
        const trigger = triggerOf(compiledScript(card).script)!;
        const absent = trigger.effect(contextOn(base, 0 as SeatIndex, 'c1'));
        const mine = trigger.effect(contextOn(base, 0 as SeatIndex, 'c1', 0 as SeatIndex));
        expect(absent).toEqual(mine);
      }
      const unraveler = triggerOf(compiledScript('Fate Unraveler').script)!;
      expect(unraveler.effect(contextOn(base, 0 as SeatIndex, 'c1')).seats[0]!.life)
        .toBeLessThan(base.seats[0]!.life);
    });

    it('is not reachable from a spell, where "that player" means nothing', () => {
      /*
        The restriction, asserted as a card. A sorcery printing the same sentence is refused rather
        than compiled into a spell that resolves and does nothing with no line left unread for a
        human to notice (D362).
      */
      const spell = compileCard({
        name: 'Vague Drain', type_line: 'Sorcery', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: 'That player loses 2 life and you gain 2 life.',
      });
      expect(spell.ok).toBe(true);
      if (spell.ok) expect(spell.script).toBeUndefined();
    });

    it('reads each event as the player that event is about, which is not always the actor', () => {
      /*
        The gate D475 added, and the reason the test above can be as blunt as it is.

        `raise` passes the caster for a cast, the drawing seat for a draw, the gaining seat for a
        life gain and the **active** seat for a step — four events where the actor is the player the
        sentence is about. It passes the *watcher's own side* for combat damage, an attack, an entry
        and a death, where the sentence means somebody else entirely: Furnace Scamp's "deals 3
        damage to that player" means the player it hit, which lives in `c.attacked.defender`.

        **This row used to assert that the combat-damage line was refused, and that refusal is now
        retired.** It was true of D475, which had only the actor to offer; D530 gave the hit player
        its own supply (`c.attacked.defender`, asked as `hit-player`), and D533 let the pronoun be
        matched in object position — which is where Furnace Scamp prints it. So all three rows read,
        and the third reads the *hit* player rather than the actor. Keeping the old assertion would
        have been the suite asserting the past (D516); what replaces it is the reading being right,
        which a compile test cannot see on its own and `scripts.test.ts` checks at the table.
      */
      const card = (text: string) => compileCard({
        name: 'Vague Clock', type_line: 'Enchantment', mana_cost: '{B}', cmc: 1, colors: ['B'],
        oracle_text: text,
      });
      for (const prologue of [
        'Whenever a player casts a spell',
        "At the beginning of each player's upkeep",
      ]) {
        const read = card(`${prologue}, Vague Clock deals 1 damage to that player.`);
        expect(read.ok).toBe(true);
        if (read.ok) expect(read.unread).toEqual([]);
      }
      const combat = card(
        'Whenever Vague Clock deals combat damage to a player,'
        + ' Vague Clock deals 1 damage to that player.',
      );
      expect(combat.ok).toBe(true);
      if (!combat.ok) return;
      expect(combat.unread).toEqual([]);
      expect(combat.script?.triggers?.[0]?.on.kind).toBe('combat-damage');
      /*
        And the gate it replaces is still doing its job: an ENTRY trigger has no player the sentence
        could mean — `raise` passes the watcher's own side and there is no defender — so the same
        clause on the same card is still refused rather than read as the controller. That is the
        discriminating half of this row, and it is the half D475 was about.
      */
      const entry = card('Whenever another creature enters, Vague Clock deals 1 damage to that player.');
      expect(entry.ok).toBe(true);
      if (entry.ok) expect(entry.unread).toHaveLength(1);
    });

    it('keeps both halves of the printed event', () => {
      /*
        `by: 'opponent'` and `spell: 'noncreature'` are both printed and both load-bearing: the same
        event without them fires on every spell anybody casts, including the controller's own, which
        is a very different card.
      */
      const on = triggerOf(compiledScript('Kambal, Consul of Allocation').script)!.on as
        { by?: string; spell?: string };
      expect(on.by).toBe('opponent');
      expect(on.spell).toBe('noncreature');
    });
  });

  describe('the attack the trigger was about, and a graveyard half spelled the long way', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
      attacked?: { defender: SeatIndex; planeswalker?: string },
    ): EffectContext => ({
      state, controller: seat, source, targets: [], decisions: [], attacked,
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const triggerOf = (script: unknown, i = 0) =>
      (field(script, 'triggers') as readonly TriggerDef[] | undefined)?.[i];

    it('hits what that attack was declared against, as Hellrider does', () => {
      const mine = compiledScript('Hellrider');
      expect(mine.unread).toEqual([]);
      const base = arena({ decks: { 0: 'ember-rush', 1: 'verdant-guard' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', { defender: 1 as SeatIndex });
      expect(triggerOf(mine.script)!.effect(ctx))
        .toEqual(triggerOf(scriptFor('Hellrider'))!.effect(ctx));
      expect(triggerOf(mine.script)!.effect(ctx).seats[1]!.life)
        .toBe(base.seats[1]!.life - 1);
    });

    it('hits the planeswalker instead of its controller, where one was attacked', () => {
      /*
        The half of the clause that names both: a planeswalker that was attacked takes the damage
        **instead of** its controller. `c.attacked` carries which, because by the time the trigger
        resolves the attacker may be dead and combat may no longer say what it was aimed at.
      */
      const base = arena({
        decks: { 0: 'ember-rush', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', {
        defender: 1 as SeatIndex, planeswalker: bear,
      });
      const after = triggerOf(compiledScript('Hellrider').script)!.effect(ctx);
      expect(after).toEqual(triggerOf(scriptFor('Hellrider'))!.effect(ctx));
      // The damage went to the permanent and the seat's life is untouched.
      expect(after.instances[bear]!.damage).toBe(1);
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life);
    });

    it('does nothing when the stack object carries no attack', () => {
      // Trigger-only for the same reason as "that player" (D408): a spell has no attack, so the
      // reading stays where the words mean something and answers an absent one with the state.
      const base = arena({ decks: { 0: 'ember-rush', 1: 'verdant-guard' }, turn: 3 });
      expect(triggerOf(compiledScript('Hellrider').script)!
        .effect(contextOn(base, 0 as SeatIndex, 'c1'))).toEqual(base);
    });

    it('reads a noncreature permanent’s graveyard half, which cannot say "dies"', () => {
      /*
        "Dies" is defined for **creatures** (CR 700.4), so Ichor Wellspring — an artifact — prints
        "or is put into a graveyard from the battlefield" for the same shape. Both events, one
        effect, exactly as the hand-written card pairs them.
      */
      const mine = compiledScript('Ichor Wellspring');
      expect(mine.unread).toEqual([]);
      const kinds = (field(mine.script, 'triggers') as readonly TriggerDef[]).map((t) => t.on.kind);
      expect(kinds).toEqual(['etb', 'to-graveyard']);
      const written = (field(scriptFor('Ichor Wellspring'), 'triggers') as readonly TriggerDef[]);
      expect(kinds).toEqual(written.map((t) => t.on.kind));
    });

    it('draws from the graveyard half even when the card has moved on', () => {
      /*
        D409's correction, and the reason the compiled reading can use one effect for both events.

        The hand-written script guarded this half on the card still being in a graveyard, copied
        from Rancor — and the two cards are not the same shape. Rancor **returns itself**, so a card
        that moved on is a card there is nothing to return. "Draw a card" asks nothing about the
        source, and a triggered ability on the stack exists independently of the permanent that made
        it (CR 603.2, CR 608.2), so the draw happens either way.

        The test puts the card somewhere else entirely before resolving, which is what the guarded
        version answered with nothing.
      */
      const base = arena({
        decks: { 0: 'forge-alliance', 1: 'ember-rush' },
        graveyard: { 0: ['Ichor Wellspring'] },
        turn: 3,
      });
      const card = find(base, 0 as SeatIndex, 'graveyard', 'Ichor Wellspring');
      const moved = {
        ...base,
        instances: { ...base.instances, [card]: { ...base.instances[card]!, zone: 'exile' } },
      } as GameState;
      for (const script of [compiledScript('Ichor Wellspring').script, scriptFor('Ichor Wellspring')]) {
        const after = (field(script, 'triggers') as readonly TriggerDef[])[1]!
          .effect(contextOn(moved, 0 as SeatIndex, card));
        expect(after.drawsOwed.length).toBe(moved.drawsOwed.length + 1);
      }
    });
  });

  describe('a land that turns itself into a creature', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
    ): EffectContext => ({
      state, controller: seat, source, targets: [], decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const abilitiesOf = (script: unknown) =>
      (field(script, 'abilities') as readonly AbilityDef[] | undefined) ?? [];

    /** Mutavault's animation is its second ability; the first is the mana one. */
    const animation = (script: unknown) => abilitiesOf(script)[1];

    it('adds the creature type and keeps the land, as Mutavault does', () => {
      /*
        The two printed sentences are one reading, and the second decides what the first does:
        `addTypes` adds a type where `setTypes` would replace the line, and "it's still a land" is
        the printed reason to add (CR 613.1c). Guessing wrong makes a Mutavault that cannot be
        tapped for mana for the rest of the turn.
      */
      const mine = compiledScript('Mutavault');
      expect(mine.unread).toEqual([]);
      expect(abilitiesOf(mine.script)).toHaveLength(2);

      const base = arena({
        decks: { 0: 'ember-rush', 1: 'verdant-guard' },
        battlefield: { 0: ['Mutavault'] },
        turn: 3,
      });
      const vault = find(base, 0 as SeatIndex, 'battlefield', 'Mutavault');
      const ctx = contextOn(base, 0 as SeatIndex, vault);
      const after = animation(mine.script)!.effect!(ctx);
      expect(after).toEqual(animation(scriptFor('Mutavault'))!.effect!(ctx));
      /*
        And right rather than merely equal: a 2/2 that is **both** a creature and a land. The state
        comparison would pass on two readings that both replaced the type line, and this says which.
      */
      const ch = characteristicsOf(after, after.instances[vault]!);
      expect(ch.isCreature).toBe(true);
      expect(ch.power).toBe(2);
      expect(ch.toughness).toBe(2);
      expect(ch.isLand).toBe(true);
    });

    it('is a base 2/2, so an anthem lands on top of it', () => {
      /*
        Layer 7b, which is the difference between `setPower: 2` and a `+2/+2` pump: a base of two
        with an anthem on top is a 3/3, where a pump of two on a 0/0 land that an anthem also hits
        would be a 1/1 and a very different card. The engine has had the layer since #94; this is
        the assertion that the compiled reading uses it.
      */
      const base = arena({
        decks: { 0: 'ember-rush', 1: 'verdant-guard' },
        battlefield: { 0: ['Mutavault'] },
        turn: 3,
      });
      const vault = find(base, 0 as SeatIndex, 'battlefield', 'Mutavault');
      const animated = animation(compiledScript('Mutavault').script)!
        .effect!(contextOn(base, 0 as SeatIndex, vault));
      const anthemed = pump(animated, [vault], 'fx-anthem', 0 as SeatIndex,
        { power: 1, toughness: 1 });
      const ch = characteristicsOf(anthemed, anthemed.instances[vault]!);
      expect(ch.power).toBe(3);
      expect(ch.toughness).toBe(3);
    });

    it('carries the animation hint, so the bot does not animate for nothing', () => {
      /*
        `AbilityDef.animates` is how the bot knows not to press this unless there is an attack or a
        block to make with it — and pressing it costs the land as a mana source for the turn, so an
        animation without the flag is a card that plays itself badly twice over (#322).
      */
      expect(animation(compiledScript('Mutavault').script)?.animates).toBe(true);
      expect(animation(scriptFor('Mutavault'))?.animates).toBe(true);
    });

    it("refuses the animation without the sentence that says it is still a land", () => {
      /*
        The second sentence is what decides between adding a type and replacing the line, so a clause
        that does not print it leaves the reader guessing — and guessing is what D259 rules out. A
        permanent that is not a land becoming a creature is a different family anyway (a Vehicle's
        crew), so nothing is lost by refusing this and flagging the line for a human (D362).
      */
      const card = compileCard({
        name: 'Quiet Vault', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
        oracle_text: '{T}: Add {C}.\n{1}: Quiet Vault becomes a 2/2 creature until end of turn.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      // The mana ability still reads; the animation is the unread line.
      expect(card.unread.map((u) => u.line)).toEqual([
        '{1}: Quiet Vault becomes a 2/2 creature until end of turn.',
      ]);
    });
  });

  describe('a characteristic read before the permanent leaves', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it("exiles and pays the creature's controller, as Swords to Plowshares does", () => {
      /*
        The third kind of internal dependency: not an order (D413) and not an identity (D414) but a
        **reading**. "Its power" is a characteristic of the creature the sentence before exiled, and
        no clause reader is handed the object another clause moved — so the two sentences are read
        together or not at all.

        Deliberately **not** asserted here: that the power is read before the exile rather than
        after. It is written that way, because that is the printed order and the hand-written card's,
        but in this engine the two orders give the same answer — `exileCard` leaves the instance in
        place with its continuous effects still reaching it, since `pump` scopes to an instance id
        and `relocate` keeps the id across a zone change (the limitation `pumpTeam`'s docblock
        records). A break that read the power afterwards passed every test in this file, so the claim
        is made in the docblock and not pretended to be covered.
      */
      const mine = compiledScript('Swords to Plowshares');
      expect(mine.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'skyward-writ', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bears = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bears }]);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Swords to Plowshares'))(ctx));
      /*
        And right rather than merely equal: a 2/2 leaves and its **controller** — not the caster —
        gains exactly two. A reader that paid the caster would pass the state comparison only if the
        hand-written card were wrong the same way, and this says which seat.
      */
      expect(ids(after, 1 as SeatIndex, 'exile')).toContain(bears);
      expect(after.seats[1]!.life).toBe(base.seats[1]!.life + 2);
      expect(after.seats[0]!.life).toBe(base.seats[0]!.life);
    });

    it('pays nothing for a creature whose power has been reduced below zero', () => {
      /*
        The behaviour, stated without claiming more than it proves.

        The hand-written card writes `Math.max(0, power)` and the compiled reading does not, because
        `gainLife` returns the state untouched for any amount `<= 0` on its first line — so the clamp
        is provably indistinguishable from its absence, and a guard that cannot fail was deleted
        rather than mirrored (a break that removed it from the compiled reader passed every test,
        which is how that was settled).

        What this row pins is the outcome: a creature at negative power pays its controller nothing,
        and both readings agree. Driven with a real reduction rather than a fabricated instance.
      */
      const mine = compiledScript('Swords to Plowshares');
      const base = arena({
        decks: { 0: 'skyward-writ', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bears = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const shrunk = pump(pump(base, [bears], 'fx-a', 0 as SeatIndex, { power: -2, toughness: 0 }),
        [bears], 'fx-b', 0 as SeatIndex, { power: -1, toughness: 0 });
      expect(characteristicsOf(shrunk, shrunk.instances[bears]!).power).toBeLessThan(0);

      const ctx = contextOn(shrunk, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bears }]);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Swords to Plowshares'))(ctx));
      expect(after.seats[1]!.life).toBe(shrunk.seats[1]!.life);
    });

    it('carries the removal hint, so the bot does not cast it into an empty board', () => {
      // `removesACreature` is the bot's only way to know this spell wants somebody's creature to
      // point at. Dropping it is the failure #322 was about: a card that plays itself into nothing.
      expect(field(compiledScript('Swords to Plowshares').script, 'removesACreature')).toBe(true);
      expect(field(scriptFor('Swords to Plowshares'), 'removesACreature')).toBe(true);
    });

    it('points at exactly the spec the hand-written card points at', () => {
      const mine = field(compiledScript('Swords to Plowshares').script, 'targets') as
        readonly TargetSpec[];
      const written = field(scriptFor('Swords to Plowshares'), 'targets') as readonly TargetSpec[];
      expect(mine).toEqual(written);
    });
  });

  describe('a blink, which is two clauses about one object', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it('exiles and returns the same permanent, as Cloudshift does', () => {
      /*
        "Exile target creature you control, then return that card to the battlefield under your
        control" splits on ", then " into two clauses, and the second is about the **first clause's
        object** — "that card" is neither a target nor the source, but whatever the exile just
        moved. No clause reader can be handed that, so the whole sentence is read at once.

        Reading only the first half would be worse than refusing both: the exile clause has a reader
        of its own, so a compiler that took it and stopped would turn a blink into unconditional
        removal of your own creature.
      */
      const mine = compiledScript('Cloudshift');
      expect(mine.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'skyward-writ', 1: 'ember-rush' },
        // `arena` places from the seat's own deck, and Cloudshift lives in Skyward Writ — which
        // holds no Grizzly Bears. Healer's Hawk is its own one-drop and does the same job here.
        battlefield: { 0: ["Healer's Hawk"] },
        turn: 3,
      });
      const bears = find(base, 0 as SeatIndex, 'battlefield', "Healer's Hawk");
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bears }]);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Cloudshift'))(ctx));
      /*
        And right rather than merely equal: the creature is back on the battlefield, which is what a
        reader that exiled and stopped would fail — and the state comparison alone would pass if
        both readings stopped.
      */
      expect(ids(after, 0 as SeatIndex, 'battlefield')).toContain(bears);
      expect(ids(after, 0 as SeatIndex, 'exile')).not.toContain(bears);
    });

    it('carries the blink hint the bot needs, because it cuts both ways', () => {
      /*
        `TargetSpec.blinks` is not a restriction — pointing a blink at your own token stays legal —
        and its docblock says at length why it has to be said out loud: what the permanent loses by
        leaving is what decides whether a blink helps or hurts, and a token ceases to exist
        (CR 111.7) while counters, Auras and marked damage all go with it. The bot cannot read any
        of that off a candidate list, so a compiled blink without the flag is a card it plays blind.
      */
      const specs = field(compiledScript('Cloudshift').script, 'targets') as readonly TargetSpec[];
      expect(specs).toHaveLength(1);
      expect(specs[0]).toMatchObject({ blinks: true });
      const written = field(scriptFor('Cloudshift'), 'targets') as readonly TargetSpec[];
      expect(specs[0]?.blinks).toBe(written[0]?.blinks);
    });

    it("reads a return under its owner's control, which this reader used to refuse (D543)", () => {
      /*
        **Retargeted, not deleted.** This row asserted that the owner's-control wording stays unread,
        and the reason it gave was Flickerwisp: "a different card twice over — the permanent comes
        back under its **owner's** control and at the beginning of the next end step", so reading it
        as this shape would hand somebody else's creature straight to you.

        Half of that is still true and is still refused — the delayed return is Flickerwisp's own
        row below. The other half stopped being true the moment a clause reader learnt to read the
        owner's seat off the instance (D543): the return goes to `inst.owner`, so an opponent's
        creature goes back to the opponent. Keeping the refusal here would be the suite asserting the
        past (D516).

        Read by the **clause** path rather than by this spell-shape reader, which is why the describe
        it sits in is about `blinkResolution` and the assertion is about the card.
      */
      const card = compileCard({
        name: 'Borrowed Shift', type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
        oracle_text: "Exile target creature you control, then return that card to the battlefield under its owner's control.",
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread.map((u) => u.line)).toEqual([]);
      expect(card.script?.targets?.[0]).toMatchObject({ blinks: true, friendly: true });
    });

    it('reads the shape as part of a longer resolution, which this reader cannot (D543)', () => {
      /*
        Also retargeted. The refusal was right about **this** reader — `blinkResolution` takes the
        whole spell line and a second line means it has not seen everything the spell does — and
        wrong about the compiler, once the pair became two clauses in a chain. "Exile … then return
        it" and "You gain 2 life" are two parts `composeEffects` runs in order, which is what the
        printed sentence means.

        That is the whole argument for having read this as a clause: Justiciar's Portal, Personify
        and Scrollshift all print a third sentence after the blink, and a line-shaped reader can
        reach none of them.
      */
      const card = compileCard({
        name: 'Busy Shift', type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
        oracle_text: 'Exile target creature you control, then return that card to the battlefield under your control.\nYou gain 2 life.',
      });
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.unread.map((u) => u.line)).toEqual([]);
    });
  });

  describe('two hints the standing check found missing, and one guard it found redundant', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    it('carries the removal hint on damage whose spec is creature-only', () => {
      /*
        D420. `removesACreature` keeps a removal spell from being cast with nothing worth hitting
        (#322), and the compiler set it for a *destroy* or an *exile* aimed at a creature but not
        for **damage** aimed at one. Flame Slash is "deals 4 damage to target creature" — creature-only
        by its own spec, so there is nothing else it could ever be cast at.

        Found by `compiled-vs-written.test.ts` comparing against the hand-written card, which has
        carried the flag all along.
      */
      expect(field(compiledScript('Flame Slash').script, 'removesACreature')).toBe(true);
      expect(field(scriptFor('Flame Slash'), 'removesACreature')).toBe(true);
    });

    it('does not carry it where the spell can be aimed at a player', () => {
      /*
        The arm without which the row above says only "the flag exists somewhere". Lava Spike and
        Magma Jet say "any target", so a board with no creature on it is still a board they do
        something on — and neither hand-written card carries the flag. A rule that set it on every
        damage clause would make the bot hold a burn spell it should be pointing at a face.
      */
      for (const name of ['Lava Spike', 'Magma Jet']) {
        expect(field(compiledScript(name).script, 'removesACreature'), name).toBeUndefined();
        expect(field(scriptFor(name), 'removesACreature'), name).toBeUndefined();
      }
    });

    it('needs no battlefield filter on a permanent spec, because the engine has two', () => {
      /*
        Capsize carried a hand-written filter requiring `zone === 'battlefield'`, and the compiled
        spec has none — so the standing check flagged it. The engine already requires it **twice**,
        in both places that can ever be asked: `legalTargets` enumerates a permanent spec's
        candidates out of the battlefield zone and nowhere else, and `isLegalTarget` — which
        validates a target somebody *submitted* rather than one the engine offered — refuses any
        instance whose zone is not the battlefield before it looks at a type at all.

        So the filter could not refuse anything the engine would have allowed. Deleted, and this is
        the proof rather than the argument: a board with one creature on the battlefield and one in
        a graveyard offers exactly the first.
      */
      const base = arena({
        decks: { 0: 'tidal-mind', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        graveyard: { 1: ['Giant Growth'] },
        turn: 3,
      });
      const bears = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const buried = find(base, 1 as SeatIndex, 'graveyard', 'Giant Growth');

      const spec = (field(compiledScript('Capsize').script, 'targets') as readonly TargetSpec[])[0]!;
      expect(spec.filter).toBeUndefined();
      const offered = legalTargets(base, spec, 0 as SeatIndex, 'c1')
        .flatMap((t) => (t.kind === 'card' ? [t.id] : []));
      expect(offered).toContain(bears);
      expect(offered).not.toContain(buried);
      // And the hand-written spec agrees, now that its filter is gone.
      const written = (field(scriptFor('Capsize'), 'targets') as readonly TargetSpec[])[0]!;
      expect(written.filter).toBeUndefined();
    });
  });

  describe('a composition split at its first question', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    it('puts the damage before the question, as Magma Jet does', () => {
      /*
        D418, and the first finding of `compiled-vs-written.test.ts` to be fixed.

        The engine plans a resolution's decisions and asks them **before** the resolution runs. So a
        composition that put every clause in `onResolve` would ask the player which cards to put on
        the bottom of their library about a board the damage has not changed yet — and the
        hand-written card's comment is the argument: "by the time the player is looking at the top
        of their library the creature is already dead … what is drawn next is a different decision
        once the board has changed."

        The fix is an **assembly rule**, not a reader: the parts before the first part that asks
        something go in `beforeDecisions`. Any resolution shaped "an effect. a question." had it.
      */
      const mine = compiledScript('Magma Jet');
      expect(mine.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'arc-tempest', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bears = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bears }]);

      const before = field(mine.script, 'beforeDecisions') as
        ((c: EffectContext) => GameState) | undefined;
      expect(before).toBeDefined();
      if (before === undefined) return;
      const damaged = before(ctx);
      expect(damaged).toEqual(
        (field(scriptFor('Magma Jet'), 'beforeDecisions') as (c: EffectContext) => GameState)(ctx),
      );
      // And right rather than merely equal: two damage really landed on the creature.
      expect(damaged.instances[bears]!.damage).toBe(2);
    });

    it('carries no effect where the questions are the whole resolution', () => {
      /*
        The other half of making the two scripts identical. The scry clause's own effect is the
        identity — the engine applies a scry answer itself — so a composition whose remaining parts
        are all questions has nothing to run afterwards, and `onResolve` is omitted rather than set
        to a function that cannot be told from its absence.

        The hand-written Magma Jet has no `onResolve` for the same reason, which is why this is the
        assertion rather than a style preference.
      */
      expect(field(compiledScript('Magma Jet').script, 'onResolve')).toBeUndefined();
      expect(field(scriptFor('Magma Jet'), 'onResolve')).toBeUndefined();
      // The questions are still there, so this is not a card that does nothing.
      expect(field(compiledScript('Magma Jet').script, 'decisions'))
        .toEqual(field(scriptFor('Magma Jet'), 'decisions'));
    });

    it('leaves a resolution whose question comes first exactly as it was', () => {
      /*
        The arm that keeps the split from being "always move everything": a question in the **first**
        clause leaves nothing before it. Preordain is "Scry 2, then draw a card" — the scry is the
        first part, so the draw stays in `onResolve` and there is no `beforeDecisions` at all.
      */
      const mine = compiledScript('Preordain');
      expect(mine.unread).toEqual([]);
      expect(field(mine.script, 'beforeDecisions')).toBeUndefined();
      expect(field(mine.script, 'onResolve')).toBeDefined();
    });

    it('keeps the asking clause in the effect, not only the clauses after it', () => {
      /*
        The arm a break run demanded. Slicing from **after** the asking part instead of from it
        passed every test, because every composed question in the pool is a scry — whose own effect
        is the identity, so dropping it changes nothing.

        A question with a real effect is a different matter: "Target player discards a card" asks
        *and* moves the chosen cards, so a split that threw the asking part away would ask the
        question and never act on the answer. That is a card that works and quietly does half of
        what it says, which is the failure this project is most careful about.
      */
      const card = compileCard({
        name: 'Gift and Grief', type_line: 'Sorcery', mana_cost: '{1}{B}', cmc: 2, colors: ['B'],
        oracle_text: 'You gain 2 life. Target player discards a card.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread).toEqual([]);
      // The life is before the question; the discard is the effect, and it is still there.
      expect(field(card.script, 'beforeDecisions')).toBeDefined();
      expect(field(card.script, 'onResolve')).toBeDefined();

      const base = arena({
        decks: { 0: 'rot-harvest', 1: 'ember-rush' },
        hands: { 1: ['Mountain', 'Mountain'] },
        turn: 3,
      });
      const victimHand = ids(base, 1 as SeatIndex, 'hand');
      const ctx = {
        state: base, controller: 0 as SeatIndex, source: 'c1',
        targets: [{ kind: 'player', seat: 1 as SeatIndex }],
        decisions: [{ ids: [victimHand[0]!] }],
      } as unknown as EffectContext;
      const after = (field(card.script, 'onResolve') as (c: EffectContext) => GameState)(ctx);
      expect(ids(after, 1 as SeatIndex, 'graveyard')).toContain(victimHand[0]!);
    });

    it('refuses a composition whose part already has a pre-question half', () => {
      /*
        A composition cannot carry two pre-question halves, and `conjoinedEffect` composes too, so a
        nested one is reachable — a `beforeDecisions` buried inside would be silently dropped.
        Refusing is D364's rule: a fragment without its companion is not a reading.

        The first fixture here was a loot sentence conjoined with something else, and a break run
        showed it never reached the guard: `lootResolution` matches an exact sentence, so the
        conjunction never produced a nested half and deleting the refusal left every test green.

        This one does reach it. "You gain 2 life and scry 2" is a conjunction whose **second** half
        asks, so the inner composition splits and carries a `beforeDecisions`; the sentence after it
        makes that inner reading one part of an outer composition, which is exactly the case the
        guard is for.
      */
      const card = compileCard({
        name: 'Nested Ask', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: 'You gain 2 life and scry 2. Draw a card.',
      });
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.script).toBeUndefined();
    });
  });

  describe('a draw that has to happen before the question', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, decisions: readonly unknown[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets: [], decisions,
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const before = (script: unknown) =>
      field(script, 'beforeDecisions') as ((c: EffectContext) => GameState) | undefined;
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it('asks the same question the hand-written Faithless Looting asks', () => {
      /*
        The decision spec is plain data, so this is deep equality against the card: who is asked,
        which zone, how many, and the prompt — which echoes the printed count and its noun rather
        than being built from the number, so "a card" stays singular.
      */
      const mine = compiledScript('Faithless Looting');
      expect(mine.unread).toEqual([]);
      expect(field(mine.script, 'decisions'))
        .toEqual(field(scriptFor('Faithless Looting'), 'decisions'));
      expect(field(mine.script, 'decisions')).toEqual([{
        who: 'controller', from: 'hand', prompt: 'Discard two cards', min: 2, max: 2,
      }]);
    });

    it('draws before the question is planned, so the drawn cards can be discarded', () => {
      /*
        The whole point of the shape reader, and the thing a composition gets wrong.

        `clausesOf` splits the sentence on ", then ", so composed it is "Draw two cards" followed by
        "discard two cards" — the right order for two *effects*, and the wrong card: a question is
        planned before the resolution runs, so the player would be choosing out of the hand they
        held **before** drawing. The hand-written card puts the draw in `beforeDecisions` and its
        docblock says why: "the cards it offers to discard are the ones it has not seen yet".

        So the assertion is about where the draw lives, and the board it leaves.
      */
      const mine = compiledScript('Faithless Looting');
      const base = arena({ decks: { 0: 'arc-tempest', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');

      const step = before(mine.script);
      expect(step).toBeDefined();
      if (step === undefined) return;
      const drawn = step(ctx);
      expect(drawn).toEqual(before(scriptFor('Faithless Looting'))!(ctx));
      /*
        Two cards **in hand**, not owed. `drawLater` is the better primitive everywhere else in this
        module, and here it would be the bug: a card that is owed is not a card you can be asked to
        discard.
      */
      expect(ids(drawn, 0 as SeatIndex, 'hand')).toHaveLength(
        ids(base, 0 as SeatIndex, 'hand').length + 2,
      );
      expect(drawn.drawsOwed).toEqual(base.drawsOwed);
    });

    it('puts the chosen cards in the graveyard, as the hand-written card does', () => {
      const mine = compiledScript('Faithless Looting');
      // A hand to discard from: `arena` deals none unless asked, and two named cards make the
      // assertion about *which* cards moved rather than how many.
      const base = arena({
        decks: { 0: 'arc-tempest', 1: 'ember-rush' },
        hands: { 0: ['Lightning Bolt', 'Mountain'] },
        turn: 3,
      });
      const hand = ids(base, 0 as SeatIndex, 'hand');
      expect(hand.length).toBeGreaterThanOrEqual(2);
      const chosen = [{ ids: [hand[0]!, hand[1]!] }];
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', chosen);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Faithless Looting'))(ctx));
      // Not vacuous: both named cards really moved.
      expect(ids(after, 0 as SeatIndex, 'graveyard')).toEqual(
        expect.arrayContaining([hand[0]!, hand[1]!]),
      );
    });

    it('reads two counts that need not match', () => {
      // Thrill of Possibility's shape. Nothing requires the numbers to be equal, so nothing
      // assumes it — a reader that used the draw count twice would ask for two discards here.
      const card = compileCard({
        name: 'Rummage', type_line: 'Instant', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
        oracle_text: 'Draw two cards, then discard a card.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread).toEqual([]);
      expect(field(card.script, 'decisions')).toEqual([{
        who: 'controller', from: 'hand', prompt: 'Discard a card', min: 1, max: 1,
      }]);
    });

    it('will not read the shape as part of a longer resolution', () => {
      /*
        `beforeDecisions` runs before **every** question the spell asks, so a loot sentence sharing
        a resolution with anything else is a draw that could be moved in front of a question it has
        nothing to do with. The reader takes the whole resolution or none of it, and a second
        sentence refuses the card rather than reading half of it (D362).
      */
      const card = compileCard({
        name: 'Greedy Rummage', type_line: 'Sorcery', mana_cost: '{R}', cmc: 1, colors: ['R'],
        oracle_text: 'Draw two cards, then discard two cards.\nTarget player discards a card.',
      });
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.script).toBeUndefined();
    });
  });

  describe('a keyword grant that also changes colour, and the hint it must not carry', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({
      state, controller: seat, source, targets, decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it('grants the keyword and sets the colour in one pump, as Crimson Wisps does', () => {
      /*
        "Target creature gains haste until end of turn and becomes red" is **one** printed effect,
        and `pump` takes both halves in one `PumpOptions` — which is how the hand-written card
        writes it. Two continuous effects would expire independently, and this pair especially:
        layer 5 *replaces* the printed colours (CR 105.3), so a colour change outliving its keyword
        would leave a creature whose colours came from a spell that has finished.
      */
      const mine = compiledScript('Crimson Wisps');
      expect(mine.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'arc-tempest', 1: 'verdant-guard' },
        battlefield: { 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const bears = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      expect(characteristicsOf(base, base.instances[bears]!).colors).toEqual(['G']);

      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: bears }]);
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor('Crimson Wisps'))(ctx));
      /*
        And right rather than merely equal. Red, not red *and* green — the state comparison above
        would pass on two readings that both added the colour instead of replacing it.
      */
      const ch = characteristicsOf(after, after.instances[bears]!);
      expect(ch.colors).toEqual(['R']);
      expect(ch.keywords.has('haste')).toBe(true);
    });

    it('refuses a colour word the engine has no colour for', () => {
      /*
        `TOKEN_COLOURS` is the word list, shared with the token reader so a colour word is spelled
        in one place. "Colorless" is in it as `null`, and that is a different claim from a colour:
        `setColors: []` says "has no colours", which is not the absence of the effect. Nothing in
        the pool prints it, so it is left unread rather than guessed (D259). "Purple" is not a
        colour in Magic at all.
      */
      for (const colour of ['colorless', 'purple']) {
        const card = compileCard({
          name: 'Tinted Haste', type_line: 'Instant', mana_cost: '{R}', cmc: 1, colors: ['R'],
          oracle_text: `Target creature gains haste until end of turn and becomes ${colour}.`,
        });
        expect(card.ok).toBe(true);
        if (card.ok) expect(card.script).toBeUndefined();
      }
    });

    it('does not tell the bot to hold a bonus whose value is in the attack', () => {
      /*
        D412's correction, and the one the hand-written cards had right all along.

        `expiresAtEndOfTurn` means "hold this for the combat", and its own docblock says what that
        does to an instant: it may wait for blockers. A haste grant waited out is a card that never
        did its job — the creature it was cast to let attack has not attacked — and an infect grant
        is the same. The hint this family needs is on the **target spec** instead
        (`helpsInCombat`: aim it at something that can attack), and the two together would say hold
        it *and* aim it at an attacker.

        Both hand-written twins carry no spell flag. The compiled reading carried
        `expiresAtEndOfTurn` on both until this test, because the increment that wrote the reader
        compared the target spec against theirs and never the flags.
      */
      for (const name of ['Crimson Wisps', 'Tainted Strike']) {
        const mine = compiledScript(name);
        expect(mine.unread, name).toEqual([]);
        expect(field(mine.script, 'expiresAtEndOfTurn'), name).toBeUndefined();
        expect(field(mine.script, 'expiresAtEndOfTurn'), name)
          .toEqual(field(scriptFor(name), 'expiresAtEndOfTurn'));
        // The hint that replaces it, on the spec rather than the card.
        const specs = field(mine.script, 'targets') as readonly TargetSpec[];
        expect(specs[0], name).toMatchObject({ helpsInCombat: true });
      }
    });

    it('still holds a pump whose value is not in the attack', () => {
      /*
        The other arm, without which the test above says only "no flag anywhere". A Giant Growth is
        as good on a blocker as on an attacker, so it keeps `expiresAtEndOfTurn` and carries no
        `helpsInCombat` — which is `helpsInCombat`'s own docblock, naming this card.
      */
      for (const name of ['Giant Growth', 'Titanic Growth']) {
        const mine = compiledScript(name);
        expect(field(mine.script, 'expiresAtEndOfTurn'), name).toBe(true);
        expect(field(mine.script, 'expiresAtEndOfTurn'), name)
          .toEqual(field(scriptFor(name), 'expiresAtEndOfTurn'));
        const specs = field(mine.script, 'targets') as readonly TargetSpec[];
        expect(specs[0]?.helpsInCombat, name).toBeUndefined();
      }
      // And a protection trick keeps its own, which is the third case.
      expect(field(compiledScript('Dive Down').script, 'protectsACreature')).toBe(true);
    });
  });

  describe('a token the card names instead of describing', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string,
    ): EffectContext => ({
      state, controller: seat, source, targets: [], decisions: [],
    } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const resolve = (script: unknown) =>
      field(script, 'onResolve') as (c: EffectContext) => GameState;

    it("draws and makes the engine's own Treasure, as Pirate's Prize does", () => {
      /*
        "Create a Treasure token" names a token rather than describing one, and the bracketed
        reminder after it is not rules text (CR 207.2) — so the token's characteristics are nowhere
        in the sentence this reader sees. Writing them out from the reminder would be transcribing
        a real card's text (D259), so the reading is a **lookup** of `TREASURE_TOKEN`, which is the
        same argument `investigate` is read by and the same object the hand-written card makes.

        That object matters beyond its name: the Treasure's sacrifice-for-mana ability is what makes
        the mana solver count it, so a token that merely looked like one would be a spell that
        appears to ramp and does not.
      */
      const mine = compiledScript("Pirate's Prize");
      expect(mine.unread).toEqual([]);
      const base = arena({ decks: { 0: 'tidal-mind', 1: 'ember-rush' }, turn: 3 });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const after = resolve(mine.script)(ctx);
      expect(after).toEqual(resolve(scriptFor("Pirate's Prize"))(ctx));
      /*
        And right rather than merely equal: two cards in hand and one Treasure on the battlefield.
        The state comparison above would also pass if both readings drew the wrong number, and this
        says which number it is.
      */
      expect(ids(after, 0 as SeatIndex, 'hand')).toHaveLength(
        ids(base, 0 as SeatIndex, 'hand').length + 2,
      );
      expect(ids(after, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(after, id) === 'Treasure')).toHaveLength(1);
    });

    it('reads a count on a named token, through the same machinery as a described one', () => {
      // The count is deliberately not this reader's business: `namedTokenFrom` hands back the
      // printed word and `tokenEffect`'s existing count logic makes sense of it, so "two" needs
      // nothing new. A reader that ignored the word would make one.
      const card = compileCard({
        name: 'Doubloon Cache', type_line: 'Sorcery', mana_cost: '{2}', cmc: 2, colors: [],
        oracle_text: 'Create two Treasure tokens.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread).toEqual([]);
      const base = arena({ decks: { 0: 'tidal-mind', 1: 'ember-rush' }, turn: 3 });
      const after = resolve(card.script)(contextOn(base, 0 as SeatIndex, 'c1'));
      expect(ids(after, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(after, id) === 'Treasure')).toHaveLength(2);
    });

    it('reads a Clue by name, which is the other definition the engine has', () => {
      /*
        No card in the pool prints "Create a Clue token" — Thraben Inspector says "investigate"
        instead — so this is the one entry in the table with no pool card behind it. It is here
        because the table's rule is "a token the engine has a definition for", and `CLUE_TOKEN` is
        one; leaving it out would be an exception with no reason. The assertion is still about real
        engine data: the token made is the Clue, with the text D243 wrote.
      */
      const card = compileCard({
        name: 'Paper Trail', type_line: 'Sorcery', mana_cost: '{1}', cmc: 1, colors: [],
        oracle_text: 'Create a Clue token.',
      });
      expect(card.ok).toBe(true);
      if (!card.ok) return;
      expect(card.unread).toEqual([]);
      const base = arena({ decks: { 0: 'tidal-mind', 1: 'ember-rush' }, turn: 3 });
      const after = resolve(card.script)(contextOn(base, 0 as SeatIndex, 'c1'));
      const clues = ids(after, 0 as SeatIndex, 'battlefield')
        .filter((id) => nameOf(after, id) === 'Clue');
      expect(clues).toHaveLength(1);
      const def = after.cardDefs[after.instances[clues[0]!]!.defKey]!;
      expect(def.oracleText).toBe(CLUE_TOKEN.oracleText);
      expect(def.typeLine).toBe(CLUE_TOKEN.typeLine);
    });

    it('refuses a predefined token the engine has no definition for', () => {
      /*
        Food is as real a token as Treasure and the engine has never needed one, so the only way to
        read it would be to invent "{2}, {T}, Sacrifice this artifact: You gain 3 life" — the text
        of a real card, written from memory. The refusal is the point of the table being a table:
        an unread line is flagged for a human (D362), an invented Food plays and is wrong.
      */
      for (const named of ['Food', 'Blood', 'Powerstone']) {
        const card = compileCard({
          name: `Larder ${named}`, type_line: 'Sorcery', mana_cost: '{1}', cmc: 1, colors: [],
          oracle_text: `Create a ${named} token.`,
        });
        expect(card.ok).toBe(true);
        if (card.ok) expect(card.script).toBeUndefined();
      }
    });
  });

  describe('loyalty abilities, against the two planeswalkers that compile whole', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets, decisions: [] } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const abilitiesOf = (script: unknown) =>
      (field(script, 'abilities') as readonly AbilityDef[] | undefined) ?? [];

    /*
      A loyalty cost is the one cost that is a number rather than a list of components, and
      `AbilityCost.loyalty` is a field rather than a component because it carries its own
      restrictions: sorcery speed, once a turn, controller only. So the cost parse takes it before
      the component loop, which has no `{T}` or mana to classify on a planeswalker's line.
    */
    it('Pyromatics is 1 damage to any target, and does not divide (D577)', () => {
      /*
        It was the second row of the divided-damage table, for the sentence the pool gave it: "1
        damage divided as you choose among one or two targets". The card prints "Pyromatics deals
        1 damage to any target", and replicate is how it reaches a second one.
      */
      const mine = (field(compiledScript('Pyromatics').script, 'targets') as readonly TargetSpec[]);
      expect(mine).toEqual(field(scriptFor('Pyromatics'), 'targets'));
      expect(mine).toHaveLength(1);
      expect(mine[0]!.divided).toBeUndefined();
      expect(mine[0]!.count).toBeUndefined();
    });

    it.each([
      ['Jace, Memory Adept', '\u22127: Any number of target players each draw twenty cards.'],
      ['Ajani, Caller of the Pride', '\u22128: Create X 2/2 white Cat creature tokens, where X is your life total.'],
    ])('%s reads every ability but its printed ultimate, and says which (D577)', (card, ultimate) => {
      /*
        Both read whole while the pool gave them ultimates of its own. The printed ones are two
        sentences no reader takes yet, so each is reported unread and the card is the hand-written
        one. The abilities above it still agree line for line.
      */
      const compiled = compiledScript(card as string);
      expect(compiled.unread.map((u) => u.line)).toEqual([ultimate]);
      const mine = abilitiesOf(compiled.script);
      const theirs = abilitiesOf(scriptFor(card as string));
      expect(theirs).toHaveLength(3);
      expect(mine).toHaveLength(2);
      mine.forEach((ability, i) => {
        expect(ability.cost).toEqual(theirs[i]!.cost);
        expect(ability.description).toBe(theirs[i]!.description);
      });
      expect(theirs[2]!.description).toBe(ultimate);
    });

    it.each([
      ['Jace Beleren'],
    ])('%s reads ability for ability, cost and description, like the hand-written card', (card) => {
      const compiled = compiledScript(card as string);
      expect(compiled.unread).toEqual([]);
      const mine = abilitiesOf(compiled.script);
      const theirs = abilitiesOf(scriptFor(card as string));
      expect(mine).toHaveLength(theirs.length);
      mine.forEach((ability, i) => {
        expect(ability.cost).toEqual(theirs[i]!.cost);
        expect(ability.description).toBe(theirs[i]!.description);
        expect(ability.targets).toEqual(theirs[i]!.targets);
      });
    });

    it('reads the minus as a minus, which is a typographic one on a real card', () => {
      /*
        A printed loyalty cost spells its minus U+2212, not a hyphen, and reading it as a plus would
        make a planeswalker that pays nothing and gains loyalty for its ultimate. Both spellings are
        read; the pool only prints the typographic one, so the hyphen is pinned by a synthetic.
      */
      const beleren = abilitiesOf(compiledScript('Jace Beleren').script);
      expect(beleren.map((a) => a.cost?.loyalty)).toEqual([2, -1, -10]);

      const hyphen = compileCard({
        name: 'Plain Walker', type_line: 'Legendary Planeswalker — Test', mana_cost: '{2}{U}',
        cmc: 3, colors: ['U'], loyalty: '3', oracle_text: '-2: Draw a card.',
      });
      expect(hyphen.ok).toBe(true);
      if (!hyphen.ok) return;
      expect(hyphen.unread).toEqual([]);
      expect(abilitiesOf(hyphen.script)[0]?.cost?.loyalty).toBe(-2);
    });

    it('draws for everybody, the opponent included, as Jace Beleren’s +2 does', () => {
      const base = arena({ decks: { 0: 'tidal-mind', 1: 'verdant-guard' } });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = abilitiesOf(compiledScript('Jace Beleren').script)[0]!.effect!(ctx);
      const theirs = abilitiesOf(scriptFor('Jace Beleren'))[0]!.effect!(ctx);
      expect(mine).toEqual(theirs);
      // Symmetrical, which is the card: a reader that drew only for the controller would be a
      // strictly better Divination, and this is the assertion that says so.
      expect(mine.zones[zoneKey(0 as SeatIndex, 'hand')]).toHaveLength(1);
      expect(mine.zones[zoneKey(1 as SeatIndex, 'hand')]).toHaveLength(1);
    });

    it('owes the targeted player a card for "Target player draws a card", as the hand-written minus does (D576)', () => {
      const base = arena({ decks: { 0: 'tidal-mind', 1: 'verdant-guard' } });
      for (const seat of [0, 1] as const) {
        const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: seat as SeatIndex }]);
        const mine = abilitiesOf(compiledScript('Jace Beleren').script)[1]!.effect!(ctx);
        const theirs = abilitiesOf(scriptFor('Jace Beleren'))[1]!.effect!(ctx);
        expect(mine).toEqual(theirs);
        expect(mine.drawsOwed).toEqual([seat]);
      }
    });

    it('mills twenty, which needed the word as well as the clause', () => {
      /*
        "mills twenty cards" went unread for want of one row in `WORD_NUMBERS` while the two lines
        around it compiled — a count printed as a word above ten, which the pool prints exactly
        once. Twenty is the assertion, because ten would pass a reader that stopped at the word it
        knew.
      */
      const base = arena({ decks: { 0: 'tidal-mind', 1: 'verdant-guard' } });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'player', seat: 1 as SeatIndex }]);
      const mine = abilitiesOf(compiledScript('Jace Beleren').script)[2]!.effect!(ctx);
      const theirs = abilitiesOf(scriptFor('Jace Beleren'))[2]!.effect!(ctx);
      expect(mine).toEqual(theirs);
      expect(mine.zones[zoneKey(1 as SeatIndex, 'graveyard')]).toHaveLength(20);
    });

    it('refuses a loyalty line whose clause has no reader, and reads its neighbours', () => {
      /*
        A synthetic planeswalker, and it owns its text for the reason the keyword-and-a-sentence
        fixture does: this test was written against Garruk Wildspeaker, whose `−4` it listed as
        unread, and the next increment read that line; one increment later his `+1` compiled too and
        every planeswalker in the pool was whole. The property being pinned is **"a loyalty line
        with no reader is reported and its neighbours still compile"**, not any particular card, so
        the example is a sentence this module has no reader for rather than a card that might get
        one.
      */
      const walker = compileCard({
        name: 'Made Up Walker', type_line: 'Legendary Planeswalker — Test', mana_cost: '{2}{G}',
        cmc: 3, colors: ['G'], loyalty: '3',
        oracle_text: '+1: Exchange control of two target creatures.\n'
          + '\u22122: Create a 3/3 green Beast creature token.\n'
          + '\u22127: You gain 5 life.',
      });
      expect(walker.ok).toBe(true);
      if (!walker.ok) return;
      expect(walker.unread.map((u) => u.line)).toEqual(['+1: Exchange control of two target creatures.']);
      // The two that read are still read, in printed order.
      expect(abilitiesOf(walker.script).map((a) => a.description)).toEqual([
        '\u22122: Create a 3/3 green Beast creature token.',
        '\u22127: You gain 5 life.',
      ]);
      expect(abilitiesOf(walker.script).map((a) => a.cost?.loyalty)).toEqual([-2, -7]);
    });
  });
  describe('the grant family: two keywords, and the hint the team pump was missing', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets, decisions: [] } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    /*
      The defect this stage fixed, and it is D364's trap in the one family whose targeted twin
      already avoided it.

      `expiresAtEndOfTurn` is "hold this for the combat". Both hand-written cards of this shape set
      it — Inspired Charge and Overrun — and the compiled reading did not, so a compiled Inspired
      Charge was a card that *works* and gets cast in a main phase with nothing to attack with.
      Nothing in the engine reads the flag; the bot does, which is why no rules test could see it.
    */
    it.each([
      ['Inspired Charge'],
      ['Overrun'],
    ])('%s is held for the combat, as the hand-written card is', (card) => {
      const compiled = compiledScript(card as string);
      expect(compiled.unread).toEqual([]);
      expect(field(scriptFor(card as string), 'expiresAtEndOfTurn')).toBe(true);
      expect(field(compiled.script, 'expiresAtEndOfTurn')).toBe(true);
    });

    it('pumps the team and grants the keyword in one effect, as Overrun does', () => {
      const base = arena({
        decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
        battlefield: { 0: ['Grizzly Bears'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = (field(compiledScript('Overrun').script, 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      const theirs = (field(scriptFor('Overrun'), 'onResolve') as
        (c: EffectContext) => GameState)(ctx);
      expect(mine).toEqual(theirs);
      /*
        One continuous effect carrying both halves, not two. Two would expire independently, and the
        count is what says which this is.
      */
      expect(mine.effects).toHaveLength(1);
      expect(mine.effects[0]?.power).toBe(3);
      expect(mine.effects[0]?.keywords).toEqual(['trample']);
      // And the team, not the table: the opponent's bear is untouched by this effect's scope.
      const ours = find(base, 0 as SeatIndex, 'battlefield', 'Grizzly Bears');
      expect(characteristicsOf(mine, mine.instances[ours]!).power).toBe(5);
      const theirCreature = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      expect(characteristicsOf(mine, mine.instances[theirCreature]!).power).toBe(2);
    });

    /*
      Ajani's ultimate: a grant with **no size change at all**, and two keywords.

      Its own branch rather than an optional size on the pump, because `sizeBonus` refuses `+0/+0`
      and should go on refusing it — a clause that pumped by nothing is a continuous effect doing
      nothing. A grant with no size is a different sentence, not a pump of zero.
    */
    it('grants both keywords in one effect, as Ajani’s hand-written ultimate does', () => {
      const base = arena({
        decks: { 0: 'forge-alliance', 1: 'verdant-guard' },
        battlefield: { 0: ['Serra Angel'] },
        turn: 3,
      });
      const angel = find(base, 0 as SeatIndex, 'battlefield', 'Serra Angel');
      const ctx = contextOn(base, 0 as SeatIndex, 'c1', [{ kind: 'card', id: angel }]);
      const mine = (field(compiledScript('Ajani, Caller of the Pride').script, 'abilities') as
        readonly AbilityDef[])[1]!.effect!(ctx);
      const theirs = (field(scriptFor('Ajani, Caller of the Pride'), 'abilities') as
        readonly AbilityDef[])[1]!.effect!(ctx);
      expect(mine).toEqual(theirs);
      expect(mine.effects).toHaveLength(1);
      expect(mine.effects[0]?.keywords).toEqual(['flying', 'double strike']);
      // No size change, which is what makes this its own reading.
      expect(mine.effects[0]?.power).toBeUndefined();
      expect(characteristicsOf(mine, mine.instances[angel]!).keywords.has('double strike')).toBe(true);
    });

    it('points Ajani’s ultimate at exactly the spec the hand-written ability points at', () => {
      const mine = (field(compiledScript('Ajani, Caller of the Pride').script, 'abilities') as
        readonly AbilityDef[])[1]!;
      const theirs = (field(scriptFor('Ajani, Caller of the Pride'), 'abilities') as
        readonly AbilityDef[])[1]!;
      expect(mine.targets).toEqual(theirs.targets);
      // Friendly: flying and double strike help what they point at, and the bot's default is the
      // enemy's board.
      expect((mine.targets as readonly TargetSpec[])[0]?.friendly).toBe(true);
    });

    it.each([
      ['Target creature gains flying and soaring until end of turn.'],
      ['Target creature gains protection from red until end of turn.'],
      ['Target creature gains flying, trample and haste until end of turn.'],
    ])('refuses %s, whose words this engine would ignore', (text) => {
      /*
        `isKeyword` is the gate: the engine's keyword list is what `characteristicsOf` consults, so a
        word outside it would compile to a creature that gains nothing and a spell that looks like it
        worked. "Soaring" is made up, "protection from red" is a real ability this engine stores
        elsewhere, and the third is three keywords — refused because the list takes one or two and
        nothing in the pool prints more. Each is reported unread, to be played by hand (D362).
      */
      const refused = compileCard({
        name: 'Grant Maker', type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
        oracle_text: text as string,
      });
      expect(refused.ok).toBe(true);
      if (!refused.ok) return;
      expect(refused.script).toBeUndefined();
      expect(refused.unread.map((u) => u.why)).toEqual(['no-reader']);
    });
  });
  describe('every planeswalker in the pool, read end to end', () => {
    const contextOn = (
      state: GameState, seat: SeatIndex, source: string, targets: readonly Target[] = [],
    ): EffectContext => ({ state, controller: seat, source, targets, decisions: [] } as unknown as EffectContext);

    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const abilityOf = (script: unknown, i: number) =>
      ((field(script, 'abilities') as readonly AbilityDef[] | undefined) ?? [])[i];

    /*
      The headline, and the reason it is worth a test of its own: a planeswalker is three or four
      independent abilities, so it is the shape most likely to compile *partly* — and a card that is
      three quarters automated is the hybrid D362 is about, not a finished reading. Three of the
      pool's five read whole; Jace, Memory Adept and Ajani, Caller of the Pride each have a printed
      ultimate that does not (D577), asserted where their abilities are compared.
    */
    it.each([
      ['Jace Beleren'],
      ['Garruk Wildspeaker'],
      ['Nissa, Voice of Zendikar'],
    ])('%s leaves no line unread', (card) => {
      const compiled = compiledScript(card as string);
      expect(compiled.unread).toEqual([]);
      const mine = (field(compiled.script, 'abilities') as readonly AbilityDef[] | undefined) ?? [];
      const theirs = (field(scriptFor(card as string), 'abilities') as readonly AbilityDef[] | undefined) ?? [];
      expect(mine).toHaveLength(theirs.length);
      expect(mine.map((a) => a.description)).toEqual(theirs.map((a) => a.description));
      expect(mine.map((a) => a.cost)).toEqual(theirs.map((a) => a.cost));
    });

    /*
      Garruk's +1 is the pool's only **counted** target: `TargetSpec.count` is 2, the engine fills
      the list before resolution, and the effect reduces over all of them rather than taking the
      first. A reader that dropped the count would untap one land and be a worse card.
    */
    it('untaps both lands Garruk’s +1 points at, as the hand-written ability does', () => {
      const base = arena({
        decks: { 0: 'verdant-guard' }, battlefield: { 0: ['Forest', 'Forest'] }, turn: 3,
      });
      const [first, second] = [...ids(base, 0 as SeatIndex, 'battlefield')];
      const tapped = tap(tap(base, first!), second!);
      const ctx = contextOn(tapped, 0 as SeatIndex, 'c1', [
        { kind: 'card', id: first! }, { kind: 'card', id: second! },
      ]);
      const mine = abilityOf(compiledScript('Garruk Wildspeaker').script, 0)!.effect!(ctx);
      const theirs = abilityOf(scriptFor('Garruk Wildspeaker'), 0)!.effect!(ctx);
      expect(mine).toEqual(theirs);
      // Both, which is the assertion a dropped count fails.
      expect(mine.instances[first!]!.tapped).toBe(false);
      expect(mine.instances[second!]!.tapped).toBe(false);
    });

    it('carries the count on Garruk’s +1, and not the untap-only flag', () => {
      const mine = abilityOf(compiledScript('Garruk Wildspeaker').script, 0)!;
      const theirs = abilityOf(scriptFor('Garruk Wildspeaker'), 0)!;
      const spec = (mine.targets as readonly TargetSpec[])[0]!;
      const written = (theirs.targets as readonly TargetSpec[])[0]!;
      expect(spec.count).toBe(2);
      expect(spec.count).toBe(written.count);
      // The description stays singular, because that is what a player is asked for each time.
      expect(spec.description).toBe(written.description);
      expect(spec.kind).toBe(written.kind);
      /*
        **This row asserted `untapsOnly: true` and that was wrong (D419).** The flag's own docblock
        forbids it here by name — "Garruk's +1 untaps two lands *and* puts a loyalty counter on him
        — both have a payoff the question below would miss" — because the flag exists to stop the
        bot tapping and untapping for ever when the board ends where it started, and a `+N` loyalty
        cost gains a counter. The assertion was written from the untap reader rather than from the
        card, which is the fourth time in this series a check has encoded the implementation it was
        meant to judge, and `compiled-vs-written.test.ts` is what caught it.
      */
      expect(mine.untapsOnly).toBeUndefined();
      expect(mine.untapsOnly).toBe(theirs.untapsOnly);
      /*
        And `friendly`, which the hand-written ability was missing: the card says "target lands"
        with no "you control", so the filter admits an opponent's and untapping one is a card thrown
        away. The flag is the bot's ordering hint, and both readings carry it now.
      */
      expect(spec.friendly).toBe(true);
      expect(spec.friendly).toBe(written.friendly);
    });

    /*
      Nissa's −2 is counters and not a pump, which her own comment calls the difference between her
      and an Overrun: they stay, they stack with the next activation, and a sweeper that kills
      everything else leaves the survivor bigger.
    */
    it('puts a counter on each of Nissa’s creatures and none of the opponent’s', () => {
      const base = arena({
        decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
        battlefield: { 0: ['Grizzly Bears'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = abilityOf(compiledScript('Nissa, Voice of Zendikar').script, 1)!.effect!(ctx);
      const theirs = abilityOf(scriptFor('Nissa, Voice of Zendikar'), 1)!.effect!(ctx);
      expect(mine).toEqual(theirs);
      const ours = find(base, 0 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const hers = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      expect(mine.instances[ours]!.counters['+1/+1']).toBe(1);
      expect(mine.instances[hers]!.counters['+1/+1']).toBeUndefined();
      // Counters, not a continuous effect: nothing was added to `effects`.
      expect(mine.effects).toHaveLength(0);
    });

    /*
      Nissa's ultimate is the pool's only clause that spends the same announced count twice: "You
      gain X life and draw X cards, where X is the number of lands you control."
    */
    it('spends the same count twice in Nissa’s ultimate, gain before draw', () => {
      const base = arena({
        decks: { 0: 'verdant-guard' }, battlefield: { 0: ['Forest', 'Forest', 'Forest'] }, turn: 3,
      });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = abilityOf(compiledScript('Nissa, Voice of Zendikar').script, 2)!.effect!(ctx);
      const theirs = abilityOf(scriptFor('Nissa, Voice of Zendikar'), 2)!.effect!(ctx);
      expect(mine).toEqual(theirs);
      // Three lands: three life and three cards, which is what makes the count discriminating.
      expect(mine.seats[0]!.life).toBe(base.seats[0]!.life + 3);
      expect(mine.zones[zoneKey(0 as SeatIndex, 'hand')]).toHaveLength(3);
    });
  });
  /*
    The two keyword declarations that are not a cast option and nothing else.

    Six of the eight alternative-cost keywords the reader groups together really are one field: the
    engine reads `flashback` and offers the cast, and the card needs nothing else. Dash and
    ninjutsu are not like that, and the standing compiled-vs-written check is what said so — both
    cards disagreed with their hand-written twins on a list, and reading the engine said the list
    was where the keyword actually lives:

      - `ninjutsu`'s own docblock admits the field is "read nowhere but the card that declares it".
        `collectLegalActions` offers a ninjutsu play by walking `script.abilities` for a cost with
        `returnsUnblockedAttacker`, so a card with the field and no ability can never be used.
      - `completeResolution` grants a dashed creature haste and the `DASHED` counter itself, but
        schedules the return by finding the card's one `delayed` end-step trigger, behind an
        `index >= 0` guard. With no such trigger the creature gets haste and never goes home —
        silently, because the guard is the thing that makes a missing trigger not a crash.

    So these tests are about what the compiled card can *do*, not about which keys match: the field
    matching was never in question, and was never the part that mattered.
  */
  describe('dash and ninjutsu: the two keyword fields the engine reads nowhere on their own', () => {
    /** A context carrying the two fields these two abilities read. */
    const contextFor = (
      state: GameState,
      seat: SeatIndex,
      source: string,
      extra: { subject?: string; enteringAttack?: { defender: SeatIndex } } = {},
    ): EffectContext =>
      ({ state, controller: seat, source, ...extra } as unknown as EffectContext);

    const delayedEndSteps = (script: unknown) =>
      ((script as { triggers?: readonly TriggerDef[] } | undefined)?.triggers ?? [])
        .filter((t) => t.delayed === true && t.on.kind === 'step' && t.on.step === 'end');

    const abilities = (script: unknown) =>
      (script as { abilities?: readonly AbilityDef[] } | undefined)?.abilities ?? [];

    it('reads dash as exactly one delayed end-step trigger, which is what the engine searches for', () => {
      /*
        The same invariant `scripts.test.ts` holds over the hand-written pool — "every card with
        dash carries exactly one delayed trigger" — asked of the compiled reading, because the
        search `dashReturnIndex` does is `findIndex`: two would schedule the first and none would
        schedule nothing.
      */
      expect(delayedEndSteps(compiledScript('Mardu Scout').script)).toHaveLength(1);
      expect(delayedEndSteps(scriptFor('Mardu Scout'))).toHaveLength(1);
    });

    it('the compiled dash return puts the creature back in its owner’s hand', () => {
      const base = arena({ decks: { 0: 'kindle-grove' }, battlefield: { 0: ['Mardu Scout'] } });
      const id = find(base, 0 as SeatIndex, 'battlefield', 'Mardu Scout');
      // Non-vacuity: it is on the battlefield before the ability runs, so the move is the evidence.
      expect(base.instances[id]!.zone).toBe('battlefield');
      const trigger = delayedEndSteps(compiledScript('Mardu Scout').script)[0]!;
      const after = trigger.effect(contextFor(base, 0 as SeatIndex, id, { subject: id }));
      expect(after.instances[id]!.zone).toBe('hand');
    });

    it('the compiled dash return does nothing to a creature that has already left', () => {
      // CR 608.2: the delayed ability stops belonging to the permanent, so a Scout killed before
      // the end step leaves it behind doing as much as it can, which is nothing.
      const base = arena({ decks: { 0: 'kindle-grove' }, graveyard: { 0: ['Mardu Scout'] } });
      const id = find(base, 0 as SeatIndex, 'graveyard', 'Mardu Scout');
      const trigger = delayedEndSteps(compiledScript('Mardu Scout').script)[0]!;
      const after = trigger.effect(contextFor(base, 0 as SeatIndex, id, { subject: id }));
      expect(after.instances[id]!.zone).toBe('graveyard');
    });

    it('reads ninjutsu as the activated ability the play is offered from, cost and all', () => {
      const compiled = abilities(compiledScript('Ninja of the Deep Hours').script);
      expect(compiled).toHaveLength(1);
      /*
        `returnsUnblockedAttacker` is not decoration: `collectLegalActions` reads it to decide this
        ability is used from the **hand** rather than the battlefield, and `legalActions` builds the
        `returnOptions` list from it. Without it the ability would be offered from nowhere.
      */
      expect(compiled[0]!.cost).toEqual({ mana: '{1}{U}', returnsUnblockedAttacker: true });
      // And the printed cost is carried through rather than hard-coded, which is the same cost the
      // hand-written card hands the shared factory.
      expect(abilities(scriptFor('Ninja of the Deep Hours'))[0]!.cost).toEqual(compiled[0]!.cost);
    });

    it('the compiled ninjutsu ability arrives tapped and attacking the seat the cost was aimed at', () => {
      const base = arena({
        decks: { 0: 'skyward-writ' }, hands: { 0: ['Ninja of the Deep Hours'] },
      });
      const id = find(base, 0 as SeatIndex, 'hand', 'Ninja of the Deep Hours');
      const ability = abilities(compiledScript('Ninja of the Deep Hours').script)[0]!;
      const after = ability.effect!(contextFor(base, 0 as SeatIndex, id, {
        enteringAttack: { defender: 1 as SeatIndex },
      }));
      expect(after.instances[id]!.zone).toBe('battlefield');
      expect(after.instances[id]!.tapped).toBe(true);
      expect(after.combat.attacks.map((a) => [a.attacker, a.defender])).toEqual([[id, 1]]);
    });

    it('the compiled ninjutsu ability does nothing with no attack to join', () => {
      /*
        The guard the hand-written card has and the factory keeps: `enteringAttack` is written when
        the cost is paid, and an ability that resolved without one has no attack to put the card
        into. Asserted because an unguarded `enterAttacking` would need a defender it has not got.
      */
      const base = arena({
        decks: { 0: 'skyward-writ' }, hands: { 0: ['Ninja of the Deep Hours'] },
      });
      const id = find(base, 0 as SeatIndex, 'hand', 'Ninja of the Deep Hours');
      const ability = abilities(compiledScript('Ninja of the Deep Hours').script)[0]!;
      expect(ability.effect!(contextFor(base, 0 as SeatIndex, id))).toEqual(base);
    });
  });
  /*
    The last row off D417's list: `removesACreature` on a permanent whose removal is an ETB trigger.

    `triggerFromLine` drops `spellFlags` on purpose — advice about casting a spell is not advice
    about a triggered ability — so the flag had nowhere to come from on the permanent path. It is
    read in `exileUntilLeavesShapeFor` instead, the one reader that holds the whole card, because the
    flag's own docblock makes it a fact about the whole card: "this card's whole effect is to remove
    a creature", and "not for a card that is good without a creature to kill".

    Three cards in the pool print this shape and the pool's hand-written scripts already draw the
    line between them, so all three are asserted: the rule is two tests, and each of the two is the
    only thing keeping the flag off one of the other cards.
  */
  describe('removesACreature on a permanent whose removal is an ETB trigger', () => {
    const flagOf = (script: unknown) =>
      (script as { removesACreature?: boolean } | undefined)?.removesACreature;

    it.each([
      [
        'Journey to Nowhere', true,
        'an Enchantment that exiles a creature: nothing to do if there is no creature to point at',
      ],
      [
        'Banisher Priest', undefined,
        'the same text on a 2/2 body, which is worth casting for the body alone',
      ],
      [
        'Banishing Light', undefined,
        'exiles a nonland permanent, so an Equipment or a planeswalker is reason enough to cast it',
      ],
    ])('%s: %s', (card, expected, _why) => {
      expect(flagOf(compiledScript(card as string).script)).toBe(expected);
      // The hand-written card is the ground truth for the judgement, not just for the shape.
      expect(flagOf(scriptFor(card as string))).toBe(expected);
    });
  });
  /*
    Damage with no target, and the payoff that changes its number (D423).

    Three cards came out of this at once, and they are one increment because they are one sentence
    read in two halves. `sweepDestination` reads **where** — "each creature with flying and each
    player" — and `kickerSpellFor` reads **how much**, which for a kicker spell is one of two
    printed numbers chosen as the spell resolves. Neither is any use to the pool without the other:
    Hurricane needs only the destination, Burst Lightning only the amount, and Breath of Darigaaz
    needs both.

    Every row below compares against the hand-written card where there is one, because the question
    is never "does this compile" — it is whether the compiled card does what the printed one does.
  */
  describe('the sweep, and the kicker payoff that picks between two printed numbers', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    /** A resolution context, with the two facts these readings depend on. */
    const resolving = (
      state: GameState,
      seat: SeatIndex,
      extra: { x?: number; kicked?: boolean; targets?: readonly Target[] } = {},
    ): EffectContext => ({
      state,
      controller: seat,
      source: 'c1',
      targets: extra.targets ?? [],
      decisions: [],
      x: extra.x ?? 0,
      ...(extra.kicked === undefined ? {} : { kicked: extra.kicked }),
    } as unknown as EffectContext);

    const spell = (text: string) => compileCard({
      name: 'Joined Up', type_line: 'Sorcery', mana_cost: '{2}{R}', cmc: 3, colors: ['R'],
      oracle_text: text,
    });

    /** A flier, a grounded 0/4 and two players: the board every row here discriminates on. */
    const board = () => arena({
      decks: { 0: 'skyward-writ', 1: 'ember-rush' },
      battlefield: { 0: ['Serra Angel', 'Basilica Guards'] },
      turn: 3,
    });

    const run = (script: unknown, state: GameState, extra = {}) =>
      (field(script, 'onResolve') as (c: EffectContext) => GameState)(
        resolving(state, 0 as SeatIndex, extra),
      );

    it('Hurricane: the fliers and every player, read as the hand-written card deals it', () => {
      const mine = compiledScript('Hurricane');
      expect(mine.unread).toEqual([]);
      const base = board();
      const compiled = run(mine.script, base, { x: 3 });
      const written = run(scriptFor('Hurricane'), base, { x: 3 });
      expect(compiled).toEqual(written);
      // Non-vacuity, and the filter: the 4/4 flier takes it, the 0/4 that cannot fly does not.
      expect(compiled.instances[find(base, 0 as SeatIndex, 'battlefield', 'Serra Angel')]!.damage)
        .toBe(3);
      expect(compiled.instances[find(base, 0 as SeatIndex, 'battlefield', 'Basilica Guards')]!
        .damage ?? 0).toBe(0);
      expect(compiled.seats.map((seat) => seat.life))
        .toEqual(base.seats.map((seat) => seat.life - 3));
    });

    it('Hurricane cast for nothing deals nothing, with no branch here saying so', () => {
      /*
        The hand-written sweeps open with `if (c.x === 0) return c.state` and `sweepDestination`
        deliberately does not: a break run showed that copying the branch changes nothing any test
        can see, because `dealDamage` refuses a non-positive amount itself. So the branch would be a
        check that cannot fail, which is D415's lesson found a second time.

        This row is what makes relying on that safe. It is not a test of a branch — it is the
        equality between a reading that **does** have one and a reading that does not, so if
        `dealDamage` ever stops refusing zero, this fails here instead of diverging quietly.
      */
      const base = board();
      const compiled = run(compiledScript('Hurricane').script, base, { x: 0 });
      expect(compiled).toEqual(run(scriptFor('Hurricane'), base, { x: 0 }));
      expect(compiled).toEqual(base);
    });

    it('Savage Twister still reads the bare "each creature", and hits both sides', () => {
      /*
        The regression this refactor could have caused: `xSpellResolution` used to spell out "each
        creature" itself, and that branch is now a call into the shared reader. Asserted against the
        hand-written card on a board with a creature on each side.
      */
      const mine = compiledScript('Savage Twister');
      expect(mine.unread).toEqual([]);
      const base = arena({
        decks: { 0: 'kindle-grove', 1: 'verdant-guard' },
        battlefield: { 0: ['Mardu Scout'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      expect(run(mine.script, base, { x: 2 })).toEqual(run(scriptFor('Savage Twister'), base, { x: 2 }));
      // Both sides, and no player: a Twister is not "and each player".
      expect(run(mine.script, base, { x: 2 }).seats.map((seat) => seat.life))
        .toEqual(base.seats.map((seat) => seat.life));
    });

    it('refuses a sweep filtered by a word the engine has no keyword for', () => {
      /*
        D259's rule applied to a filter: a word this engine cannot test is not a filter, and a sweep
        that quietly ignored it would hit every creature on the board. Unread is the honest answer —
        the card is then dealt to a human (D362).
      */
      const made = spell('Joined Up deals 2 damage to each creature with moxiness and each player.');
      expect(made.ok).toBe(true);
      if (made.ok) expect(made.script).toBeUndefined();
    });

    it('Burst Lightning: two damage, or four, from the same compiled effect', () => {
      const mine = compiledScript('Burst Lightning');
      expect(mine.unread).toEqual([]);
      // The declaration is read as the hand-written card sets it, printed description and all.
      expect(field(mine.script, 'kicker')).toEqual(field(scriptFor('Burst Lightning'), 'kicker'));
      expect(field(mine.script, 'targets')).toEqual(field(scriptFor('Burst Lightning'), 'targets'));

      const base = board();
      const angel = find(base, 0 as SeatIndex, 'battlefield', 'Serra Angel');
      const at = { targets: [{ kind: 'card', id: angel }] as readonly Target[] };
      for (const [kicked, expected] of [[false, 2], [true, 4]] as const) {
        const compiled = run(mine.script, base, { ...at, kicked });
        const written = run(scriptFor('Burst Lightning'), base, { ...at, kicked });
        expect(compiled).toEqual(written);
        expect(compiled.instances[angel]!.damage).toBe(expected);
      }
    });

    it('Breath of Darigaaz: the kicked number, through the sweep rather than a target', () => {
      const mine = compiledScript('Breath of Darigaaz');
      expect(mine.unread).toEqual([]);
      expect(field(mine.script, 'kicker'))
        .toEqual(field(scriptFor('Breath of Darigaaz'), 'kicker'));
      // No target: the destination is a sweep, and the hand-written card has none either.
      expect(field(mine.script, 'targets')).toBeUndefined();

      const base = board();
      const angel = find(base, 0 as SeatIndex, 'battlefield', 'Serra Angel');
      const guards = find(base, 0 as SeatIndex, 'battlefield', 'Basilica Guards');
      for (const [kicked, expected] of [[false, 1], [true, 4]] as const) {
        const compiled = run(mine.script, base, { kicked });
        expect(compiled).toEqual(run(scriptFor('Breath of Darigaaz'), base, { kicked }));
        // "without flying" is the other arm of the same filter Hurricane reads.
        expect(compiled.instances[guards]!.damage).toBe(expected);
        expect(compiled.instances[angel]!.damage ?? 0).toBe(0);
        expect(compiled.seats.map((seat) => seat.life))
          .toEqual(base.seats.map((seat) => seat.life - expected));
      }
    });

    it('leaves Agonizing Demise alone, whose kicked half is a different effect', () => {
      /*
        The refusal that keeps this reader honest. Agonizing Demise has kicker and is not this
        shape: kicked, it throws the dead creature's power at that creature's controller, which is
        not a bigger number for the same effect. Forcing it through a reading about numbers would be
        a card that does the wrong thing silently; unread, it is dealt by a human.
      */
      const demise = compiledScript('Agonizing Demise');
      expect(demise.script).toBeUndefined();
      expect(demise.unread.map((entry) => entry.line)).toContain('Kicker {1}{R}');
    });

    it('a kicker with no payoff line is the spell without the option, and says so', () => {
      /*
        The pair is a unit, so half of it is not read as the other half: the resolution is read,
        the declaration is **reported** as an unimplemented keyword, and no `kicker` is emitted. A
        card offering a player four extra mana for nothing would be worse than one missing an
        option, because the missing option is flagged (D362) and the pointless one is not.
      */
      const made = spell('Kicker {2}\nJoined Up deals 2 damage to any target.');
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      expect(field(made.script, 'onResolve')).toBeDefined();
      expect(field(made.script, 'kicker')).toBeUndefined();
      expect(made.unread.map((entry) => entry.line)).toEqual(['Kicker {2}']);
    });
  });
  /*
    The printed ability lines the compiler was reporting as unread on cards that already worked.

    `compile.ts` counts a line **compiled and emits nothing** when the engine reads it off the
    `CardDef` itself, because restating it in a script would be a second source for one fact. That
    check used to ask `printedKeywords` alone, so three lines in the pool were reported as unread
    on cards the engine was playing correctly or could have been: River Boa's `Islandwalk`, which
    `printedLandwalk` has read since #324; Paladin en-Vec's protection, which nothing read; and
    Phyrexian Crusader's mixed list, which nothing read either half of.

    D424 gave the three readers one classifier and the compiler one predicate — `isPrintedAbilityLine`
    — and the two protection cards then needed no script at all.
  */
  /*
    A leveler's bands are not the card's abilities (CR 711.2, D572).

    Found by D571, and only because it put the printed text on a pool card: Student of Warfare's
    Oracle text prints `First strike` on a line of its own inside the LEVEL 2-6 band, and the
    moment the pool carried that text the Student had first strike with no counters on it. The
    reader that did it — `printedKeywords`, line by line — had always done it to every leveler
    read from the card table. The pool's two were typed in a one-line form nothing could parse,
    so the suite never saw it.

    Rows copied from the corpus unchanged, and each claim run both ways: what the card must not
    have at level zero, and what it must still have.
  */
  describe('a level band is not the card\'s own text (D572)', () => {
    const BRIMSTONE_MAGE = {
      name: 'Brimstone Mage', type_line: 'Creature — Human Shaman', mana_cost: '{2}{R}', cmc: 3,
      colors: ['R'], power: '2', toughness: '2', layout: 'normal',
      oracle_text: 'Level up {3}{R} ({3}{R}: Put a level counter on this. Level up only as a sorcery.)\n{T}: Brimstone Mage deals 1 damage to any target.\nLEVEL 1-2\n2/3\n{T}: Brimstone Mage deals 3 damage to any target.\nLEVEL 3+\n2/4\n{T}: Brimstone Mage deals 5 damage to any target.',
    };
    const KARGAN_DRAGONLORD = {
      name: 'Kargan Dragonlord', type_line: 'Creature — Human Warrior', mana_cost: '{R}{R}', cmc: 2,
      colors: ['R'], power: '2', toughness: '2', layout: 'normal',
      oracle_text: 'Level up {R} ({R}: Put a level counter on this. Level up only as a sorcery.)\nLEVEL 4-7\n4/4\nFlying\nLEVEL 8+\n8/8\nFlying, trample\n{R}: Kargan Dragonlord gets +1/+0 until end of turn.',
    };

    it('reads the keyword printed above the first band, and none of the ones under it', () => {
      expect(printedKeywords('Flying\nLevel up {1}\nLEVEL 2-3\n3/3\nTrample\nLEVEL 4+\n4/4\nTrample, lifelink'))
        .toEqual(['flying']);
      expect(printedKeywords(KARGAN_DRAGONLORD.oracle_text)).toEqual([]);
      // The pool's old one-line form stops the reader too, so a card still written that way is safe.
      expect(printedKeywords('Level up {W}\nLEVEL 2-6: 3/3, first strike\nFirst strike')).toEqual([]);
      // And a card that is not a leveler is read exactly as before.
      expect(printedKeywords('Flying\nTrample')).toEqual(['flying', 'trample']);
    });

    it('Brimstone Mage taps for one damage, and not also for three and for five', () => {
      const mage = compileCard(BRIMSTONE_MAGE as never);
      expect(mage.ok).toBe(true);
      if (!mage.ok) return;
      // Its level-zero ability is above the first band and is the card's own.
      expect(mage.compiled).toEqual(['{T}: Brimstone Mage deals 1 damage to any target.']);
      expect(mage.script?.abilities ?? []).toHaveLength(1);
      // Everything from the first header down is reported, not read.
      const unread = mage.unread.map((u) => u.line);
      expect(unread).toContain('LEVEL 1-2');
      expect(unread).toContain('{T}: Brimstone Mage deals 3 damage to any target.');
      expect(unread).toContain('{T}: Brimstone Mage deals 5 damage to any target.');
    });

    it('Kargan Dragonlord has no ability of its own under the bands: no firebreathing, no flying', () => {
      const lord = compileCard(KARGAN_DRAGONLORD as never);
      expect(lord.ok).toBe(true);
      if (!lord.ok) return;
      expect(lord.compiled).toEqual([]);
      expect(lord.script?.abilities ?? []).toEqual([]);
      expect(lord.unread.map((u) => u.line)).toContain('{R}: Kargan Dragonlord gets +1/+0 until end of turn.');
    });

    it('and on the battlefield it is a 2/2 that does not fly', () => {
      const list = customDeck({
        id: 'levelers', name: 'Levelers',
        entries: [{ name: 'Kargan Dragonlord', count: 4 }, { name: 'Mountain', count: 20 }],
        data: [KARGAN_DRAGONLORD] as never[],
      });
      expect(list.unknown).toEqual([]);
      const s = arena({
        decks: { 0: 'levelers', 1: 'levelers' }, deckSpecs: { levelers: list.deck },
        battlefield: { 0: ['Mountain', 'Mountain', 'Kargan Dragonlord'] }, turn: 3, firstSeat: 0,
      });
      const id = find(s, 0 as SeatIndex, 'battlefield', 'Kargan Dragonlord');
      const ch = characteristicsOf(s, s.instances[id]!);
      expect([ch.power, ch.toughness]).toEqual([2, 2]);
      expect(ch.keywords.has('flying')).toBe(false);
      expect(ch.keywords.has('trample')).toBe(false);
    });
  });

  describe('printed ability lines the engine reads off the card definition', () => {
    it.each([
      ['River Boa', 'Islandwalk', 'landwalk, read since #324 and miscounted ever since'],
      // Both as Oracle prints them (D571). The pool had typed each a different way — the Paladin's
      // protection on a line of its own, the Crusader's as one four-part list — so these rows were
      // checking the reader against sentences no card carries.
      ['Paladin en-Vec', 'First strike, protection from black and from red', 'a keyword and the and-from printing in one list'],
      ['Phyrexian Crusader', 'First strike, protection from red and from white', 'the same, the other two colours'],
      ['Phyrexian Crusader', 'Infect', 'and the keyword Oracle gives a line of its own'],
    ])('%s counts "%s" as compiled rather than unread', (card, line) => {
      const mine = compiledScript(card as string);
      expect(mine.unread).toEqual([]);
      expect(mine.compiled).toContain(line as string);
    });

    it('emits nothing for such a line, so the script is not a second source for it', () => {
      /*
        The other half of the rule, and the reason the two protection cards now have no
        hand-written script: everything they print is read off the card. A compiled script that
        restated the line would disagree with `characteristicsOf` the moment one of them changed.
      */
      expect(compiledScript('Paladin en-Vec').script).toBeUndefined();
      expect(compiledScript('Phyrexian Crusader').script).toBeUndefined();
      expect(scriptFor('Paladin en-Vec')).toBeUndefined();
      expect(scriptFor('Phyrexian Crusader')).toBeUndefined();
      // River Boa still has a script, because its regeneration is an activated ability and nothing
      // reads one of those off printed text — only the islandwalk line came off.
      expect(compiledScript('River Boa').script).toBeDefined();
    });

    it('still refuses a sentence that mentions an ability rather than printing one', () => {
      const made = compileCard({
        name: 'Joined Up', type_line: 'Creature — Human Soldier', mana_cost: '{W}', cmc: 1,
        colors: ['W'], power: '1', toughness: '1',
        oracle_text: 'Target creature gains protection from red until end of turn.',
      });
      expect(made.ok).toBe(true);
      if (made.ok) expect(made.unread.map((entry) => entry.line)).toHaveLength(1);
    });
  });
  /*
    The templating the pool could not reveal (D427).

    Wizards shortened "enters the battlefield" to "enters" in 2024 and made "this creature" the way
    a card refers back to itself. Every reader here was written against the long form, and so is the
    engine's own card data — thirteen decks written by hand from memory — so the compiler read the
    pool at 76.8% while reading all of Magic at 23.7%, and the single largest cause was a spelling
    the pool is structurally unable to print. The corpus counts it: 5,898 cards say "enters,", 47
    still say "enters the battlefield", and about 860 say "this creature enters" or the same of an
    artifact, enchantment, land or permanent.

    These rows are fixtures rather than pool cards for exactly that reason: there is no pool card
    with the modern wording to compare against. What they assert is the property — **the two
    spellings are one phrase** — by compiling both and comparing, so neither reading can drift.
  */
  describe('the modern "enters" templating, and a card referring to itself by type', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];

    /** A permanent whose text is whatever is being read. */
    const permanent = (text: string) => compileCard({
      name: 'Joined Up', type_line: 'Creature — Human Soldier', mana_cost: '{1}{W}', cmc: 2,
      colors: ['W'], power: '2', toughness: '2', oracle_text: text,
    });

    /** A trigger's shape: when it fires and what it says, which is all that comes from a builder. */
    const shape = (script: unknown) =>
      ((field(script, 'triggers') as readonly TriggerDef[] | undefined) ?? [])
        .map((trigger) => `${JSON.stringify(trigger.on)} ${trigger.description ?? ''}`);

    it.each([
      ['When Joined Up enters, draw a card.', 'When Joined Up enters the battlefield, draw a card.'],
      [
        'When this creature enters, draw a card.',
        'When Joined Up enters the battlefield, draw a card.',
      ],
      [
        'When Joined Up enters or dies, draw a card.',
        'When Joined Up enters the battlefield or dies, draw a card.',
      ],
      [
        'Whenever another creature enters, draw a card.',
        'Whenever another creature enters the battlefield, draw a card.',
      ],
      [
        'Whenever a creature you control enters, draw a card.',
        'Whenever a creature you control enters the battlefield, draw a card.',
      ],
    ])('reads "%s" as the same trigger as the long form', (modern, old) => {
      const read = permanent(modern as string);
      const long = permanent(old as string);
      expect(read.ok && long.ok).toBe(true);
      if (!read.ok || !long.ok) return;
      expect(read.unread, `the modern spelling went unread: ${modern}`).toEqual([]);
      expect(long.unread).toEqual([]);
      // Non-vacuity first: both read a trigger at all, so this is not two empty lists agreeing.
      expect(shape(read.script).length).toBeGreaterThan(0);
      expect(shape(read.script)).toEqual(shape(long.script));
    });

    it('reads the counters a permanent enters with under either spelling, and by type', () => {
      for (const text of [
        'Joined Up enters with two +1/+1 counters on it.',
        'Joined Up enters the battlefield with two +1/+1 counters on it.',
        'This creature enters with two +1/+1 counters on it.',
      ]) {
        const read = permanent(text);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(field(read.script, 'entersWith'), `not read: ${text}`)
          .toEqual({ counter: '+1/+1', amount: 2 });
      }
    });

    it('does not read a "this creature" inside a quoted granted ability as the card\'s own', () => {
      /*
        The over-match the alias could have caused, and the reason it does not. On a *spell*, "this
        creature" means the creature the quoted ability was granted to — Abnormal Endurance grants
        `"When this creature dies, return it to the battlefield tapped under its owner's control."`
        — and reading that as the spell's own trigger would be a card that does something subtly
        wrong, which D362 calls worse than an unread line.

        Two things keep it out. A spell's lines are its resolution, so the prologue readers are never
        asked about them; and the clause readers refuse quoted text, so nothing reads the inside of
        the quotes either. Measured over the corpus rather than argued: of the 111 instants and
        sorceries whose text says "this creature", "this artifact", "this enchantment", "this land"
        or "this permanent", **five** compile to a script, and all five are a bare keyword
        declaration — `flashback`, `split second`, `escape` — with no trigger and no resolution.

        **What this row does and does not prove.** A break run adding "that creature" to the
        self-reference list left it passing, and that is correct rather than a hole in the row: on a
        spell no word list can matter, because the prologue readers are never consulted. So this
        guards the **path split**, not the list. The list's exclusion of "that" is a templating
        argument — printed Oracle text says "this" for the object an ability is on and "that" or
        "it" for something else — and nothing in the pool or in these fixtures can discriminate it,
        which is recorded in D427 as an untested claim rather than dressed up as a passing test.
      */
      const granted = compileCard({
        name: 'Joined Up', type_line: 'Instant', mana_cost: '{1}{B}', cmc: 2, colors: ['B'],
        oracle_text: 'Until end of turn, target creature gets +2/+0 and gains "When this creature'
          + ' dies, return it to the battlefield tapped under its owner\'s control."',
      });
      expect(granted.ok).toBe(true);
      if (granted.ok) expect(granted.script).toBeUndefined();
    });

    it('refuses a type the self-reference list does not name, rather than any "this X"', () => {
      // The list is a list: "this Saga" is not one of the words printed text uses for the object an
      // ability is on, so the line is unread (D362) rather than guessed at.
      const saga = permanent('When this Saga enters, draw a card.');
      expect(saga.ok).toBe(true);
      if (saga.ok) expect(saga.unread.map((entry) => entry.line)).toHaveLength(1);
    });
  });
  /*
    The second batch off the corpus queue (D428): a one-line reader and two step prologues, chosen
    because they are the biggest buckets after the templating and each is unambiguous.

    "~ enters tapped" is the case that shows what the corpus is for. `cardFromData` has always read
    the phrase — but only as part of a **whole** card it can account for, so a land printing nothing
    else was read and a land printing one more line it could not take reported the tapped clause as
    unread. 347 cards print it.
  */
  describe('enters tapped, and the two steps a card names after the upkeep', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    /*
      A creature arm gets a printed size, because a creature with none is a card the compiler now
      refuses outright (D431): `printedDef` carries the printed power and toughness, and a row that
      prints neither would be dealt as a 0/0 and binned by CR 704.5f on arrival. The land arm keeps
      no size, which is what a land prints.
    */
    const card = (text: string, type_line = 'Land') => compileCard({
      name: 'Joined Up', type_line, mana_cost: '', cmc: 0, colors: [], oracle_text: text,
      ...(/\bCreature\b/.test(type_line) ? { power: '2', toughness: '2' } : {}),
      loyalty: null, layout: 'normal',
    });

    it.each([
      ['Joined Up enters tapped.'],
      ['Joined Up enters the battlefield tapped.'],
      ['This land enters tapped.'],
    ])('reads "%s" as entersTapped', (text) => {
      const read = card(text as string);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toEqual([]);
      expect(field(read.script, 'entersTapped')).toBe(true);
    });

    it('reads it beside a line the whole-card path cannot take, which is the case that was missing', () => {
      /*
        The pair `cardFromData` could never reach: a tapped land with a step trigger on it. Before
        this reader the tapped clause was reported unread *and* the card lost the trigger with it,
        because the whole-card path is all-or-nothing and the per-line path had no reader for the
        clause.
      */
      const read = card('Joined Up enters tapped.\nAt the beginning of your draw step, draw a card.');
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toEqual([]);
      expect(field(read.script, 'entersTapped')).toBe(true);
      expect(field(read.script, 'triggers')).toHaveLength(1);
    });

    it('refuses a conditional arrival, which is a different card', () => {
      // "enters tapped unless you control two or more lands" is a replacement with a condition on
      // it, and `entersTapped` is unconditional — reading it as the plain field would be a land
      // that always arrives tapped, which is strictly worse than the printed card.
      const read = card('Joined Up enters tapped unless you control two or more other lands.');
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(field(read.script, 'entersTapped')).toBeUndefined();
      expect(read.unread).toHaveLength(1);
    });

    it.each([
      ['At the beginning of your draw step, draw a card.', 'draw'],
      ['At the beginning of combat on your turn, draw a card.', 'begin-combat'],
    ])('reads "%s" as a step trigger on %s', (text, step) => {
      const read = card(text as string, 'Creature — Human Soldier');
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toEqual([]);
      const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
      // `of: 'you'` is the card saying "your", not a default — the same note the upkeep row carries.
      expect(triggers[0]!.on).toEqual({ kind: 'step', step, of: 'you' });
    });

    it.each([
      ["At the beginning of each opponent's upkeep, draw a card."],
      ["At the beginning of each opponent's draw step, draw a card."],
      ['At the beginning of combat on each opponent\'s turn, draw a card.'],
    ])('leaves %s alone, because "your" is the half that is the rule', (text) => {
      /*
        `each opponent's` is still read by nothing: `of: 'you'` is wrong for it and `of: 'any'` is
        wrong too, so it stays unread (D362) rather than firing on the wrong turn. D434 measured
        what the missing third value would buy — 43 printed lines, **no** card whose body this
        compiler can finish — and declined to add `of: 'opponent'` on that count; `TriggerDef`'s
        `step` docblock carries the figure.

        One row per *new* prologue as well as the upkeep, which a break run is what established:
        widening only the draw-step pattern to "each opponent's" failed nothing while this described
        the upkeep alone, so the claim "of: 'you' is the card saying your" was asserted for one
        prologue and assumed for the other two.

        **"At the beginning of each end step" was the fourth row here and has been removed, because
        it is now read** (D434): `of: 'any'` is exactly right for it, 152 printed lines say it in
        three spellings, and 17 of those cards compile whole. This row had encoded a *gap* as a
        rule — "'your' is the half that is the rule" was true of what the compiler did, not of
        Magic — and a test that pins a gap fails the day the gap closes, which is this one. The new
        reading has its own table in `the step of the turn, read off the prologue`.
      */
      const read = card(text as string, 'Creature — Human Soldier');
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread).toHaveLength(1);
    });
  });
  /*
    Third batch off the corpus queue (D429): cycling, and landfall.

    Both are the D421 shape — a keyword whose declaration *is* what it does, built through a factory
    the hand-written card calls too, so the two readings cannot drift. Cycling is 192 corpus cards
    and landfall 184.
  */
  describe('cycling, and the landfall trigger the engine had a field for and no card', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const card = (text: string, type_line = 'Creature — Human Soldier') => compileCard({
      name: 'Joined Up', type_line, mana_cost: '{1}', cmc: 1, colors: [], oracle_text: text,
      power: '1', toughness: '1', loyalty: null, layout: 'normal',
    });

    it('reads Cycling {2} as the ability its reminder text spells out', () => {
      const read = card('Cycling {2}', 'Sorcery');
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toEqual([]);
      const abilities = field(read.script, 'abilities') as readonly AbilityDef[];
      expect(abilities).toHaveLength(1);
      // `discardSelf` is what tells `collectLegalActions` this is used from the hand and spends the
      // card — the half of the cost that is not mana.
      expect(abilities[0]!.cost).toEqual({ mana: '{2}', discardSelf: true });
    });

    it('builds Compelling Argument\'s cycling as its hand-written script does', () => {
      const mine = (field(compiledScript('Compelling Argument').script, 'abilities') as readonly AbilityDef[]);
      const written = (field(scriptFor('Compelling Argument'), 'abilities') as readonly AbilityDef[]);
      expect(mine[0]!.cost).toEqual(written[0]!.cost);
      expect(mine[0]!.cost).toEqual({ mana: '{U}', discardSelf: true });
    });

    it.each([['Landcycling {1}{G}'], ['Basic landcycling {2}'], ['Swampcycling {2}']])(
      'leaves %s unread, because it searches a library rather than drawing',
      (text) => {
        /*
          The typed cyclings put a card of a named kind into your hand out of your **library**, which
          needs a filter this reader would have to invent (D259). Reading one as a draw would be a
          card that does something else entirely, so it is reported instead (D362).
        */
        const read = card(text as string, 'Sorcery');
        expect(read.ok).toBe(true);
        if (read.ok) expect(read.unread.map((entry) => entry.line)).toEqual([text]);
      },
    );

    it.each([
      ['Landfall — Whenever a land you control enters, draw a card.'],
      ['Whenever a land you control enters, draw a card.'],
    ])('reads "%s" as a land-entry trigger', (text) => {
      /*
        `what: 'land'` has been in `TriggerDef` since #163, with its own docblock calling it "the
        landfall templating" and noting that "until a card asked, nothing could hear it". This is the
        card asking. The ability word is stripped before the prologue table is consulted, which is
        what an ability word *is* — so both spellings are one row.
      */
      const read = card(text as string);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toEqual([]);
      const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
      expect(triggers[0]!.on).toEqual({ kind: 'etb', who: 'any', of: 'you', what: 'land' });
    });

    it('agrees with Tatyova, whose hand-written trigger this reading corrected', () => {
      /*
        Tatyova's script said `who: 'another'`, arguing "she is not a land and her own arrival is not
        one" — true of her and not of the phrase. The standing check flagged it the moment the
        compiler could read the line, and the general reading won: the corpus prints exactly one
        **land** with this trigger (Chocobo Camp), and for that card `another` would miss its own
        arrival, which the printed text includes.
      */
      const mine = (field(compiledScript('Tatyova, Benthic Druid').script, 'triggers') as readonly TriggerDef[]);
      const written = (field(scriptFor('Tatyova, Benthic Druid'), 'triggers') as readonly TriggerDef[]);
      expect(mine[0]!.on).toEqual(written[0]!.on);
      expect(mine[0]!.on).toEqual({ kind: 'etb', who: 'any', of: 'you', what: 'land' });
    });

    it('leaves an opponent\'s land alone, which the step and entry triggers cannot express together', () => {
      // "a land an opponent controls" is `of: 'opponent'`, which the etb trigger does have — but the
      // phrase is not this phrase, and reading it as `of: 'you'` would fire on the wrong turn. Left
      // for its own row rather than folded into this one.
      const read = card('Whenever a land an opponent controls enters, draw a card.');
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread).toHaveLength(1);
    });
  });
  /*
    The printed body, which is the fourth batch and the one that was a defect rather than a gap
    (D431).

    `printedDef` built every `CardDef` the compiler hands back, and it carried no `power`, no
    `toughness` and no `loyalty`. Nothing noticed while the only consumer of a compiled script was
    `derive.ts`, which takes `script` and `unread` and gets its def from somewhere else — but
    `customDeck` started taking the def itself (D430), and `characteristicsOf` reads a missing size
    as zero. Every one of the corpus's 18,603 creatures was arriving as a 0/0 for CR 704.5f to bin,
    and all 327 of its planeswalkers at zero loyalty for CR 704.5i.
  */
  describe('the printed size, and the two permanents that die without one', () => {
    const field = (script: unknown, key: string) =>
      (script as Record<string, unknown> | undefined)?.[key];
    const row = (over: Record<string, unknown>) => compileCard({
      name: 'Sized Thing', type_line: 'Creature — Human Soldier', mana_cost: '{1}{W}', cmc: 2,
      colors: ['W'], oracle_text: '', layout: 'normal', ...over,
    } as Parameters<typeof compileCard>[0]);

    it('carries the printed power and toughness onto the def', () => {
      const read = row({ power: '2', toughness: '3' });
      expect(read.ok).toBe(true);
      if (read.ok) expect([read.def.power, read.def.toughness]).toEqual(['2', '3']);
    });

    it('carries a printed starting loyalty onto the def', () => {
      const read = row({
        type_line: 'Legendary Planeswalker — Jace', loyalty: '3',
        oracle_text: '+1: Draw a card.',
      });
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.def.loyalty).toBe('3');
    });

    it('refuses a creature whose row prints no size, rather than dealing a 0/0', () => {
      /*
        The corpus has none of these — every creature file carries a `PT:` line — but the engine's
        own `CardDef` path does: `derive.ts` rebuilds a row out of a def, and a def with no size
        (a token, a card somebody typed by hand) must not come back as a playable creature.
      */
      const read = row({ power: null, toughness: null });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.why).toContain('no printed power or toughness');
    });

    it('refuses a planeswalker whose row prints no loyalty', () => {
      const read = row({
        type_line: 'Legendary Planeswalker — Jace', loyalty: null,
        oracle_text: '+1: Draw a card.',
      });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.why).toContain('no printed loyalty');
    });

    it.each([
      /*
        A `*` is only playable when the compiler read the ability that defines it, which is why the
        refusal waits for the text. The first row is Lhurgoyf's shape — a count that supplies both
        halves — and it is kept. The second is the same count the engine does not have, so nothing
        defines the size and the card is refused. The third is the half-and-half case: a count that
        `definesSize` applies to the **power only** (`applies: 'power'`), leaving a toughness of `*`
        that nothing supplies, which is a creature with zero toughness and the same death.
      */
      ['a count that supplies both halves', 'creature cards in all graveyards', '*', true],
      ['a count this engine does not have', 'cards in your hand', '*', false],
      ['a power-only count beside a starred toughness', 'instant and sorcery cards in your graveyard', '*', false],
    ])('%s: kept = %s', (_label, count, toughness, kept) => {
      const text = count === 'instant and sorcery cards in your graveyard'
        ? `Sized Thing's power is equal to the number of ${count}.`
        : `Sized Thing's power is equal to the number of ${count} and its toughness is equal to`
          + ' that number plus 1.';
      const read = row({
        type_line: 'Creature — Lhurgoyf', power: '*', toughness, oracle_text: text,
      });
      expect(read.ok).toBe(kept);
    });

    it('keeps a starred power beside a printed toughness, which is what Enigma Drake prints', () => {
      // `*`/`4`: the count defines the power and the 4 is a real number, so the creature has a
      // size either way and is dealt. The row above is the same text with a `*` toughness.
      const read = row({
        type_line: 'Creature — Drake', power: '*', toughness: '4',
        oracle_text: "Sized Thing's power is equal to the number of instant and sorcery cards in"
          + ' your graveyard.',
      });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.def.toughness).toBe('4');
        expect(field(read.script, 'statics')).toHaveLength(1);
      }
    });
  });
});

/*
  The attachment-subject trigger, read off printed text (D433).

  These exist because of a break run that failed nothing. `compiled-vs-written.test.ts` skips any
  card with an unread line — by design, and its docblock says so — so every regression that makes a
  line *stop* reading takes the card out of the comparison instead of failing it. Breaking the
  prologue, breaking the equip reader and deleting the body reader all did exactly that, and all
  three passed. A standing check that stops looking is not a check, so the claims are asserted
  directly here.
*/
describe('the trigger whose subject is the attached permanent, as printed text', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const equipment = (text: string) => compileCard({
    name: 'Armory of Iroas', type_line: 'Artifact — Equipment', mana_cost: '{2}', cmc: 2,
    colors: [], layout: 'normal', oracle_text: text,
  });

  it('reads Armory of Iroas whole, and exactly as the hand-written card does', () => {
    const read = equipment('Whenever equipped creature attacks, put a +1/+1 counter on it.\nEquip {2}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Nothing unread is the half the standing check cannot assert: it skips rather than fails.
    expect(read.unread).toEqual([]);
    const written = scriptFor('Armory of Iroas');
    const mine = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(mine[0]!.on).toEqual((field(written, 'triggers') as readonly TriggerDef[])[0]!.on);
    expect(mine[0]!.on).toEqual({ kind: 'attacks', who: 'attached' });
    // And the equip ability, which a bonus-less Equipment used to lose entirely.
    expect(field(read.script, 'abilities')).toHaveLength(1);
  });

  it('keeps the equip ability on an Equipment that prints no bonus line', () => {
    /*
      The defect Armory of Iroas exposed, pinned on its own. `attachmentScriptFor` required a line
      starting "Equipped creature …" and returned nothing without one, so the whole equip ability
      went missing. Asserted with text that has *no* trigger either, so the only thing left to read
      is the equip — a card that reads nothing at all would otherwise look the same as this one.
    */
    const read = equipment('Equip {2}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    expect(field(read.script, 'abilities')).toHaveLength(1);
  });

  it('reads the combat-damage prologue the same way, for both printed words', () => {
    // 45 corpus cards, and the arm a break run showed nothing was testing.
    for (const word of ['equipped', 'enchanted']) {
      const read = equipment(
        `Whenever ${word} creature deals combat damage to a player, put a +1/+1 counter on it.`
        + '\nEquip {2}',
      );
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toEqual([]);
      const mine = field(read.script, 'triggers') as readonly TriggerDef[];
      expect(mine[0]!.on).toEqual({ kind: 'combat-damage', who: 'attached' });
    }
  });

  it('puts the compiled counter on the creature, not on the Equipment', () => {
    /*
      The assertion a break run showed was missing, and the reason it matters more than the others.

      Deleting the "put a +1/+1 counter on it" reader did **not** make the line unread: a reader
      downstream matched it and put the counter on `source`, which for an Equipment is the
      Equipment. The compiled card then reported `unread: []` — fully automated — and grew the
      sword instead of the creature holding it. Nothing caught that, because every other assertion
      here is about the *shape* of the script and this is about where the effect lands.

      So this runs the compiled effect against two permanents and reads which one got the counter.
      A card that is silently wrong is worse than a card that refuses the line, and it is the one
      failure D362's flag cannot warn anybody about.
    */
    const read = equipment('Whenever equipped creature attacks, put a +1/+1 counter on it.\nEquip {2}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const trigger = (field(read.script, 'triggers') as readonly TriggerDef[])[0]!;
    const inst = (id: string) => ({
      id, defKey: 'k', zone: 'battlefield', zoneSeat: 0, counters: {}, damage: 0,
      tapped: false, attachedTo: null, enteredTurn: 1,
    });
    const before = {
      instances: { gear: inst('gear'), body: inst('body') },
      cardDefs: { k: { name: 'x', typeLine: 'Creature', manaCost: '', cmc: 0, oracleText: '', colors: [] } },
      effects: [], seats: [{ life: 20 }], log: [], stateVersion: 1,
    } as unknown as GameState;
    const after = trigger.effect!({
      state: before, controller: 0 as SeatIndex, source: 'gear', subject: 'body',
      targets: [], decisions: [],
    } as unknown as EffectContext);
    expect(after.instances['body']!.counters['+1/+1']).toBe(1);
    expect(after.instances['gear']!.counters['+1/+1']).toBeUndefined();
  });

  it.each([
    /*
      The other three bodies that say "it", each on a real printed card, each from the corpus.

      The counter arm was the one Armory of Iroas found, but `selfEffect` accepted a bare "it" in
      four clauses and resolved all four to the source. So the same defect sat under three more
      bodies, and these are the cards that print them: a count rather than "a" (Bone Sabres, four
      counters), a keyword grant (Reaper's Talisman), and a size bonus (Fervent Charge, which is an
      Enchantment watching the team rather than an Equipment — the subject is somebody else either
      way). Printed text, not invented text: D259 applies to a test's fixtures as much as to a
      card's definition, so each of these was read out of the corpus.

      `counters` for the counter arm, and for the two continuous effects the pair that matters —
      `scope.ids` is **who the effect applies to** and `source` is **where it came from**. Those are
      different objects here and that is the whole point: the pump belongs to the Equipment and
      lands on the creature.
    */
    [
      'Bone Sabres', '{2}{G}', 'Artifact — Equipment',
      'Whenever equipped creature attacks, put four +1/+1 counters on it.\nEquip {3}',
      { counters: 4 },
    ],
    [
      "Reaper's Talisman", '{B}', 'Artifact — Equipment',
      'Whenever equipped creature attacks, it gains deathtouch until end of turn.\nEquip {2}',
      { keywords: ['deathtouch'] },
    ],
    [
      'Fervent Charge', '{1}{R}{W}{B}', 'Enchantment',
      'Whenever a creature you control attacks, it gets +2/+2 until end of turn.',
      { power: 2, toughness: 2 },
    ],
  ])('%s puts its "it" on the subject, not on the card', (name, cost, typeLine, text, want) => {
    const read = compileCard({
      name, type_line: typeLine, mana_cost: cost, cmc: 0,
      colors: [], layout: 'normal', oracle_text: text,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const trigger = (field(read.script, 'triggers') as readonly TriggerDef[])[0]!;
    const inst = (id: string) => ({
      id, defKey: 'k', zone: 'battlefield', zoneSeat: 0, counters: {}, damage: 0,
      tapped: false, attachedTo: null, enteredTurn: 1,
    });
    const before = {
      instances: { gear: inst('gear'), body: inst('body') },
      cardDefs: { k: { name: 'x', typeLine: 'Creature', manaCost: '', cmc: 0, oracleText: '', colors: [] } },
      effects: [], seats: [{ life: 20 }], log: [], stateVersion: 1,
    } as unknown as GameState;
    const after = trigger.effect!({
      state: before, controller: 0 as SeatIndex, source: 'gear', subject: 'body',
      targets: [], decisions: [],
    } as unknown as EffectContext);

    if ('counters' in want) {
      expect(after.instances['body']!.counters['+1/+1']).toBe(want.counters);
      expect(after.instances['gear']!.counters['+1/+1']).toBeUndefined();
      expect(after.effects).toEqual([]);
      return;
    }
    expect(after.effects).toHaveLength(1);
    const pumped = after.effects[0] as unknown as {
      scope: { ids: readonly string[] }; source: string;
      keywords?: readonly string[]; power?: number; toughness?: number;
    };
    expect(pumped.scope.ids).toEqual(['body']);
    expect(pumped.source).toBe('gear');
    if ('keywords' in want) expect(pumped.keywords).toEqual(want.keywords);
    else {
      expect(pumped.power).toBe(want.power);
      expect(pumped.toughness).toBe(want.toughness);
    }
  });

  it('reads "that creature" too, which is Good-Fortune Unicorn and 15 other corpus cards', () => {
    /*
      The other spelling of the same object, and the one clause in `targetedEffect` that is still
      reached for it. "it" is `selfEffect`'s now (`itMeans`); "that creature" is nobody else's, so
      this is what holds that clause down — without it, deleting the clause fails nothing and the
      line quietly stops reading.

      Good-Fortune Unicorn prints it alone on a one-line card, which is why it is the fixture: there
      is nothing else on the card for the reading to come from. Printed text, out of the corpus.
    */
    const read = compileCard({
      name: 'Good-Fortune Unicorn', type_line: 'Creature — Unicorn', mana_cost: '{1}{G}{W}',
      cmc: 3, colors: ['G', 'W'], layout: 'normal', power: '2', toughness: '2',
      oracle_text: 'Whenever another creature you control enters, put a +1/+1 counter on that creature.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const trigger = (field(read.script, 'triggers') as readonly TriggerDef[])[0]!;
    const inst = (id: string) => ({
      id, defKey: 'k', zone: 'battlefield', zoneSeat: 0, counters: {}, damage: 0,
      tapped: false, attachedTo: null, enteredTurn: 1,
    });
    const before = {
      instances: { horn: inst('horn'), body: inst('body') },
      cardDefs: { k: { name: 'x', typeLine: 'Creature', manaCost: '', cmc: 0, oracleText: '', colors: [] } },
      effects: [], seats: [{ life: 20 }], log: [], stateVersion: 1,
    } as unknown as GameState;
    const after = trigger.effect!({
      state: before, controller: 0 as SeatIndex, source: 'horn', subject: 'body',
      targets: [], decisions: [],
    } as unknown as EffectContext);
    expect(after.instances['body']!.counters['+1/+1']).toBe(1);
    expect(after.instances['horn']!.counters['+1/+1']).toBeUndefined();
  });

  it('leaves the line alone when the body is not one it reads', () => {
    /*
      The prologue reading on its own is not enough, and this is what says so: the same prologue
      with a body nothing reads must leave the **whole line** unread rather than emitting a trigger
      that fires and does nothing. A reader that kept the prologue and dropped the body would be a
      card that looks automated and is not.
    */
    const read = equipment(
      'Whenever equipped creature attacks, untangle the fourth harmonic.\nEquip {2}',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((entry) => entry.line))
      .toEqual(['Whenever equipped creature attacks, untangle the fourth harmonic.']);
  });
});

/*
  The step-family prologues, as printed text (D434).

  Three rows shipped out of twelve candidate spellings, and the table below is the half the runtime
  tests in `scripts.test.ts` cannot state: *which* trigger each printed sentence becomes. The
  runtime tests prove the events now exist and fire on the right turns; these prove the reading maps
  the sentence to the right step and the right `of`, and that the six spellings with no compilable
  card stay unread rather than being approximated by a near neighbour.
*/
describe('the step of the turn, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const permanent = (text: string) => compileCard({
    name: 'Stepwise Thing', type_line: 'Enchantment', mana_cost: '{2}', cmc: 2,
    colors: [], layout: 'normal', oracle_text: text,
  });

  it.each([
    // The four `any` spellings of the two steps that have compilable cards, and the one `you`
    // spelling that had neither a raise nor a reader. Counts are legal corpus lines.
    ['At the beginning of each end step', 'end', 'any'],
    ['At the beginning of the end step', 'end', 'any'],
    ["At the beginning of each player's end step", 'end', 'any'],
    ["At the beginning of each player's upkeep", 'upkeep', 'any'],
    ['At the beginning of each upkeep', 'upkeep', 'any'],
    ['At the beginning of your first main phase', 'precombat-main', 'you'],
    // And the two that already existed, which the uniform raise is what made live.
    ['At the beginning of combat on your turn', 'begin-combat', 'you'],
    ['At the beginning of your upkeep', 'upkeep', 'you'],
    ['At the beginning of your end step', 'end', 'you'],
  ])('%s becomes %s/%s', (prologue, step, of) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual({ kind: 'step', step, of });
  });

  it.each([
    /*
      The six spellings with no compilable card, left unread on purpose, and the three that are a
      different mechanism rather than a different count. Each is asserted with a body the compiler
      definitely reads, so the only thing that can leave the line unread is the prologue — without
      that, a row quietly added later would make these pass while still being unread for a real
      card, and an unread assertion that cannot fail is the trap D415 and D433 are both about.
    */
    ["each opponent's upkeep", '31 printed lines, 0 cards the compiler can finish'],
    ["each opponent's end step", '7 lines, 0 cards'],
    ['combat on each opponent’s turn', 'the apostrophe Scryfall prints is not even this one'],
    ['each combat', '27 lines, 0 cards'],
    ["each player's draw step", '13 lines, 0 cards'],
    ['your second main phase', '10 lines, 0 cards'],
    ["the upkeep of enchanted creature's controller", "an attachment's seat, not `of`"],
    ['each of your postcombat main phases', 'a turn structure this engine does not have'],
    ['your next upkeep', 'a delayed trigger, scheduled rather than printed'],
  ])('leaves "At the beginning of %s" unread: %s', (prologue) => {
    const read = permanent(`At the beginning of ${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(field(read.script, 'triggers')).toBeUndefined();
  });
});

/*
  The cast family, read off the prologue (D435, and parsed rather than enumerated in D474).

  Which printed sentence becomes which trigger. The runtime tests in `scripts.test.ts` cover the
  rows whose *behaviour* was new — `ofType`, the unused `spell: 'creature'`, `self: true` from a
  compiled card, and D474's colour, subtype and mana-value filters — and this covers the mapping
  for every spelling the parse reads, plus the ones it refuses.

  **The refusals are the half of this table that can rot.** A parse matches a wide sentence and then
  decides whether it understood the narrow part, so the day somebody widens `castDescriptor` the
  refused rows below are what notices. Each is asserted with a body the compiler definitely reads,
  which is what makes "unread" mean the prologue and nothing else (D415, D433).
*/
describe('the cast trigger, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const permanent = (text: string) => compileCard({
    name: 'Casting Thing', type_line: 'Enchantment', mana_cost: '{2}', cmc: 2,
    colors: [], layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Whenever you cast a creature spell', { kind: 'spell-cast', by: 'you', spell: 'creature' }],
    ['Whenever you cast an artifact spell', { kind: 'spell-cast', by: 'you', ofType: 'artifact' }],
    ['Whenever you cast an enchantment spell', { kind: 'spell-cast', by: 'you', ofType: 'enchantment' }],
    ['Whenever you cast a spell', { kind: 'spell-cast', by: 'you', spell: 'any' }],
    ['Whenever a player casts a spell', { kind: 'spell-cast', by: 'any', spell: 'any' }],
    ['Whenever an opponent casts a spell', { kind: 'spell-cast', by: 'opponent', spell: 'any' }],
    ['When you cast this spell', { kind: 'spell-cast', self: true }],
    // And the three that already existed, so widening the family cannot quietly capture them.
    ['Whenever you cast an instant or sorcery spell',
      { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' }],
    ['Whenever you cast a noncreature spell', { kind: 'spell-cast', by: 'you', spell: 'noncreature' }],
    ['Whenever an opponent casts a noncreature spell',
      { kind: 'spell-cast', by: 'opponent', spell: 'noncreature' }],
    /*
      And the filters the parse added (D474): a colour, two colours, multicoloured, a subtype pair,
      a single tribe, both mana-value bounds, magecraft's copy, and the caster-times-type cells the
      enumerated table never had a row for.
    */
    ['Whenever a player casts a white spell', { kind: 'spell-cast', by: 'any', ofColours: ['W'] }],
    ['Whenever an opponent casts a blue or black spell',
      { kind: 'spell-cast', by: 'opponent', ofColours: ['U', 'B'] }],
    ['Whenever you cast a multicolored spell', { kind: 'spell-cast', by: 'you', multicoloured: true }],
    ['Whenever you cast a Spirit or Arcane spell',
      { kind: 'spell-cast', by: 'you', ofSubtypes: ['Spirit', 'Arcane'] }],
    ['Whenever a player casts a Goblin spell', { kind: 'spell-cast', by: 'any', ofSubtypes: ['Goblin'] }],
    ['Whenever a player casts a spell with mana value 3 or less',
      { kind: 'spell-cast', by: 'any', spell: 'any', manaValueAtMost: 3 }],
    ['Whenever you cast a spell with mana value 4 or greater',
      { kind: 'spell-cast', by: 'you', spell: 'any', manaValueAtLeast: 4 }],
    ['Whenever you cast or copy an instant or sorcery spell',
      { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery', how: 'any' }],
    ['Whenever an opponent casts a creature spell',
      { kind: 'spell-cast', by: 'opponent', spell: 'creature' }],
    ['Whenever a player casts an enchantment spell',
      { kind: 'spell-cast', by: 'any', ofType: 'enchantment' }],
    // Heroic's tail, which reads the permanent's own name off `selfRef` (D476).
    ['Whenever you cast a spell that targets Casting Thing',
      { kind: 'spell-cast', by: 'you', spell: 'any', targetsSelf: true }],
    ['Whenever you cast a spell that targets this creature',
      { kind: 'spell-cast', by: 'you', spell: 'any', targetsSelf: true }],
  ])('%s becomes the trigger it prints', (prologue, on) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual(on);
  });

  it.each([
    /*
      Refused on the mechanism, which is the distinction worth asserting: these are not "not yet",
      they are "not expressible without lying about the card" — and a trigger that fires on the
      wrong spells, or never fires at all, is worse than a line left for a human (D362).

      **Two rows left this list in D474 and the reason is worth keeping.** "A multicolored spell"
      was refused here on the ground that it is "a fact about the mana cost"; CR 105.1 makes it a
      fact about the card's *colours*, which the engine always computed and now puts on the cast
      event, so the refusal was wrong about the mechanism and came off with the field it needed.
      "An opponent casts a creature spell" was refused on the count alone, and the parse reads it
      for free whether or not a card exercises it.
    */
    ['Whenever you cast a historic spell', 'artifact or legendary or Saga, not one field'],
    ['Whenever you cast a legendary spell', 'a supertype, which the event does not carry'],
    ['Whenever an opponent casts a white or blue instant or sorcery spell',
      'a colour and a type in one descriptor: read as neither, not as half of each'],
    ['Whenever an opponent casts a spell that targets you or a creature you control',
      'a seat and a board filter in one phrase; its "targets ~" sibling reads since D476'],
    ['Whenever you cast a spell from your graveyard', 'the zone a spell was cast from'],
    ['Whenever you cast a spell during an opponent’s turn', 'a fact about the turn'],
    ['Whenever you cast another spell', 'another than what? a permanent is not a spell'],
    ['Whenever you cast a kicked spell', 'no field asks whether a cost was paid'],
  ])('leaves "%s" unread: %s', (prologue) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(field(read.script, 'triggers')).toBeUndefined();
  });
});

/*
  The board prologue, read off the printed line (D477).

  "Whenever a[nother] <kind> you control enters / dies," as one parse. The mapping is here and the
  behaviour is in `scripts.test.ts`; the refusals below are the half that can rot, because a parsed
  row matches a wide sentence and then decides whether it understood the narrow part of it.
*/
describe('the board trigger, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const permanent = (text: string) => compileCard({
    name: 'Watching Thing', type_line: 'Enchantment', mana_cost: '{2}', cmc: 2,
    colors: [], layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Whenever a creature you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'creature' }],
    ['Whenever another creature you control enters',
      { kind: 'etb', who: 'another', of: 'you', what: 'creature' }],
    ['Whenever an artifact you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'artifact' }],
    ['Whenever another artifact you control enters',
      { kind: 'etb', who: 'another', of: 'you', what: 'artifact' }],
    ['Whenever an enchantment you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'enchantment' }],
    ['Whenever a land you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'land' }],
    ['Whenever a permanent you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'permanent' }],
    // The long spelling of the same event, which `ENTERS` folds into one row.
    ['Whenever a creature you control enters the battlefield',
      { kind: 'etb', who: 'any', of: 'you', what: 'creature' }],
    // And the death half, which takes the same filters minus `land`.
    ['Whenever a creature you control dies',
      { kind: 'dies', who: 'any', of: 'you', what: 'creature' }],
    ['Whenever another creature you control dies',
      { kind: 'dies', who: 'another', of: 'you', what: 'creature' }],
    /*
      The characteristic filters (D478). Both bounds of both sizes, a named counter and a keyword,
      on the entry and on the death — the two runtime tests in `scripts.test.ts` drive a power
      bound and a keyword through a game, and these are the rows that say the other four map.
    */
    ['Whenever a creature you control with power 3 or greater enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'creature', powerAtLeast: 3 }],
    ['Whenever another creature you control with power 2 or less enters',
      { kind: 'etb', who: 'another', of: 'you', what: 'creature', powerAtMost: 2 }],
    ['Whenever a creature you control with toughness 4 or greater dies',
      { kind: 'dies', who: 'any', of: 'you', what: 'creature', toughnessAtLeast: 4 }],
    ['Whenever a creature you control with toughness 2 or less dies',
      { kind: 'dies', who: 'any', of: 'you', what: 'creature', toughnessAtMost: 2 }],
    ['Whenever a creature you control with a +1/+1 counter on it dies',
      { kind: 'dies', who: 'any', of: 'you', what: 'creature', withCounter: '+1/+1' }],
    ['Whenever a creature you control with flying enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'creature', withKeyword: 'flying' }],
    ['Whenever another creature you control with flying dies',
      { kind: 'dies', who: 'another', of: 'you', what: 'creature', withKeyword: 'flying' }],
    /*
      `nontoken` (D484), which is part of the subject rather than of the filter: 101 legal lines
      print it across these prologues, 68 of them on a plain "nontoken creature". `dies` has had
      the field from the beginning; the entry got it with this row.
    */
    ['Whenever a nontoken creature you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'creature', nontoken: true }],
    ['Whenever another nontoken creature you control enters',
      { kind: 'etb', who: 'another', of: 'you', what: 'creature', nontoken: true }],
    ['Whenever a nontoken creature you control dies',
      { kind: 'dies', who: 'any', of: 'you', what: 'creature', nontoken: true }],
    ['Whenever a nontoken artifact you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'artifact', nontoken: true }],
    // And with a tribe under it, which is two fields off one subject.
    ['Whenever another nontoken Dragon you control enters',
      { kind: 'etb', who: 'another', of: 'you', what: 'permanent', ofSubtypes: ['Dragon'],
        nontoken: true }],
    /*
      The tribe in place of the card type (D479), told apart by the capital letter the printed line
      gives it. `permanent` beneath it rather than `creature`: a Cartouche is an enchantment and an
      Equipment an artifact, so the tribe is the whole of what the sentence says.
    */
    ['Whenever a Dragon you control enters',
      { kind: 'etb', who: 'any', of: 'you', what: 'permanent', ofSubtypes: ['Dragon'] }],
    ['Whenever another Zombie you control dies',
      { kind: 'dies', who: 'another', of: 'you', what: 'permanent', ofSubtypes: ['Zombie'] }],
    // `When` as well as `Whenever`, which the printed Egg and Ally cards use.
    ['When a Cleric you control dies',
      { kind: 'dies', who: 'any', of: 'you', what: 'permanent', ofSubtypes: ['Cleric'] }],
    // A tribe and a characteristic filter in one prologue, each read by its own arm.
    ['Whenever a Goblin you control with power 2 or greater enters',
      {
        kind: 'etb', who: 'any', of: 'you', what: 'permanent', ofSubtypes: ['Goblin'],
        powerAtLeast: 2,
      }],
  ])('%s becomes the trigger it prints', (prologue, on) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual(on);
  });

  it.each([
    /*
      Each refused for its own reason, and the reason is what makes the row worth keeping.

      A **subtype** was on this list until D479 taught both board events to carry one; those two
      rows live in the mapping table above now. What is still refused is a prologue naming two
      tribes: `ofSubtypes` is an any-of and would read it correctly, but the regex cannot span the
      "or", so the line stays whole rather than half-read.
    */
    ['Whenever a Human or Dwarf you control enters',
      'two tribes in one prologue, which `(?<what>[a-z]+)` cannot span'],
    ['Whenever a creature you control with power equal to its toughness enters',
      'a comparison between two of its own characteristics, which no field asks'],
    ['Whenever a creature you control with power or toughness 1 or less dies',
      'an or across two bounds; `powerAtMost` and `toughnessAtMost` are an and'],
    ['Whenever a creature you control with a counter on it dies',
      'any counter rather than a named one, which `withCounter` cannot say'],
    ['Whenever a creature you control with annihilator enters',
      'a word this engine has no keyword for: `isKeyword` refuses it rather than compiling a'
      + ' filter nothing ever has'],
    ['Whenever another creature you control leaves the battlefield',
      'a different event, whose filters this parse did not widen'],
    ['Whenever an artifact you control is put into a graveyard from the battlefield',
      '`to-graveyard`, which has no `what` yet'],
    ['Whenever a land you control dies',
      'dies is defined for creatures only (CR 700.4), so the parse refuses it'],
    ['Whenever a creature an opponent controls enters', "a board that is not yours: `of: 'opponent'`"],
  ])('leaves "%s" unread: %s', (prologue) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(field(read.script, 'triggers')).toBeUndefined();
  });
});

/*
  The draw-ordinal prologue, as printed text (D436).

  Which sentence becomes which trigger, and where the reader stops. The runtime tests in
  `scripts.test.ts` prove the ordinal behaves — fires on the second card, once for a `draw(2)`,
  and resets each turn — and this proves the mapping and the two spellings left alone.
*/
describe('the draw ordinal, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const permanent = (text: string) => compileCard({
    name: 'Drawing Thing', type_line: 'Enchantment', mana_cost: '{2}', cmc: 2,
    colors: [], layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Whenever you draw your second card each turn', { kind: 'draws', by: 'you', onNth: 2 }],
    ["Whenever an opponent draws their second card each turn",
      { kind: 'draws', by: 'opponent', onNth: 2 }],
    ["Whenever a player draws their second card each turn", { kind: 'draws', by: 'any', onNth: 2 }],
    /*
      And the plain one that already existed, so widening the family cannot capture it. It emits no
      `by` at all and leans on the default, where the three rows above state it — the asymmetry is
      real and left alone: `by: 'you'` *is* the default, so the two are the same trigger, and
      rewriting the older row to match would change a shape the standing compiled-vs-written check
      compares for no gain.
    */
    ['Whenever you draw a card', { kind: 'draws' }],
  ])('%s becomes the trigger it prints', (prologue, on) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual(on);
  });

  it.each([
    /*
      The two ordinals left unread, and the reason is a count rather than a mechanism: `onNth` takes
      any number, so the field is already general and only the *reader* is narrow. Of the 65 legal
      corpus lines that name an ordinal, 63 say "second"; these two spellings are one line each, so
      a word-to-number map for five ordinals would be a parser nothing exercises.
    */
    ['first', 'one legal line prints it'],
    ['fifth', 'one legal line prints it, on Alandra'],
  ])('leaves "your %s card each turn" unread: %s', (word) => {
    const read = permanent(`Whenever you draw your ${word} card each turn, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(field(read.script, 'triggers')).toBeUndefined();
  });

  it('reads one of Alandra’s two lines and flags the other, which is D362 on a real card', () => {
    /*
      Alandra, Sky Dreamer prints both ordinals: "second" on one line and "fifth" on the next. She
      is the clearest case in the corpus for what the hybrid reading is *for* — the second-card line
      compiles and the fifth-card line is handed to a human with the badge D363 added, on the same
      card, at the same time. Printed text, out of the corpus.
    */
    const read = compileCard({
      name: 'Alandra, Sky Dreamer', type_line: 'Legendary Creature — Merfolk Wizard',
      mana_cost: '{2}{U}{U}', cmc: 4, colors: ['U'], layout: 'normal', power: '2', toughness: '4',
      oracle_text: 'Whenever you draw your second card each turn, create a 2/2 blue Drake creature'
        + ' token with flying.\nWhenever you draw your fifth card each turn, Alandra, Sky Dreamer'
        + ' and Drakes you control get +X/+X until end of turn, where X is the number of cards in'
        + ' your hand.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(field(read.script, 'triggers')).toHaveLength(1);
    expect(read.unread).toHaveLength(1);
    expect(read.unread[0]!.line).toContain('fifth card');
  });
});

/*
  The death prologues, read off printed text (D437).

  Which sentence becomes which trigger, including the two spellings of the attachment's death that
  D433 left out, and the Aura shape that had to change to read them at all.
*/
describe('a death, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const permanent = (text: string, typeLine = 'Enchantment') => compileCard({
    name: 'Dying Thing', type_line: typeLine, mana_cost: '{2}', cmc: 2,
    colors: [], layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Whenever a creature you control dies', { kind: 'dies', who: 'any', of: 'you', what: 'creature' }],
    ['When equipped creature dies', { kind: 'dies', who: 'attached' }],
    ['When enchanted creature dies', { kind: 'dies', who: 'attached' }],
    ['Whenever equipped creature dies', { kind: 'dies', who: 'attached' }],
    ['Whenever enchanted creature dies', { kind: 'dies', who: 'attached' }],
    // And the two that already existed, so the new rows cannot quietly swallow them. "another"
    // excludes the card itself; the row above that says "a creature" includes it.
    ['Whenever another creature you control dies',
      { kind: 'dies', who: 'another', of: 'you', what: 'creature' }],
    ['Whenever another creature dies', { kind: 'dies', who: 'another', of: 'any', what: 'creature' }],
  ])('%s becomes the trigger it prints', (prologue, on) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual(on);
  });

  it('reads an Aura whose only other line is a trigger, which Bequeathal is', () => {
    /*
      The Aura half of D433's bonus-less Equipment. `attachmentScriptFor` required a
      "Enchanted creature …" line and returned nothing without one, so **Bequeathal** —
      "Enchant creature / When enchanted creature dies, you draw two cards" — compiled as a spell
      with no target that attached to nothing and did nothing. That is the "works and does nothing"
      shape D364's docblock is about, and the corpus says it is the majority: of 55 legal Auras
      printing "enchanted creature dies", **29 have no bonus line at all**.

      Both halves asserted, because the aura fragment is what gives the spell its target and the
      trigger is what it then does — a card with one and not the other is the defect, not the fix.
    */
    const read = compileCard({
      name: 'Bequeathal', type_line: 'Enchantment — Aura', mana_cost: '{G}', cmc: 1,
      colors: ['G'], layout: 'normal',
      oracle_text: 'Enchant creature\nWhen enchanted creature dies, you draw two cards.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const aura = field(read.script, 'aura') as { target: { kind: string; friendly?: true } };
    expect(aura.target.kind).toBe('creature');
    /*
      And `friendly` is **absent**: with no bonus line there is no signal either way — Bequeathal
      wants to be on your own creature and Banewasp Affliction on theirs, and both print nothing
      but a trigger — so the hint is omitted rather than guessed.
    */
    expect(aura.target.friendly).toBeUndefined();
    expect(field(read.script, 'triggers')).toHaveLength(1);
  });

  it('keeps the bonus and the friendly hint when the Aura prints one', () => {
    // The other side of the same change: an Aura that does print a bonus still reads it, and still
    // tells the bot the Aura helps. Without this the row above would pass on a reader that had
    // stopped reading bonuses altogether.
    const read = compileCard({
      name: 'Helpful Thing', type_line: 'Enchantment — Aura', mana_cost: '{1}{W}', cmc: 2,
      colors: ['W'], layout: 'normal',
      oracle_text: 'Enchant creature\nEnchanted creature gets +2/+2.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const aura = field(read.script, 'aura') as {
      target: { friendly?: true }; effect: { power?: number; toughness?: number };
    };
    expect(aura.target.friendly).toBe(true);
    expect([aura.effect.power, aura.effect.toughness]).toEqual([2, 2]);
  });
});

describe('a card that calls itself by its short name', () => {
  /*
    Oracle text names a legendary permanent in full once and by its short name after. The compiler
    matched the full name and "this creature" and nothing else, so "Whenever Alesha attacks" — on a
    card called *Alesha, Who Laughs at Fate* — was a line nothing could read (D438).

    Every fixture below is a printed corpus row, copied rather than written: inventing the text of
    a real card is worse than leaving the mechanic out (D259).
  */
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);

  it.each([
    [
      'Alesha, Who Laughs at Fate',
      'Legendary Creature — Human Warrior', '{1}{B}{R}', 3, ['B', 'R'],
      'First strike\nWhenever Alesha attacks, put a +1/+1 counter on it.',
      'Whenever Alesha attacks, put a +1/+1 counter on it.',
    ],
    [
      'Alirios, Enraptured',
      'Legendary Creature — Human', '{2}{U}', 3, ['U'],
      'Alirios enters tapped.',
      'Alirios enters tapped.',
    ],
    [
      'Badgey, Malicious Glitch',
      'Legendary Artifact Creature — Illusion Horror', '{3}{B}', 4, ['B'],
      'Whenever Badgey becomes tapped, each opponent loses 1 life and you gain 1 life.',
      'Whenever Badgey becomes tapped, each opponent loses 1 life and you gain 1 life.',
    ],
    [
      'Ant-Man, Scott Lang',
      'Legendary Creature — Human Hero', '{1}{W}', 2, ['W'],
      '{4}: Put a +1/+1 counter on Ant-Man.',
      '{4}: Put a +1/+1 counter on Ant-Man.',
    ],
    // The apostrophe is the point of this one: the short name is escaped the same way the full
    // name always was, so "April O'Neil" is a name and not a half-open quote in a pattern.
    [
      "April O'Neil, Kunoichi Trainee",
      'Legendary Creature — Human Ninja', '{1}{W}', 2, ['W'],
      "When April O'Neil enters, scry 2.",
      "When April O'Neil enters, scry 2.",
    ],
    [
      'Aang, A Lot to Learn',
      'Legendary Creature — Human Avatar Ally', '{2}{G/W}', 3, ['G', 'W'],
      'Whenever another creature you control dies, put a +1/+1 counter on Aang.',
      'Whenever another creature you control dies, put a +1/+1 counter on Aang.',
    ],
  ])('%s reads the line that names it in short', (name, typeLine, cost, cmc, colors, text, line) => {
    const read = compileCard({
      name, type_line: typeLine, mana_cost: cost, cmc, colors: colors as string[],
      power: '2', toughness: '2', layout: 'normal', oracle_text: text,
    });
    expect(read.ok).toBe(true);
    expect(unreadLines(read)).not.toContain(line);
  });

  it('offers the short name only where a comma separates a title, not a thousand', () => {
    /*
      Three printed names carry a comma that is a thousands separator rather than a title:
      *70,000 Light-Years from Home*, *Borrowing 100,000 Arrows* and *Guan Yu's 1,000-Li March*.
      Two of the three have letters before that comma, so "is there a letter in it" does not tell
      the two kinds of comma apart and the **space** does — which is why the probe below is named
      after the shape those two have rather than after the first.

      A pair, so that one break can move it: the same line reads on a card whose comma introduces a
      title and stays unread on a card whose comma sits inside a number.
    */
    const number = compileCard({
      name: 'Probe 1,000 Rounds', type_line: 'Artifact', mana_cost: '{2}', cmc: 2,
      colors: [], layout: 'normal', oracle_text: 'Probe 1 enters tapped.',
    });
    expect(number.ok).toBe(true);
    expect(unreadLines(number)).toEqual(['Probe 1 enters tapped.']);

    const title = compileCard({
      name: 'Probe, the Thing', type_line: 'Artifact', mana_cost: '{2}', cmc: 2,
      colors: [], layout: 'normal', oracle_text: 'Probe enters tapped.',
    });
    expect(title.ok).toBe(true);
    expect(unreadLines(title)).toEqual([]);
    expect(field(title.ok ? title.script : undefined, 'entersTapped')).toBe(true);
  });

  it.each([
    [
      'Eleven, the Mage',
      'Your maximum hand size is eleven.',
      'Legendary Creature — Human Wizard', '{1}{U}{B}{R}', 4, ['U', 'B', 'R'],
    ],
    [
      'Storm, Force of Nature',
      'Ceaseless Tempest — Whenever Storm deals combat damage to a player, the next instant or '
        + 'sorcery spell you cast this turn has storm.',
      'Legendary Creature — Mutant Hero', '{1}{G}{U}{R}', 4, ['G', 'U', 'R'],
    ],
  ])('does not read %s\'s own name as a word', (name, first, typeLine, cost, cmc, colors) => {
    /*
      The two cards in 33,847 whose short name is also an ordinary word of their own text, found by
      scanning every legal card for an alias occurrence spelled differently from the name:
      *Eleven, the Mage* prints "your maximum hand size is eleven" and *Storm, Force of Nature*
      "the next instant or sorcery spell you cast this turn has storm".

      The alias is matched case-insensitively because every reader in the module is, and JavaScript
      cannot switch that off for part of a pattern — so these rows exist to **fail the day the
      collision becomes reachable**. Neither clause is one any reader matches today; a future reader
      for "has <keyword>" or for a maximum hand size would turn one of these into a misreading of a
      real card, and this is the test that would say so rather than a measure nobody re-ran.
    */
    const read = compileCard({
      name, type_line: typeLine, mana_cost: cost, cmc, colors: colors as string[],
      power: '3', toughness: '5', layout: 'normal', oracle_text: first,
    });
    expect(read.ok).toBe(true);
    expect(unreadLines(read)).toContain(first);
    expect(field(read.ok ? read.script : undefined, 'triggers') ?? []).toEqual([]);
    expect(field(read.ok ? read.script : undefined, 'abilities') ?? []).toEqual([]);
  });
});

describe('combat damage dealt to a player, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const permanent = (text: string, typeLine = 'Enchantment') => compileCard({
    name: 'Hitting Thing', type_line: typeLine, mana_cost: '{2}', cmc: 2,
    colors: [], layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Whenever a creature you control deals combat damage to a player',
      { kind: 'combat-damage', who: 'any', of: 'you' }],
    // And the two that already existed, so the new row cannot quietly swallow them. The `self`
    // spelling names the card, which `selfRef` reads; `attached` is D433's Equipment reading.
    ['Whenever equipped creature deals combat damage to a player',
      { kind: 'combat-damage', who: 'attached' }],
    ['Whenever enchanted creature deals combat damage to a player',
      { kind: 'combat-damage', who: 'attached' }],
  ])('%s becomes the trigger it prints', (prologue, on) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual(on);
  });

  it('reads the card naming itself, which is the row this one must not swallow', () => {
    const read = compileCard({
      name: 'Hitting Thing', type_line: 'Creature — Bird', mana_cost: '{2}{U}', cmc: 3,
      colors: ['U'], power: '1', toughness: '3', layout: 'normal',
      oracle_text: 'Whenever Hitting Thing deals combat damage to a player, draw a card.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers[0]!.on).toEqual({ kind: 'combat-damage' });
  });

  it('reads the batched plural as its own trigger, which fires once per hit', () => {
    /*
      **This row asserted the opposite until D443, and that was the right refusal at the time.** It
      read "refuses the batched plural, which this engine would fire once per attacker": "whenever
      **one or more** creatures you control deal combat damage to a player" fires once however many
      creatures connected, and D439 had only `combat-damage`, which is raised per creature — so
      reading it would have paid a Grim Hireling two Treasures per attacker. A wrong reading is
      worse than a line left unread (D362).

      D443 built the batched event, so the line reads now, and the two prologues differ by one word
      of English and by how many times they fire. The count itself is asserted at runtime, under
      "the batched hit, as printed text" — a compile row can only say which trigger it became.
    */
    const read = permanent('Whenever one or more creatures you control deal combat damage to a'
      + ' player, you gain 1 life.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual({ kind: 'combat-damage-dealt', by: 'you' });
  });

  it('keeps the singular reading apart from it, which is one word of English', () => {
    // The pair that makes the two rows one lever: "a creature" is per creature, "one or more
    // creatures" is per hit, and a prologue row that swallowed the other would show up here.
    const singular = permanent('Whenever a creature you control deals combat damage to a player,'
      + ' you gain 1 life.');
    expect(singular.ok).toBe(true);
    if (!singular.ok) return;
    const triggers = field(singular.script, 'triggers') as readonly TriggerDef[];
    expect(triggers[0]!.on).toEqual({ kind: 'combat-damage', who: 'any', of: 'you' });
  });
});

describe('the cast ordinal, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const creature = (text: string) => compileCard({
    name: 'Counting Thing', type_line: 'Creature — Spirit', mana_cost: '{1}{W}', cmc: 2,
    colors: ['W'], power: '2', toughness: '2', layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Whenever you cast your second spell each turn', { kind: 'spell-cast', by: 'you', onNth: 2 }],
    ['Whenever you cast your first spell each turn', { kind: 'spell-cast', by: 'you', onNth: 1 }],
    // The ability word in front is flavour with no rules meaning (CR 207.2c) and
    // `withoutAbilityWord` takes it off, so these are the same row — which is what keeps the
    // fourteen corpus lines printing "Flurry — " from needing fourteen readers.
    ['Flurry — Whenever you cast your second spell each turn',
      { kind: 'spell-cast', by: 'you', onNth: 2 }],
    ['Eukrasia — Whenever you cast your second spell each turn',
      { kind: 'spell-cast', by: 'you', onNth: 2 }],
    // And the plain cast row, so the ordinal rows cannot quietly swallow it.
    ['Whenever you cast a spell', { kind: 'spell-cast', by: 'you', spell: 'any' }],
  ])('%s becomes the trigger it prints', (prologue, on) => {
    const read = creature(`${prologue}, you gain 2 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual(on);
  });

  it('leaves the third spell unread, which is 2 lines and 0 finished cards', () => {
    /*
      Measured before the rows were written, the way D434 onward measures: of the legal lines naming
      a cast ordinal, 47 say second (17 cards finished), 3 say first (1), and 2 say third (**0**).
      A row for the third would read a prologue onto two cards whose bodies are still unread, which
      changes nothing at all (D362) while adding a branch no test can discriminate (D425).

      `TriggerDef.onNth` already takes any number, so the field is general and the reader is not.
      This row fails if someone adds the row anyway, at which point the measure should be re-run
      rather than the test deleted.
    */
    const read = creature('Whenever you cast your third spell each turn, you gain 2 life.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'Whenever you cast your third spell each turn, you gain 2 life.',
    ]);
  });
});

describe('the label in front of an ability, which has no rules meaning', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const card = (row: Record<string, unknown>) => compileCard(row as never);

  it.each([
    /*
      A one-card flavour name, which is the shape an allow list cannot cover: of the 2,733 legal
      lines carrying a letters-only label and an em dash there are 540 distinct labels, and most of
      the readable ones are named on exactly one card (D441).
    */
    [{
      name: 'Owlbear', type_line: 'Creature — Bird Bear', mana_cost: '{3}{G}{G}', cmc: 5,
      colors: ['G'], power: '4', toughness: '4', layout: 'normal',
      oracle_text: 'Trample\nKeen Senses — When Owlbear enters, draw a card.',
    }],
    // The same, with a three-word label and the card's short name in the ability (D438).
    [{
      name: 'Primaris Chaplain', type_line: 'Creature — Astartes Cleric', mana_cost: '{2}{W}{B}',
      cmc: 4, colors: ['W', 'B'], power: '3', toughness: '3', layout: 'normal',
      oracle_text: 'Rosarius — Whenever Primaris Chaplain attacks, it gains indestructible until'
        + ' end of turn.',
    }],
    // And a shared ability word, which the three-word allow list already read: nothing it could
    // read before stops reading.
    [{
      name: 'Ardent Recruit', type_line: 'Creature — Human Soldier', mana_cost: '{W}', cmc: 1,
      colors: ['W'], power: '1', toughness: '1', layout: 'normal',
      oracle_text: 'Metalcraft — Ardent Recruit gets +2/+2 as long as you control three or more'
        + ' artifacts.',
    }],
  ])('$name reads the ability behind its label', (row) => {
    const read = card(row);
    expect(read.ok).toBe(true);
    expect(unreadLines(read)).toEqual([]);
  });

  it.each([
    /*
      The em dash joins a keyword to its **cost** on these, not a label to an ability. Dropping the
      label would turn a price into an unconditional effect, which is the worst reading this module
      can produce — so each stays unread, and each row fails if the refusal is lifted.
    */
    ['a keyword and its cost (cumulative upkeep)', {
      name: 'Aboroth', type_line: 'Creature — Elemental', mana_cost: '{4}{G}{G}', cmc: 6,
      colors: ['G'], power: '9', toughness: '9', layout: 'normal',
      oracle_text: 'Cumulative upkeep—Put a -1/-1 counter on Aboroth.',
    }],
    /*
      And the judgement in this entry: `Boast` and `Exhaust` print "<keyword> — <activated
      ability>", so their remainders **would** read — 8 and 15 cards. The keyword *is* the
      restriction on the ability (boast only during your turn and only after this creature attacked;
      each exhaust ability only once), so reading the remainder on its own would offer an
      unrestricted ability. 23 wrong readings, not 23 lines left unread (D362).
    */
    ['a keyword that is the restriction (boast)', {
      name: 'Axgard Braggart', type_line: 'Creature — Dwarf Warrior', mana_cost: '{3}{W}', cmc: 4,
      colors: ['W'], power: '3', toughness: '3', layout: 'normal',
      oracle_text: 'Boast — {1}{W}: Untap Axgard Braggart. Put a +1/+1 counter on it.',
    }],
    ['a keyword that is the restriction (exhaust)', {
      name: 'Afterburner Expert', type_line: 'Creature — Goblin Artificer', mana_cost: '{2}{G}',
      cmc: 3, colors: ['G'], power: '4', toughness: '2', layout: 'normal',
      oracle_text: 'Exhaust — {2}{G}{G}: Put two +1/+1 counters on this creature.',
    }],
    // A digit in the label, which the label pattern refuses outright.
    ['a label with a number in it (descend)', {
      name: 'Akawalli, the Seething Tower', type_line: 'Legendary Creature — Fungus',
      mana_cost: '{1}{B}{G}', cmc: 3, colors: ['B', 'G'], power: '3', toughness: '3',
      layout: 'normal',
      oracle_text: 'Descend 4 — As long as there are four or more permanent cards in your'
        + ' graveyard, Akawalli, the Seething Tower gets +2/+2 and has trample.',
    }],
  ])('leaves %s unread', (_label, row) => {
    const read = card(row);
    expect(read.ok).toBe(true);
    expect(unreadLines(read)).toHaveLength(1);
  });

  /*
    The refusals that **no printed card can discriminate today**, on one probe sentence.

    Each of these labels has a rules meaning, and each is refused — but the remainder of every
    printed line carrying one is a cost or a bare effect that this compiler cannot read either way,
    so a fixture built from a real card would pass whether the refusal were there or not. A probe
    sentence the compiler definitely reads makes the guard falsifiable, which is the whole point of
    having it: these entries protect a reading that does not exist yet.

    - `Suspend X` and `Splice onto Arcane` are the first-word rule: "Suspend 3—{2}{R}" is caught by
      the digit, "Suspend X" is not, and both join a keyword to its cost.
    - `Channel` and `Ward` are keyword abilities `KEYWORD_ABILITY_NAMES` does not name. 40 legal
      lines print "Channel — <ability>" and that ability is activated from your **hand**, so reading
      the remainder as an ordinary one would offer it from the battlefield.
    - `I` and `III` are a Saga's chapter markers (CR 714) — 473 legal lines, and the one case where
      stripping the label changes a reading rather than leaving a line unread: the chapter ability
      would become an ability the Saga simply has.

    `Keen Senses` is the control, so the table fails if the probe sentence ever stops reading rather
    than reading every row as a refusal.
  */
  it.each([
    ['Suspend X', false], ['Splice onto Arcane', false],
    ['Channel', false], ['Ward', false],
    ['I', false], ['III', false],
    ['Keen Senses', true],
  ])('%s: the ability behind it reads = %s', (label, reads) => {
    const sentence = 'Whenever you gain life, draw a card.';
    const read = compileCard({
      name: 'Probe Thing', type_line: 'Enchantment — Saga', mana_cost: '{2}', cmc: 2,
      colors: [], layout: 'normal', oracle_text: `${label} — ${sentence}`,
    });
    expect(read.ok).toBe(true);
    expect(unreadLines(read)).toEqual(reads === true ? [] : [`${label} — ${sentence}`]);
    expect(field(read.ok ? read.script : undefined, 'triggers') ?? [])
      .toHaveLength(reads === true ? 1 : 0);
  });
});

describe('the declaration, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const creature = (text: string) => compileCard({
    name: 'Swinging Thing', type_line: 'Creature — Human Soldier', mana_cost: '{1}{W}', cmc: 2,
    colors: ['W'], power: '2', toughness: '2', layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Whenever you attack'],
    // The longer spelling of the same sentence, which is 5 legal lines.
    ['Whenever one or more creatures you control attack'],
  ])('%s becomes the declaration trigger', (prologue) => {
    const read = creature(`${prologue}, you gain 2 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.on).toEqual({ kind: 'attack-declared', by: 'you' });
  });

  it.each([
    // Every variant carries a restriction the event cannot express, with its corpus count. Read as
    // the bare declaration each would be a wrong reading of a real card (D362), so each stays
    // unread — and these rows fail if a prologue row is ever widened to swallow one.
    ['Whenever you attack with three or more creatures'],      // 8 legal lines
    ['Whenever you attack with two or more creatures'],         // 6
    ['Whenever you attack with one or more creatures'],         // 3
    ['Whenever you attack a player'],                           // 7
    ['Whenever you attack with your commander'],                // 2
    ['Whenever two or more creatures you control attack a player'], // 2
  ])('refuses %s, which this event cannot express', (prologue) => {
    const line = `${prologue}, you gain 2 life.`;
    const read = creature(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([line]);
  });

  it('still reads one creature attacking, which is a different trigger', () => {
    // The row the new ones must not swallow: "Whenever this creature attacks" is about the creature
    // and is raised once per attacker, which is what `attacks` has always been.
    const read = creature('Whenever Swinging Thing attacks, you gain 2 life.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers[0]!.on).toEqual({ kind: 'attacks' });
  });
});

describe('a mana ability that is a choice of colours', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const descriptions = (c: ReturnType<typeof compileCard>) =>
    ((field(c.ok ? c.script : undefined, 'abilities') ?? []) as readonly { description: string }[])
      .map((a) => a.description);
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);

  it.each([
    /*
      "Add {B} or {R}" is 252 legal lines, and 67 of those cards have no other unread line at all.
      The branch that reads it used to say a choice "is left to `cardFromData`'s land path rather
      than guessed at here" — and `cardFromData` reads a whole card or nothing, so a dual land that
      also enters tapped and gains a life got no script from either (D444).

      `AbilityDef` has no "one of these": the hand-written Guildgates and Birds of Paradise express
      a choice as one ability per colour, so this emits the pool's own shape. The descriptions are
      per colour because the table puts one on each button, and two buttons reading "Add {B} or
      {R}." cannot be told apart.
    */
    ['Akoum Refuge', 'Land', '', 0,
      'Akoum Refuge enters tapped.\nWhen Akoum Refuge enters, you gain 1 life.\n{T}: Add {B} or {R}.',
      ['{T}: Add {B}.', '{T}: Add {R}.']],
    // Three colours, printed with the Oxford comma; the other line stays unread, which costs this
    // one nothing (D362).
    ['Abzan Banner', 'Artifact', '{3}', 3,
      '{T}: Add {W}, {B}, or {G}.',
      ['{T}: Add {W}.', '{T}: Add {B}.', '{T}: Add {G}.']],
    // And a cost that is not just a tap: the prefix is kept verbatim on each option.
    ['An-Havva Township', 'Land', '', 0,
      '{2}, {T}: Add {R} or {W}.',
      ['{2}, {T}: Add {R}.', '{2}, {T}: Add {W}.']],
  ])('%s becomes one ability per colour', (name, typeLine, cost, cmc, text, expected) => {
    const read = compileCard({
      name, type_line: typeLine, mana_cost: cost, cmc, colors: [], layout: 'normal',
      oracle_text: text,
    });
    expect(read.ok).toBe(true);
    expect(descriptions(read)).toEqual(expected);
  });

  it('reads "any color" as the five Birds of Paradise abilities', () => {
    /*
      The same shape with five options, which is how Birds of Paradise is written by hand. Its own
      row because a creature needs a printed body to compile at all — and **both** of Accomplished
      Alchemist's printed lines are here on purpose: with only the first, `cardFromData` reads the
      whole card as a mana creature (#309) and this reader is never reached, so the break run showed
      the row passing with the branch disabled. The second line stays unread, which is what forces
      the line-by-line path.
    */
    const read = compileCard({
      name: 'Accomplished Alchemist', type_line: 'Creature — Elf Druid', mana_cost: '{3}{G}',
      cmc: 4, colors: ['G'], power: '2', toughness: '5', layout: 'normal',
      oracle_text: '{T}: Add one mana of any color.\n{T}: Add X mana of any one color, where X is'
        + ' the amount of life you gained this turn.',
    });
    expect(read.ok).toBe(true);
    expect(descriptions(read)).toEqual([
      '{T}: Add {W}.', '{T}: Add {U}.', '{T}: Add {B}.', '{T}: Add {R}.', '{T}: Add {G}.',
    ]);
    expect(unreadLines(read)).toHaveLength(1);
  });

  it.each([
    /*
      Each refusal is a restriction this shape cannot express, and each is refused by the anchors
      rather than by a list — a second sentence or an extra word simply does not match.
    */
    // 37 legal lines. Reading it would make a Ziggurat tap for any spell.
    ['Ancient Ziggurat', 'Land',
      '{T}: Add one mana of any color. Spend this mana only to cast a creature spell.'],
    // 20 legal lines, and there is no chosen colour until an "As ~ enters, choose a colour" reader
    // exists to make one.
    ['Colour Thing', 'Land', '{T}: Add one mana of the chosen color.'],
    // 10 legal lines: two mana, not one, and the combination is a choice per symbol.
    ['Combination Thing', 'Artifact', '{T}: Add two mana in any combination of colors.'],
    /*
      **Adarkar Wastes was here and is read (D497).** The row said "a second sentence, which is
      Adarkar Wastes' painland clause — the choice is right and the damage is not read, so the line
      stays whole", and that was true of the reader as it stood. The second sentence is read now:
      the damage is the mana ability's own effect, grouped per line so `{T}: Add {C}` stays free.
      Its assertions live in this file's D497 block — the sixth stale refusal row in this series,
      and the third I wrote myself.
    */
  ])('leaves %s\'s narrower mana ability unread', (name, typeLine, text) => {
    const read = compileCard({
      name, type_line: typeLine, mana_cost: '', cmc: 0, colors: [], layout: 'normal',
      oracle_text: text,
    });
    expect(read.ok).toBe(true);
    expect(unreadLines(read)).toEqual([text]);
  });
});

describe('a timing restriction on an activated ability', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const abilities = (c: ReturnType<typeof compileCard>) =>
    (field(c.ok ? c.script : undefined, 'abilities') ?? []) as
      readonly { description: string; sorcerySpeed?: boolean }[];

  it('reads "Activate only as a sorcery" into the flag the engine already enforces', () => {
    /*
      The sentence is a **timing** restriction, not an effect, so it is taken off the end of the line
      before the clause vocabulary reads the rest — and a line that kept it read as nothing at all,
      which is why cards printing it were unread (D445).

      `AbilityDef.sorcerySpeed` has existed since planeswalkers (#43) and the engine enforces it, so
      this is a sentence read into a field rather than a rule taught.
    */
    const read = compileCard({
      name: 'Brave-Kin Duo', type_line: 'Creature — Rabbit Mouse', mana_cost: '{W}', cmc: 1,
      colors: ['W'], power: '1', toughness: '1', layout: 'normal',
      oracle_text: '{1}, {T}: Target creature gets +1/+1 until end of turn. Activate only as a'
        + ' sorcery.',
    });
    expect(read.ok).toBe(true);
    expect(read.ok ? read.unread : []).toEqual([]);
    expect(abilities(read)).toHaveLength(1);
    expect(abilities(read)[0]!.sorcerySpeed).toBe(true);
    // The printed line is kept whole as the description, restriction and all, because that is what
    // the table shows on the button.
    expect(abilities(read)[0]!.description).toContain('Activate only as a sorcery.');
  });

  it('does not set the flag on the same ability without the sentence', () => {
    // The other half of the lever: the restriction is read from the text and not assumed, so the
    // unrestricted version of the same line is still an instant-speed ability.
    const read = compileCard({
      name: 'Brave-Kin Duo', type_line: 'Creature — Rabbit Mouse', mana_cost: '{W}', cmc: 1,
      colors: ['W'], power: '1', toughness: '1', layout: 'normal',
      oracle_text: '{1}, {T}: Target creature gets +1/+1 until end of turn.',
    });
    expect(read.ok).toBe(true);
    expect(abilities(read)).toHaveLength(1);
    expect(abilities(read)[0]!.sorcerySpeed).toBeUndefined();
  });

  it('refuses a line that puts text after the restriction', () => {
    /*
      The sentence is anchored at the **end** of the line, and this is the row that makes that
      anchor falsifiable — no printed card puts text after it, so nothing real can discriminate it.

      Without the anchor the non-greedy capture takes the text *before* the sentence and throws the
      rest away: "{1}: Put a +1/+1 counter on this creature. Activate only as a sorcery. Draw a
      card." would compile to an ability that puts a counter and never draws. A silently missing
      effect is the worst reading this module can produce (D362), so the line stays unread instead.
    */
    const read = compileCard({
      name: 'Probe Thing', type_line: 'Creature — Human Soldier', mana_cost: '{1}{W}', cmc: 2,
      colors: ['W'], power: '2', toughness: '2', layout: 'normal',
      oracle_text: '{1}: Put a +1/+1 counter on this creature. Activate only as a sorcery. Draw a'
        + ' card.',
    });
    expect(read.ok).toBe(true);
    expect(read.ok ? read.unread : []).toHaveLength(1);
    expect(abilities(read)).toEqual([]);
  });

  it('reads it beside a mana ability that is a choice of colours', () => {
    // Charisma Bobblehead, printed: D444's reader finishes the first line and this one the second,
    // which is the hybrid compiler finishing a card neither change could finish alone.
    const read = compileCard({
      name: 'Charisma Bobblehead', type_line: 'Artifact — Bobblehead', mana_cost: '{3}', cmc: 3,
      colors: [], layout: 'normal',
      oracle_text: '{T}: Add one mana of any color.\n{4}, {T}: Create X 1/1 white Soldier creature'
        + ' tokens, where X is the number of Bobbleheads you control. Activate only as a sorcery.',
    });
    expect(read.ok).toBe(true);
    expect(read.ok ? read.unread : []).toEqual([]);
    expect(abilities(read).filter((a) => a.sorcerySpeed === true)).toHaveLength(1);
    expect(abilities(read)).toHaveLength(6);
  });
});

describe('an ability cost that is not mana, a tap or life', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const costs = (c: ReturnType<typeof compileCard>) =>
    ((field(c.ok ? c.script : undefined, 'abilities') ?? []) as
      readonly { cost: Record<string, unknown> }[]).map((a) => a.cost);
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const read = (name: string, typeLine: string, text: string, extra: Record<string, unknown> = {}) =>
    compileCard({
      name, type_line: typeLine, mana_cost: '{2}', cmc: 2, colors: [], layout: 'normal',
      ...extra, oracle_text: text,
    } as never);

  it.each([
    /*
      `AbilityCost` has carried `sacrificeSelf`, `sacrifice` and `discardSelf` for a long time and
      the payment enforces all three; the cost loop read none of them, so an ability naming one read
      as nothing at all (D446). Of the unread lines whose **effect** this compiler can already read
      once the cost is swapped for `{1}`, 415 print "Sacrifice <this permanent>", 143 the three
      filtered sacrifices and 14 "Discard <this card>".
    */
    ['Sacrifice Probe Thing: Draw a card.', { sacrificeSelf: true }],
    // The other three spellings of the same cost, which `selfRef` already knew (D426, D438).
    ['{2}, {T}, Sacrifice this artifact: You gain 3 life.',
      { mana: '{2}', tap: true, sacrificeSelf: true }],
    ['{4}, {T}, Sacrifice this land: Draw a card.',
      { mana: '{4}', tap: true, sacrificeSelf: true }],
    // Ashnod's Altar: the sacrifice is the **whole** cost, which the "is there a cost at all" guard
    // has to count or the line is refused for having no cost.
    ['Sacrifice a creature: Add {C}{C}.', { sacrifice: 'creature' }],
    ['{1}, Sacrifice another creature: Draw a card.',
      { mana: '{1}', sacrifice: 'another-creature' }],
    ['Sacrifice an artifact: Draw a card.', { sacrifice: 'artifact' }],
    ['{T}, Discard Probe Thing: Draw a card.', { tap: true, discardSelf: true }],
  ])('reads %s', (text, cost) => {
    const compiled = read('Probe Thing', 'Artifact', text);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    expect(costs(compiled)).toEqual([cost]);
  });

  it.each([
    /*
      What is refused, and why each one must be: there is **no field on `AbilityCost`** for any of
      these, so there is nothing to read them into — and inventing one would be a cost the payment
      does not charge, which is an ability that activates for free. Each is a printed shape with its
      corpus count.
    */
    ['a land, which has no field', '{1}{B}, Sacrifice a land: Draw a card.'],            // 27 lines
    ['a creature type, which has no field', '{1}, Sacrifice a Goblin: Draw a card.'],    // 15
    ['tapping somebody else, which has no field',
      'Tap an untapped creature you control: Draw a card.'],                             // 18
    ['taking a counter off, which has no field',
      '{1}, Remove a +1/+1 counter from Probe Thing: Draw a card.'],                     // 35
    ['exiling from a graveyard, which has no field',
      '{2}, Exile Probe Thing from your graveyard: Draw a card.'],                       // 17
    // And two sacrifices in one cost, which the field cannot count: refused rather than halved.
    ['two sacrifices in one cost, which the field cannot count',
      'Sacrifice a creature, Sacrifice an artifact: Draw a card.'],
  ])('refuses %s', (_label, text) => {
    const compiled = read('Probe Thing', 'Artifact', text);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([text]);
    expect(costs(compiled)).toEqual([]);
  });

  it('finishes Abandoned Outpost, which needs this reader and D444 together', () => {
    // Printed. The first line is "enters tapped", the second a mana ability, the third a mana
    // ability that is a choice of colours behind a sacrifice — three readers and one card.
    const compiled = compileCard({
      name: 'Abandoned Outpost', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
      layout: 'normal',
      oracle_text: 'Abandoned Outpost enters tapped.\n{T}: Add {W}.\n{T}, Sacrifice Abandoned'
        + ' Outpost: Add one mana of any color.',
    });
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    expect(costs(compiled)).toEqual([
      { tap: true },
      { tap: true, sacrificeSelf: true },
      { tap: true, sacrificeSelf: true },
      { tap: true, sacrificeSelf: true },
      { tap: true, sacrificeSelf: true },
      { tap: true, sacrificeSelf: true },
    ]);
  });
});

describe('"you may": the optional triggered ability', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const triggersOf = (c: ReturnType<typeof compileCard>) =>
    (field(c.ok ? c.script : undefined, 'triggers') ?? []) as readonly TriggerDef[];
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const read = (text: string) => compileCard({
    name: 'Probe Thing', type_line: 'Creature — Bird', mana_cost: '{2}{U}', cmc: 3,
    colors: ['U'], power: '2', toughness: '2', layout: 'normal', oracle_text: text,
  } as never);
  /** The one `ChoiceDecisionSpec` a read "you may" carries, as a plain object. */
  const choice = (c: ReturnType<typeof compileCard>) => {
    const specs = triggersOf(c)[0]?.decisions ?? [];
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(typeof spec).not.toBe('function');
    return spec as unknown as Record<string, unknown>;
  };

  it.each([
    /*
      The commonest two words in Magic's trigger clauses, and until D447 they made the whole line
      unreadable: the clause vocabulary is about what an effect does, and "you may" is about whether
      it happens. 82 legal lines on 50 cards are exactly a prologue this compiler reads, a "you
      may", and an effect it reads.
    */
    ['the enters trigger', 'When Probe Thing enters, you may draw a card.', 'Draw a card?'],
    ['a counter on itself',
      'Whenever Probe Thing attacks, you may put a +1/+1 counter on Probe Thing.',
      'Put a +1/+1 counter on Probe Thing?'],
    ['a step trigger', 'At the beginning of your end step, you may draw a card.', 'Draw a card?'],
    // With a target, which is chosen when the trigger goes on the stack and so is not part of the
    // question: the yes-or-no is asked as it resolves (CR 601.2c against CR 603.3).
    ['a targeted effect', 'When Probe Thing enters, you may destroy target artifact.',
      'Destroy target artifact?'],
  ])('reads %s and asks before it acts', (_label, text, prompt) => {
    const compiled = read(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    const spec = choice(compiled);
    expect(spec['who']).toBe('controller');
    expect(spec['prompt']).toBe(prompt);
    /*
      Yes **first**, and no `best`. `ChoiceDecisionSpec.options` documents the first option as the
      answer a bot falls back on when the card gives none, and that is the right fallback for every
      one of the 82 lines this reads — all of them are pure upside for the controller. The refusal
      table below is what keeps that true.
    */
    expect(spec['options']).toEqual(['Yes', 'No']);
    expect(spec['best']).toBeUndefined();
  });

  it('leaves a mandatory trigger with no question at all', () => {
    /*
      The other arm of the pair, and the one that makes the rows above mean something: the same
      clause without the two words must read as a trigger that simply happens. A reader that put a
      yes-or-no on every trigger would pass every row above.
    */
    const compiled = read('When Probe Thing enters, draw a card.');
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    expect(triggersOf(compiled)).toHaveLength(1);
    expect(triggersOf(compiled)[0]?.decisions).toBeUndefined();
  });

  it('keeps the printed clause as the description, "you may" and all', () => {
    // The description is what the card says, not what the reading made of it (see
    // `triggerFromLine`), so the table and the log show the printed words.
    const compiled = read('When Probe Thing enters, you may draw a card.');
    expect(triggersOf(compiled)[0]?.description).toBe('you may draw a card');
  });

  it('asks the yes-or-no before the effect\'s own question, not after it', () => {
    /*
      **Retired refusal (D450).** This block's refusal table used to open with
      `['an effect that asks its own question', 'When Probe Thing enters, you may search your
      library for a basic land card, put it onto the battlefield tapped, then shuffle.']`, and the
      comment above it read: "The engine asks a resolution's questions in order and cannot skip a
      later one on an earlier answer, so the search would open the library **before** the yes-or-no
      could be read … That is a wrong reading and an information leak, and it costs 9 legal lines on
      7 cards."

      It cost rather more than that in the end — 42 cards on this sub-shape alone — and D450 paid it
      by adding `DecisionSpec.askOnlyIfChosen`. The claim is kept here because the rule it states
      has not changed: the question must not be asked before the "may" is answered. What changed is
      that the engine can now express that, so the line reads instead of being refused.
    */
    const compiled = read('When Probe Thing enters, you may search your library for a basic land'
      + ' card, put it onto the battlefield tapped, then shuffle.');
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    const specs = (triggersOf(compiled)[0]?.decisions ?? []) as unknown as Record<string, unknown>[];
    expect(specs).toHaveLength(2);
    // The yes-or-no first, with no condition on it...
    expect(specs[0]?.['options']).toEqual(['Yes', 'No']);
    expect(specs[0]?.['askOnlyIfChosen']).toBeUndefined();
    // ...and the search second, asked only on a yes.
    expect(specs[1]?.['from']).toBe('library');
    expect(specs[1]?.['askOnlyIfChosen']).toBe('Yes');
  });

  it.each([
    // A "may" whose effect is not in the vocabulary at all is still refused, for the ordinary
    // reason: stripping two words off a line does not make the rest readable.
    ['an effect with no reader', 'When Probe Thing enters, you may bargain with the umpire.'],
    /*
      And a "may" whose effect runs something **before** its question, which is still refused after
      D450. `composeEffects` splits a composition at its first question and puts what comes before
      it in `beforeDecisions` (D418), so here the draw would happen and *then* the player would be
      asked whether they wanted any of it.

      **A probe row**, added because a break run found the guard untestable: no printed card in this
      family composes an effect in front of a question. It is the one shape `askOnlyIfChosen` cannot
      rescue, because the thing that needs gating is not a question.
    */
    ['an effect that runs before its own question',
      'When Probe Thing enters, you may draw a card, then search your library for a basic land'
        + ' card, put it into your hand.'],
  ])('refuses %s', (_label, text) => {
    const compiled = read(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([text]);
    expect(triggersOf(compiled)).toHaveLength(0);
  });

  it('reads the pool\'s own Mystic Remora, which was an unread line until this', () => {
    /*
      The card this increment finished in the pool, and the reason the hand-written Remora now
      spells its question `['Yes', 'No']`: before D447 its trigger line was unread and the two
      readings could not be compared at all.
    */
    const remora = compiledScript('Mystic Remora');
    expect(fullyCompiled(remora)).toBe(true);
    const spec = (remora.script?.triggers ?? [])
      .flatMap((t) => t.decisions ?? [])
      .filter((d) => typeof d !== 'function') as unknown as Record<string, unknown>[];
    /*
      One card, and a price the caster may pay to stop it (D578): the pool's text said "draw two
      cards" and the printed card says "a card unless that player pays {4}". Two questions, the
      payer's first, and the draw held back on the answer that did not pay.
    */
    expect(spec.map((d) => d['prompt'])).toEqual([
      'Pay {4}? If you do not, the ability\'s controller may draw a card.',
      'Draw a card?',
    ]);
    expect(spec.map((d) => d['who'])).toEqual(['acting-player', 'controller']);
    expect(spec[0]!['payIfChosen']).toEqual({ option: 'Pay {4}', cost: '{4}' });
    expect(spec[1]!['askOnlyIfChosen']).toBe("Don't pay");
  });

  it('reads Rhystic Study, and refuses the same sentence with a price it cannot charge', () => {
    const study = read('Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.');
    expect(unreadLines(study)).toEqual([]);
    const asked = (triggersOf(study)[0]?.decisions ?? []) as unknown as Record<string, unknown>[];
    expect(asked.map((d) => d['options'])).toEqual([["Don't pay", 'Pay {1}'], ['Yes', 'No']]);
    // Esper Sentinel's: X is a fact about the board when the trigger resolves, not a cost string.
    const sentinel = 'Whenever an opponent casts a spell, you may draw a card unless that player pays {X}.';
    expect(unreadLines(read(sentinel))).toEqual([sentinel]);
  });
});

describe('a "may" with a price on it (D448)', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const triggersOf = (c: ReturnType<typeof compileCard>) =>
    (field(c.ok ? c.script : undefined, 'triggers') ?? []) as readonly TriggerDef[];
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const read = (text: string) => compileCard({
    name: 'Probe Thing', type_line: 'Creature — Bird', mana_cost: '{2}{U}', cmc: 3,
    colors: ['U'], power: '2', toughness: '2', layout: 'normal', oracle_text: text,
  } as never);
  const choice = (c: ReturnType<typeof compileCard>) => {
    const specs = triggersOf(c)[0]?.decisions ?? [];
    expect(specs).toHaveLength(1);
    return specs[0] as unknown as Record<string, unknown>;
  };

  it.each([
    /*
      66 legal lines print this and 39 name a cost the engine can charge.
      `ChoiceDecisionSpec.payIfChosen` is the shape, unchanged since echo (#196): a price on one
      answer, paid before the effect, and **not offered at all** when the seat cannot afford it.
    */
    ['one generic symbol', 'When Probe Thing enters, you may pay {1}. If you do, draw a card.',
      '{1}', 'Pay {1} — Draw a card?'],
    ['a coloured cost',
      'When Probe Thing enters, you may pay {2}{B}. If you do, draw a card.',
      '{2}{B}', 'Pay {2}{B} — Draw a card?'],
    // Hybrid, which `parseManaCost` has understood since #167 — Shu Yun prints exactly this.
    ['a hybrid cost',
      'Whenever Probe Thing attacks, you may pay {R/W}{R/W}. If you do, draw a card.',
      '{R/W}{R/W}', 'Pay {R/W}{R/W} — Draw a card?'],
  ])('reads %s', (_label, text, cost, prompt) => {
    const compiled = read(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    const spec = choice(compiled);
    expect(spec['prompt']).toBe(prompt);
    expect(spec['payIfChosen']).toEqual({ option: `Pay ${cost as string}`, cost });
    /*
      **The decline is first, where a free "may" puts Yes first**, and the asymmetry is the point.
      `options[0]` is a bot's fallback, and `extort()`'s docblock says which way a price falls:
      "do not spend mana" is the safe one of the two. A free may cannot cost its controller
      anything; this one can tap them out.
    */
    expect(spec['options']).toEqual(['Decline', `Pay ${cost as string}`]);
    expect(spec['best']).toBeUndefined();
  });

  it('puts Yes first on the free may and Decline first on the priced one', () => {
    /*
      The pair, stated as one assertion so the asymmetry cannot drift. Two rows that each checked
      their own order would both pass if a change made them the same.
    */
    const free = choice(read('When Probe Thing enters, you may draw a card.'));
    const priced = choice(read('When Probe Thing enters, you may pay {1}. If you do, draw a card.'));
    expect(free['options']).toEqual(['Yes', 'No']);
    expect(priced['options']).toEqual(['Decline', 'Pay {1}']);
    expect(free['payIfChosen']).toBeUndefined();
  });

  it.each([
    /*
      Every refusal here is a cost `payIfChosen` cannot charge, with its corpus count. Inventing a
      payment would be worse than leaving the line unread: a trigger that fires for free when the
      card says it costs something is a different card (D362).
    */
    /*
      **Retired row (D451).** This list opened with
      `['energy, which is not mana', 'Whenever Probe Thing attacks, you may pay {E}{E}. If you do,
      draw a card.']` — 19 legal lines — and the comment read: "`{E}` exists in this engine (#180)
      but not as a price on an answer, and `parseManaCost` is what refuses it rather than a list of
      exceptions."

      The first half of that was the whole limitation, and D451 removed it: `payIfChosen.energy`
      prices an answer in energy, so the row moved to that increment's own table. The **rule** this
      test states has not changed — a price the engine cannot charge refuses the line — and the
      three rows left are the ones it still cannot charge.
    */
    ['life, which has no field here',
      'When Probe Thing dies, you may pay 2 life. If you do, draw a card.'],                   // 4
    ['mana and a discard, which is two costs',
      'When Probe Thing enters, you may pay {1} and discard a card. If you do, draw a card.'], // 2
    ['mana and a sacrifice, which is two costs',
      'When Probe Thing enters, you may pay {2} and sacrifice a token. If you do, draw a card.'],
    // An announced X on a trigger's price is machinery this reader does not reach — the same line
    // D446's ability costs drew.
    ['an announced X',
      'When Probe Thing enters, you may pay {X}. If you do, draw a card.'],
  ])('refuses %s', (_label, text) => {
    const compiled = read(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([text]);
    expect(triggersOf(compiled)).toHaveLength(0);
  });

  it('keeps the whole printed clause as the description', () => {
    const compiled = read('When Probe Thing enters, you may pay {1}. If you do, draw a card.');
    expect(triggersOf(compiled)[0]?.description)
      .toBe('you may pay {1}. If you do, draw a card');
  });
});

describe('a library search, generalised (D449)', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const spell = (text: string, name = 'Probe Thing', typeLine = 'Sorcery') => compileCard({
    name, type_line: typeLine, mana_cost: '{2}{G}', cmc: 3, colors: ['G'], layout: 'normal',
    // A creature row needs a printed body or `compileCard` refuses the card outright, for a reason
    // that has nothing to do with this clause.
    ...(/creature/i.test(typeLine) ? { power: '2', toughness: '2' } : {}),
    oracle_text: text,
  } as never);
  /** The one search question a read clause carries, as a plain object. */
  const question = (c: ReturnType<typeof compileCard>) => {
    const specs = (field(c.ok ? c.script : undefined, 'decisions') ?? []) as readonly unknown[];
    expect(specs).toHaveLength(1);
    return specs[0] as Record<string, unknown>;
  };

  it.each([
    /*
      Two exact-string readers covered two of the **173 distinct shapes** this clause takes in the
      corpus. They are not 173 mechanics: they are one mechanic crossed with a filter, an optional
      reveal, two spellings of "the card you found", and three destinations — 439 unread legal
      lines in all.
    */
    ['a basic land card to the battlefield tapped (Rampant Growth)',
      'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.'],
    // "that card" where the line above says "it": a wording variant, 14 lines of it.
    ['the same with "that card" (Deep Reconnaissance)',
      'Search your library for a basic land card, put that card onto the battlefield tapped, then'
        + ' shuffle.'],
    ['an untapped arrival (Khalni Heart Expedition’s shape)',
      'Search your library for a basic land card, put it onto the battlefield, then shuffle.'],
    ['a reveal before the hand (Attune with Aether)',
      'Search your library for a basic land card, reveal it, put it into your hand, then shuffle.'],
    ['"reveal that card" (Braidwood Sextant)',
      'Search your library for a basic land card, reveal that card, put it into your hand, then'
        + ' shuffle.'],
    // A card type, lowercase in print.
    ['a card type (Eladamri’s Call)',
      'Search your library for a creature card, reveal that card, put it into your hand, then'
        + ' shuffle.'],
    ['a planeswalker (Call the Gatewatch)',
      'Search your library for a planeswalker card, reveal it, put it into your hand, then shuffle.'],
    // A subtype, capitalised in print.
    ['a creature subtype (Cateran Summons)',
      'Search your library for a Mercenary card, reveal that card, put it into your hand, then'
        + ' shuffle.'],
    ['a basic land type (Flagstones of Trokair)',
      'Search your library for a Plains card, put it onto the battlefield tapped, then shuffle.'],
  ])('reads %s', (_label, text) => {
    const compiled = spell(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    const spec = question(compiled);
    expect(spec['from']).toBe('library');
    expect(spec['max']).toBe(1);
    expect(typeof spec['filter']).toBe('function');
  });

  it('reads the comma form of "a card", with no filter at all', () => {
    /*
      Demonic Tutor, printed. "A card" is the one phrase whose reading is the **absence** of a
      filter, and it has to be told apart from a phrase this module cannot build rather than
      falling through to one: a search with a filter that matches nothing and a search with no
      filter look identical in the spec until you ask what it offers.
    */
    const compiled = spell(
      'Search your library for a card, put that card into your hand, then shuffle.',
    );
    expect(unreadLines(compiled)).toEqual([]);
    expect(question(compiled)['filter']).toBeUndefined();
  });

  it.each([
    /*
      The multi-word filters, which are the dangerous refusals rather than the obvious ones: each
      ends in " card" like a type phrase and so reaches the type branch, where a capitalised
      multi-word name would be matched against a subtype list that holds one word per entry — and
      find nothing, silently, on a card that otherwise works. The one-word guard is what refuses
      them, and these are the printed shapes it is refusing (counts are legal lines in the corpus).
    */
    /*
      **Retired rows (D455).** This list opened with five, and three of them have since become
      readings rather than refusals:

      | row | printed phrase | why it was refused | why it reads now |
      | --- | --- | --- | --- |
      | `a basic of a named type` | `a basic Plains card` | the one-word guard | a leading `basic` distributes over the list |
      | `two types` | `an instant or sorcery card` | the one-word guard | alternatives are OR-ed |
      | `a supertype and a type` | `a legendary creature card` | the one-word guard | words inside an alternative are AND-ed |

      The claim they made was "each ends in ' card' like a type phrase and so reaches the type
      branch, where a capitalised multi-word name would be matched against a subtype list that holds
      one word per entry — and find nothing, silently". That was true of a reader that took the whole
      phrase as one word. D455 splits the phrase into alternatives of conjunctions, which is the
      grammar Magic actually prints, and each word still has to classify on its own — so the
      silent-nothing the rows were guarding against is still impossible, and the two rows left are
      the shapes that genuinely cannot be read: `permanent` is not a type (CR 205.2a) and a colour
      is not on the type line at all.

      **A fourth row retired (D491).** `a Rebel permanent card`, 10 lines, refused here because
      "`permanent` is not a type (CR 205.2a)". That sentence is still true and is no longer a reason
      to refuse the phrase: `cardWordMatch` reads the word as what CR 110.1 says a permanent *is* —
      any of the six permanent types — rather than as a word to look for on the line. So the
      silent-nothing this row guarded against is impossible for the same reason the three above are,
      and the row is a reading now.

      **One row is left**, and it is the next increment in this family rather than a rule: a colour
      is not on the type line at all, so `a green creature card` needs a filter over `CardDef.colors`.
    */
    ['a colour and a type', 'a green creature card'],                                 // 4
  ])('refuses %s, which ends in "card" but is not a type', (_label, filterPhrase) => {
    const text = `Search your library for ${filterPhrase as string}, put that card into your hand,`
      + ' then shuffle.';
    const compiled = spell(text);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([text]);
  });


  it('reads a supertype, which is neither a type nor a subtype', () => {
    /*
      Captain Sisay prints "a legendary card". **This was a defect in the first draft of this
      reader** and the reason the lowercase allow-list exists: "legendary" is a supertype
      (CR 205.4a), so a reader matching subtypes found nothing, every time, on a card that
      otherwise worked. See the next test for the other half of the same mistake.
    */
    const compiled = spell(
      '{T}: Search your library for a legendary card, reveal that card, put it into your hand,'
        + ' then shuffle.',
      'Captain Sisay',
      // A tap ability needs a permanent to live on: the same line on a Sorcery is refused for that
      // reason and not for its filter, which is a distinction worth not tripping over.
      'Legendary Creature — Human Soldier',
    );
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
  });

  it('reads "a permanent card" as the six permanent types, not as a word on the line', () => {
    /*
      **This was a refusal until D491**, and the reason it gave is kept because it is still correct:
      "permanent" is a *category* of types, not a type (CR 205.2a), so no card's type line contains
      it — a reader that accepted the word as a type would compile a search offering **nothing**, on
      a card whose other lines work. That is worse than leaving the line unread, because the card
      plays and plays wrongly (D362), and nothing at the table would flag it.

      What changed is the reading, not the rule. The word is not matched against the line at all
      now: it is read as what CR 110.1 says a permanent **is**, over the `PERMANENT_TYPES` list
      `permanentWordMatch` already used for board scopes. So the failure this test was written to
      forbid is still forbidden. `scripts.test.ts` holds the assertion that makes the difference
      observable — the same search offers the creatures *and* the land, and turns down the instant.
    */
    const text = 'Search your library for a permanent card, put that card into your hand, then'
      + ' shuffle.';
    const compiled = spell(text);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
  });

  it('reads "a card named <itself>" and refuses any other name', () => {
    /*
      Avarax's shape, and the only name a printed line can give this reader: the card's own. A line
      naming some *other* card would need a database to look the name up in, and a filter matching a
      name that is not in the deck is a search that finds nothing.
    */
    const own = spell(
      'Search your library for a card named Probe Thing, reveal it, put it into your hand, then'
        + ' shuffle.',
    );
    expect(unreadLines(own)).toEqual([]);
    const other = 'Search your library for a card named Shivan Dragon, reveal it, put it into your'
      + ' hand, then shuffle.';
    expect(unreadLines(spell(other))).toEqual([other]);
  });

  it.each([
    /*
      What is refused, each with its printed shape. All of them need something this reader has not
      got: a count on the question, a destination applied to a set, two filters, a condition on a
      characteristic, two zones, or a fourth destination.
    */
    /*
      **Retired rows (D455).** Two rows have left this list: `a count on the question` ("up to two
      basic land cards, put them onto the battlefield tapped") and `a destination applied to a set`
      ("any number of cards named ~, reveal them, put them into your hand"). Both were refused
      because this reader had neither a count nor a set — "Up to two basic land cards, any number of
      cards named ~ and reveal them, put them into your hand need a count on the question and a
      destination applied to a set", as the docblock then said. D455 gave it both, and the two
      shapes are now read and asserted in its own block below; 416 legal cards were one unread line
      from finished and that line was a library search.
    */
    ['two filters at once',
      'Search your library for a basic land card or Gate card, put it onto the battlefield tapped,'
        + ' then shuffle.'],
    ['a condition on a characteristic',
      'Search your library for an artifact card with mana value 4 or 5, reveal that card, put it'
        + ' into your hand, then shuffle.'],
    ['two zones',
      'Search your library and/or graveyard for a creature card, reveal it, put it into your hand,'
        + ' then shuffle.'],
    // The top of the library is a fourth destination, and `searchYourLibrary`'s own shuffle would
    // undo it — so this one is not merely unread, it is a reading that could not be correct.
    ['the top of the library as a destination',
      'Search your library for a basic land card, reveal it, then shuffle and put that card on top.'],
  ])('refuses %s', (_label, text) => {
    const compiled = spell(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([text]);
  });

  it('still reads the two cards the narrow readers it replaced were written for', () => {
    // Diabolic Tutor keeps its own exact-string reader ("...for a card and put that card into your
    // hand"), which this clause's comma form does not cover; Rampant Growth goes through the new
    // one. Both are in the pool and `compiled-vs-written` compares them against their scripts.
    expect(fullyCompiled(compiledScript('Diabolic Tutor'))).toBe(true);
    expect(fullyCompiled(compiledScript('Rampant Growth'))).toBe(true);
  });
});

describe('a price paid in energy rather than mana (D451)', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const triggersOf = (c: ReturnType<typeof compileCard>) =>
    (field(c.ok ? c.script : undefined, 'triggers') ?? []) as readonly TriggerDef[];
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const read = (text: string) => compileCard({
    name: 'Probe Thing', type_line: 'Creature — Gremlin', mana_cost: '{1}{R}', cmc: 2,
    colors: ['R'], power: '2', toughness: '1', layout: 'normal', oracle_text: text,
  } as never);
  const price = (c: ReturnType<typeof compileCard>) => {
    const specs = triggersOf(c)[0]?.decisions ?? [];
    return (specs[0] as unknown as Record<string, unknown>)['payIfChosen'];
  };

  it.each([
    /*
      The biggest refusal D448 left behind. `payIfChosen.cost` was a mana string, and `{E}` is not
      mana — so 19 of that increment's 66 lines paid a price the engine could not charge, even
      though `AbilityCost.energy` has charged an *activated* ability in energy since #180.
    */
    ['one energy', 'Whenever Probe Thing attacks, you may pay {E}. If you do, draw a card.', 1],
    ['two', 'Whenever Probe Thing attacks, you may pay {E}{E}. If you do, draw a card.', 2],
    ['three', 'When Probe Thing dies, you may pay {E}{E}{E}. If you do, draw a card.', 3],
  ])('reads %s', (_label, text, energy) => {
    const compiled = read(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    expect(price(compiled)).toEqual({ option: `Pay ${'{E}'.repeat(energy as number)}`, energy });
  });

  it('keeps a mana price a mana price', () => {
    /*
      The control, and the reason the energy reader is tried **first**. `{E}` matches the mana
      reader's own `\\{[^}]+\\}`, so that reader matches an energy clause too and then hands
      "{E}{E}" to `parseManaCost`, which refuses it — and the line reads as nothing. That is what
      the first run of this change did, and the coverage measure caught it: not one card moved.
      This row is the other half of the pair, so the ordering cannot be "fixed" by swapping it back.
    */
    const compiled = read('Whenever Probe Thing attacks, you may pay {1}{R}. If you do, draw a'
      + ' card.');
    expect(unreadLines(compiled)).toEqual([]);
    expect(price(compiled)).toEqual({ option: 'Pay {1}{R}', cost: '{1}{R}' });
  });

  it('refuses a price that is mana and energy at once', () => {
    /*
      Two currencies in one price, which `payIfChosen` holds one of. The energy reader wants a run
      of nothing but `{E}`, so this falls through to the mana reader, where `parseManaCost` records
      `{E}` as unsupported and the line stays unread (D362). No printed card pays both; the row is
      here because the two readers in sequence could otherwise half-read it.
    */
    const text = 'Whenever Probe Thing attacks, you may pay {1}{E}. If you do, draw a card.';
    expect(unreadLines(read(text))).toEqual([text]);
  });
});

describe('surveil, which is scry with the other destination (D452)', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const spell = (text: string) => compileCard({
    name: 'Probe Thing', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
    layout: 'normal', oracle_text: text,
  } as never);
  const question = (c: ReturnType<typeof compileCard>) =>
    ((field(c.ok ? c.script : undefined, 'decisions') ?? []) as readonly unknown[])[0] as
      Record<string, unknown>;

  it.each([
    /*
      The largest clause left in the corpus that needed no new machinery: **227 unread legal lines
      mention surveil, 120 of them a card's only unread line**. Every prologue they hang off was
      already read — an enters trigger, an attack, a step, an activated ability, a spell's own
      resolution — so one clause reader and one field were all they were waiting for.
    */
    ['one', 'Surveil 1.', 1],
    ['two', 'Surveil 2.', 2],
    ['four', 'Surveil 4.', 4],
  ])('reads surveil %s', (_label, text, count) => {
    const compiled = spell(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    const spec = question(compiled);
    expect(spec['from']).toBe('library-top');
    expect(spec['look']).toBe(count);
    // `min: 0` is what makes "keep them all" a legal answer, and it matters more here than for
    // scry: surveilling into your own graveyard is a cost on some boards and a gain on others.
    expect(spec['min']).toBe(0);
    expect(spec['max']).toBe(count);
    expect(spec['chosenGoTo']).toBe('graveyard');
  });

  it('leaves scry pointed at the bottom, which is the half that makes the field mean anything', () => {
    /*
      The pair. Both keywords compile to a `library-top` question with the same candidates and the
      same bounds; the **only** difference is the destination, so a test that checked one without
      the other would pass a reading that sent every scry to the graveyard.
    */
    const scried = spell('Scry 2.');
    expect(unreadLines(scried)).toEqual([]);
    const spec = question(scried);
    expect(spec['from']).toBe('library-top');
    expect(spec['look']).toBe(2);
    expect(spec['chosenGoTo']).toBeUndefined();
  });

  it('reads the keyword off a trigger and off an activated ability, not only off a spell', () => {
    // The 120 cards are spread across these prologues, so the clause has to work wherever the
    // clause vocabulary is consulted. Both of these are printed shapes (Barrier of Bones, Coastal
    // Bulwark).
    const onEnter = compileCard({
      name: 'Probe Wall', type_line: 'Creature — Skeleton Wall', mana_cost: '{B}', cmc: 1,
      colors: ['B'], power: '0', toughness: '3', layout: 'normal',
      oracle_text: 'Defender\nWhen Probe Wall enters, surveil 1.',
    } as never);
    expect(unreadLines(onEnter)).toEqual([]);
    const activated = compileCard({
      name: 'Probe Bulwark', type_line: 'Artifact', mana_cost: '{2}', cmc: 2, colors: [],
      layout: 'normal', oracle_text: '{2}, {T}: Surveil 1.',
    } as never);
    expect(unreadLines(activated)).toEqual([]);
  });

  it.each([
    // A count outside what any card prints is a corrupt row rather than a card, and reading it
    // would put a question on screen with forty cards in it.
    ['nought', 'Surveil 0.'],
    ['an absurd count', 'Surveil 40.'],
    // And the keyword with anything else on the same clause: "surveil 2, then draw two cards" is
    // read as a composition by `clausesOf`, but a clause this reader does not recognise whole
    // stays unread rather than having its first two words taken.
    ['a clause that is not just the keyword', 'Surveil for the empire.'],
  ])('refuses %s', (_label, text) => {
    expect(unreadLines(spell(text as string))).toEqual([text]);
  });
});

describe('a counter on each permanent a printed scope names (D453)', () => {
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  /*
    The scope is read on a **creature** rather than on an instant, because that is where the corpus
    prints it: of the 51 one-line-short legal cards whose only unread line is a counter-on-each
    clause, every one of the twenty this increment reads is a permanent, and most hang the clause
    off an enters trigger. A probe card is used rather than a real one for the same reason the rest
    of this file does: the reading under test is the phrase, and a real card would also drag in
    whatever else it prints.
  */
  const probe = (text: string) => compileCard({
    name: 'Probe Beast', type_line: 'Creature — Beast', mana_cost: '{3}{G}', cmc: 4, colors: ['G'],
    power: '3', toughness: '3', layout: 'normal',
    oracle_text: `When Probe Beast enters, ${text}`,
  } as never);

  it.each([
    /*
      Every scope form this reads, one row each — and the list is the grammar: an optional `other`,
      one or two type words, an optional controller clause. The example beside each is the printed
      card the form was taken from, which is what keeps this list a reading of Magic rather than of
      a regex.
    */
    ['the whole team', 'put a +1/+1 counter on each creature you control.'],
    // Katara, Heroic Healer and five others: the commonest form in the corpus.
    ['the team except this one', 'put a +1/+1 counter on each other creature you control.'],
    // Acid-Spewer Dragon: a capitalised word is a subtype (CR 205.3).
    ['a subtype', 'put a +1/+1 counter on each other Dragon creature you control.'],
    // Biogenic Ooze: the subtype with no "creature" after it.
    ['a subtype with no noun', 'put a +1/+1 counter on each Ooze you control.'],
    // Arcbound Shikari: a lowercase word is a card type.
    ['a card type', 'put a +1/+1 counter on each other artifact creature you control.'],
    // The two white legendary-matters cards print this; `legendary` is a supertype (CR 205.4a).
    ['a supertype', 'put a +1/+1 counter on each legendary creature you control.'],
    // Aku Djinn, and the other two spellings of the same set of permanents.
    ['the other side of the table', 'put a +1/+1 counter on each creature each opponent controls.'],
    ['their creatures, said the second way', 'put a -1/-1 counter on each creature your opponents control.'],
    ['their creatures, said the third way', 'put a -1/-1 counter on each creature you don’t control.'],
    // Harbinger of Night: no controller clause at all, which is every creature on the battlefield.
    ['every creature in the game', 'put a -1/-1 counter on each creature.'],
  ])('reads %s', (_label, text) => {
    const compiled = probe(text as string);
    expect(compiled.ok).toBe(true);
    expect(unreadLines(compiled)).toEqual([]);
    /*
      And asks nothing and points at nothing. A scope is not a target (CR 115.1), so a reading that
      came out with a `targets` list would put a prompt on screen for a card that prints none — and
      would make the trigger wait for an answer the player cannot give.
    */
    const script = compiled.ok ? (compiled.script as Record<string, unknown> | undefined) : undefined;
    const trigger = ((script?.['triggers'] ?? []) as readonly Record<string, unknown>[])[0];
    expect(trigger?.['targets']).toBeUndefined();
    expect(trigger?.['decisions']).toBeUndefined();
  });

  it.each([
    /*
      The refusals, and they are the reason this reader is worth trusting. Each of these prints a
      scope **narrower or wider** than the three parts above can express, so a reading would put
      counters on a set of creatures the card does not name — a board a player cannot argue with,
      which D362 says is worse than the badge an unread line gets.
    */
    // Patron of the Valiant: a condition after the noun.
    ['a condition on the permanents', 'put a +1/+1 counter on each creature you control with a +1/+1 counter on it.'],
    // Arcbound Overseer: a condition before it, which is the same problem from the other side.
    ['a keyword condition', 'put a +1/+1 counter on each creature with modular you control.'],
    // Blech, Loafing Pest: five subtypes in a list.
    ['a list of subtypes', 'put a +1/+1 counter on each Pest, Bat, Insect, Snake, and Spider you control.'],
    // Venerated Loxodon: a fact about how the spell was cast, not about the board.
    ['a fact about the cast', 'put a +1/+1 counter on each creature that convoked it.'],
    // Choking Fumes: a combat scope, which this reader has no vocabulary for yet.
    ['an attacking scope', 'put a -1/-1 counter on each attacking creature.'],
    // Charmed Stray: a name, and a name needs a card database to resolve.
    ['a named scope', 'put a +1/+1 counter on each other creature you control named Charmed Stray.'],
    /*
      **The support/bolster shape was here and is read now (D485).** Its row said this clause "is a
      targeted clause and belongs to a different reader", and that reader arrived: the counter
      clause asks `targetSpecFrom`, which parses "each of up to two target creatures" into one spec
      with a count of two. So the line reads, this row would fail, and it is deleted rather than
      kept — which is what the stale-row rule above is for. The mapping lives in "the counter
      clause, read off the printed phrase".
    */
    /*
      **The rest of the printed three-word-and-longer shapes**, and this group is load-bearing
      rather than thorough.

      The first draft of `boardScope` bounded a scope at two type words, on the theory that a longer
      phrase was a shape it had not read. Breaking that bound changed nothing in 1,585 tests, so the
      bound was measured against the corpus rather than kept on the theory: of 294 printed
      counter-on-each clauses, **every** scope of three words or more is one of the shapes below,
      and each is refused by the word classification itself — `with`, `target`, `and/or`, `you`,
      `of` and `that's` are lowercase words that are not card types. The bound was a second rule
      saying what these rows say, and nothing could tell the two apart, so the rows are what is
      left. If a word-shape change ever lets one of these through, this is what fails.
    */
    ['a controller said as a target', 'put a +1/+1 counter on each creature target player controls.'],
    ['a union of two types', 'put a +1/+1 counter on each artifact creature and/or Vehicle you control.'],
    ['a keyword the creature has', 'put a +1/+1 counter on each creature you control with lifelink.'],
    ['a back-reference to earlier creatures', 'put a +1/+1 counter on each of those creatures.'],
    ['a colour', 'put a +1/+1 counter on each white creature you control.'],
    ['a second clause riding along', 'put a +1/+1 counter on each creature you control and gain 4 life.'],
  ])('refuses %s', (_label, text) => {
    expect(unreadLines(probe(text as string))).toEqual([`When Probe Beast enters, ${text as string}`]);
  });

  it('refuses a type no permanent can have, rather than a scope that matches nothing', () => {
    /*
      **This is the D449 guard in a second place, and the reason `PERMANENT_TYPES` is shorter than
      `SEARCHABLE_TYPES`.** "Each instant you control" is a well-formed phrase whose set is always
      empty on a battlefield, so a reader that classified `instant` as a card type would compile a
      card that resolves, puts no counters anywhere, and is flagged by nothing. That is the failure
      D362 is about: the badge on an unread line is a human looking at the card, and a silent
      nothing is not.

      No printed card says this — it is here because the lowercase allow-list is the only thing
      stopping it, and a list is exactly the kind of guard that gets widened by someone who does not
      know what it is for.
    */
    const text = 'put a +1/+1 counter on each instant you control.';
    expect(unreadLines(probe(text))).toEqual([`When Probe Beast enters, ${text}`]);
  });

  it('refuses a word that is not a word, rather than a scope that matches nothing', () => {
    /*
      The punctuation guard, and the reason it exists rather than the word count.

      A printed list arrives with its punctuation attached — "Pest, Bat, Insect, Snake, and Spider"
      splits into `Pest,` with the comma still on it — and a capitalised word is classified as a
      subtype. So `Pest,` would become `hasSubtype(line, 'pest,')`, which is false for every
      permanent ever printed: the scope would be empty on every board, on a card that otherwise
      resolves. `and` is what saves the one card that prints that list, which is luck rather than a
      guard, so the word shape is checked.

      Blech, Loafing Pest is the printed card; this row is the same list with the "and" taken out,
      which no card prints — it is here because the guard has no printed counter-example and a
      guard nobody can test gets removed by someone who does not know what it is for.
    */
    const text = 'put a +1/+1 counter on each Pest, Bat you control.';
    expect(unreadLines(probe(text))).toEqual([`When Probe Beast enters, ${text}`]);
  });

  it('refuses a counter key the engine does not read as size', () => {
    /*
      `+1/+1` and `-1/-1` are the two keys the state-based actions pair off (CR 704.5q, D269) and
      the two `characteristicsOf` adds to a creature's size. A "+2/+2 counter" is a real printed
      thing on a handful of cards and would compile to counters that sit on the creature doing
      nothing at all — so the clause refuses the key rather than the scope, and the line keeps its
      badge.
    */
    const text = 'put a +2/+2 counter on each creature you control.';
    expect(unreadLines(probe(text))).toEqual([`When Probe Beast enters, ${text}`]);
  });
});

describe('the shrink, which is the pump with one character changed (D454)', () => {
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const spell = (text: string) => compileCard({
    name: 'Probe Bolt', type_line: 'Instant', mana_cost: '{B}', cmc: 1, colors: ['B'],
    layout: 'normal', oracle_text: text,
  } as never);
  const target = (c: ReturnType<typeof compileCard>) =>
    ((((c.ok ? c.script : undefined) as Record<string, unknown> | undefined)?.['targets']
      ?? []) as readonly Record<string, unknown>[])[0];
  const flags = (c: ReturnType<typeof compileCard>) =>
    ((c.ok ? c.script : undefined) as Record<string, unknown> | undefined) ?? {};

  it.each([
    /*
      **265 legal cards print this clause** and none of them read until this increment, because the
      pattern demanded a `+`. It is the largest single clause family that was waiting on one
      character.
    */
    ['the common one', 'Target creature gets -2/-2 until end of turn.'],
    ['a one-point shrink', 'Target creature gets -1/-1 until end of turn.'],
    ['a big one', 'Target creature gets -5/-5 until end of turn.'],
    // Befuddle and the blue "shrink the power only" cycle. `sizeBonus` leaves the zero component
    // out of the bonus entirely rather than passing it as 0, which is its own rule and the reason
    // it exists: two bonuses that behave identically must not compare unequal.
    ['power only', 'Target creature gets -4/-0 until end of turn.'],
    ['toughness only', 'Target creature gets -0/-2 until end of turn.'],
  ])('reads %s', (_label, text) => {
    const compiled = spell(text as string);
    expect(unreadLines(compiled)).toEqual([]);
    /*
      It points at a creature and asks nothing. The size itself is proved where it can be seen —
      the runtime block in `scripts.test.ts` kills a 3/3 with Dark Deed's -4/-4 and leaves it at
      0/3 with Befuddle's -4/-0 — because a shrink until end of turn is a continuous effect that
      wears off (CR 611.2), not the -1/-1 counter D453's clause puts on.
    */
    expect(target(compiled)?.['kind']).toBe('creature');
    expect(flags(compiled)['decisions']).toBeUndefined();
  });

  it('points at the enemy, where the pump points at a friend', () => {
    /*
      **This is the increment.** The two sentences differ by one character and point in opposite
      directions, and `TargetSpec.friendly` is where that lands (D252): without the flag the bot's
      default is "the enemy and the enemy's creatures", which is exactly right for a shrink and
      exactly wrong for a pump. So the pair is asserted together — a reading that passed `friendly`
      for both would make every shrink in the corpus a card the bot points at its own board.
    */
    const shrink = spell('Target creature gets -2/-2 until end of turn.');
    expect(target(shrink)?.['friendly']).toBeUndefined();
    const pump = spell('Target creature gets +2/+2 until end of turn.');
    expect(target(pump)?.['friendly']).toBe(true);
  });

  it.each([
    // Both hostile spellings of the same set of creatures, which `targetSpecFrom` already read.
    ['an opponent controls', 'Target creature an opponent controls gets -2/-2 until end of turn.'],
    ['you don’t control', 'Target creature you don’t control gets -3/-3 until end of turn.'],
    // And the friendly phrase, which a printed shrink does use — a creature you control shrinking
    // is a cost, not a mistake.
    ['you control', 'Target creature you control gets -1/-1 until end of turn.'],
  ])('reads the phrase that says whose creature it is: %s', (_label, text) => {
    expect(unreadLines(spell(text as string))).toEqual([]);
  });

  it.each([
    /*
      **The mixed sign reads now, and the aim comes off the toughness** (D544). These three rows
      asserted a refusal, and the refusal's own reason was that the aim "cannot be read off the
      sentence": a +4/-4 is removal across the table and a trick on your own 1/1 depending on the
      rest of the card.

      That was right that the aim must be read rather than guessed and wrong that the sentence is
      silent. **Toughness is what kills a creature**, so a size that lowers it is a creature being
      killed and a size that raises it is one being saved — which sorts all ten printed mixed sizes
      correctly, Auger Spree's +4/-4 one way and Alpha Kavu's -1/+1 the other. Retargeted rather
      than deleted, with the old reason kept above so the change is legible (D516).
    */
    ['a pump with a shrunk toughness is hostile',
      'Target creature gets +4/-4 until end of turn.', undefined],
    ['a shrink with a pumped toughness is friendly',
      'Target creature gets -1/+1 until end of turn.', true],
    ['a mixed size may grant a keyword, which the corpus prints',
      'Target creature gets +1/-1 and gains haste until end of turn.', undefined],
    // And the two unmixed signs, so the rule is asserted across all four quadrants in one table.
    ['a pump is friendly', 'Target creature gets +2/+2 until end of turn.', true],
    ['a shrink is hostile', 'Target creature gets -2/-2 until end of turn.', undefined],
    /*
      Power decides when toughness does not move, which is the fourth case the rule needs and the
      one no printing of a *bare* target forced: +2/+0 is a creature being helped and -2/-0 is one
      being made harmless.
    */
    ['a power-only bonus is friendly', 'Target creature gets +2/+0 until end of turn.', true],
    ['a power-only penalty is hostile', 'Target creature gets -2/-0 until end of turn.', undefined],
  ])('reads %s', (_label, text, friendly) => {
    const read = spell(text as string);
    expect(unreadLines(read)).toEqual([]);
    expect(target(read)?.['friendly']).toBe(friendly);
  });

  it.each([
    /*
      A **grant on a true shrink**, which no printed card has: across the corpus the `and gains …`
      tail appears only on `+`/`+` and `+`/`-` sizes, so reading one would be inventing the only
      card it could apply to (D259). Scoped to the sign pair it was measured on — the mixed size
      above does print a grant and now reads one.
    */
    ['a shrink that grants a keyword', 'Target creature gets -2/-2 and gains menace until end of turn.'],
    // No duration at all, which would be a permanent effect rather than a trick.
    ['a shrink with no duration', 'Target creature gets -2/-2.'],
    // A type-restricted phrase `targetSpecFrom` cannot build (#341).
    ['a subtype phrase', 'Target Kavu creature gets -1/-1 until end of turn.'],
  ])('refuses %s', (_label, text) => {
    expect(unreadLines(spell(text as string))).toEqual([text]);
  });

  it('reads "another target creature", and the engine is what keeps the two apart', () => {
    /*
      This row asserted a refusal too, and its reason was "\"another\" means not the other target,
      and a script has one target list". The first half is right and the second does not follow:
      `permanentFilter`'s `another` excludes the **source**, which for a spell is never on the
      battlefield — but `checkTargets` carries one `seen` set across every spec of a resolution and
      refuses "the same target cannot be chosen twice". So the engine already forces Leeching Bite's
      two creatures apart, which is the same finding D542 recorded for Pit Fight.

      The clause reads; the *line* Consume Strength prints is still unread, because two targeting
      parts cannot share one `targets` list — `composeEffects`' rule, asserted in the second half
      here so the limit is recorded where someone will look for it.
    */
    const clause = spell('Another target creature gets -2/-2 until end of turn.');
    expect(unreadLines(clause)).toEqual([]);
    expect(target(clause)?.['friendly']).toBeUndefined();

    const pair = spell('Target creature gets +2/+2 until end of turn. Another target creature gets '
      + '-2/-2 until end of turn.');
    expect(unreadLines(pair).length).toBe(1);
  });

  it('wears off at end of turn, which on a shrink is what kills the creature', () => {
    /*
      `expiresAtEndOfTurn` is **Darkblast's** field, not a new judgement: the pool's one
      hand-written card of this shape sets it, with a comment saying that wearing off at end of
      turn is what kills the creature before the shrink expires. `compiled-vs-written` compares the
      whole reading against that card, so this row is the local half of a check that is also made
      against the pool.
    */
    const compiled = spell('Target creature gets -2/-2 until end of turn.');
    expect(flags(compiled)['expiresAtEndOfTurn']).toBe(true);
    // And `removesACreature` is not set: -1/-1 kills a Glistener Elf and is a wasted card on a
    // 5/5, which is the board rather than the spell. Darkblast sets no such flag either.
    expect(flags(compiled)['removesACreature']).toBeUndefined();
  });
});

describe('the library search as a product, widened (D455)', () => {
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const spell = (text: string) => compileCard({
    name: 'Probe Tutor', type_line: 'Sorcery', mana_cost: '{2}{B}', cmc: 3, colors: ['B'],
    layout: 'normal', oracle_text: text,
  } as never);
  const question = (c: ReturnType<typeof compileCard>) =>
    ((((c.ok ? c.script : undefined) as Record<string, unknown> | undefined)?.['decisions']
      ?? []) as readonly Record<string, unknown>[])[0];

  it.each([
    /*
      **416 legal cards were one unread line from finished and that line was a library search** —
      by far the largest family left. D449 read the singular form; the refusals it listed were a
      count, a set to apply the destination to, and a filter of more than one word. The corpus says
      those are not exotic: they are the normal way Magic prints this clause.
    */
    // The count, printed three ways. `up to two basic land cards` alone blocks 18 cards.
    ['one', 'Search your library for a basic land card, put it onto the battlefield tapped.', 1],
    ['up to two', 'Search your library for up to two basic land cards, put them onto the battlefield tapped.', 2],
    ['up to three', 'Search your library for up to three creature cards, put them into your graveyard.', 3],
    // "Any number of" is the Relentless Rats family. The max is clamped to the zone, so the number
    // only has to be bigger than a library.
    ['any number', 'Search your library for any number of cards named Probe Tutor, reveal them, put them into your hand.', 1000],
  ])('reads a count of %s on the question', (_label, text, max) => {
    const compiled = spell(text as string);
    expect(unreadLines(compiled)).toEqual([]);
    expect(question(compiled)?.['max']).toBe(max);
    /*
      And the minimum is nought whatever the count, which is not a simplification: a player may
      always fail to find (CR 701.19c). That is what makes a search a decision rather than a
      lookup, and it is what `searchYourLibrary` has always set.
    */
    expect(question(compiled)?.['min']).toBe(0);
  });

  it('shows the printed phrase in the prompt, plural and all', () => {
    // The prompt is what a player reads mid-question, so it says what the card says rather than the
    // singular this reader classified the filter from.
    const compiled = spell(
      'Search your library for up to two basic land cards, put them onto the battlefield tapped.',
    );
    expect(question(compiled)?.['prompt']).toBe('Search your library for up to two basic land cards');
  });

  it.each([
    /*
      The filter, as the grammar Magic prints: alternatives of conjunctions, with a leading `basic`
      distributing over the whole list. Each row is a printed family, with the card it was read
      from.
    */
    // Bloodstained Mire and the nine other fetchlands.
    ['two subtypes', 'a Swamp or Mountain card'],
    // The Panoramas.
    ['a basic of three subtypes', 'a basic Island, Swamp, or Mountain card'],
    // Aerial Surveyor and the basic-fetch cycle.
    ['a basic of one subtype', 'a basic Plains card'],
    // Mystical Tutor.
    ['two card types', 'an instant or sorcery card'],
    // The Seriema.
    ['a supertype and a type', 'a legendary creature card'],
    // Dragon's Approach.
    ['a subtype and a type', 'a Dragon creature card'],
    // Anchor to Reality.
    ['two subtypes of artifact', 'an Equipment or Vehicle card'],
  ])('reads %s', (_label, filterPhrase) => {
    const text = `Search your library for ${filterPhrase as string}, put it into your hand.`;
    expect(unreadLines(spell(text))).toEqual([]);
  });

  it.each([
    // Entomb, and the Buried Alive family.
    ['the graveyard', 'Search your library for a creature card, put that card into your graveyard.'],
    // Mana Severance.
    ['exile', 'Search your library for any number of land cards, exile them.'],
    // Academy Rector's spelling of the battlefield.
    ['the battlefield, said with "that card"', 'Search your library for an enchantment card, put that card onto the battlefield.'],
    // The newer template, which puts an "and" in front of the destination.
    ['a destination after "and"', 'Search your library for a creature card, reveal it, and put it into your hand.'],
    // The plural reveal, Armillary Sphere's spelling.
    ['a plural reveal', 'Search your library for up to two basic land cards, reveal them, put them into your hand.'],
  ])('reads %s', (_label, text) => {
    expect(unreadLines(spell(text as string))).toEqual([]);
  });

  it('reads the conditional shuffle newer cards print after the search', () => {
    /*
      "If you search your library this way, shuffle." — 31 cards print it, and it reads as the
      identity for the same reason the bare word does: `searchYourLibrary` shuffles when the search
      ends, so a reader that shuffled again would shuffle twice. The condition needs no reading
      either, because the only thing it guards is the shuffle that has already happened.
    */
    const text = 'Search your library for a creature card, reveal it, and put it into your hand.'
      + ' If you search your library this way, shuffle.';
    expect(unreadLines(spell(text))).toEqual([]);
  });

  it.each([
    /*
      What is still refused, and each of these is a shape rather than an oversight.
    */
    // X is chosen at cast time and "that many" points back at a count in an earlier clause.
    ['a count of X', 'Search your library for up to X basic land cards, put them onto the battlefield tapped.'],
    ['a count that points backwards', 'Search your library for up to that many land cards, put them onto the battlefield tapped.'],
    /*
      **Two rows retired here (D491)**, both of which this list called shapes rather than oversights,
      and both of which were:

      | row | printed phrase | why it was refused | why it reads now |
      | --- | --- | --- | --- |
      | `a mana value condition` | `a creature card with mana value 3 or less` | "a filter this module cannot build" | peeled off in a wrapper, read against `CardDef.cmc` |
      | `a category that is not a type` | `an artifact or permanent card` | the D449 `permanent` guard | `permanent` is the six permanent types (CR 110.1) |

      The first was the honest answer while nothing read a characteristic off a library card. The
      second was a correct refusal whose reason stopped applying when the word's *reading* changed
      rather than when the rule did. The assertions for both now live in this file's D491 block and
      in `scripts.test.ts`.
    */
    // Two zones.
    ['two zones', 'Search your library and/or graveyard for a creature card, reveal it, put it into your hand.'],
    // The top of the library, which `searchYourLibrary`'s own shuffle would undo.
    ['the top of the library', 'Search your library for a basic land card, reveal it, then shuffle and put that card on top.'],
    // Cultivate: one card to one place and the other to another.
    ['a split destination', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand.'],
    // Shefet Monitor: two filters rather than two words of one.
    ['two filters', 'Search your library for a basic land card or a Desert card, put it onto the battlefield tapped.'],
  ])('refuses %s', (_label, text) => {
    expect(unreadLines(spell(text as string))).toEqual([text]);
  });

  it('refuses a pronoun that disagrees with the count', () => {
    /*
      A guard on this reader rather than a rule about Magic: no printed card says "up to two cards …
      put **it** into your hand". So a disagreement means the quantity was parsed wrong — something
      was read as a count that was not one — and the honest answer is an unread line rather than a
      singular destination applied to a set, or a set's applied to one card.
    */
    const singular = 'Search your library for up to two basic land cards, put it onto the battlefield tapped.';
    expect(unreadLines(spell(singular))).toEqual([singular]);
    const plural = 'Search your library for a basic land card, put them onto the battlefield tapped.';
    expect(unreadLines(spell(plural))).toEqual([plural]);
  });

  it.each([
    /*
      Two rows that **no card prints**, and they are here because a break run said the guards they
      pin were otherwise untested. Both are the D362 failure in its quietest form: a reading that
      compiles, resolves, and offers the player nothing at all.

      `up to X` with a singular pronoun isolates the count guard from the agreement guard beside it
      — on the printed cards the two overlap, and a reader that took "X" as 1 would be refused by
      the plural "them" rather than by the number. Here nothing else refuses it, and taking X as one
      card would quietly cap a search the card lets the player size.

      `a Forest/Plains card` isolates the word-shape guard. Measured across the whole legal corpus,
      dropping that guard changes **nothing** — 136 distinct filters read either way, because the
      split already removes commas and the lowercase allow-list refuses the rest. What it still
      catches is a *capitalised* word that is not a word: `Forest/Plains` would be read as the
      subtype "forest/plains", which no card has, so the search would offer nothing on a card whose
      other lines work.
    */
    ['a count of X, with nothing else to refuse it',
      'Search your library for up to X cards, put it into your hand.'],
    ['a capitalised word that is not a word',
      'Search your library for a Forest/Plains card, put it into your hand.'],
  ])('refuses %s', (_label, text) => {
    expect(unreadLines(spell(text as string))).toEqual([text]);
  });

  it('still reads the two cards the narrow readers were written for', () => {
    // The ground truth this widening must not disturb: both are in the pool, and
    // `compiled-vs-written` compares their compiled readings against their hand-written scripts.
    expect(fullyCompiled(compiledScript('Diabolic Tutor'))).toBe(true);
    expect(fullyCompiled(compiledScript('Rampant Growth'))).toBe(true);
  });
});

describe('an Aura attaches even when its statics do not read (D456)', () => {
  const unreadLines = (c: ReturnType<typeof compileCard>) =>
    (c.ok ? c.unread : []).map((u) => u.line);
  const aura = (text: string, typeLine = 'Enchantment — Aura') => compileCard({
    name: 'Probe Aura', type_line: typeLine, mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
    layout: 'normal', oracle_text: text,
  } as never);
  const attachment = (c: ReturnType<typeof compileCard>) =>
    (((c.ok ? c.script : undefined) as Record<string, unknown> | undefined)?.['aura']) as
      { target?: { kind?: string; description?: string }; effect?: Record<string, unknown> }
      | undefined;

  it.each([
    /*
      **738 of 1,240 legal Auras had no attachment of any kind** when this was measured: not
      castable, not attachable, nothing for a person to play by hand either. 356 of them named a
      phrase this reader did not know and 382 printed a static it could not read, which used to
      refuse the whole card.

      Each row below is a printed phrase with the count of legal Auras that print it.
    */
    ['a creature', 'Enchant creature', 'creature', 382],
    ['a land', 'Enchant land', 'permanent', 82],
    ['your own creature', 'Enchant creature you control', 'creature', 54],
    ['any permanent', 'Enchant permanent', 'permanent', 22],
    ['an artifact', 'Enchant artifact', 'permanent', 19],
    ['their creature', 'Enchant creature an opponent controls', 'creature', 5],
  ])('reads "enchant %s"', (_label, declaration, kind) => {
    const compiled = aura(`${declaration as string}\nWhen this Aura enters, you gain 2 life.`);
    const read = attachment(compiled);
    // The spec comes from `targetSpecFrom`, so the filters are the ones the rest of the file uses.
    expect(read?.target?.kind).toBe(kind);
    // And the description is the **printed** phrase, which is what a player reads in the prompt.
    expect(read?.target?.description).toBe((declaration as string).toLowerCase());
  });

  it('attaches with no bonus when the static line cannot be read, and flags the line', () => {
    /*
      The change, in one card. `Enchanted creature doesn't untap during its controller's untap step`
      is 48 legal Auras' only other line, and the reader used to answer `null` for the whole card
      because that line reached `attachmentBonus` and came back unread.

      Now the attachment ships with **no effect at all** — nothing is invented — and the line keeps
      its badge, which is the hybrid reading D362 gives every other card type.
    */
    const text = 'Enchant creature\nEnchanted creature doesn’t untap during its controller’s'
      + ' untap step.';
    const compiled = aura(text);
    expect(attachment(compiled)?.target?.description).toBe('enchant creature');
    expect(attachment(compiled)?.effect).toEqual({});
    /*
      And `friendly` is **omitted**, not guessed. With no bonus read there is no signal about which
      side of the table the Aura is for — this one is removal and Bequeathal's trigger wants your
      own creature — so the bot is left to read the board instead of a wrong hint (D252).
    */
    expect((attachment(compiled)?.target as { friendly?: boolean } | undefined)?.friendly)
      .toBeUndefined();
    expect(unreadLines(compiled))
      .toEqual(['Enchanted creature doesn’t untap during its controller’s untap step.']);
  });

  it('still reads the bonus when it can, and claims the line', () => {
    // The control: nothing about the hybrid path changes a card whose bonus does read.
    const compiled = aura('Enchant creature\nEnchanted creature gets +2/+2.');
    expect(attachment(compiled)?.effect).toEqual({ power: 2, toughness: 2 });
    expect(attachment(compiled)?.target).toMatchObject({ friendly: true });
    expect(unreadLines(compiled)).toEqual([]);
  });

  it('reads a declaration whose printing carries reminder text', () => {
    /*
      **And the stripping is not this reader's, which a break run established.** The declaration
      pattern used to end with an optional parenthetical; breaking that group changed nothing,
      because `printedRulesLines` removes reminder text from every line before any reader sees it
      (CR 207.2). So the group is gone and this row covers the pipeline rather than a second copy of
      it — if the upstream stripping is ever dropped, this is what fails.
    */
    const compiled = aura('Enchant creature (Target a creature as you cast this. This card enters'
      + ' attached to that creature.)\nEnchanted creature gets +1/+1.');
    expect(attachment(compiled)?.target?.description).toBe('enchant creature');
    expect(unreadLines(compiled)).toEqual([]);
  });

  it('refuses "enchant player", although the target phrase itself reads', () => {
    /*
      **The deliberate refusal, and the reason it is not an oversight.** `targetSpecFrom` can build
      `target player`, so without this the 42 legal Auras printing `Enchant player` would compile.

      The engine attaches an Aura by writing `attachedTo` with the id of a **card** — the resolution
      looks for `targets.find((t) => t.kind === 'card')` — so an Aura pointed at a seat would
      resolve, find no card among its targets, and sit on the battlefield attached to nothing. That
      is the "works and does nothing" shape this reader exists to avoid, and it is worse than the
      badge because nothing at the table would say so.
    */
    const text = 'Enchant player\nAt the beginning of the upkeep of enchanted player, that player'
      + ' loses 1 life.';
    const compiled = aura(text);
    expect(attachment(compiled)).toBeUndefined();
    expect(unreadLines(compiled)).toContain('Enchant player');
  });

  it.each([
    // Refused by `targetSpecFrom`, which has no spec for any of them. Each is a real printed
    // phrase, with the count of legal Auras that print it.
    ['a planeswalker', 'Enchant planeswalker'],                 // 5
    ['two types at once', 'Enchant artifact or creature'],      // 22
    ['a type and a subtype', 'Enchant creature or Vehicle'],    // 10
    ['a controller on a land', 'Enchant land you control'],     // 7
    ['a colour', 'Enchant red or green creature'],              // 3
  ])('refuses "enchant %s"', (_label, declaration) => {
    const compiled = aura(`${declaration as string}\nWhen this Aura enters, you gain 2 life.`);
    expect(attachment(compiled)).toBeUndefined();
    expect(unreadLines(compiled)).toContain(declaration as string);
  });

  it('still refuses an Aura whose whole card is the declaration', () => {
    /*
      The invariant D364 and D437 both kept, and D456 does not touch: a declaration on its own is an
      Aura you can cast, that attaches, and that does nothing — and *nothing* is flagged, because
      the only line it has was read. That is the one case where the badge cannot do its job, so the
      card stays unread and a human plays it.
    */
    const compiled = aura('Enchant creature');
    expect(attachment(compiled)).toBeUndefined();
    expect(unreadLines(compiled)).toEqual(['Enchant creature']);
  });
});

describe('the compilation cache (D459)', () => {
  /*
    `compileCard` memoises on the row, and the reason it is worth testing at all is the one way a
    cache here could be wrong rather than slow: handing a caller somebody else's card.

    99 cards cost 14.65 ms to compile and 1.04 ms when they are already compiled, which is what
    makes reading a pasted deck out of the card table affordable — `apps/realtime` rebuilds a seat's
    deck on every action and every seat's summary on every snapshot. So the cache is not an
    optimisation looking for a problem; it is the thing that lets the wiring happen at all.
  */
  const rowFor = (name: string, oracleText: string): CardDataRow => ({
    name,
    type_line: 'Creature — Human Soldier',
    oracle_text: oracleText,
    mana_cost: '{1}{W}',
    cmc: 2,
    colors: ['W'],
    power: '2',
    toughness: '2',
    layout: 'normal',
  });

  it('returns the same compilation for the same row', () => {
    // Object identity, which is the only assertion that can tell a cache that is working from one
    // that is not: two equal-but-separate compilations would pass any assertion about contents.
    const row = rowFor('Cache Probe', 'Flying');
    expect(compileCard(row)).toBe(compileCard({ ...row }));
  });

  it('does not give two cards with the same name the same rules', () => {
    /*
      The failure a name-keyed cache would cause, and it would be invisible: the compilation handed
      back is internally consistent and reads perfectly well — it is simply a different card. Two
      rows can share a name legitimately (a pool card and its corpus row, a corpus loaded from two
      sources, a fixture built to probe one clause), so the key is the whole row.
    */
    const flier = compileCard(rowFor('Same Name', 'Flying'));
    const trampler = compileCard(rowFor('Same Name', 'Trample'));
    expect(flier).not.toBe(trampler);
    // The card's own text, which is what a name-keyed cache would hand to the second caller: a 2/2
    // that flies where the list asked for a 2/2 that tramples, with nothing anywhere saying so.
    expect(flier.ok && flier.def.oracleText).toBe('Flying');
    expect(trampler.ok && trampler.def.oracleText).toBe('Trample');
    expect(flier.ok && flier.compiled).toEqual(['Flying']);
    expect(trampler.ok && trampler.compiled).toEqual(['Trample']);
  });

  it('tells apart two rows that differ only in a field the key must cover', () => {
    // Size is the field most likely to be left out of a hand-written key, and the one whose being
    // wrong is worst: a creature with the wrong toughness dies to the wrong amount of damage.
    const small = compileCard(rowFor('Sized Probe', 'Flying'));
    const big = compileCard({ ...rowFor('Sized Probe', 'Flying'), power: '5', toughness: '5' });
    expect(small).not.toBe(big);
    expect(small.ok && small.def.toughness).toBe('2');
    expect(big.ok && big.def.toughness).toBe('5');
  });

  it('compiles a row that cannot be serialised rather than throwing', () => {
    /*
      A cycle cannot arrive from Postgres or from a corpus file, but it can arrive from a test or a
      fixture builder — and a cache layer that throws where the compiler would have answered is a
      cache that has changed the compiler's contract. So the key is skipped and the card compiled.
    */
    const row = rowFor('Cyclic Probe', 'Flying') as CardDataRow & { self?: unknown };
    (row as { self?: unknown }).self = row;
    const compiled = compileCard(row);
    expect(compiled.ok).toBe(true);
    expect(compiled.ok && compiled.def.name).toBe('Cyclic Probe');
  });
});

/*
  The block prologue, as printed text (D480).

  Three spellings, two events, and the eight refusals that say where the parse stops. The runtime
  tests in `scripts.test.ts` drive the damage, the two pumps and the counter through a real combat;
  these rows say which sentence becomes which pair of triggers, and which sentences do not.
*/
describe('the block trigger, read off the prologue', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const creature = (text: string) => compileCard({
    name: 'Blocking Thing', type_line: 'Creature — Beast', mana_cost: '{2}{G}', cmc: 3,
    colors: ['G'], layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it.each([
    ['Whenever Blocking Thing blocks a creature', [{ kind: 'blocks' }]],
    ['Whenever Blocking Thing becomes blocked by a creature', [{ kind: 'becomes-blocked' }]],
    // One line, both events — which is the shape most of the family prints.
    ['Whenever Blocking Thing blocks or becomes blocked by a creature',
      [{ kind: 'blocks' }, { kind: 'becomes-blocked' }]],
    // "This creature" is the same subject under another name, which `selfRef` already folds in.
    ['Whenever this creature blocks a creature', [{ kind: 'blocks' }]],
  ])('%s becomes the triggers it prints', (prologue, on) => {
    const read = creature(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers.map((t) => t.on)).toEqual(on);
  });

  it.each([
    /*
      The bare spellings were on this list until D482 built the batched events, and they are in the
      mapping table above now. What is still refused is a count the engine does not raise at all:
      "becomes blocked by two or more creatures" asks how many blocked, and neither event carries
      it.
    */
    ['Whenever Blocking Thing becomes blocked by two or more creatures',
      'a count of blockers, which no event carries'],
    // A filter on the other creature, which no field on either event asks.
    ['Whenever Blocking Thing blocks or becomes blocked by a non-Wall creature',
      'Thicket Basilisk’s filter on the other creature'],
    ['Whenever Blocking Thing becomes blocked by a green creature', 'a colour filter on the other'],
    ['Whenever Blocking Thing becomes blocked by two or more creatures',
      'a count of blockers, which is a different question again'],
    ['Whenever Blocking Thing blocks a Wall', 'a subtype in place of "a creature"'],
    ['Whenever Blocking Thing becomes blocked by a creature with flying',
      'a keyword filter on the other creature'],
  ])('leaves "%s" unread: %s', (prologue) => {
    const read = creature(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(field(read.script, 'triggers')).toBeUndefined();
  });

  it.each([
    /*
      And the clause side: "that creature" is read **only** under a block prologue. Under an `etb`
      or a `dies` prologue the same words mean the permanent that entered or died, which is a
      different creature and a different field — so the gate refuses rather than reading the wrong
      one (D475's rule, applied to a creature instead of a player).
    */
    ['Whenever a creature you control enters, Blocking Thing deals 1 damage to that creature'],
    ['Whenever a creature you control dies, put a -1/-1 counter on that creature'],
    ['Whenever Blocking Thing attacks, that creature gets +1/+1 until end of turn'],
  ])('leaves "%s" unread: the event does not carry the other creature', (line) => {
    const read = creature(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

/*
  "~ or another <thing> you control", as printed text (D483).

  Which subject becomes which pair of events, and the subject words the fields cannot express. The
  runtime tests in `scripts.test.ts` drive both arms through a game on printed Beregond of the Guard
  and Eidolon of Blossoms; these rows say what the parse accepts and what it leaves alone.
*/
describe('the "or another" prologue, read off the printed subject', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const permanent = (text: string) => compileCard({
    name: 'Watching Thing', type_line: 'Creature — Human Soldier', mana_cost: '{2}{W}', cmc: 3,
    colors: ['W'], layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it.each([
    // A tribe, which is the bulk of the family: Ally alone is 39 legal lines.
    ['Whenever Watching Thing or another Ally you control enters',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'permanent', ofSubtypes: ['Ally'] }]],
    // A tribe and the type it is a tribe of, which are two fields rather than a choice.
    ['Whenever Watching Thing or another Human creature you control enters',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'creature', ofSubtypes: ['Human'] }]],
    // A bare card type: constellation's own wording, 23 legal lines.
    ['Whenever Watching Thing or another enchantment you control enters',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'enchantment' }]],
    ['Whenever Watching Thing or another creature you control enters',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'creature' }]],
    ['Whenever Watching Thing or another artifact you control enters',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'artifact' }]],
    ['Whenever Watching Thing or another permanent you control enters',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'permanent' }]],
    // `nontoken`, on the "another" half only: the card printing the line is a card (D484).
    ['Whenever Watching Thing or another nontoken creature you control enters',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'creature', nontoken: true }]],
    ['Whenever Watching Thing or another nontoken Zombie you control dies',
      [{ kind: 'dies', who: 'self' },
        { kind: 'dies', who: 'another', of: 'you', what: 'permanent', nontoken: true,
          ofSubtypes: ['Zombie'] }]],
    // The death half, which takes the same subjects minus `land`.
    ['Whenever Watching Thing or another Goblin you control dies',
      [{ kind: 'dies', who: 'self' },
        { kind: 'dies', who: 'another', of: 'you', what: 'permanent', ofSubtypes: ['Goblin'] }]],
    ['Whenever Watching Thing or another creature you control dies',
      [{ kind: 'dies', who: 'self' },
        { kind: 'dies', who: 'another', of: 'you', what: 'creature' }]],
    // The long spelling of the entry, and `When` as well as `Whenever`.
    ['Whenever Watching Thing or another Spirit you control enters the battlefield',
      [{ kind: 'etb', who: 'self' },
        { kind: 'etb', who: 'another', of: 'you', what: 'permanent', ofSubtypes: ['Spirit'] }]],
    ['When Watching Thing or another Zombie you control dies',
      [{ kind: 'dies', who: 'self' },
        { kind: 'dies', who: 'another', of: 'you', what: 'permanent', ofSubtypes: ['Zombie'] }]],
  ])('%s becomes the pair it prints', (prologue, on) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    const triggers = field(read.script, 'triggers') as readonly TriggerDef[];
    expect(triggers.map((t) => t.on)).toEqual(on);
  });

  it.each([
    /*
      Every refusal here is a **filter** on the subject rather than a type, and each would compile
      into a trigger looser than the card — which is the wrong direction (D362). Together they are
      most of the family's 52-shape tail.
    */
    ['Whenever Watching Thing or another black creature you control enters',
      'a colour, which no board event asks about'],
    ['Whenever Watching Thing or another legendary creature you control enters',
      'a supertype'],
    ['Whenever Watching Thing or another snow permanent you control enters', 'the same, for snow'],
    ['Whenever Watching Thing or another historic permanent you control enters',
      'a defined class (CR 701.x) that is three things at once'],
    ['Whenever Watching Thing or another non-Human creature you control enters',
      'a negated subtype, which `ofSubtypes` cannot say'],
    ['Whenever Watching Thing or another creature or planeswalker you control dies',
      'two types in one subject'],
    ['Whenever Watching Thing or another land you control dies',
      'dies is defined for creatures (CR 700.4), so the land half exists on the entry only'],
    ['Whenever Watching Thing or another creature an opponent controls enters',
      "a board that is not yours: the parse reads `you control` and nothing else"],
  ])('leaves "%s" unread: %s', (prologue) => {
    const read = permanent(`${prologue}, you gain 1 life.`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(field(read.script, 'triggers')).toBeUndefined();
  });
});

/*
  The counter clause, as printed text (D485).

  Which printed phrase becomes which count, kind and target spec — and the phrases still refused.
  The runtime tests in `scripts.test.ts` drive three printed cards through a game; these rows say
  what the parse accepts.
*/
describe('the counter clause, read off the printed phrase', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const sorcery = (text: string) => compileCard({
    name: 'Counting Thing', type_line: 'Sorcery', mana_cost: '{1}{G}', cmc: 2,
    colors: ['G'], layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Put a +1/+1 counter on target creature.', 1],
    ['Put a +1/+1 counter on target creature you control.', 1],
    ['Put a +1/+1 counter on another target creature you control.', 1],
    ['Put a +1/+1 counter on up to one target creature.', 1],
    ['Put a +1/+1 counter on each of up to two target creatures.', 1],
    ['Put two +1/+1 counters on target creature.', 1],
    ['Put three -1/-1 counters on target creature.', 1],
    ['Put a -1/-1 counter on target creature you control.', 1],
    // The target parse reaches past creatures, and the counter clause comes with it.
    ['Put a +1/+1 counter on target creature with flying.', 1],
    ['Put two -1/-1 counters on target creature an opponent controls.', 1],
    /*
      And a **subtype** in the noun position, which was the row below until D486 taught the target
      parse to keep its phrase's printed capitalisation. Deeproot Elite is the card that failed this
      increment's own probe, so it is here as itself.
    */
    ['Put a +1/+1 counter on target Merfolk you control.', 1],
    ['Put two +1/+1 counters on target Goblin or Orc you control.', 1],
  ])('%s reads, and asks for its target', (text, targets) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    expect((field(read.script, 'targets') as readonly unknown[]).length).toBe(targets);
  });

  it.each([
    /*
      The counts and kinds the parse refuses, each because the number or the word comes from
      somewhere this clause cannot see (D362).
    */
    ['Put X +1/+1 counters on target creature.', 'X names a number from the cost'],
    ['Put that many +1/+1 counters on target creature.', '"that many" names an earlier count'],
    ['Put four +1/+1 counters on target creature.', 'a count past what the corpus prints'],
    ['Put a loyalty counter on target creature.', 'a counter kind with its own rules'],
    ['Put a +1/+1 counter on target Sagas you control.',
      'a plural subtype, which no rule separates from the singulars ending in s (D486)'],
    ['Put a +1/+1 counter on target non-Human creature.',
      'a negated subtype: the qualifier run has no list it is on'],
    ['Put a +1/+1 counter on enchanted creature.', 'the Aura host, which is a different question'],
  ])('leaves "%s" unread: %s', (text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

/*
  A **subtype in the noun position** of a target phrase, and the disjunction it is spelled with
  (D486).

  The table below is the whole family at once, which is the point of putting it in `targetSpecFrom`:
  the same noun position is read by destroy, exile, bounce, the damage family, the pump and the
  counter clause, so a card that says "destroy target Equipment" and one that says "put a +1/+1
  counter on target Merfolk you control" are one change. Each row is a printed line from the legal
  corpus, named in the comment beside it where the card is the reason the row exists.
*/
describe('a subtype in the target noun position (D486)', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const sorcery = (text: string) => compileCard({
    name: 'Pointing Thing', type_line: 'Sorcery', mana_cost: '{1}{B}', cmc: 2,
    colors: ['B'], layout: 'normal', oracle_text: text,
  });

  it.each([
    // Bare, one word: the shape 165 of the family's lines print.
    ['Destroy target Equipment.', 1],                          // Acid Web Spider
    ['Exile target Zombie.', 1],                               // Aim for the Head
    ['Destroy target Aura.', 1],
    ['Return target Ally you control to its owner\'s hand.', 1], // Ally Encampment
    ['Put a +1/+1 counter on another target Soldier you control.', 1], // Aeronaut Cavalry
    // A qualifier in front of a subtype noun, which the qualifier run reads as it always did.
    ['Destroy target attacking Goblin.', 1],                   // Boggart Prankster's shape
    ['Destroy target tapped Merfolk you control.', 1],
    // A land subtype, which is a subtype like any other.
    ['Destroy target Forest.', 1],                             // Arbor Elf's shape
    // The disjunction, 65 more lines: a card type beside a subtype, and subtypes among themselves.
    ['Destroy target creature or Vehicle.', 1],                // Daring Demolition
    ['Destroy target Island or Swamp an opponent controls.', 1], // Marshdrinker Giant
    ['Destroy target Djinn or Efreet.', 1],                    // King Suleiman
    ['Put a +1/+1 counter on target Bird, Cat, Dog, Goat, Ox, or Snake.', 1], // Animal Sanctuary
    ['Destroy target artifact or enchantment.', 1],
  ])('%s reads, and asks for one target', (text, targets) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    expect((field(read.script, 'targets') as readonly unknown[]).length).toBe(targets);
  });

  it.each([
    /*
      The refusals, each because the phrase says something this reader cannot check.

      The first is the one this increment got wrong first time and corrected: a capitalised word
      ending in `s` may be a plural (`Sagas`) or a singular subtype (`Plains`, `Fungus`), and the
      half that is a plural would read a line whose target can never be chosen — a card that is
      never castable and, unlike an unread line, is never flagged (D362, D449).
    */
    ['Destroy target Sagas.', 'a capitalised word ending in s: plural or subtype, unknowable here'],
    ['Destroy target Plains.', 'the same shape, and the cost of refusing it'],
    ['Destroy target non-Human creature.', 'a negated subtype, on none of the qualifier lists'],
    ['Destroy target tapped Goblin or Elf.', 'a qualifier inside a disjunction'],
    ['Destroy target Goblin or player.', 'a player is not a permanent, so the run is refused'],
    ['Destroy target Goblin and Elf.', 'a conjunction, which is not one target'],
  ])('leaves "%s" unread: %s', (text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  /*
    And the bot hint, which the disjunction nearly dropped. `targetedEffect`'s docblock argues that a
    compiled card that works and plays badly is worse than an unread line, and
    `compiled-vs-written.test.ts` proved it on Vraska's Contempt the moment this arm began to read:
    "exile target creature or planeswalker" has to be `kind: 'permanent'`, so the kind could no
    longer carry `removesACreature` and the printed phrase had to.
  */
  it.each([
    ['Destroy target creature or Vehicle.', true],
    ['Exile target creature or planeswalker.', true],
    ['Destroy target Equipment.', false],
    ['Destroy target artifact or enchantment.', false],
  ])('%s: removesACreature is %s', (text, wanted) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(field(read.script, 'removesACreature') === true).toBe(wanted);
  });
});

/*
  A spell's lines that are **not its resolution** (D487).

  `readResolution` is all-or-nothing by design, so every line `spellScriptFor` puts into the
  resolution can refuse the card — and `isKeywordDeclaration` exists because `Miracle {R}` was
  refusing Thunderous Wrath's perfectly readable damage clause. These are the same defect in three
  more families, and the three next to them that must keep refusing because dropping them would make
  the card better than printed.
*/
describe("a spell's non-resolution lines (D487)", () => {
  const spell = (text: string) => compileCard({
    name: 'Flinging Thing', type_line: 'Instant', mana_cost: '{1}{R}', cmc: 2,
    colors: ['R'], layout: 'normal', oracle_text: text,
  });
  const RESOLUTION = 'Flinging Thing deals 2 damage to any target.';

  it.each([
    // A cost modification: a way to cast the card, exactly like a keyword (64 lines).
    'This spell costs {3} less to cast if it targets a tapped creature.',
    'This spell costs {2} less to cast if it was bargained.',
    // A triggered ability, which on a spell functions somewhere other than resolution (36).
    'Whenever an opponent gains life, you may pay {R}. If you do, return Flinging Thing from your'
      + ' graveyard to your hand.',
    'When you cycle Flinging Thing, you may gain 2 life.',
    'When a spell or ability an opponent controls causes you to discard Flinging Thing, you gain'
      + ' 2 life.',
    // An activated ability, paid from the graveyard or a discard (6).
    '{2}{R}{R}{R}: Return Flinging Thing from your graveyard to your hand.',
    '{2}, Discard this card: Look at the top two cards of your library.',
  ])('reads the resolution beside "%s"', (other) => {
    const read = spell(`${RESOLUTION}\n${other}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The resolution compiled, and the other line is the one thing left for a human.
    expect(read.compiled).toContain(RESOLUTION);
    expect(read.unread.map((u) => u.line)).toEqual([other]);
  });

  it.each([
    /*
      And the three that keep refusing, because the safety property is not "this is not the
      resolution" — it is that the spell read **without** this line gives its controller no more
      than the printed card does.
    */
    ['Cast this spell only if you control two or more Vampires.',
      'a casting restriction: dropping it casts a card the rules forbid'],
    ['Cast this spell only during the declare attackers step.',
      'the same, on a timing restriction'],
    ['This spell costs {1} more to cast for each target beyond the first.',
      "Fireball's cost structure: dropping it makes the spell cheaper than printed"],
    ['When you cast this spell, any player may pay 5 life. If a player does, counter Flinging Thing.',
      "Dash Hopes' drawback, which no shape separates from Empyrial Storm's copy"],
  ])('still refuses the whole card beside "%s": %s', (other) => {
    const read = spell(`${RESOLUTION}\n${other}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Both lines unread: the spell is compiled whole or not at all.
    expect(read.unread.map((u) => u.line).sort()).toEqual([RESOLUTION, other].sort());
  });
});

/*
  "Prevent the next N damage that would be dealt to <somewhere> this turn" (D488).

  Ranked top of the clause queue by cards finished: 105 printed lines on 50 legal cards, in 27
  distinct destination forms — all 27 were listed before the reader was written. `preventDamage` is
  the primitive and has been here since #85, and `shieldFirstTarget` is the wrapper the two
  hand-written prevention cards already use, so this is a reader and not an engine change.
*/
describe('prevent the next N damage (D488)', () => {
  const field = (script: unknown, key: string) =>
    (script as Record<string, unknown> | undefined)?.[key];
  const wall = (text: string) => compileCard({
    name: 'Shielding Wall', type_line: 'Creature — Wall', mana_cost: '{2}{W}', cmc: 3,
    colors: ['W'], layout: 'normal', power: '0', toughness: '4', oracle_text: text,
  });

  it.each([
    // The dominant form, 61 printed lines (Alabaster Wall, Abuna Acolyte, Samite Healer).
    '{T}: Prevent the next 1 damage that would be dealt to any target this turn.',
    // 16 lines (Abuna's Chant, Wandering Mage).
    '{T}: Prevent the next 5 damage that would be dealt to target creature this turn.',
    // And the narrower target phrases, each a real printing.
    '{T}: Prevent the next 1 damage that would be dealt to target artifact creature this turn.',
    '{T}: Prevent the next 1 damage that would be dealt to target player or planeswalker this turn.',
    '{T}: Prevent the next 1 damage that would be dealt to target legendary creature this turn.',
    // The controller, 7 lines (Conservator). Not a side — see the reader's docblock.
    '{T}: Prevent the next 2 damage that would be dealt to you this turn.',
    // The source itself, 7 lines (Rock Hydra, Ethereal Champion, Opal-Eye, Rasputin Dreamweaver).
    '{T}: Prevent the next 1 damage that would be dealt to Shielding Wall this turn.',
  ])('reads "%s"', (text) => {
    const read = wall(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const abilities = field(read.script, 'abilities') as readonly Record<string, unknown>[];
    expect(abilities).toHaveLength(1);
    // The bot hint, on the ability: do not spend a shield on a board with nothing coming.
    expect(abilities[0]!['preventsDamage']).toBe(true);
  });

  it.each([
    /*
      X first, and it is the one refusal that is about where the number comes from rather than what
      the destination is. X is chosen as a spell is cast (CR 601.2b); on a trigger or an activated
      ability `c.x` is zero, so reading bare X here would give a card that works and prevents
      nothing, with nothing left unread for anybody to notice. `xSpellResolution`'s argument.
    */
    ['{T}: Prevent the next X damage that would be dealt to target creature this turn.',
      'X comes from a cost this clause cannot see'],
    // A scope is not a target: `preventDamage` pushes one effect per target (Kitsune Palliator).
    ['{T}: Prevent the next 1 damage that would be dealt to each creature and each player this turn.',
      'a scope, which would shield the first and silently drop the rest'],
    ['{T}: Prevent the next 1 damage that would be dealt to each creature you control this turn.',
      'the same, on your own board'],
    // The Aura host, which D469 says is a different question from a target phrase (Fylgja).
    ['{T}: Prevent the next 1 damage that would be dealt to enchanted creature this turn.',
      'the Aura host'],
    // Event-relative: it belongs to whatever raised the event (Guardian Angel).
    ['{T}: Prevent the next 1 damage that would be dealt to that permanent or player this turn.',
      '"that permanent or player" names something an event carried'],
    /*
      And one this increment got wrong first time. I wrote this row as a *mapping* row on the
      argument that D486 reads a disjunction in the noun position — but Wandering Mage's phrase is a
      disjunction whose parts **share a trailing noun**, and D486 splits on `or` and then requires
      each part to be a single word, so "Wizard creature" refuses the run. The capability I claimed
      is not the capability that shipped. One printed line; recorded as the shape to read next
      rather than widened here, because a shared trailing noun changes what the parts mean.
    */
    ['{T}: Prevent the next 1 damage that would be dealt to target Cleric or Wizard creature this turn.',
      'a disjunction sharing a trailing noun, which D486 does not read'],
  ])('leaves "%s" unread: %s', (text) => {
    const read = wall(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

/*
  "Counter target spell unless its controller pays {N}" (D489).

  Measured from the corpus: 81 unread "Counter target … unless …" sentences on 81 cards, and **50 of
  them are the bare shape** (Abstruse Interference). `counterUnlessPaid` is ward's mechanism from
  the other side of the table — `pendingPayment` was built for a question asked of somebody who is
  not resolving anything — so this is a second raiser of an existing field, not a new pause.
*/
describe('counter unless its controller pays (D489)', () => {
  const instant = (text: string) => compileCard({
    name: 'Asking Thing', type_line: 'Instant', mana_cost: '{1}{U}', cmc: 2,
    colors: ['U'], layout: 'normal', oracle_text: text,
  });

  it.each([
    'Counter target spell unless its controller pays {1}.',
    'Counter target spell unless its controller pays {4}.',
    // A spell filter the target parse already reads.
    'Counter target noncreature spell unless its controller pays {2}.',
    'Counter target creature spell unless its controller pays {2}.',
    /*
      Two rows that **were refusals** in this table when D489 shipped, with a comment recording that
      a disjunction in the spell-kind position did not read in the plain "Counter target instant or
      sorcery spell" either. D490 taught that position to read, so the gap those rows described is
      closed and they belong here. The history is kept rather than the rows deleted, because the
      pair is the evidence that this arm never cared about the spell filter in front of it — it
      asks `targetSpecFrom` and checks the answer points at the stack.
    */
    'Counter target instant or sorcery spell unless its controller pays {1}.',
    'Counter target artifact or creature spell unless its controller pays {4}.',
  ])('reads "%s"', (text) => {
    const read = instant(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it.each([
    /*
      Every refusal here is about **where the number comes from**, which is the one thing a clause
      reader must not guess.
    */
    ['Counter target spell unless its controller pays {X}.',
      "Clash of Wills: X is the counterspell's own, chosen as it was cast"],
    ['Counter target spell unless its controller pays {1} for each card in your graveyard.',
      'a cost computed off the board (Circular Logic)'],
    ['Counter target spell unless its controller pays {1} for each creature you control.',
      'the same (Protect the Negotiators)'],
    ['Counter target spell unless its controller discards their hand.',
      "Perplex: a cost that is not mana, which `pendingPayment` cannot price"],
    ['Counter target spell unless its controller exiles all cards from their graveyard.',
      'Grip of Amnesia, the same'],
  ])('leaves "%s" unread: %s', (text) => {
    const read = instant(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('a kind of spell in the target noun position (D490)', () => {
  const instant = (text: string) => compileCard({
    name: 'Asking Thing', type_line: 'Instant', mana_cost: '{1}{U}', cmc: 2,
    colors: ['U'], layout: 'normal', oracle_text: text,
  });

  /*
    Each row is a printed phrase from a real corpus card, named in the comment. The assertion is on
    the spec's **description**, because that is the prompt a player reads and the string the
    ground-truth test compares against a hand-written twin: a phrase that reads to the right filter
    under the wrong description is still a bug.
  */
  it.each([
    // One word: a card type.
    ['Counter target artifact spell.', 'target artifact spell'],
    ['Counter target enchantment spell.', 'target enchantment spell'],
    ['Counter target instant spell.', 'target instant spell'],
    ['Counter target sorcery spell.', 'target sorcery spell'],
    // One word: a colour. Blue Elemental Blast and Deathgrip, which are the oldest of these.
    ['Counter target red spell.', 'target red spell'],
    ['Counter target green spell.', 'target green spell'],
    ['Counter target blue spell.', 'target blue spell'],
    ['Counter target black spell.', 'target black spell'],
    ['Counter target white spell.', 'target white spell'],
    // One word: how many colours, which is not a colour (CR 202.2).
    ['Counter target colorless spell.', 'target colorless spell'],
    ['Counter target multicolored spell.', 'target multicolored spell'],
    // A negation, over either half of the vocabulary.
    ['Counter target nonblue spell.', 'target nonblue spell'],
    ['Counter target nonartifact spell.', 'target nonartifact spell'],
    // A disjunction of card types, which is the commonest shape in the corpus.
    ['Counter target instant or sorcery spell.', 'target instant or sorcery spell'],
    ['Counter target artifact or creature spell.', 'target artifact or creature spell'],
    ['Counter target artifact or enchantment spell.', 'target artifact or enchantment spell'],
    ['Counter target creature or planeswalker spell.', 'target creature or planeswalker spell'],
    ['Counter target creature or sorcery spell.', 'target creature or sorcery spell'],
    // A disjunction of colours.
    ['Counter target red or green spell.', 'target red or green spell'],
    ['Counter target white or black spell.', 'target white or black spell'],
    // The one supertype printed in this position, on Icy Reception.
    ['Counter target creature or legendary spell.', 'target creature or legendary spell'],
    /*
      Guttural Response, which is the card that makes the grammar a disjunction of **conjunctions**
      rather than a flat list: it counters a spell that is both blue and an instant. Read as a flat
      disjunction it would counter every instant at the table, which is a strictly better card.
    */
    ['Counter target blue instant spell.', 'target blue instant spell'],
  ])('reads "%s" as "%s"', (text, description) => {
    const read = instant(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets?.map((t) => t.description)).toEqual([description]);
  });

  it.each([
    /*
      One unknown word refuses the whole phrase (D362: a wrong reading is worse than an unread
      line). Consign to Memory is the real card behind the first row — its phrase reaches across
      two kinds of stack object, and reading it as "target colorless spell" would print a card
      that cannot answer the triggered ability it was printed to answer.
    */
    ['Counter target triggered ability or colorless spell.',
      'Consign to Memory: "triggered ability" is not a spell kind, and the phrase spans two kinds'],
    ['Counter target cheap spell.', 'a word the engine cannot test'],
    ['Counter target historic spell.', 'a real Magic word, and not one of these'],
    /*
      The row the break run asked for. The three above are each a term of **one** unknown word, and
      the "a term with no readable word refuses the phrase" guard turns all three down on its own —
      so with the per-word refusal deleted they all still passed. A term that mixes a known word
      with an unknown one is the case that separates the two rules: without the per-word refusal
      this reads as "target blue spell", which counters every blue spell at the table instead of
      nothing.
    */
    ['Counter target blue historic spell.',
      'one unknown word refuses the phrase, not just the word'],
    ['Counter target Goblin spell.', 'a subtype, which a spell on the stack is not filtered by here'],
    /*
      `land` is left out of the vocabulary deliberately: a land is played, never cast (CR 305.1), so
      a phrase that read would match nothing on any stack and make the card silently uncastable —
      the failure #341 is open about. Refusing it keeps the rule stated.
    */
    ['Counter target land spell.', 'there is no such thing as a land spell'],
    /*
      **A row retired by D492**, kept here as a note rather than deleted. D490 wrote it as "the
      clause family that is still open rather than closed by this increment", naming the
      mana-value restriction as the half that did not read while the colour disjunction did. D492
      peels that clause in `targetSpecFrom`, so the phrase reads whole and the row moved to D492's
      mapping table.

      It is worth a sentence because this is the fifth refusal row in five increments that a later
      increment turned into a reading, and the third I wrote myself. Writing the *reason* beside a
      refusal is what makes that visible: the row did not quietly become false, it failed in the
      gate and named which half had changed.
    */
  ])('leaves "%s" unread: %s', (text) => {
    const read = instant(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  /*
    The two phrases that stay in `targetSpecFrom`'s exact switch, asserted as *descriptions that
    read* rather than as the functions behind them — those are what `compiled-vs-written.test.ts`
    compares by identity against Essence Scatter and Negate. This parse would read both to the same
    answer through a different function, so the switch has to win, and these rows fail loudly if
    anything reorders it.
  */
  it.each([
    ['Counter target creature spell.', 'target creature spell'],
    ['Counter target noncreature spell.', 'target noncreature spell'],
  ])('keeps "%s" on the exact switch', (text, description) => {
    const read = instant(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.targets?.map((t) => t.description)).toEqual([description]);
  });
});

describe('a mana-value clause, and the word permanent, in a search filter (D491)', () => {
  const tutor = (text: string) => compileCard({
    name: 'Asking Thing', type_line: 'Sorcery', mana_cost: '{2}{B}', cmc: 3,
    colors: ['B'], layout: 'normal', oracle_text: text,
  });

  const found = (text: string) => {
    const read = tutor(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return undefined;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    /*
      A `DecisionSpecOf` may be a **function** of the state — that is how a question whose shape
      depends on the board is declared — and a search is not one. Narrowed rather than cast,
      because an `as` here would turn "this compiled to the wrong kind of decision" into a
      runtime `undefined` that the assertions below would read as a missing prompt. `typecheck:tests`
      (#246) is what found this, for the third increment running.
    */
    const spec = read.script?.decisions?.[0];
    expect(typeof spec).not.toBe('function');
    return typeof spec === 'function' ? undefined : spec;
  };

  /*
    The prompt is the assertion, because it is the whole printed phrase and a player reads it. A
    clause silently dropped would still produce a working search — of a wider pool than the card
    prints — so "it compiled" is not the property worth checking here.
  */
  it.each([
    // The two chains this increment is really about, 19 lines between them.
    'Search your library for a Rebel permanent card with mana value 3 or less, put it onto the battlefield, then shuffle',
    'Search your library for a Mercenary permanent card with mana value 2 or less, put it onto the battlefield, then shuffle',
    // The clause on a plain card type.
    'Search your library for an artifact card with mana value 1 or less, put it into your hand, then shuffle',
    'Search your library for a creature card with mana value 6 or greater, put it into your hand, then shuffle',
    'Search your library for an enchantment card with mana value 3 or less, put it onto the battlefield, then shuffle',
    // `permanent` with no clause, and with a supertype in front of it.
    'Search your library for a Dragon permanent card, reveal it, and put it into your hand',
    'Search your library for a legendary Spirit permanent card, put it onto the battlefield, then shuffle',
    'Search your library for a snow permanent card, put it into your hand, then shuffle',
    /*
      The phrase the wrapper exists for: "a card" is the one body that reads to `filter: null`, so
      an arm that applied the clause per-body would leave this one searching the whole library.
    */
    'Search your library for a card with mana value 6 or greater, put it into your hand, then shuffle',
  ])('reads "%s"', (text) => {
    const read = tutor(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('keeps the whole printed phrase, clause included, in the prompt', () => {
    const decision = found(
      'Search your library for a Rebel permanent card with mana value 3 or less, put it onto the battlefield, then shuffle',
    );
    expect(decision?.prompt).toBe(
      'Search your library for a Rebel permanent card with mana value 3 or less',
    );
  });

  it.each([
    /*
      Every refusal here is about **where the number comes from** — the same rule D489's
      unless-paid arm turned out to need, for the same reason: a bound this reader cannot compute
      must not be read as one it can.
    */
    ['{X}, {T}: Search your library for a Rebel permanent card with mana value X or less, put it onto the battlefield, then shuffle',
      "Lin Sivvi: X is chosen when the ability is activated"],
    ['Search your library for a legendary permanent card with mana value less than this creature\'s power, put it onto the battlefield, then shuffle',
      "Sisay, Weatherlight Captain: a bound that is a fact about the board"],
    ['Search your library for a creature card with mana value equal to the number of lands you control, put it into your hand, then shuffle',
      'a computed bound, and not even a comparison this reads'],
    ['Search your library for a creature card with mana value 3, put it into your hand, then shuffle',
      'Magic prints "or less" and "or greater" in this position and this reads neither alone'],
    /*
      And the vocabulary still missing, each a real printing, each left unread rather than read
      loosely. These are the next increment in this family, not oversights.
    */
    ['Search your library for a nonland permanent card with mana value 3 or less, put it onto the battlefield, then shuffle',
      'Guardian Sunmare: a `non` negation in a card filter'],
    ['Search your library for a colorless creature card with mana value 7 or greater, put it into your hand, then shuffle',
      'Conduit of Ruin: a colour word in a card filter'],
    ['Search your library for a nonlegendary green creature card with mana value 3 or less, put it onto the battlefield, then shuffle',
      'Woodland Bellower: both of the above at once'],
    ['Search your library for a permanent card with the same name as target nontoken creature, put it onto the battlefield, then shuffle',
      'Bifurcate: a filter that reads another object entirely'],
  ])('leaves "%s" unread: %s', (text) => {
    const read = tutor(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('did not widen the two searches that already read', () => {
    // Rampant Growth and Diabolic Tutor, whose prompts are pinned elsewhere too. A wrapper that
    // changed the no-clause path would show up here first.
    expect(found('Search your library for a basic land card, put it onto the battlefield tapped, then shuffle')?.prompt)
      .toBe('Search your library for a basic land card');
    expect(found('Search your library for a card, put it into your hand, then shuffle')?.prompt)
      .toBe('Search your library for a card');
  });
});

describe('a mana-value clause on a target phrase (D492)', () => {
  const instant = (text: string) => compileCard({
    name: 'Asking Thing', type_line: 'Instant', mana_cost: '{1}{B}', cmc: 2,
    colors: ['B'], layout: 'normal', oracle_text: text,
  });

  /*
    The description is the assertion, and it has to be the **whole** printed phrase: the clause is
    part of what a player reads before choosing, and a spec that quietly dropped it from the prompt
    while keeping it in the filter would offer a legal target list nobody could predict.
  */
  it.each([
    // A bare creature, both directions. Eliminate and Epic Downfall.
    ['Destroy target creature with mana value 3 or less.', 'target creature with mana value 3 or less'],
    ['Exile target creature with mana value 3 or greater.', 'target creature with mana value 3 or greater'],
    // The clause sits AFTER the controller clause, which is what forces the peel to run first.
    ['Exile target creature an opponent controls with mana value 3 or less.',
      'target creature an opponent controls with mana value 3 or less'],
    ['Exile target nonland permanent an opponent controls with mana value 2 or less.',
      'target nonland permanent an opponent controls with mana value 2 or less'],
    // A disjunction in the noun position (D486) with a clause on the end of it.
    ['Destroy target creature or planeswalker with mana value 3 or less.',
      'target creature or planeswalker with mana value 3 or less'],
    ['Destroy target artifact or enchantment with mana value 4 or less.',
      'target artifact or enchantment with mana value 4 or less'],
    // The switch phrases.
    ['Destroy target nonland permanent with mana value 3 or less.',
      'target nonland permanent with mana value 3 or less'],
    ['Exile target permanent with mana value 4 or greater.', 'target permanent with mana value 4 or greater'],
    ['Destroy target artifact with mana value 3 or less.', 'target artifact with mana value 3 or less'],
    // A spell on the stack: Disdainful Stroke, Minor Misstep, Thoughtbind.
    ['Counter target spell with mana value 4 or greater.', 'target spell with mana value 4 or greater'],
    ['Counter target spell with mana value 1 or less.', 'target spell with mana value 1 or less'],
    // And a spell whose KIND is read by D490, with this clause behind it.
    ['Counter target creature spell with mana value 4 or less.',
      'target creature spell with mana value 4 or less'],
    ['Counter target red or green spell with mana value 6 or less.',
      'target red or green spell with mana value 6 or less'],
  ])('reads "%s" as "%s"', (text, description) => {
    const read = instant(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets?.map((t) => t.description)).toEqual([description]);
  });

  /*
    Narrowed on `ok` once here rather than at each call site. `Compilation` is a union whose failing
    arm has no `script` at all, so `instant(text).script` does not typecheck — `typecheck:tests`
    (#246) caught that for the fourth increment running, and the plain `tsc -p tsconfig.json` is
    clean on it every time.
  */
  const scriptOf = (text: string) => {
    const read = instant(text);
    expect(read.ok).toBe(true);
    return read.ok ? read.script : undefined;
  };

  it('keeps the kind the phrase without the clause would have had', () => {
    /*
      The peel re-reads the inner phrase and keeps its `kind`, which is load-bearing twice over:
      `pointsAtTheStack` decides whether a counter arm may use the spec at all, and
      `mayRemoveACreature` reads the kind to set the bot hint. A peel that returned a bare
      `permanent` for everything would silently disarm both.
    */
    expect(scriptOf('Counter target spell with mana value 4 or greater.')?.targets?.[0]?.kind)
      .toBe('spell');
    expect(scriptOf('Destroy target creature with mana value 3 or less.')?.targets?.[0]?.kind)
      .toBe('creature');
    expect(scriptOf('Exile target permanent with mana value 4 or greater.')?.targets?.[0]?.kind)
      .toBe('permanent');
  });

  it('still sets the bot hint on a removal whose phrase carries a clause', () => {
    // `removesACreature` keeps a card from being cast with nothing to point at (#89). The clause
    // must not cost a card its hint, and the kind is what carries it through the peel.
    expect(scriptOf('Destroy target creature with mana value 3 or less.')?.removesACreature)
      .toBe(true);
    expect(scriptOf('Destroy target creature or planeswalker with mana value 3 or less.')?.removesACreature)
      .toBe(true);
  });

  it.each([
    /*
      Refused for where the **bound** comes from, which is the rule D489 and D491 both needed.
    */
    ['Destroy target creature with mana value X or less.', 'X is chosen as this is cast'],
    ['Destroy target creature with mana value equal to the number of lands you control.',
      'a bound that is a fact about the board'],
    ['Destroy target creature with mana value 3.',
      'Magic prints "or less" and "or greater" here, and this reads neither alone'],
    /*
      And refused for the **phrase** rather than the clause — each is a real printing whose inner
      phrase this compiler cannot read, so the clause has nothing to attach to. The rows are here
      to record that the peel refuses rather than inventing a spec for an unreadable noun.
    */
    ['Return target spell or permanent with mana value 1 or greater to its owner\'s hand.',
      'Divide by Zero: "spell or permanent" reaches across the stack and the battlefield'],
    ['Target player sacrifices a creature with mana value 3 or less.',
      'Exile into Darkness: the clause is on a sacrifice, not on a target'],
  ])('leaves "%s" unread: %s', (text) => {
    const read = instant(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('the three one-line combat statics (D495)', () => {
  /*
    `compileCard` is the right instrument for the **first** half of this reading even though the
    reading emits no script: `isPrintedAbilityLine` is what counts a line compiled-and-silent, so
    an empty `unread` on a card whose whole text is one of these lines is the compiler agreeing
    that the engine already knows the rule. The second half — that it actually does — is the
    `printedCombatStatics` block below and the runtime tests in `scripts.test.ts`.
  */
  const creature = (name: string, text: string) => compileCard({
    name, type_line: 'Creature — Human Soldier', mana_cost: '{2}', cmc: 2,
    colors: ['W'], layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it.each([
    // The three bare forms, each with the real card the corpus found them on.
    ['Aesthir Glider', "Aesthir Glider can't block."],
    ['Akoum Firebird', 'Akoum Firebird attacks each combat if able.'],
    ['Aether Figment', "Aether Figment can't be blocked."],
    // Two of them on one line, joined by "and". Changeling Outcast's printing.
    ['Changeling Outcast', "Changeling Outcast can't block and can't be blocked."],
    // "This creature", the 2024 retemplate's second reference. 9 cards print it.
    ['Cantor of the Refrain', "This creature can't block."],
    ['Cogwork Tracker', 'This creature attacks each combat if able.'],
    // A short name, on a card whose title has one: 9 of the 192 print only this.
    ['Bilbo, Luckwearer', "Bilbo can't be blocked."],
    ['Hulk, Brutal Brawler', 'Hulk attacks each combat if able.'],
    // The name matched case-insensitively, like every other reader in the engine.
    ['Aesthir Glider', "AESTHIR GLIDER can't block."],
    // Mixed with the other printed-ability readers on the same card, one line each.
    ['Aesthir Glider', "Flying\nAesthir Glider can't block."],
    ['Akoum Firebird', 'Flying, haste\nAkoum Firebird attacks each combat if able.'],
  ])('reads %s: "%s"', (name, text) => {
    const read = creature(name as string, text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it.each([
    /*
      Refused for the **subject**, which is the whole reason this reader runs on the line rather
      than on a comma-part. Each of these grants the restriction to somebody else, and handing it
      to the card printing it would be a card that cannot block because it says other creatures
      cannot — the exact mistake the whole-line rule exists to prevent (D362).
    */
    ['Enchanted creature', "Enchanted creature can't block."],
    ['Equipped creature', "Equipped creature can't be blocked."],
    ['Creatures', "Creatures can't block."],
    ['Goaded creatures', "Goaded creatures your opponents control can't block."],
    ['Blue creatures', "Blue creatures you control can't be blocked."],
    /*
      Refused for the **predicate**: the subject is right and the sentence is not one of the three.
      A pump welded onto the static, and a static behind a condition the engine would have to keep
      re-reading.

      **The exception clause was here and is read (D498).** The row said Baneslayer Angel's
      "~ can't be blocked except by creatures with flying" was refused for the predicate, which was
      true of D495's reader: an allow-list is not one of the three statics and `Characteristics` had
      no field for it. D498 gave it one, so this line now compiles — the restriction lands in
      `blockableOnlyBy` and `canBlock` enforces it. Its assertion lives in this file's D498 block,
      the seventh stale refusal row in this series.
    */
    ['a pump on the same line', "Aesthir Glider gets +2/+2 and can't block."],
    ['a condition', "As long as you control a Forest, Aesthir Glider can't block."],
    ['an ability word', "Wraith Form — Aesthir Glider can't be blocked."],
    /*
      And the fourth shape the corpus printed next to these three, refused because
      `Characteristics` has no field for it: 22 cards print "can block only creatures with flying"
      and the engine's `canBlock` has no way to express it. A separate increment, named here so the
      next reader of this file knows it was seen and left (D259, D362).
    */
    ['can block only creatures with flying', 'Ascending Aven can block only creatures with flying.'],
  ])('leaves a line unread: %s', (_why, text) => {
    const read = creature('Aesthir Glider', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it.each([
    ["Aesthir Glider can't block.", 'Aesthir Glider', { cantBlock: true, cantBeBlocked: false, mustAttack: false }],
    ["Aether Figment can't be blocked.", 'Aether Figment', { cantBlock: false, cantBeBlocked: true, mustAttack: false }],
    ['Akoum Firebird attacks each combat if able.', 'Akoum Firebird', { cantBlock: false, cantBeBlocked: false, mustAttack: true }],
    ["Changeling Outcast can't block and can't be blocked.", 'Changeling Outcast',
      { cantBlock: true, cantBeBlocked: true, mustAttack: false }],
    ["This creature can't block.", 'Cantor of the Refrain', { cantBlock: true, cantBeBlocked: false, mustAttack: false }],
    ["Bilbo can't be blocked.", 'Bilbo, Luckwearer', { cantBlock: false, cantBeBlocked: true, mustAttack: false }],
    // Nothing at all for a line that is somebody else's, read with the Aura's own name.
    ["Enchanted creature can't block.", 'Bloodshed Fever', { cantBlock: false, cantBeBlocked: false, mustAttack: false }],
    // And nothing for a card with no name to match against.
    ["Aesthir Glider can't block.", undefined, { cantBlock: false, cantBeBlocked: false, mustAttack: false }],
  ])('reads "%s" on %s as its flags', (text, name, flags) => {
    expect(printedCombatStatics(text as string, name as string | undefined)).toEqual(flags);
  });

  it('refuses the whole line, not the part it understood', () => {
    /*
      The half of the whole-line rule that matters (D487). "Aesthir Glider gets +2/+2 and can't
      block" has a readable clause in it, and reading only that clause would give the creature a
      restriction with none of the compensation printed beside it — strictly worse for the player
      than leaving the line to a human.
    */
    expect(printedCombatStatics("Aesthir Glider gets +2/+2 and can't block.", 'Aesthir Glider'))
      .toEqual({ cantBlock: false, cantBeBlocked: false, mustAttack: false });
  });
});

describe('tap target, and a self-pump that shrinks (D496)', () => {
  /*
    Two readers whose absence was the same thing: the sibling nobody wrote.

    `Untap target creature` read and `Tap target creature` did not, though `tap` is one primitive
    with its boolean either way round. And the self-subject pump demanded a `+` on both halves,
    which is **exactly** the oversight D252 found in the targeted pump — "265 legal cards print the
    second [sign] … unread because the pattern above it demanded a `+`" — one reader later.

    Neither was found by reading the code. A probe asked the compiler about the top shapes in
    D494's queue and printed which read, and the asymmetry was in the output:

        READ    {G}, {T}: Untap target creature.
        unread  {G}, {T}: Tap target creature.
        READ    {G}: Probe Beast gets +1/+1 until end of turn.
        unread  {G}: Probe Beast gets +1/-1 until end of turn.
  */
  const creature = (name: string, text: string, cost = '{1}{W}') => compileCard({
    name, type_line: 'Creature — Human Soldier', mana_cost: cost, cmc: 2,
    colors: ['W'], layout: 'normal', power: '1', toughness: '2', oracle_text: text,
  });

  it.each([
    // The tapper family, each a real printing. 26 legal cards print the first line exactly.
    ['Benalish Trapper', '{W}, {T}: Tap target creature.'],
    ['Ballynock Trapper', '{T}: Tap target creature.'],
    ['Akroan Mastiff', '{W}, {T}: Tap target creature.'],
    // Mana alone, no tap in the cost: the cost and the effect are read separately.
    ['Homarid Shaman', '{U}: Tap target green creature.'],
    // Not only creatures. Auriok Transfixer, Ali Baba, and Icy Manipulator's own three-way phrase.
    ['Auriok Transfixer', '{W}, {T}: Tap target artifact.'],
    ['Ali Baba', '{R}: Tap target Wall.'],
    ['Icy Manipulator', '{1}, {T}: Tap target artifact, creature, or land.'],
    // The self-pump with a negative half. Breathstealer and Darklit Gargoyle's printings.
    ['Breathstealer', '{B}: Breathstealer gets +1/-1 until end of turn.'],
    ['Darklit Gargoyle', '{B}: Darklit Gargoyle gets +2/-1 until end of turn.'],
    ['Cavern Crawler', '{R}: Cavern Crawler gets +1/-1 until end of turn.'],
    // Still reads the positive it always read, which is the half a sign change can break.
    ['Probe Beast', '{G}: Probe Beast gets +1/+1 until end of turn.'],
    // And the shapes the regex now admits that no legal card happens to print, read for the same
    // reason `sizeBonus` accepts them: the sign is data, not a second rule.
    ['Probe Beast', '{G}: Probe Beast gets -1/-1 until end of turn.'],
    ['Probe Beast', '{G}: Probe Beast gets +0/-1 until end of turn.'],
    // "it", which this reader has always accepted beside the name.
    ['Probe Beast', '{G}: It gets +2/-2 until end of turn.'],
  ])('reads %s: "%s"', (name, text) => {
    const read = creature(name as string, text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities ?? []).toHaveLength(1);
  });

  it('carries the count on a counted tap, which I expected it to refuse', () => {
    /*
      **A refusal row I wrote and the test deleted.** I expected `Tap two target creatures` to be
      turned down, because the untap beside it needs a *separate* `untappedMany` reader to set
      `TargetSpec.count`, so I assumed the single-target path dropped the number. It does not:
      `TARGET_QUANTIFIER_PREFIX` carries "two" into `parsedTargetPhrase`, the count lands on the
      spec, and `foldCardTargets` folds the effect over every target the engine filled in. The
      untap's extra reader predates that and is now redundant for this.

      Asserted rather than deleted, because "it reads" was not the question — a count silently
      dropped would tap one creature out of two and look like a working card (D362). Nomad Decoy's
      printing is the real one.
    */
    const decoy = creature('Nomad Decoy', '{W}{W}, {T}: Tap two target creatures.', '{2}{W}');
    expect(decoy.ok).toBe(true);
    if (!decoy.ok) return;
    expect(decoy.unread.map((u) => u.line)).toEqual([]);
    expect(decoy.script?.abilities?.[0]?.targets?.[0]?.count).toBe(2);
  });

  it('aims a tap at the other side of the table, and an untap at its own', () => {
    /*
      The one thing that differs between the two readers, and the reason they are not one function
      with a flag. Untapping your own land is the point of a Kiora's Follower; tapping your own
      creature throws the card away. `TargetSpec.friendly` is where the bot reads that.
    */
    const tapper = creature('Benalish Trapper', '{W}, {T}: Tap target creature.');
    expect(tapper.ok).toBe(true);
    if (!tapper.ok) return;
    expect(tapper.script?.abilities?.[0]?.targets?.[0]?.friendly).not.toBe(true);

    const untapper = creature('Kiora Probe', '{W}, {T}: Untap target creature.');
    expect(untapper.ok).toBe(true);
    if (!untapper.ok) return;
    expect(untapper.script?.abilities?.[0]?.targets?.[0]?.friendly).toBe(true);
  });

  it('does not tell the bot a tap buys nothing', () => {
    /*
      `untapsOnly` exists because an untap can put the board back exactly as it was found, so the
      bot can tap and untap for ever (#124). A tap moves the board one way, so carrying the flag
      here would be wrong rather than redundant — it would mark a real play as a no-op.
    */
    const tapper = creature('Benalish Trapper', '{W}, {T}: Tap target creature.');
    expect(tapper.ok).toBe(true);
    if (!tapper.ok) return;
    expect(tapper.script?.abilities?.[0]?.untapsOnly).toBeUndefined();

    const untapper = creature('Kiora Probe', '{W}, {T}: Untap target creature.');
    expect(untapper.ok).toBe(true);
    if (!untapper.ok) return;
    expect(untapper.script?.abilities?.[0]?.untapsOnly).toBe(true);
  });

  it.each([
    /*
      Refused for the **phrase**, not the verb: each is a real printing whose noun this compiler
      cannot read yet, so the tap has nothing to point at. Rows rather than silence, because these
      are the next increment in this family and not oversights.
    */
    ['Avacynian Priest: `non` in front of a capitalised creature type',
      '{1}, {T}: Tap target non-Human creature.'],
    ['Blinkmoth Well: `noncreature artifact`', '{2}, {T}: Tap target noncreature artifact.'],
    /*
      Refused for the **sentence**. Amber Prison's tap carries a second clause that outlives the
      ability, and reading only the first half would be a card that does strictly less than it
      prints — the whole-line rule (D487).
    */
    ['Amber Prison: a second clause after the tap',
      "{4}, {T}: Tap target artifact, creature, or land. That permanent doesn't untap during its controller's untap step."],
    /*
      **The Basking Rootwalla row was here and is retired: D508 reads it.** It said "13 cards print
      'Activate only once each turn'", which was this family's own count rather than the queue's —
      re-measured for D508, **38 legal cards are one printed line away on nothing but that
      sentence**, and 519 carry some "Activate only …" clause. The reading is in
      `activationRestriction`, the engine half in `AbilityDef.onceEachTurn`, and the assertions that
      replace this row are in the D508 block below.

      Eighth stale refusal row in this series, and the pattern is now worth naming: a row that says
      "this is the next increment" becomes a lie the moment that increment ships, and the suite is
      where it is caught. That is the row doing its job, not a defect — but it is why each one names
      what would retire it.
    */
    // +0/+0 is still refused, which `sizeBonus` has always done: a pump that changes nothing.
    ['a pump of nothing', '{G}: Probe Beast gets +0/+0 until end of turn.'],
  ])('leaves a line unread: %s', (_why, text) => {
    const read = creature('Probe Beast', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('a mana ability that deals you damage (D497)', () => {
  /*
    **Three different rules wear almost the same words, and the pool already had two of them.**
    `scripts.ts`'s own comment draws the line: *City of Brass* **triggers**, so its damage uses the
    stack and can be responded to; *Mana Confluence* **costs** life, so a player on one life is
    never offered the mana at all (CR 118.4).

    A pain land is the third. `{T}: Add {W} or {U}. Adarkar Wastes deals 1 damage to you.` is one
    mana ability whose *effect* includes the damage: it resolves immediately without the stack
    (CR 605.3a), nobody gets a window, and a player on one life may tap it and die. 34 printed lines
    on 37 legal cards.
  */
  const land = (name: string, text: string) => compileCard({
    name, type_line: 'Land', mana_cost: '', cmc: 0, colors: [], layout: 'normal', oracle_text: text,
  });
  const abilitiesOf = (name: string, text: string) => {
    const read = land(name, text);
    expect(read.ok).toBe(true);
    expect(read.ok && read.unread.map((u) => u.line)).toEqual([]);
    return read.ok ? (read.script?.abilities ?? []) : [];
  };

  it('gives the damage to the colours that print it and to no others', () => {
    /*
      The reading that matters most, and the one the first version of this got wrong. Adarkar Wastes
      prints **two** lines — `{T}: Add {C}.` and `{T}: Add {W} or {U}. … 1 damage to you.` — and the
      damage belongs to the second. The fold used to flatten both into one cost, so whichever line
      came first decided for every colour: every pain land made its coloured mana for free, which is
      a card that plays better than it reads (D362).
    */
    const abilities = abilitiesOf(
      'Adarkar Wastes',
      '{T}: Add {C}.\n{T}: Add {W} or {U}. Adarkar Wastes deals 1 damage to you.',
    );
    expect(abilities.map((a) => a.description)).toEqual([
      '{T}: Add {C}.',
      '{T}: Add {W}. It deals 1 damage to you.',
      '{T}: Add {U}. It deals 1 damage to you.',
    ]);
    // The colourless one has no effect at all; the two coloured ones do.
    expect(abilities[0]?.effect).toBeUndefined();
    expect(abilities[1]?.effect).toBeDefined();
    expect(abilities[2]?.effect).toBeDefined();
  });

  it.each([
    // The six single-colour pain lands and the two-colour family, each a real printing.
    ['Caves of Koilos', '{T}: Add {C}.\n{T}: Add {W} or {B}. Caves of Koilos deals 1 damage to you.', 3],
    ['Llanowar Wastes', '{T}: Add {C}.\n{T}: Add {B} or {G}. Llanowar Wastes deals 1 damage to you.', 3],
    // A sum rather than a choice: Ancient Tomb taps for two and deals two.
    ['Ancient Tomb', '{T}: Add {C}{C}. Ancient Tomb deals 2 damage to you.', 1],
    // One colour only, and the short-name spelling a titled card would use.
    ['Probe Spring', '{T}: Add {R}. Probe Spring deals 1 damage to you.', 1],
    // "This land", the retemplated second reference.
    ['Probe Reef', '{T}: Add {U}. This land deals 1 damage to you.', 1],
  ])('reads %s', (name, text, count) => {
    const abilities = abilitiesOf(name as string, text as string);
    expect(abilities).toHaveLength(count as number);
    expect(abilities.some((a) => a.effect !== undefined)).toBe(true);
  });

  it('keeps the mana on a land whose other ability it cannot read', () => {
    /*
      **Found while writing the refusal rows below, and worse than what D497 set out to fix.**
      `cardFromData` only answers when it can read the *whole* card, so a pain land with a second
      ability falls through to `compile.ts`'s line-by-line path — and that path had no mana reader at
      all. The general activated-ability reader claimed the line, built an ability out of the damage
      clause and dropped the `Add {U}`: **the compiled Cephalid Coliseum tapped for nothing.**

      Eleven legal lands were in that state — Cephalid Coliseum, Barbarian Ring, Cabal Pit, Centaur
      Garden and the rest of the Odyssey threshold cycle — and it is strictly worse than an unread
      line, because the bot plays a land that produces no mana and then cannot use it. Two synthetic
      refusal rows that should have been turned down came back read, and following that answer to a
      real card is what found it.

      The break run insisted this test exist: removing the per-line mana reader left every other row
      in this block green, because they are all single-line cards that `cardFromData` reads whole.
    */
    const read = compileCard({
      name: 'Cephalid Coliseum', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
      layout: 'normal',
      oracle_text: '{T}: Add {U}. Cephalid Coliseum deals 1 damage to you.\n'
        + 'Threshold — {U}, {T}, Sacrifice Cephalid Coliseum: Target player draws three cards, then'
        + ' discards three cards. Activate only if there are seven or more cards in your graveyard.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The threshold ability is honestly unread; the mana line is read, and it makes mana.
    expect(read.unread).toHaveLength(1);
    expect(read.unread[0]?.line).toContain('Threshold');
    expect(read.script?.abilities ?? []).toHaveLength(1);
    expect(read.script?.abilities?.[0]?.produces).toEqual(['U']);
    expect(read.script?.abilities?.[0]?.effect).toBeDefined();
  });

  it.each([
    /*
      Refused for the **tail**, which is the half that keeps this reader honest. 30 more printed
      lines are this exact shape with a different second sentence, and none of them is damage: a
      restriction on what the mana may pay for, a land that stays tapped, a depletion counter, an
      activation condition. Reading any of them as nothing at all would be a land that does strictly
      more than it prints.
    */
    ['spend-only restriction', '{T}: Add {C}. Spend this mana only to cast a creature spell.'],
    ["doesn't untap", "{T}: Add {U} or {B}. Probe Land doesn't untap during your next untap step."],
    ['a depletion counter', '{T}: Add {W} or {U}. Put a depletion counter on Probe Land.'],
    ['an activation condition', '{T}: Add {R} or {G}. Activate only if you control a Swamp.'],
    // And for the **subject**: the damage has to be this land's own.
    ['somebody else deals it', '{T}: Add {R}. Shivan Dragon deals 1 damage to you.'],
    ['dealt to someone else', '{T}: Add {R}. Probe Land deals 1 damage to any target.'],
    // Zero is not damage worth modelling, and no card prints it.
    ['nought damage', '{T}: Add {R}. Probe Land deals 0 damage to you.'],
  ])('leaves a mana line unread: %s', (_why, text) => {
    const read = land('Probe Land', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('still reads the ordinary mana lines it always read', () => {
    // The half a change to this regex could break without any new row failing.
    expect(abilitiesOf('Probe Waste', '{T}: Add {C}.').map((a) => a.description))
      .toEqual(['{T}: Add {C}.']);
    expect(abilitiesOf('Probe Gate', '{T}: Add {W} or {U}.').map((a) => a.description))
      .toEqual(['{T}: Add {W}.', '{T}: Add {U}.']);
    expect(abilitiesOf('Probe Tower', '{T}: Add one mana of any color.')).toHaveLength(5);
    expect(abilitiesOf('Probe Ring', '{T}: Add {C}{C}.').map((a) => a.description))
      .toEqual(['{T}: Add {C}{C}.']);
    for (const a of abilitiesOf('Probe Gate', '{T}: Add {W} or {U}.')) {
      expect(a.effect).toBeUndefined();
    }
  });
});

describe('printed restrictions on who may block (D498)', () => {
  /*
    The fifth printed-characteristic reader, after keywords, landwalk, protection and D495's combat
    statics. **244 printed lines in 126 shapes** say something about who may block this creature;
    these two sentences are most of them:

        ~ can't be blocked by creatures with power 2 or less.      (31 lines)
        ~ can't be blocked except by creatures with flying.        (the allow-list half)

    A **ban** and an **allow** are not the same rule and do not share a list: a ban refuses a
    blocker matching any clause, an allow refuses one matching none. A card printing both is
    refused rather than merged — the merge rule would be a judgement nothing in the corpus asks
    for, and a guessed merge is a creature that blocks when it may not (D362).
  */
  const read = (text: string, name = 'Probe Beast') => printedBlockerLimit(text, name);

  it.each([
    // The power family, both directions. Amrou Kithkin and the 31-line "or less" half.
    ["Amrou Kithkin can't be blocked by creatures with power 3 or greater.", 'Amrou Kithkin',
      { ban: [{ kind: 'power', cmp: 'at-least', n: 3 }], only: null }],
    ["Probe Beast can't be blocked by creatures with power 2 or less.", 'Probe Beast',
      { ban: [{ kind: 'power', cmp: 'at-most', n: 2 }], only: null }],
    // A colour. Dauthi Horror's printing.
    ["Dauthi Horror can't be blocked by white creatures.", 'Dauthi Horror',
      { ban: [{ kind: 'colour', colour: 'W' }], only: null }],
    // A card type, a creature type, and a keyword.
    ["Probe Beast can't be blocked by artifact creatures.", 'Probe Beast',
      { ban: [{ kind: 'type', type: 'artifact' }], only: null }],
    ["Probe Beast can't be blocked by Walls.", 'Probe Beast',
      { ban: [{ kind: 'subtype', subtype: 'Wall' }], only: null }],
    ["Probe Beast can't be blocked by creatures with flying.", 'Probe Beast',
      { ban: [{ kind: 'keyword', keyword: 'flying' }], only: null }],
    // Two bans on one line, joined as cards print them.
    ["Probe Beast can't be blocked by artifact creatures and/or white creatures.", 'Probe Beast',
      { ban: [{ kind: 'type', type: 'artifact' }, { kind: 'colour', colour: 'W' }], only: null }],
    // The allow list.
    ["Probe Beast can't be blocked except by black creatures.", 'Probe Beast',
      { ban: [], only: [{ kind: 'colour', colour: 'B' }] }],
    ["Probe Beast can't be blocked except by creatures with flying or reach.", 'Probe Beast',
      { ban: [], only: [{ kind: 'keyword', keyword: 'flying' }, { kind: 'keyword', keyword: 'reach' }] }],
    /*
      D495 refused this exact line for its predicate and said so in a row of its own; this is the
      assertion that row now points at. Keeping the precise sentence, Aesthir Glider's name and all,
      so that the retirement is checkable rather than a claim in a comment.
    */
    ["Aesthir Glider can't be blocked except by creatures with flying.", 'Aesthir Glider',
      { ban: [], only: [{ kind: 'keyword', keyword: 'flying' }] }],
    // "This creature", the retemplated second reference; and the short name.
    ["This creature can't be blocked by creatures with power 2 or less.", 'Probe Beast',
      { ban: [{ kind: 'power', cmp: 'at-most', n: 2 }], only: null }],
    ["Bilbo can't be blocked by red creatures.", 'Bilbo, Luckwearer',
      { ban: [{ kind: 'colour', colour: 'R' }], only: null }],
  ])('reads "%s"', (text, name, expected) => {
    expect(read(text as string, name as string)).toEqual(expected);
  });

  it.each([
    /*
      **Counts are deliberately out**, and these are the two shapes that make the point. They are
      about how *many* creatures block rather than which — a fact about the whole declaration, not
      about one blocker — so they belong with `menaceSatisfied` and not here. 23 printed lines
      between them, named rather than silently dropped.
    */
    ['more than one creature', "Probe Beast can't be blocked by more than one creature."],
    ['three or more creatures', "Probe Beast can't be blocked except by three or more creatures."],
    /*
      Refused for the **filter**: a noun this reader has no clause for. "Creatures you control" is a
      fact about who controls them; shadow is a keyword this engine does not have, and a creature
      that ignored it would be blocked by things that cannot block it.
    */
    ['creatures you control', "Probe Beast can't be blocked by creatures you control."],
    /*
      **Shadow was this row's example and the engine has it now (D501).** The row read "a keyword the
      engine lacks" and named shadow, which was true until shadow became a `KEYWORDS` entry with its
      own rule. The point it was making is unchanged, so the row keeps it with a word the engine
      genuinely does not have: banding, which is the most tempting wrong read in the game, being a
      keyword about blocking. The eighth stale refusal row in this series.
    */
    ['a keyword the engine lacks', "Probe Beast can't be blocked by creatures with banding."],
    ['a subtype outside the list', "Probe Beast can't be blocked by Goblins."],
    /*
      And for the **subject**, which is the whole-line rule again: "Enchanted creature" is an Aura
      granting the restriction to its host, and handing it to the Aura would be the D495 mistake.
    */
    ['an Aura granting it', "Enchanted creature can't be blocked by white creatures."],
    ['Equipment granting it', "Equipped creature can't be blocked by red creatures."],
  ])('reads nothing from %s', (_why, text) => {
    expect(read(text as string)).toEqual({ ban: [], only: null });
  });

  it('refuses a card that prints both a ban and an allow list rather than merging them', () => {
    /*
      No card in 33,847 prints both, and the merge rule would be a judgement: does the ban narrow
      the allow list, or does either one alone let a blocker through? Refusing leaves the card to a
      human, which is the only honest answer to a question the printed text does not settle.
    */
    expect(read("Probe Beast can't be blocked by white creatures.\n"
      + "Probe Beast can't be blocked except by black creatures.")).toEqual({ ban: [], only: null });
  });

  it('counts the line compiled, and emits no script for it', () => {
    /*
      The same bargain as every other printed-characteristic line (D424): `characteristicsOf` reads
      it straight off the card definition, so restating it in a script would be a second source for
      one fact. What the compiler owes is to count it read.
    */
    const compiled = compileCard({
      name: 'Amrou Kithkin', type_line: 'Creature — Kithkin', mana_cost: '{1}{W}', cmc: 2,
      colors: ['W'], layout: 'normal', power: '1', toughness: '1',
      oracle_text: "Amrou Kithkin can't be blocked by creatures with power 3 or greater.",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.unread.map((u) => u.line)).toEqual([]);
    expect(compiled.script?.abilities ?? []).toEqual([]);
    expect(compiled.script?.triggers ?? []).toEqual([]);
  });

  it('is a base characteristic, so "loses all abilities" takes it away (CR 613.1f)', () => {
    // The reason it is seeded in `characteristicsOf` beside printed landwalk rather than layered
    // on top of `state.effects`. Same shape as D495's statics.
    const def = {
      name: 'Amrou Kithkin', typeLine: 'Creature — Kithkin', manaCost: '{1}{W}', cmc: 2,
      colors: ['W'], power: '1', toughness: '1',
      oracleText: "Amrou Kithkin can't be blocked by creatures with power 3 or greater.",
    } as unknown as CardDef;
    const state = {
      cardDefs: { k: def },
      instances: { i: { id: 'i', defKey: 'k', zone: 'battlefield', owner: 0, controller: 0, tapped: false, counters: {} } },
      effects: [],
      seats: [],
    } as unknown as GameState;
    const inst = state.instances['i']!;
    expect(characteristicsOf(state, inst).cantBeBlockedBy).toHaveLength(1);
    const frogged = {
      ...state,
      effects: [{
        id: 'fx1', source: 'i', controller: 0, createdTurn: 1, duration: 'end-of-turn',
        scope: { kind: 'cards', ids: ['i'] }, losesAllAbilities: true,
      }],
    } as unknown as GameState;
    expect(characteristicsOf(frogged, inst).cantBeBlockedBy).toEqual([]);
  });
});

describe('the printed-part cache (D499)', () => {
  /*
    `printedParts` is memoised, and these are the two ways a memoised pure function goes wrong.

    The cache exists because D498's gate caught a timeout, not because anybody guessed at a hot
    path: `characteristicsOf` reads the printed statics, the blocker limits and the landwalk on
    every call, and the bot calls it thousands of times a move, so each of the five readers in
    `characteristics.ts` was re-splitting and re-regexing the same unchanged string. One playout
    test went 42.8s -> over 60s when the fifth arrived; with the cache it is 18.2s, which is less
    than half what it cost before D498 existed.
  */

  it('keys on the name as well as the text, so one sentence does not leak between two cards', () => {
    /*
      The failure this would have been: key on the text alone and the *first* card to ask decides
      the answer for every card printing the same sentence. The sentence below is a self-subject
      restriction for Aesthir Glider and somebody else's restriction for Probe Beast, which is the
      whole-line subject rule (D495, D362) — exactly the pair that a text-only key would collapse.

      Asked in both orders, because a one-way check passes on a cache that never stores anything.
    */
    const line = "Aesthir Glider can't be blocked by white creatures.";
    const mine = { ban: [{ kind: 'colour', colour: 'W' }], only: null };
    const theirs = { ban: [], only: null };

    expect(printedBlockerLimit(line, 'Aesthir Glider')).toEqual(mine);
    expect(printedBlockerLimit(line, 'Probe Beast')).toEqual(theirs);
    expect(printedBlockerLimit(line, 'Aesthir Glider')).toEqual(mine);
    expect(printedBlockerLimit(line, 'Probe Beast')).toEqual(theirs);
  });

  it('gives every caller the same answer, so nothing has mutated the shared value', () => {
    /*
      The other failure: the cached array is shared, so a caller that spliced or sorted it would
      change what the next reader sees. Each of these readers builds its own result from it, and a
      card carrying one of each is the cheapest way to prove all three still agree on the fourth
      pass as they did on the first.
    */
    const name = 'Shared Reader Beast';
    const text = "Flying\nIslandwalk\n"
      + `${name} can't block.\n`
      + `${name} can't be blocked by creatures with power 2 or less.`;
    const twice = <T>(read: () => T): [T, T] => [read(), read()];

    const [blockersA, blockersB] = twice(() => printedBlockerLimit(text, name));
    expect(blockersA).toEqual({ ban: [{ kind: 'power', cmp: 'at-most', n: 2 }], only: null });
    expect(blockersB).toEqual(blockersA);

    const [staticsA, staticsB] = twice(() => printedCombatStatics(text, name));
    expect(staticsA.cantBlock).toBe(true);
    expect(staticsB).toEqual(staticsA);

    const [walkA, walkB] = twice(() => printedLandwalk(text));
    expect(walkA).toEqual(['Island']);
    expect(walkB).toEqual(walkA);
  });
});

describe('printed restrictions on what this creature may block (D500)', () => {
  /*
    D498's mirror, and the row D495 and D498 both named and left: `~ can block only creatures with
    flying`.

    **Not the same rule, and not the same field.** "Can't be blocked by creatures with flying" keeps
    fliers from blocking *it*; "can block only creatures with flying" keeps *it* from blocking
    anything but a flier. A Cloud Pirates is a 1/1 flier with no evasion at all and a very bad
    blocker. Fold the two directions into one pair of lists and every card in this family silently
    gains evasion it does not print — the D362 mistake, committed to 29 cards at once.

    The whole family, from 33,847 printings (39 lines, all read):

        ~ can block only creatures with flying.              29 lines, the entire allow-list half
        ~ can't block creatures with power N or greater.      6
        ~ can't block creatures with power N or less.         2
        ~ can't block artifact creatures.                     1   (Hinterland Drake)
        ~ can't block black creatures.                        1   (Gibbering Hyenas)

    The filter vocabulary is D498's, unchanged — which is why the last two read without a line of
    new parsing. What is new is the subject-and-verb shape and the two fields it lands in.
  */
  const read = (text: string, name = 'Probe Beast') => printedBlocksLimit(text, name);

  it.each([
    // The allow list, which is 29 of the 39 lines and one sentence.
    ['Ascending Aven can block only creatures with flying.', 'Ascending Aven',
      { ban: [], only: [{ kind: 'keyword', keyword: 'flying' }] }],
    // "This creature", the retemplated second reference — Etherium Pteramander's printing.
    ['This creature can block only creatures with flying.', 'Etherium Pteramander',
      { ban: [], only: [{ kind: 'keyword', keyword: 'flying' }] }],
    // The ban, both comparison directions. Brassclaw Orcs and Sunweb.
    ["Brassclaw Orcs can't block creatures with power 2 or greater.", 'Brassclaw Orcs',
      { ban: [{ kind: 'power', cmp: 'at-least', n: 2 }], only: null }],
    ["Sunweb can't block creatures with power 2 or less.", 'Sunweb',
      { ban: [{ kind: 'power', cmp: 'at-most', n: 2 }], only: null }],
    // The two that read for free because the filter vocabulary is shared with D498.
    ["Hinterland Drake can't block artifact creatures.", 'Hinterland Drake',
      { ban: [{ kind: 'type', type: 'artifact' }], only: null }],
    ["Gibbering Hyenas can't block black creatures.", 'Gibbering Hyenas',
      { ban: [{ kind: 'colour', colour: 'B' }], only: null }],
    // The short name, as the subject reader already handles for every other printed sentence.
    ["Bilbo can't block white creatures.", 'Bilbo, Luckwearer',
      { ban: [{ kind: 'colour', colour: 'W' }], only: null }],
  ])('reads "%s"', (text, name, expected) => {
    expect(read(text as string, name as string)).toEqual(expected);
  });

  it.each([
    /*
      Refused for the **subject**, and this is most of what the corpus prints next to these. Every
      one hands the restriction to somebody else, and handing it to the card printing it would be
      the D495 mistake: a creature that cannot block because a spell it casts restricts a token.
    */
    ['an Aura granting it', 'Enchanted creature can block only creatures with flying.'],
    ['a class of creatures', 'Creatures with flying can block only creatures with flying.'],
    ['a token the card creates', 'Draw three cards. Create a 1/1 blue Faerie creature token with'
      + ' flying and "This token can block only creatures with flying."'],
    ['somebody else, for a turn', "Target creature can't block this turn."],
    /*
      Refused for the **predicate**. The condition is the interesting one: Orgg and Goblin Mutant
      each print a *readable* ban on one line and an unreadable condition on another, so they are
      cards this reader half-answers — which is exactly what `unread` is for.
    */
    ['a condition', "Branded Brawlers can't block if you control an untapped land."],
    ['a duration', "Probe Beast can't block creatures with flying this turn."],
    /*
      Refused for the **filter**, which is D498's vocabulary and refuses the same phrases here.
      "Warriors" is Boldwyr Intimidator's line with its subject swapped: a creature type outside
      the short list, and reading it would be a guess about what a Warrior is.
    */
    ['a creature type outside the list', "Probe Beast can't block Warriors."],
    // Shadow was here too, and went the same way as D498's row above (D501). The ninth.
    ['a keyword the engine lacks', "Probe Beast can't block creatures with banding."],
    ['a relative power', "Probe Beast can't block creatures with power less than its power."],
  ])('reads nothing from %s', (_why, text) => {
    expect(read(text as string)).toEqual({ ban: [], only: null });
  });

  it('leaves D495\'s two statics to D495', () => {
    /*
      `~ can't block` and `~ can't block and can't be blocked` are combat statics, read by
      `printedCombatStatics` and set on `cantBlock`/`cantBeBlocked`. Four real printings carry the
      joined form (Changeling Outcast, Inkfathom Infiltrator, Marang River Prowler, and one more),
      and a ban reader that claimed either would overwrite a flat prohibition with a filter — a
      creature that may block after all.

      `printedParts` asks the combat reader first, so this is belt and braces; asserted because the
      ban regex here is `can't block (.+)` and "and can't be blocked" is a `.+`.
    */
    expect(read("Probe Beast can't block.")).toEqual({ ban: [], only: null });
    expect(read("Probe Beast can't block and can't be blocked."))
      .toEqual({ ban: [], only: null });
    expect(printedCombatStatics("Probe Beast can't block and can't be blocked.", 'Probe Beast'))
      .toEqual({ cantBlock: true, cantBeBlocked: true, mustAttack: false });
  });

  it('refuses a card printing both a ban and an allow list rather than merging them', () => {
    // D498's rule, for the same reason: the merge is a judgement the printed text does not settle,
    // and no card in 33,847 asks for one.
    expect(read("Probe Beast can't block white creatures.\n"
      + 'Probe Beast can block only creatures with flying.')).toEqual({ ban: [], only: null });
  });

  it('counts both of Cloud Pirates\' lines compiled, and emits no script', () => {
    /*
      Cloud Pirates is the whole family in one card: a printed keyword and a printed block
      restriction, and nothing else. Both lines are read off the card definition (D424), so the
      compiler owes exactly one thing — to count them read and emit nothing.
    */
    const compiled = compileCard({
      name: 'Cloud Pirates', type_line: 'Creature — Human Pirate', mana_cost: '{U}', cmc: 1,
      colors: ['U'], layout: 'normal', power: '1', toughness: '1',
      oracle_text: 'Flying\nCloud Pirates can block only creatures with flying.',
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.unread.map((u) => u.line)).toEqual([]);
    expect(compiled.script?.abilities ?? []).toEqual([]);
    expect(compiled.script?.triggers ?? []).toEqual([]);
  });

  it('reads Orgg\'s ban and leaves its condition unread', () => {
    /*
      The half-answered card, and the reason the whole-line rule is per line rather than per card.
      Orgg prints trample, a ban this reads, and an attack condition nothing does — so two lines
      compile and one is reported, which is a more useful card than all-or-nothing in either
      direction.
    */
    const compiled = compileCard({
      name: 'Orgg', type_line: 'Creature — Orgg', mana_cost: '{3}{R}{R}', cmc: 5,
      colors: ['R'], layout: 'normal', power: '6', toughness: '6',
      oracle_text: 'Trample\n'
        + "Orgg can't attack if defending player controls an untapped creature with power 3 or greater.\n"
        + "Orgg can't block creatures with power 3 or greater.",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.unread.map((u) => u.line)).toEqual([
      "Orgg can't attack if defending player controls an untapped creature with power 3 or greater.",
    ]);
  });

  it('is a base characteristic, so "loses all abilities" takes it away (CR 613.1f)', () => {
    // Same argument as D495's statics and D498's lists: a printed sentence is an ability, so it is
    // seeded in `characteristicsOf` and cleared there rather than layered on `state.effects`.
    const def = {
      name: 'Cloud Pirates', typeLine: 'Creature — Human Pirate', manaCost: '{U}', cmc: 1,
      colors: ['U'], power: '1', toughness: '1',
      oracleText: 'Flying\nCloud Pirates can block only creatures with flying.',
    } as unknown as CardDef;
    const state = {
      cardDefs: { k: def },
      instances: { i: { id: 'i', defKey: 'k', zone: 'battlefield', owner: 0, controller: 0, tapped: false, counters: {} } },
      effects: [],
      seats: [],
    } as unknown as GameState;
    const inst = state.instances['i']!;
    expect(characteristicsOf(state, inst).blocksOnly).toHaveLength(1);
    const frogged = {
      ...state,
      effects: [{
        id: 'fx1', source: 'i', controller: 0, createdTurn: 1, duration: 'end-of-turn',
        scope: { kind: 'cards', ids: ['i'] }, losesAllAbilities: true,
      }],
    } as unknown as GameState;
    expect(characteristicsOf(frogged, inst).blocksOnly).toBeNull();
    expect(characteristicsOf(frogged, inst).cantBlockThese).toEqual([]);
  });

  it('does not put the restriction on the other side of the block', () => {
    /*
      The assertion this whole increment is about. Cloud Pirates may only block fliers; that says
      nothing about who may block Cloud Pirates. If D500 had reused D498's two fields, this card
      would read as "can't be blocked except by creatures with flying" — unblockable by the ground,
      which it is not — so both of D498's fields have to stay empty.
    */
    expect(printedBlockerLimit('Flying\nCloud Pirates can block only creatures with flying.',
      'Cloud Pirates')).toEqual({ ban: [], only: null });
    // The ban half too: Gibbering Hyenas may not block a black creature, and every black creature
    // may still block the Hyenas.
    expect(printedBlockerLimit("Gibbering Hyenas can't block black creatures.", 'Gibbering Hyenas'))
      .toEqual({ ban: [], only: null });
  });
});

describe('fear, shadow and horsemanship, whose rules text is a clause list (D501)', () => {
  /*
    Three evasion keywords on **101 legal printed lines**, none of which this engine had, and every
    one of whose rules is exactly the `BlockerClause` vocabulary D498 and D500 built:

        fear          37 lines   CR 702.36a   except by artifact creatures and/or black creatures
        shadow        39 lines   CR 702.28b   can block or be blocked by only creatures with shadow
        horsemanship  25 lines   CR 702.5b    except by creatures with horsemanship

    **Shadow is the card that makes D500 pay twice**: it is the first rule in this engine that is an
    allow list on who may block the creature *and* an allow list on what the creature may block, and
    until D500 there was no field for the second half.

    The rules live in `KEYWORD_BLOCK_RULES` rather than in the printed-list fields, and Dauthi
    Horror is why — see the interface's docblock. Its text is `Shadow` plus `Dauthi Horror can't be
    blocked by white creatures`, and D498 refuses a card printing both a ban and an allow list, so
    merging shadow into `blockableOnlyBy` would have cost that card *both* restrictions.
  */

  it('reads the bare keyword line off six real printings', () => {
    /*
      The reminder text in brackets comes off first, which is the whole reason a bare `Fear` is what
      the reader sees: every modern printing of these three carries its rule as reminder text, and
      the reader must not read the reminder as a sentence of its own.
    */
    expect(printedKeywords('Fear (This creature can\'t be blocked except by artifact creatures'
      + ' and/or black creatures.)')).toEqual(['fear']);
    expect(printedKeywords('Shadow (This creature can block or be blocked by only creatures with'
      + ' shadow.)')).toEqual(['shadow']);
    expect(printedKeywords('Horsemanship (This creature can\'t be blocked except by creatures with'
      + ' horsemanship.)')).toEqual(['horsemanship']);
  });

  it.each([
    ['fear', { blockedOnlyBy: [{ kind: 'type', type: 'artifact' }, { kind: 'colour', colour: 'B' }] }],
    ['shadow', {
      blockedOnlyBy: [{ kind: 'keyword', keyword: 'shadow' }],
      blocksOnly: [{ kind: 'keyword', keyword: 'shadow' }],
    }],
    ['horsemanship', { blockedOnlyBy: [{ kind: 'keyword', keyword: 'horsemanship' }] }],
  ])('states %s\'s rule as clauses, and only the halves the rule has', (keyword, expected) => {
    /*
      The table is the rule, so it is asserted as data rather than only through its effects. The
      "only the halves the rule has" half matters: horsemanship restricts who may block the
      creature and says nothing about what it may block, so a `blocksOnly` on it would be invented
      rules — and symmetry is exactly the kind of thing a table like this invites.
    */
    const rule = KEYWORD_BLOCK_RULES.find((r) => r.keyword === keyword);
    expect(rule).toBeDefined();
    expect({ ...rule, keyword: undefined }).toEqual({ ...expected, keyword: undefined });
  });

  it('reads Severed Legion, whose whole text is one word', () => {
    // Six legal cards print nothing but `Fear`, so the keyword alone finishes them.
    const compiled = compileCard({
      name: 'Severed Legion', type_line: 'Creature — Zombie', mana_cost: '{1}{B}{B}', cmc: 3,
      colors: ['B'], layout: 'normal', power: '2', toughness: '2',
      oracle_text: "Fear (This creature can't be blocked except by artifact creatures and/or black creatures.)",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.unread.map((u) => u.line)).toEqual([]);
    expect(compiled.script?.abilities ?? []).toEqual([]);
  });

  it('keeps Dauthi Horror\'s printed ban and its keyword, which a merge would have lost both of', () => {
    /*
      The card the separate table exists for. Both restrictions are real and independent: a white
      creature with shadow may not block it, for two different reasons. Asserted as two reads rather
      than one, because a merged implementation would have returned an empty printed list *and* no
      keyword rule, and an empty-vs-empty comparison is the easiest kind of test to fool.
    */
    const text = 'Shadow (This creature can block or be blocked by only creatures with shadow.)\n'
      + "Dauthi Horror can't be blocked by white creatures.";
    expect(printedKeywords(text)).toEqual(['shadow']);
    expect(printedBlockerLimit(text, 'Dauthi Horror'))
      .toEqual({ ban: [{ kind: 'colour', colour: 'W' }], only: null });
  });

  it('reads a semicolon-separated keyword line, which was refused whole before', () => {
    /*
      33 legal lines separate keywords with a semicolon, and the comma-only split refused every one.
      Zhang Fei is the card that showed it: `Vigilance; horsemanship` came out as a single part that
      is not a keyword, so a card whose entire text is two keywords read as nothing.
    */
    expect(printedKeywords('Vigilance; horsemanship (This creature can\'t be blocked except by'
      + ' creatures with horsemanship.)').slice().sort()).toEqual(['horsemanship', 'vigilance']);
    expect(printedKeywords('Flying; fear').slice().sort()).toEqual(['fear', 'flying']);
    expect(printedKeywords('Defender; reach').slice().sort()).toEqual(['defender', 'reach']);
  });

  it('still refuses a semicolon line carrying a word it has no keyword for', () => {
    /*
      The whole-line rule, unchanged by the split: every part has to be a part. Banding is on 10 of
      those 33 lines and this engine has no banding, so `First strike; banding` must read as nothing
      rather than hand over the half it understood (D487) — a creature with first strike and no
      banding is a creature whose printed text the engine is quietly disagreeing with.
    */
    expect(printedKeywords('First strike; banding')).toEqual([]);
    expect(printedKeywords('Flying; first strike; banding')).toEqual([]);
  });

  it('is a base characteristic, so "loses all abilities" takes the rule away too', () => {
    /*
      The rules come off `keywords`, which "loses all abilities" already clears — so this is not a
      fourth thing to remember to reset, and that is the argument for deriving the rules from the
      keyword rather than copying them into fields of their own.
    */
    const def = {
      name: 'Dauthi Marauder', typeLine: 'Creature — Dauthi Minion', manaCost: '{2}{B}', cmc: 3,
      colors: ['B'], power: '3', toughness: '1',
      oracleText: 'Shadow (This creature can block or be blocked by only creatures with shadow.)',
    } as unknown as CardDef;
    const state = {
      cardDefs: { k: def },
      instances: { i: { id: 'i', defKey: 'k', zone: 'battlefield', owner: 0, controller: 0, tapped: false, counters: {} } },
      effects: [],
      seats: [],
    } as unknown as GameState;
    const inst = state.instances['i']!;
    expect(keywordBlockRules(characteristicsOf(state, inst)).map((r) => r.keyword)).toEqual(['shadow']);
    const frogged = {
      ...state,
      effects: [{
        id: 'fx1', source: 'i', controller: 0, createdTurn: 1, duration: 'end-of-turn',
        scope: { kind: 'cards', ids: ['i'] }, losesAllAbilities: true,
      }],
    } as unknown as GameState;
    expect(keywordBlockRules(characteristicsOf(frogged, inst))).toEqual([]);
  });

  it('gives a creature with no such keyword no rules at all', () => {
    // The control. An empty result above has to mean "this creature has none", not "this helper
    // returns nothing" — so a plain body is put through the same call.
    const def = {
      name: 'Plain Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2,
      colors: ['G'], power: '2', toughness: '2', oracleText: '',
    } as unknown as CardDef;
    const state = {
      cardDefs: { k: def },
      instances: { i: { id: 'i', defKey: 'k', zone: 'battlefield', owner: 0, controller: 0, tapped: false, counters: {} } },
      effects: [],
      seats: [],
    } as unknown as GameState;
    expect(keywordBlockRules(characteristicsOf(state, state.instances['i']!))).toEqual([]);
  });
});

describe('the threshold condition: a static that is on while your graveyard is big (D502)', () => {
  /*
    The queue head by cards finished (D434): **31 cards** whose only unread line says
    "there are seven or more cards in your graveyard". 108 legal lines print that phrase, of which
    **33 are a static about the card itself** — the rest are activated abilities ("Activate only
    if…"), quoted abilities the card grants itself, and one-shot spell effects ("If there are seven
    or more…, instead…"), each of which belongs to another reader or to nobody.

    **Nothing new was needed in the effect machinery.** #142 built the conditional continuous effect
    for metalcraft — `ContinuousEffect.while`, asked in `effectApplies` rather than stored, because
    there is no moment at which it turns on — and this is a third `while` kind beside the artifact
    count and monstrosity's counter. It is also the cheapest of the three to answer honestly: the
    artifact count reads the *printed* type line, since it runs inside `characteristicsOf` and a
    live type line would re-enter the whole computation; a graveyard count reads a list of ids.

    Two things the reader had to learn, and they are what made it a branch rather than a row:

    1. **The condition is printed on either side of the predicate.** Nine lines put it last, as
       metalcraft does; fifteen put it first. A reader handling one position would read a third of
       the family.
    2. **The predicate is a list**: a pump, a keyword, a pump and a keyword, a pump and "can't
       block". `thresholdPredicate` splits on "and" and reads each part.
  */
  const creature = (name: string, text: string, power = '1', toughness = '1') => compileCard({
    name, type_line: 'Creature — Human', mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
    layout: 'normal', power, toughness, oracle_text: text,
  });
  const staticOf = (name: string, text: string) => {
    const read = creature(name, text);
    expect(read.ok).toBe(true);
    if (!read.ok) return undefined;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    return read.script?.statics?.[0];
  };
  const WHILE = { kind: 'controller-graveyard', atLeast: 7 } as const;

  it.each([
    /*
      Both positions of the condition, on the printings that put it there. Krosan Beast's whole
      card is the trailing form; Mystic Penitent's is the leading one.
    */
    ['Krosan Beast',
      'Threshold — Krosan Beast gets +7/+7 as long as there are seven or more cards in your graveyard.',
      { power: 7, toughness: 7 }],
    ['Mystic Penitent',
      'Threshold — As long as there are seven or more cards in your graveyard, Mystic Penitent gets'
      + ' +1/+1 and has flying.',
      { power: 1, toughness: 1, keywords: ['flying'] }],
    // "This creature", the retemplated second reference, in both positions.
    ['Billowing Shriekmass',
      'Threshold — This creature gets +2/+1 as long as there are seven or more cards in your graveyard.',
      { power: 2, toughness: 1 }],
    ['Dreadwing Scavenger',
      'Threshold — This creature gets +1/+1 and has deathtouch as long as there are seven or more'
      + ' cards in your graveyard.',
      { power: 1, toughness: 1, keywords: ['deathtouch'] }],
    // A keyword with no pump at all (Mystic Visionary), and a pump with no keyword.
    ['Mystic Visionary',
      'Threshold — Mystic Visionary has flying as long as there are seven or more cards in your graveyard.',
      { keywords: ['flying'] }],
    ['Nimble Mongoose',
      'Threshold — Nimble Mongoose gets +2/+2 as long as there are seven or more cards in your graveyard.',
      { power: 2, toughness: 2 }],
    // The three predicates that are not a pump or a keyword, each a real printing.
    ['Childhood Horror',
      "Threshold — As long as there are seven or more cards in your graveyard, Childhood Horror gets"
      + " +2/+2 and can't block.",
      { power: 2, toughness: 2, cantBlock: true }],
    ['Cephalid Inkmage',
      "Threshold — This creature can't be blocked as long as there are seven or more cards in your"
      + ' graveyard.',
      { cantBeBlocked: true }],
    ['Otarian Juggernaut',
      'Threshold — As long as there are seven or more cards in your graveyard, Otarian Juggernaut'
      + ' gets +3/+0 and attacks each combat if able.',
      { power: 3, mustAttack: true }],
    // Protection from one colour, which is Mystic Familiar's printing and `protectionFrom`'s list
    // with one entry in it (D83).
    ['Mystic Familiar',
      'Threshold — As long as there are seven or more cards in your graveyard, Mystic Familiar gets'
      + ' +1/+1 and has protection from black.',
      { power: 1, toughness: 1, protectionFrom: ['B'] }],
  ])('reads %s', (name, text, expected) => {
    expect(staticOf(name as string, text as string))
      .toEqual({ scope: 'self', effect: { ...(expected as object), while: WHILE } });
  });

  it('stores the count rather than the constant seven', () => {
    /*
      Every threshold card prints "seven", so the number could have been hard-coded — and then the
      first card printing any other count would read as a threshold card. `countFrom` reads the word
      or a digit, which is the same helper every other printed count in this file goes through.
    */
    expect(staticOf('Probe Beast',
      'Probe Beast gets +1/+1 as long as there are three or more cards in your graveyard.'))
      .toEqual({ scope: 'self',
        effect: { power: 1, toughness: 1, while: { kind: 'controller-graveyard', atLeast: 3 } } });
    expect(staticOf('Probe Beast',
      'Probe Beast gets +1/+1 as long as there are 10 or more cards in your graveyard.'))
      .toEqual({ scope: 'self',
        effect: { power: 1, toughness: 1, while: { kind: 'controller-graveyard', atLeast: 10 } } });
  });

  it.each([
    /*
      Refused for the **predicate**, and both of these are real cards the corpus prints next to the
      ones above.

      Masked Gorgon is the one that makes the whole-line rule concrete (D487): "has protection from
      green and from white" splits into a readable part and a bare "from white", so the card stays
      unread. A Gorgon with protection from one of the two colours its card names is worse than a
      Gorgon a human plays by hand.
    */
    ['two colours of protection', 'Masked Gorgon has protection from green and from white as long as'
      + ' there are seven or more cards in your graveyard.'],
    ['a bonus that is a count', 'Nantuko Blightcutter gets +1/+1 for each black permanent your'
      + ' opponents control as long as there are seven or more cards in your graveyard.'],
    ['a keyword the engine lacks', 'Probe Beast has banding as long as there are seven or more cards'
      + ' in your graveyard.'],
    /*
      And the same word **beside a readable part**, which is a different test from the row above and
      the one a break run said was missing. "gets +1/+1 and has banding" splits into a pump this
      reader understands and a keyword it does not, so the whole-line rule has to refuse — where
      the row above refuses for having nothing readable at all and would pass on a lenient reader
      that simply dropped the part it could not read.
    */
    ['an unreadable part beside a readable one', 'Probe Beast gets +1/+1 and has banding as long as'
      + ' there are seven or more cards in your graveyard.'],
    /*
      **A row that used to be here, and what replaced it.** `'a granted ability'` asserted that
      `As long as … Probe Beast has "When Probe Beast enters, draw a card."` went unread, which was
      true of this reader for as long as a quoted ability had nowhere to go. D511 built the quoted
      reader, D512 added the activated table, and D513 wired both into this branch — 17 of the
      queue's top bucket were that exact shape. The positive assertions live in "the threshold
      quoted tail" below; the refusals that survive are the ones about an inner text this compiler
      still cannot read, which is a different claim.
    */
    /*
      Refused for the **subject**: the whole-line rule again. Aboshan's Desire is an Aura and the
      restriction is its host's, so handing it to the Aura would be the D495 mistake.
    */
    ['an Aura granting it', 'Enchanted creature has shroud as long as there are seven or more cards'
      + ' in your graveyard.'],
    ['a class of creatures', 'White creatures get an additional +1/+1 as long as there are seven or'
      + ' more cards in your graveyard.'],
    /*
      Refused for the **condition**, which is the half that keeps this reader from eating its
      neighbours. "If there are …" is a one-shot spell effect (Cleansing Meditation, Demoralize,
      Cabal Ritual — 20-odd lines), "unless" is Deep-Sea Terror's attack restriction, and a
      graveyard that is not yours is somebody else's count.
    */
    ['a one-shot "if" instead of "as long as"', 'If there are seven or more cards in your graveyard,'
      + ' Probe Beast gets +1/+1.'],
    ['an "unless" restriction', "Probe Beast can't attack unless there are seven or more cards in"
      + ' your graveyard.'],
    ['somebody else\'s graveyard', 'Probe Beast gets +1/+1 as long as there are seven or more cards'
      + " in an opponent's graveyard."],
    ['a count of a kind of card', 'Probe Beast gets +1/+1 as long as there are seven or more creature'
      + ' cards in your graveyard.'],
  ])('leaves a line unread: %s', (_why, text) => {
    const read = creature('Probe Beast', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('finishes Krosan Beast, whose whole card is the one line', () => {
    // The cheapest demonstration that this is a card finished rather than a line read: a 1/1 for
    // four mana that is an 8/8 once the graveyard fills, and nothing else printed on it.
    const read = creature('Krosan Beast',
      'Threshold — Krosan Beast gets +7/+7 as long as there are seven or more cards in your graveyard.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([]);
    expect(read.script?.abilities ?? []).toEqual([]);
    expect(read.script?.triggers ?? []).toEqual([]);
  });
});


describe('"This spell can\'t be countered" (D493)', () => {
  const of = (type_line: string, text: string, mana_cost = '{1}{G}') => compileCard({
    name: 'Asking Thing', type_line, mana_cost, cmc: 2, colors: ['G'], layout: 'normal',
    oracle_text: text, ...(type_line.startsWith('Creature') ? { power: '4', toughness: '4' } : {}),
  });

  it.each([
    // The spell path: an instant or sorcery whose only other line is its resolution.
    ['Instant', 'This spell can\'t be countered.\nDestroy target creature.'],
    ['Sorcery', 'This spell can\'t be countered.\nDraw a card.'],
    // The permanent path, which is a SEPARATE line loop and was missed by the first draft.
    // Carnage Tyrant, Thrun and Blurred Mongoose all print it on a creature.
    ['Creature — Dinosaur', 'This spell can\'t be countered.\nTrample'],
    ['Creature — Troll Shaman', 'This spell can\'t be countered.'],
  ])('reads it on a %s', (typeLine, text) => {
    const read = of(typeLine as string, text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.cantBeCountered).toBe(true);
  });

  it('is what makes the rest of the card readable at all', () => {
    /*
      Abrupt Decay's shape, and the reason this was worth doing: the resolution line reads
      perfectly on its own, and the card did not compile, because a spell needs **every** printed
      line read or declared. One unread static cost the whole card.
    */
    const whole = of('Instant', 'This spell can\'t be countered.\n'
      + 'Destroy target nonland permanent with mana value 3 or less.');
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.unread.map((u) => u.line)).toEqual([]);
    expect(whole.script?.targets?.[0]?.description)
      .toBe('target nonland permanent with mana value 3 or less');
  });

  it.each([
    /*
      A permanent's static about **other** objects is a different reader with a different scope,
      and collapsing it into this flag would make the card wrong in both directions at once: the
      permanent itself would become uncounterable, and the spells it is supposed to protect would
      not be. Left unread rather than guessed.
    */
    ['Spells your opponents cast can\'t be countered.', 'a permanent protecting other spells'],
    ['Creature spells you cast can\'t be countered.', 'the same, scoped to a type'],
    ['This spell can\'t be countered by spells or abilities your opponents control.',
      'a narrower "can\'t" than the flag expresses'],
  ])('leaves "%s" unread: %s', (text) => {
    const read = of('Creature — Troll Shaman', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('Bushido N (D503)', () => {
  /*
    The queue head after D502: **35 legal printed lines**, 20 cards whose only unread line it is.
    CR 702.44a — "Whenever this creature blocks or becomes blocked, it gets +N/+N until end of
    turn" — one printed sentence and **two** events, because blocking and becoming blocked are
    different things that happen at different moments.

    Everything it needs was already here, which is what makes it a cheap 20 cards: both halves of
    the event exist, and D482's correction is why the *batched* pair is the right one. See
    `bushidoTriggers`.
  */
  const samurai = (text: string, name = 'Araba Mothrider') => compileCard({
    name, type_line: 'Creature — Human Samurai', mana_cost: '{3}{W}', cmc: 4,
    colors: ['W'], layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it.each([
    ['Bushido 1', 1],
    ['Bushido 2', 2],
    ['Bushido 3', 3],
  ])('reads "%s" as two triggers and no field', (text, count) => {
    const read = samurai(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    /*
      Both events, in this order, and **no** `bushido` field on the script: the keyword is the pair
      of abilities and nothing else, where modular and vanishing each carry a number the engine
      reads elsewhere.
    */
    expect(read.script?.triggers?.map((t) => t.on.kind))
      .toEqual(['blocking-creature', 'blocked-creature']);
    expect(read.script?.triggers?.map((t) => t.description))
      .toEqual([`it gets +${count}/+${count} until end of turn`,
        `it gets +${count}/+${count} until end of turn`]);
  });

  it('is the batched pair of events, not the per-object one', () => {
    /*
      The assertion that matters most, and it is about two words. `blocks` fires once per attacker
      blocked and `becomes-blocked` once per blocker; `blocking-creature` and `blocked-creature`
      fire once each. A Samurai on the per-object pair would get +2N/+2N against two blockers —
      which is the reading D482 found *shipping* on Ichorclaw Myr, so this row exists because the
      mistake has been made here before.
    */
    const read = samurai('Bushido 2');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const kinds = read.script?.triggers?.map((t) => t.on.kind) ?? [];
    expect(kinds).not.toContain('blocks');
    expect(kinds).not.toContain('becomes-blocked');
  });

  it('gives the two triggers separate objects', () => {
    // The engine puts a resolved trigger on the stack by identity, so two abilities that were one
    // object would be one ability firing twice at best.
    const read = samurai('Bushido 1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const [first, second] = read.script?.triggers ?? [];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('reads it beside the rest of a real card', () => {
    // Battle-Mad Ronin's whole printing: bushido and a second line, both read. The name has to be
    // the card's own, which is the point of the second line — a self-subject sentence is read
    // against the name it is printed on, and the first draft of this row passed the wrong one.
    const read = samurai('Bushido 2\nBattle-Mad Ronin attacks each combat if able.',
      'Battle-Mad Ronin');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.map((t) => t.on.kind))
      .toEqual(['blocking-creature', 'blocked-creature']);
  });

  it.each([
    /*
      The three printings in the corpus that wear the word and are a different mechanic. Each is
      named here rather than dropped quietly, which is what `bushidoTriggers`' docblock argues.
    */
    ['a count instead of a number', 'Fumiko the Lowblood has bushido X, where X is the number of'
      + ' attacking creatures.'],
    ['bushido granted to somebody else', 'Each other Samurai creature you control has bushido 1.'],
    ['a payoff that reads how much bushido a creature has', 'Each other Samurai creature you'
      + ' control gets +1/+1 for each point of bushido it has.'],
    // And a number this reader will not invent: no printing says "bushido" with no number at all.
    ['no number', 'Bushido'],
  ])('leaves a line unread: %s', (_why, text) => {
    const read = samurai(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('wither, which is infect\'s creature half (D504)', () => {
  /*
    **26 bare `Wither` lines** in the legal corpus, and a dozen more printings that grant it.
    CR 702.78a: "Damage this source would deal to a creature is dealt in the form of -1/-1
    counters" — word for word what infect does to a creature. What infect adds is the *player*
    half, where its damage is poison rather than life (CR 702.90b).

    So the whole of this increment is one word in `KEYWORDS` and one `||` in `dealDamage`'s creature
    branch, with the player branch deliberately left alone. A Boggart Ram-Gang hits you for three
    **life**; a Glistener Elf for three poison, and the difference decides games in a format where
    ten poison ends one.
  */
  const creature = (text: string, name = 'Harvest Gwyllion') => compileCard({
    name, type_line: 'Creature — Hag', mana_cost: '{2}{W}{B}', cmc: 4,
    colors: ['W', 'B'], layout: 'normal', power: '2', toughness: '4', oracle_text: text,
  });

  it('reads the bare keyword, which is Harvest Gwyllion\'s whole card', () => {
    /*
      Two assertions, because the line is counted compiled and emits **no script** (D424):
      `characteristicsOf` reads a printed keyword straight off the card, so a `keywords` entry here
      would be a second source for one fact. What the compiler owes is the count; what the reader
      owes is the word.
    */
    const read = creature('Wither (This deals damage to creatures in the form of -1/-1 counters.)');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(printedKeywords('Wither')).toEqual(['wither']);
  });

  it('reads it beside another keyword, as Boggart Ram-Gang prints it', () => {
    const read = creature('Haste\nWither (This deals damage to creatures in the form of -1/-1'
      + ' counters.)', 'Boggart Ram-Gang');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('grants for free, because every grant reader asks isKeyword', () => {
    /*
      The moment the word is in `KEYWORDS`, every reader that hands a keyword to something accepts
      it — the same free ride D501's three keywords got. Tower Above's shape is the one the pump
      reader answers.

      **Not asserted: "Equipped creature gets +1/+0 and has wither."** That line is unread, and
      checked just below that it is unread for a reason that has nothing to do with wither: the same
      sentence with *flying* in it is unread too, because no reader handles a bonus and a grant in
      one equip line. Writing the row as a wither test would have claimed a gap that is somewhere
      else entirely.
    */
    const pumped = compileCard({
      name: 'Tower Above', type_line: 'Instant', mana_cost: '{2}{G}', cmc: 3, colors: ['G'],
      layout: 'normal',
      oracle_text: 'Target creature gets +1/+1 and gains wither until end of turn.',
    });
    expect(pumped.ok).toBe(true);
    if (!pumped.ok) return;
    expect(pumped.unread.map((u) => u.line)).toEqual([]);

    const equipped = (word: string) => compileCard({
      name: 'Blight Sickle', type_line: 'Artifact — Equipment', mana_cost: '{2}', cmc: 2,
      colors: [], layout: 'normal', oracle_text: `Equipped creature gets +1/+0 and has ${word}.`,
    });
    for (const word of ['wither', 'flying']) {
      const read = equipped(word);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread).toHaveLength(1);
    }
  });

  it.each([
    /*
      Refused, and the first is the interesting one: Everlasting Torment hands wither to **every
      damage source in the game**, which is a global replacement and not a keyword on a permanent.
      Reading it as the enchantment having wither would give an enchantment an ability that does
      nothing and leave the rule it prints unenforced — wrong twice over (D362).
    */
    ['a global replacement', 'All damage is dealt as though its source had wither.'],
    ['a static about other creatures by colour', 'Black creatures you control have wither.'],
  ])('leaves a line unread: %s', (_why, text) => {
    const read = creature(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('a self-untap carries untapsOnly (D505)', () => {
  /*
    The reader half of the loop fix. `untapsOnly` is the bot's warning that an ability can put the
    board back exactly where it found it (#124), and until D505 only the **targeted** untap readers
    set it — so `{3}: Untap this artifact` compiled without it and the eleventh "spent on nothing"
    rule was never asked about Basalt Monolith. Two pods in forty then ran to the harness's
    2000-move limit inside one main phase.

    Dropping that flag is not a missing hint but a hang, which is why this is a compile test of its
    own rather than a line in the untap block above.
  */
  const monolith = compileCard({
    name: 'Basalt Monolith', type_line: 'Artifact', mana_cost: '{3}', cmc: 3, colors: [],
    layout: 'normal',
    oracle_text: "This artifact doesn't untap during your untap step.\n{T}: Add {C}{C}{C}.\n"
      + '{3}: Untap this artifact.',
  });

  it('on the real card, beside its mana ability', () => {
    expect(monolith.ok).toBe(true);
    if (!monolith.ok) return;
    const abilities = monolith.script?.abilities ?? [];
    expect(abilities).toHaveLength(2);
    // The mana ability must NOT carry it: tapping for mana is not a cycle, and the flag would tell
    // the bot the one thing this card is for buys nothing.
    expect(abilities[0]?.untapsOnly).toBeUndefined();
    expect(abilities[1]?.untapsOnly).toBe(true);
    // And the line that is still unread is the untap-step static, not either ability.
    expect(monolith.unread.map((u) => u.line))
      .toEqual(["This artifact doesn't untap during your untap step."]);
  });

  it('and on a creature that untaps itself by name', () => {
    // Horseshoe Crab's whole card, which is the self-untap worth making rather than the one that
    // loops — see the two bot tests in `playout.test.ts`.
    const crab = compileCard({
      name: 'Horseshoe Crab', type_line: 'Creature — Crab', mana_cost: '{2}{U}', cmc: 3,
      colors: ['U'], layout: 'normal', power: '1', toughness: '3',
      oracle_text: '{U}: Untap Horseshoe Crab.',
    });
    expect(crab.ok).toBe(true);
    if (!crab.ok) return;
    expect(crab.unread.map((u) => u.line)).toEqual([]);
    expect(crab.script?.abilities?.[0]?.untapsOnly).toBe(true);
  });

  it('and a tap is still not an untap', () => {
    /*
      The control the tap reader's own docblock argues for: a tap changes the board in one
      direction, so carrying the flag there would be wrong rather than redundant. Asserted here
      because D505 widened where the flag is set, and widening it one card too far is the mistake
      that costs the bot a real play.
    */
    const tapper = compileCard({
      name: 'Benalish Trapper', type_line: 'Creature — Human Soldier', mana_cost: '{2}{W}', cmc: 3,
      colors: ['W'], layout: 'normal', power: '1', toughness: '1',
      oracle_text: '{W}, {T}: Tap target creature.',
    });
    expect(tapper.ok).toBe(true);
    if (!tapper.ok) return;
    expect(tapper.script?.abilities?.[0]?.untapsOnly).toBeUndefined();
  });
});

describe('Changeling: every creature type (D506)', () => {
  /*
    The queue head after D505: **23 cards** whose only unread line is `Changeling`. CR 702.73a —
    "This card is every creature type" — and it is a *characteristic-defining* ability, so it works
    in every zone and "loses all abilities" takes it away.

    **Read as a keyword and enforced in one place.** Subtype matching is spread over eighteen call
    sites in this engine; `characteristicsOf` extends the subtype list once, after the keywords are
    final, and every one of them answers correctly without changing. See `CREATURE_TYPES` for the
    vocabulary and how it was derived.
  */
  const changeling = (text: string, name = 'Woodland Changeling') => compileCard({
    name, type_line: 'Creature — Shapeshifter', mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
    layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it('reads the bare keyword, which is Woodland Changeling\'s whole card', () => {
    const read = changeling('Changeling (This card is every creature type.)');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(printedKeywords('Changeling')).toEqual(['changeling']);
  });

  it.each([
    ['Avian Changeling', 'Changeling (This card is every creature type.)\nFlying'],
    ['Changeling Sentinel', 'Changeling (This card is every creature type.)\nVigilance'],
    ['Changeling Outcast', 'Changeling (This card is every creature type.)\n'
      + "Changeling Outcast can't block and can't be blocked."],
  ])('reads it beside the rest of %s', (name, text) => {
    const read = changeling(text as string, name as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('is every creature type on the battlefield, and the printed line still reads first', () => {
    /*
      The assertion the whole design rests on: the subtypes are extended rather than a flag being
      carried, so `hasSubtype` — which eighteen call sites use — answers for any tribe.
    */
    const def = {
      name: 'Woodland Changeling', typeLine: 'Creature — Shapeshifter', manaCost: '{1}{G}', cmc: 2,
      colors: ['G'], power: '2', toughness: '2',
      oracleText: 'Changeling (This card is every creature type.)',
    } as unknown as CardDef;
    const state = {
      cardDefs: { k: def },
      instances: { i: { id: 'i', defKey: 'k', zone: 'battlefield', owner: 0, controller: 0, tapped: false, counters: {} } },
      effects: [],
      seats: [],
    } as unknown as GameState;
    const inst = state.instances['i']!;
    const ch = characteristicsOf(state, inst);
    for (const tribe of ['Goblin', 'Elf', 'Wall', 'Wizard', 'Spirit', 'Dragon', 'Zombie']) {
      expect(hasSubtype(ch.typeLine, tribe)).toBe(true);
    }
    // Shapeshifter is still first, so anything that reads the list in order sees the printed one.
    expect(ch.typeLine.subtypes[0]).toBe('Shapeshifter');
    // And it is NOT an artifact, enchantment or land subtype: those are not creature types.
    for (const notATribe of ['Equipment', 'Aura', 'Saga', 'Vehicle', 'Food', 'Forest']) {
      expect(hasSubtype(ch.typeLine, notATribe)).toBe(false);
    }

    /*
      **The printed definition is untouched**, which is what the view sends to a player. A
      316-entry subtype list on the wire would be a real regression, and this is the assertion that
      says it cannot happen rather than the assumption that it does not.
    */
    expect(def.typeLine).toBe('Creature — Shapeshifter');

    // And "loses all abilities" takes it away, because it is a printed ability (CR 613).
    const frogged = {
      ...state,
      effects: [{
        id: 'fx1', source: 'i', controller: 0, createdTurn: 1, duration: 'end-of-turn',
        scope: { kind: 'cards', ids: ['i'] }, losesAllAbilities: true,
      }],
    } as unknown as GameState;
    const plain = characteristicsOf(frogged, inst);
    expect(hasSubtype(plain.typeLine, 'Goblin')).toBe(false);
    expect(hasSubtype(plain.typeLine, 'Shapeshifter')).toBe(true);
  });

  it('does not make a noncreature permanent every creature type', () => {
    /*
      A changeling card is every creature type in every zone, but the only subtype question this
      engine asks of a noncreature *permanent* is about artifact and enchantment subtypes — and
      those are not creature types. Extending the list for one would be a Vehicle that is also a
      Goblin, which is not a thing the rules describe.
    */
    const def = {
      name: 'Probe Relic', typeLine: 'Artifact', manaCost: '{2}', cmc: 2, colors: [],
      oracleText: 'Changeling (This card is every creature type.)',
    } as unknown as CardDef;
    const state = {
      cardDefs: { k: def },
      instances: { i: { id: 'i', defKey: 'k', zone: 'battlefield', owner: 0, controller: 0, tapped: false, counters: {} } },
      effects: [],
      seats: [],
    } as unknown as GameState;
    const ch = characteristicsOf(state, state.instances['i']!);
    expect(hasSubtype(ch.typeLine, 'Goblin')).toBe(false);
  });

  it('has a creature-type vocabulary that was derived rather than remembered', () => {
    /*
      The list is 316 names pulled out of the corpus, and the spot-check is what caught the
      derivation being wrong twice (see `CREATURE_TYPES`). These are the eighteen tribes the first
      pass dropped, plus the ten artifact/enchantment/land subtypes it wrongly kept.
    */
    expect(CREATURE_TYPES).toHaveLength(316);
    for (const tribe of ['Goblin', 'Elf', 'Wizard', 'Demon', 'Elemental', 'Soldier', 'Warrior',
      'Merfolk', 'Kithkin', 'Faerie', 'Giant', 'Shaman', 'Shapeshifter', 'Rebel', 'Rogue',
      'Treefolk', 'Eldrazi', 'Lhurgoyf', 'Wall', 'Spirit']) {
      expect(isCreatureType(tribe)).toBe(true);
    }
    for (const notATribe of ['Equipment', 'Saga', 'Shrine', 'Aura', 'Clue', 'Food', 'Treasure',
      'Background', 'Book', 'Forest', 'Vehicle', 'Island']) {
      expect(isCreatureType(notATribe)).toBe(false);
    }
  });

  it.each([
    /*
      Refused: Mistform Ultimus spells the ability out in words rather than printing the keyword,
      and the sentence is a self-subject static this reader does not answer. One card, named rather
      than read by widening the keyword into a sentence matcher.
    */
    ['the ability written out in words', "Mistform Ultimus is every creature type (even if this"
      + " card isn't on the battlefield)."],
  ])('leaves a line unread: %s', (_why, text) => {
    const read = changeling(text as string, 'Mistform Ultimus');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('finishes Irregular Cohort, whose token carries the keyword too', () => {
    /*
      **This row was written as a refusal and the test said otherwise**, which is why it is here as
      an assertion. The token reader builds a token from a printed description and asks `isKeyword`
      for each word after "with" — so the moment `changeling` joined the list, "create a 2/2
      colorless Shapeshifter creature token with changeling" read as well, and a card that prints
      the keyword *and* grants it compiles whole.

      Worth the row rather than a comment: it is the second card this increment finishes without
      being aimed at, and the first evidence that the vocabulary change reaches the token path.
    */
    const read = changeling('Changeling (This card is every creature type.)\n'
      + 'When Irregular Cohort enters, create a 2/2 colorless Shapeshifter creature token with'
      + ' changeling.', 'Irregular Cohort');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.map((t) => t.on.kind)).toEqual(['etb']);
  });
});

describe('"Activate only once each turn" (D508)', () => {
  /*
    The queue's real head, and it took a measurement to see it. The printed head of
    `one-away.mjs` was "Threshold — As long as there are seven or more cards in your graveyard,"
    at 19 cards — but 17 of those 19 are the quoted-ability tail (`has "When ~ enters, …"`), which
    needs the compiler to turn arbitrary quoted text into a `TriggerDef`.

    Measured instead (`scratchpad/actonly.mjs`, recorded under D508 in `claude/decisions-log.md`):
    **519 legal cards are one line away on a line carrying "Activate only …", and for 143 of them
    the restriction is the only thing unread** — strip the trailing sentence and the line compiles
    whole. The biggest single clause is this one, at **38 cards**, twice the printed head.

    D445 already reads "Activate only as a sorcery" (213 cards) by taking the sentence off the end
    before the effect is read. This generalises that one regex into a list, because the printings
    combine the two clauses freely — see `activationRestriction`.
  */
  const once = (text: string, name = 'Darkthicket Wolf') => compileCard({
    name, type_line: 'Creature — Wolf', mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
    layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it('reads Darkthicket Wolf, whose whole card is the ability and the restriction', () => {
    const read = once('{2}{G}: Darkthicket Wolf gets +2/+2 until end of turn. Activate only once each turn.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities?.[0]?.onceEachTurn).toBe(true);
    // And the cost and the effect still read, which is the half a restriction reader can break.
    expect(read.script?.abilities?.[0]?.cost).toEqual({ mana: '{2}{G}' });
  });

  it.each([
    ['Azimaet Drake', 'Flying\n{U}: Azimaet Drake gets +1/+0 until end of turn. Activate only once each turn.', '{U}'],
    ['Frilled Oculus', '{1}{G}: Frilled Oculus gets +2/+2 until end of turn. Activate only once each turn.', '{1}{G}'],
    ['Basking Rootwalla', '{1}{G}: Basking Rootwalla gets +2/+2 until end of turn. Activate only once each turn.', '{1}{G}'],
  ])('reads it on printed %s', (name, text, cost) => {
    const read = once(text as string, name as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities?.[0]?.onceEachTurn).toBe(true);
    expect(read.script?.abilities?.[0]?.cost).toEqual({ mana: cost as string });
  });

  it('does not set the flag on an ability that does not print it', () => {
    /*
      The control, and the one that would catch a reader that set the flag unconditionally — which
      is the failure mode that costs a player a second activation their card allows. Same card,
      same cost, same effect, the sentence removed.
    */
    const read = once('{2}{G}: Darkthicket Wolf gets +2/+2 until end of turn.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities?.[0]?.onceEachTurn).toBeUndefined();
  });

  it('reads the two clauses together, in either printed order', () => {
    /*
      Why `activationRestriction` splits on "and only" rather than matching the sentence whole:
      four shapes, three regexes. D445's reading is the `sorcerySpeed` half.
    */
    for (const tail of [
      'Activate only as a sorcery and only once each turn.',
      'Activate only once each turn and only as a sorcery.',
    ]) {
      const read = once(`{2}{G}: Darkthicket Wolf gets +2/+2 until end of turn. ${tail}`);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread.map((u) => u.line)).toEqual([]);
      expect(read.script?.abilities?.[0]?.onceEachTurn).toBe(true);
      expect(read.script?.abilities?.[0]?.sorcerySpeed).toBe(true);
    }
  });

  it('still reads "Activate only as a sorcery" on its own, which D445 shipped', () => {
    const read = once('{2}{G}: Darkthicket Wolf gets +2/+2 until end of turn. Activate only as a sorcery.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities?.[0]?.sorcerySpeed).toBe(true);
    expect(read.script?.abilities?.[0]?.onceEachTurn).toBeUndefined();
  });

  it.each([
    /*
      **Three rows were here and are retired: D509 reads them.** They named
      "Activate only during your turn", "… during your upkeep" and "… during your turn, before
      attackers are declared" as the next three clauses in the queue at 18, 8 and 6 cards, and as
      deliberately left because "when" is a different question from "how often". They were the next
      increment, and the D509 block below is it — so these rows did their job, and this note is what
      they leave behind. (Ninth, tenth and eleventh stale refusal rows in the series; the first
      three whose increment shipped the same day.)

      What is left here is the clause still unread, and the reason the row exists at all: D487's
      whole-or-nothing rule, where it matters most. A restriction read in half is an ability the
      table offers at a moment the card forbids — worse than an unread line (D362) — so a clause
      this does not know refuses the line rather than dropping the sentence.
    */
    ['a board condition', 'Activate only if there are seven or more cards in your graveyard.'],
  ])('refuses the whole line for a restriction it cannot read: %s', (_label, tail) => {
    const read = once(`{2}{G}: Darkthicket Wolf gets +2/+2 until end of turn. ${tail as string}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(read.script?.abilities ?? []).toEqual([]);
  });
});

describe('"Activate only during …", the three timing clauses (D509)', () => {
  /*
    D508's sibling and the rest of the restriction family. After that increment the family
    re-measures at **480 cards one line away** on a line carrying "Activate only …", **104** of them
    with the restriction as the only unread thing, and these three clauses are 32 of those:

      18  Activate only during your turn, before attackers are declared.
       8  Activate only during your turn.
       6  Activate only during your upkeep.

    Thirty-two beats every shape in the printed queue, whose head is still the 19-card threshold
    bucket — 17 of which are the quoted-ability job (D508 records why that bucket is misleading).

    One field with three values rather than three flags, because the clauses are mutually exclusive
    readings of *when*. See `AbilityDef.timing` and `atActivationTiming`.
  */
  const timed = (
    text: string,
    name = 'Disrupting Scepter',
    type = 'Artifact',
  ) => compileCard({
    name, type_line: type, mana_cost: '{3}', cmc: 3, colors: [],
    layout: 'normal', power: null, toughness: null, oracle_text: text,
  });

  it.each([
    ['Disrupting Scepter', '{3}, {T}: Target player discards a card. Activate only during your turn.',
      'your-turn'],
    ['Alaborn Veteran',
      '{T}: Target creature gets +2/+2 until end of turn. '
      + 'Activate only during your turn, before attackers are declared.', 'before-attackers'],
    ['Dwarven Weaponsmith',
      '{T}, Sacrifice an artifact: Put a +1/+1 counter on target creature. '
      + 'Activate only during your upkeep.', 'your-upkeep'],
  ])('reads printed %s', (_name, text, timing) => {
    const read = timed(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities?.[0]?.timing).toBe(timing);
  });

  it('reads "before attackers are declared" as its own clause, not as "during your turn"', () => {
    /*
      **The assertion this increment can get wrong silently.** The long clause *starts with* the
      short one, so a chain that tried "during your turn" first would read Alaborn Veteran as
      restricted to the whole of its turn — a card that can tap in its second main phase, which it
      cannot. The order inside `activationRestriction` is what makes this pass, and this row is
      what would fail if the order were swapped.
    */
    const short = timed('{3}, {T}: Target player discards a card. Activate only during your turn.');
    const long = timed('{3}, {T}: Target player discards a card. '
      + 'Activate only during your turn, before attackers are declared.');
    expect(short.ok && long.ok).toBe(true);
    if (!short.ok || !long.ok) return;
    expect(short.script?.abilities?.[0]?.timing).toBe('your-turn');
    expect(long.script?.abilities?.[0]?.timing).toBe('before-attackers');
  });

  it('does not set a timing on an ability that does not print one', () => {
    // The control, for the same reason D508's block has one: a reader that set a timing
    // unconditionally would take instant speed away from every activated ability in the corpus.
    const read = timed('{3}, {T}: Target player discards a card.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities?.[0]?.timing).toBeUndefined();
  });

  it('combines a timing with D508\'s once-each-turn and D445\'s sorcery speed', () => {
    const read = timed('{3}, {T}: Target player discards a card. '
      + 'Activate only during your turn and only once each turn.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities?.[0]?.timing).toBe('your-turn');
    expect(read.script?.abilities?.[0]?.onceEachTurn).toBe(true);
  });

  it('refuses two timing clauses on one ability rather than letting one win', () => {
    /*
      No printing says two, so the engine is not owed an answer about which. A silent overwrite
      would be the half-read restriction the whole function exists to avoid (D487) — and it would
      read as the *second* clause, which is the one a reader would least expect.
    */
    const read = timed('{3}, {T}: Target player discards a card. '
      + 'Activate only during your upkeep and only during your turn.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(read.script?.abilities ?? []).toEqual([]);
  });

  it.each([
    ['a board condition', 'Activate only if there are seven or more cards in your graveyard.'],
    ['an opponent\'s turn', 'Activate only during an opponent\'s turn.'],
    ['a narrower combat window', 'Activate only during combat after blockers are declared.'],
  ])('still refuses the whole line for a clause it cannot read: %s', (_label, tail) => {
    // The next clauses in the family, each a real printing and each left on purpose.
    const read = timed(`{3}, {T}: Target player discards a card. ${tail as string}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('Soulshift N (D510)', () => {
  /*
    CR 702.46a: "When this creature dies, you may return target Spirit card with mana value N or
    less from your graveyard to your hand." **25 legal corpus cards print the bare line and 17 of
    them are one printed line from a finished script** — the queue head once D508 and D509 cleared
    the restriction family.

    A counted keyword like Bushido N (D503), and like it mostly a pair of mechanisms the engine
    already had: a self-subject `dies` trigger (#157), a graveyard target (#23) and `bounceToHand`.
    What is new is a graveyard filter that reads **two** things about a card — a subtype and a
    mana-value ceiling — and that it is the first thing in the engine to ask whether a *card* has a
    creature type. See `soulshiftTriggers` and `cardHasSubtype`.
  */
  const spirit = (text: string, name = 'Crawling Filth', cost = '{5}{B}', cmc = 6) => compileCard({
    name, type_line: 'Creature — Spirit', mana_cost: cost, cmc, colors: ['B'],
    layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  const REMINDER = (n: number) => `Soulshift ${n} (When this creature dies, you may return target `
    + `Spirit card with mana value ${n} or less from your graveyard to your hand.)`;

  it.each([3, 5, 8])('reads Soulshift %i, count and all', (n) => {
    const read = spirit(REMINDER(n as number));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers).toHaveLength(1);
    expect(read.script?.triggers?.[0]?.on).toEqual({ kind: 'dies' });
    // The count reaches the description, which is what a player reads on the stack.
    expect(read.script?.triggers?.[0]?.description).toContain(`mana value ${n} or less`);
    expect(read.script?.triggers?.[0]?.targets?.[0]?.kind).toBe('graveyard-card');
    /*
      **Mandatory, which is the thing a reader test can pin and the first version got wrong.**
      `optional: true` looked like the right home for the printed "you may" and meant the engine
      declined every soulshift in the game — nothing was ever returned. See `soulshiftTriggers`
      for the whole story and for what is left out instead (#328's family).
    */
    expect(read.script?.triggers?.[0]?.targets?.[0]?.optional).toBeUndefined();
  });

  it('reads it beside another keyword on the same card', () => {
    // Crawling Filth's actual printing: fear (D501) on one line, soulshift on the next.
    const read = spirit("Fear (This creature can't be blocked except by artifact creatures "
      + 'and/or black creatures.)\n' + REMINDER(5));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers).toHaveLength(1);
    expect(printedKeywords('Fear')).toEqual(['fear']);
  });

  it('reads Body of Jukai, whose other line is trample', () => {
    const read = spirit('Trample\n' + REMINDER(8), 'Body of Jukai', '{7}{G}{G}', 9);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.[0]?.description).toContain('mana value 8 or less');
  });

  it('refuses Forked-Branch Garami\'s doubled printing', () => {
    /*
      "Soulshift 4, soulshift 4" with reminder text that merges the two into **one ability with two
      targets** — which is a different rule from two copies of this one, so it is refused rather
      than read as either (D487). The only card in the corpus that prints it.
    */
    const read = spirit('Soulshift 4, soulshift 4 (When this creature dies, you may return up to '
      + 'two target Spirit cards with mana value 4 or less from your graveyard to your hand.)',
    'Forked-Branch Garami', '{3}{G}{G}', 5);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual(['Soulshift 4, soulshift 4']);
    expect(read.script?.triggers ?? []).toEqual([]);
  });

  it('refuses a soulshift with no number, which no card prints', () => {
    // The anchored `\d+` is what does this, and the row is here because a reader that defaulted the
    // count to zero or one would be a card that returns the wrong half of a graveyard.
    const read = spirit('Soulshift (When this creature dies, …)');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('knows a changeling card is a Spirit, and an ordinary creature card is not', () => {
    /*
      **D506's named-and-left, closed.** `cardHasSubtype` is the printed-card twin of `hasSubtype`:
      changeling is a characteristic-defining ability, so it works in a graveyard too, and a
      Woodland Changeling card there is a legal soulshift target. Asserted on the helper directly
      as well as at the table, because the helper is what a future `cardWordMatch` fix will call.
    */
    const changeling = {
      name: 'Woodland Changeling', typeLine: 'Creature — Shapeshifter', manaCost: '{1}{G}',
      oracleText: 'Changeling (This card is every creature type.)',
    };
    expect(cardHasSubtype(changeling as never, 'Spirit')).toBe(true);
    expect(cardHasSubtype(changeling as never, 'Goblin')).toBe(true);
    // Not a creature type, so not even a changeling has it.
    expect(cardHasSubtype(changeling as never, 'Equipment')).toBe(false);
    // And the control: an ordinary Wolf card is a Wolf and nothing else.
    const wolf = {
      name: 'Darkthicket Wolf', typeLine: 'Creature — Wolf', manaCost: '{1}{G}', oracleText: '',
    };
    expect(cardHasSubtype(wolf as never, 'Wolf')).toBe(true);
    expect(cardHasSubtype(wolf as never, 'Spirit')).toBe(false);
  });

  it('does not extend a noncreature card that happens to print the word', () => {
    // The guard that keeps `cardHasSubtype` honest: changeling is a creature-type ability, so an
    // artifact whose text mentioned it would still not be a Spirit.
    const relic = {
      name: 'Not A Creature', typeLine: 'Artifact — Equipment', manaCost: '{2}',
      oracleText: 'Changeling (This card is every creature type.)',
    };
    expect(cardHasSubtype(relic as never, 'Spirit')).toBe(false);
    expect(cardHasSubtype(relic as never, 'Equipment')).toBe(true);
  });
});

describe('a quoted triggered ability an Aura or Equipment grants (D511)', () => {
  /*
    **The biggest family in the one-away queue, and the first increment into it.** 583 legal cards
    are one printed line away on a line carrying quoted text — four times anything else. Grouped by
    the *outer* sentence, because the subject decides the mechanism: 87 are an Aura or Equipment
    granting an **activated or static** ability (no engine field exists for that), 37 are one
    granting a **triggered** ability, 48 are Sliver and Commander-background team grants, 17 are the
    threshold tails.

    This reads the triggered attachment grants, and the whole implementation is **recursion**:
    `grantedTriggerFrom` hands the quoted text to `lineScriptFor`, the compiler's own per-line
    reader, because the quoted text *is* a line. No new engine field — #230 already shipped
    `grantedTriggers` plus `grants` holding indices into it. See `grantedTriggerFrom`.
  */
  const aura = (text: string, name = "Commander's Authority") => compileCard({
    name, type_line: 'Enchantment — Aura', mana_cost: '{4}{W}', cmc: 5, colors: ['W'],
    layout: 'normal', power: null, toughness: null, oracle_text: text,
  });
  const equipment = (text: string, name = 'Combat Research') => compileCard({
    name, type_line: 'Artifact — Equipment', mana_cost: '{1}', cmc: 1, colors: [],
    layout: 'normal', power: null, toughness: null, oracle_text: text,
  });

  it('reads Commander\'s Authority: the quote alone', () => {
    const read = aura('Enchant creature\nEnchanted creature has "At the beginning of your upkeep, '
      + 'create a 1/1 white Human creature token."');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedTriggers).toHaveLength(1);
    expect(read.script?.grantedTriggers?.[0]?.on).toEqual({ kind: 'step', step: 'upkeep', of: 'you' });
    // The two halves of #230's design: the table on the card, the indices on the effect.
    expect(read.script?.aura?.effect?.grants).toEqual([0]);
  });

  it('reads Cathar\'s Call: a keyword and the quote on one line', () => {
    /*
      The second printing shape, and the one that says why the quote is split off **before**
      `grantedKeywords` rather than inside it: the quoted sentence contains commas, and the keyword
      splitter would shred it. That is precisely what used to refuse this whole family.
    */
    const read = aura('Enchant creature\nEnchanted creature has vigilance and "At the beginning of '
      + 'your end step, create a 1/1 white Human creature token."', "Cathar's Call");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.aura?.effect?.keywords).toEqual(['vigilance']);
    expect(read.script?.aura?.effect?.grants).toEqual([0]);
    expect(read.script?.grantedTriggers?.[0]?.on).toEqual({ kind: 'step', step: 'end', of: 'you' });
  });

  it('reads it on an Equipment too, through the same bonus', () => {
    // Combat Research's printing. The grant reaches an Equipment's bonus because `modsFrom` is one
    // function for all five grant sites — an Aura's effect, a bestowed one, an Equipment's bonus,
    // a statics entry and soulbond's pair (#230).
    const read = equipment('Equipped creature has "Whenever this creature deals combat damage to a '
      + 'player, draw a card."\nEquip {1}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedTriggers).toHaveLength(1);
    expect(read.script?.equipBonus?.grants).toEqual([0]);
  });

  it.each([
    ['Sixth Sense', 'Whenever this creature deals combat damage to a player, you may draw a card.'],
    ['Sticky Fingers', 'Whenever this creature deals combat damage to a player, create a Treasure token.'],
    ['Necrosynthesis', 'Whenever another creature dies, put a +1/+1 counter on this creature.'],
    ['Pillory of the Sleepless', 'At the beginning of your upkeep, you lose 1 life.'],
    ['Nurturing Presence', 'Whenever a creature you control enters, this creature gets +1/+1 until end of turn.'],
  ])('reads the quote on printed %s', (name, inner) => {
    const read = aura(`Enchant creature\nEnchanted creature has "${inner as string}"`, name as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedTriggers).toHaveLength(1);
    expect(read.script?.aura?.effect?.grants).toEqual([0]);
  });

  it.each([
    ['Power Fist: "that many", which refers to damage the reader cannot carry forward',
      'Whenever this creature deals combat damage to a player, put that many +1/+1 counters on it.'],
    ['Withercrown: an "unless" clause on a step trigger',
      'At the beginning of your upkeep, you lose 1 life unless you sacrifice this creature.'],
    ['Idolized: a bonus whose X is a count of the board',
      'Whenever this creature attacks alone, it gets +X/+X until end of turn, where X is the number of nonland permanents you control.'],
  ])('refuses the whole line when the quoted text does not read: %s', (_why, inner) => {
    /*
      **This is where the real bottleneck turned out to be, and the measurement corrected my own
      prediction.** I scoped this increment at 25 cards from the *outer* shape and it finished 6,
      because of the 87 distinct quotations the corpus prints inside an attachment line only 8 read
      as triggers: 28 are activated abilities and 51 the reader refuses outright — see the D511
      entry in `claude/decisions-log.md` for the table and what it says to do next. The grant
      mechanism was never the gate.

      Refusing the whole line is D487, and it matters more here than usual: a reader that dropped an
      unreadable quote would be an Aura that attaches, grants a keyword it also prints, and silently
      withholds the ability that is most of the card.
    */
    const read = aura(`Enchant creature\nEnchanted creature has "${inner as string}"`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(read.script?.grantedTriggers ?? []).toEqual([]);
    // The Aura still attaches, which is D456: an unreadable bonus line keeps its badge and the
    // card stays playable rather than compiling to nothing at all.
    expect(read.script?.aura).toBeDefined();
  });

  it('reads a quoted ACTIVATED ability as an ability, not as a trigger (D512)', () => {
    /*
      **This row was a refusal, and D512 turned it into a reading.** It used to assert that a quoted
      activated ability was refused, because `grants` carried indices into `grantedTriggers` and
      there was no `grantedAbilities` to put one in — the 28 distinct texts across 38 legal cards
      this increment's own measurement named as the family's gate. The field exists now, so the card
      reads; what is still true, and what this row keeps, is that the trigger table stays **empty**:
      `grantedTriggerFrom` refuses a reading with no `triggers` in it, and the ability lands in the
      other table rather than being mistaken for a trigger.
    */
    const read = aura('Enchant creature\nEnchanted creature has "{T}: Add one mana of any color."');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedTriggers ?? []).toEqual([]);
    expect(read.script?.grantedAbilities).toHaveLength(5);
  });

  it('refuses a quoted keyword, which would otherwise read as a grant of nothing', () => {
    /*
      A quoted text that compiles to keywords rather than triggers. No printing says it this way;
      the row is here because it is the one refusal whose reading is a *successful* line reading —
      `lineScriptFor` returns `{ keywords: ['flying'] }` — so it proves the refusal is about the
      shape of what came back and not about the reader having failed. Like the activated-ability row
      above, it is the `triggers === undefined` check that refuses it.
    */
    const read = aura('Enchant creature\nEnchanted creature has "Flying"');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(read.script?.grantedTriggers ?? []).toEqual([]);
  });
});

describe('a quoted activated ability an Aura or Equipment grants (D512)', () => {
  /*
    **The bucket D511's measurement named.** Of the 87 distinct quotations the corpus prints inside
    an `(Enchanted|Equipped) creature has "…"` line, 8 are triggers (D511), 51 the reader refuses,
    and **28 are activated abilities** across 38 legal cards — and until this increment there was
    nowhere to put one: `ContinuousEffect.grants` carries indices into `grantedTriggers` and there
    was no `grantedAbilities` beside it.

    The reader is `grantedTriggerFrom`'s sibling and shares its shape: hand the quotation back to
    `lineScriptFor`, demand the result be *exactly* abilities, and refuse the whole line otherwise
    (D487). What is new is the engine behind it — a second index list on the effect, the ability
    offered on the **host** in `legalActions`, paid for by the host in `autoActions`, and resolved
    by asking the stack object's kind which of the grantor's two tables to read.
  */
  const aura = (text: string, name = 'Fire Whip') => compileCard({
    name, type_line: 'Enchantment — Aura', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
    layout: 'normal', power: null, toughness: null, oracle_text: text,
  });
  const equipment = (text: string, name = 'Viridian Longbow') => compileCard({
    name, type_line: 'Artifact — Equipment', mana_cost: '{1}', cmc: 1, colors: [],
    layout: 'normal', power: null, toughness: null, oracle_text: text,
  });

  it('reads Fire Whip: a {T} ability on the host', () => {
    const read = aura('Enchant creature you control\nEnchanted creature has "{T}: This creature '
      + 'deals 1 damage to any target."');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedAbilities).toHaveLength(1);
    expect(read.script?.grantedAbilities?.[0]?.cost.tap).toBe(true);
    expect(read.script?.grantedAbilities?.[0]?.description)
      .toBe('{T}: This creature deals 1 damage to any target.');
    // The effect carries indices, not the ability: see `ContinuousEffect.grantsAbilities`.
    expect(read.script?.aura?.effect?.grantsAbilities).toEqual([0]);
    // And not the trigger list, which is the other table (D511).
    expect(read.script?.grantedTriggers).toBeUndefined();
  });

  it('reads Viridian Longbow: the same reader on an Equipment', () => {
    const read = equipment('Equipped creature has "{T}: This creature deals 1 damage to any '
      + 'target."\nEquip {3}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedAbilities).toHaveLength(1);
    expect(read.script?.equipBonus?.grantsAbilities).toEqual([0]);
  });

  it("reads Karametra's Favor as five abilities, one per colour", () => {
    /*
      "Add one mana of any color" is five rows rather than one, which is the shape the hand-written
      Birds of Paradise has had since #49 and which `manaSources` collapses back into a single
      source offering a choice. Worth a row of its own because it is the one quotation in the family
      that reads as *several* abilities, so it is the one that proves the index list is a list.
    */
    const read = aura('Enchant creature\nEnchanted creature has "{T}: Add one mana of any color."',
      "Karametra's Favor");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedAbilities).toHaveLength(5);
    expect(read.script?.grantedAbilities?.flatMap((a) => a.produces ?? []))
      .toEqual(['W', 'U', 'B', 'R', 'G']);
    expect(read.script?.aura?.effect?.grantsAbilities).toEqual([0, 1, 2, 3, 4]);
  });

  it.each([
    ['Midnight Covenant', '{B}: This creature gets +1/+1 until end of turn.'],
    ['Dragon Mantle', '{R}: This creature gets +1/+0 until end of turn.'],
    ['Sadistic Obsession', '{B}, {T}: Put a -1/-1 counter on target creature.'],
    ['Presence of Gond', '{T}: Create a 1/1 green Elf Warrior creature token.'],
    ['Ocular Halo', '{T}: Draw a card.'],
    ['Sinstriker\'s Will',
      '{T}: This creature deals damage equal to its power to target attacking or blocking creature.'],
  ])('reads the quoted ability on printed %s', (name, inner) => {
    const read = aura(`Enchant creature\nEnchanted creature has "${inner as string}"`, name as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.grantedAbilities).toHaveLength(1);
    expect(read.script?.aura?.effect?.grantsAbilities).toEqual([0]);
  });

  it.each([
    ["Ninja's Kunai", '{1}, {T}, Sacrifice Ninja\'s Kunai: Ninja\'s Kunai deals 3 damage to any target.'],
    ['Trusty Boomerang',
      '{1}, {T}: Tap target creature. Return Trusty Boomerang to its owner\'s hand.'],
  ])('refuses a quotation that names its own grantor: %s', (name, inner) => {
    /*
      **The two cards this increment found by probing printings rather than by reading.** Both quote
      their own name inside the granted ability, and the compiler binds a card's own name to the
      ability's *source* — which for a granted ability is the host (CR 113.6). So both compiled, and
      both were wrong in the worst available way: Ninja's Kunai's granted ability would have
      sacrificed the **creature**, and Trusty Boomerang's would have returned the creature to its
      owner's hand. There is no "the permanent that granted this" to compile them against, so the
      line is refused. See `namesItsGrantor`.
    */
    const read = equipment(`Equipped creature has "${inner as string}"\nEquip {1}`, name as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(read.script?.grantedAbilities ?? []).toEqual([]);
    expect(read.script?.equipBonus?.grantsAbilities).toBeUndefined();
  });

  it('refuses a quoted ability whose inner text the compiler cannot read', () => {
    // Leyline Immersion's printing, which is also the keyword-and-quote shape: five mana in any
    // combination with a spending restriction is not a reading this compiler has, so the line goes
    // unread rather than compiling to a weaker ability (D487).
    const read = aura('Enchant legendary creature\nEnchanted creature has ward {2} and "{T}: Add '
      + 'five mana in any combination of colors. Spend this mana only to cast spells."',
      'Leyline Immersion');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Two unread lines, not one: `Enchant legendary creature` is a restriction this compiler does
    // not read either, which the row says out loud rather than asserting a count that hides it.
    expect(read.unread.map((u) => u.line)).toEqual([
      'Enchant legendary creature',
      'Enchanted creature has ward {2} and "{T}: Add five mana in any combination of colors. '
        + 'Spend this mana only to cast spells."',
    ]);
    expect(read.script?.grantedAbilities ?? []).toEqual([]);
  });

  it('still reads a quoted TRIGGER, which is the other table (D511)', () => {
    // The regression row: one branch reads both kinds now, so the trigger path has to be checked
    // where the ability path was added rather than only where it was written.
    const read = aura('Enchant creature\nEnchanted creature has "At the beginning of your upkeep, '
      + 'create a 1/1 white Human creature token."', "Commander's Authority");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.grantedTriggers).toHaveLength(1);
    expect(read.script?.grantedAbilities).toBeUndefined();
    expect(read.script?.aura?.effect?.grants).toEqual([0]);
    expect(read.script?.aura?.effect?.grantsAbilities).toBeUndefined();
  });
});

describe('the threshold quoted tail: a card that grants itself an ability (D513)', () => {
  /*
    **The head of the one-away queue, and what the measurement said it was.** 40 legal cards print
    `Threshold — As long as there are seven or more cards in your graveyard, …`; 22 are exactly one
    line short, and **17 of those have a quoted tail** — the card handing *itself* an ability for as
    long as the condition holds.

    Nothing new is needed under this reader. D511 built the recursive quoted reader, D512 added the
    activated table beside it, and `ContinuousEffect.while` has carried the threshold condition since
    D502: this is those three meeting on a `scope: 'self'` static. The two things that *were* new are
    both in `thresholdEffect` — the quote comes off before the part splitter runs (a quotation
    contains commas and "and"), and `selfGrant` turns off the self-naming guard, because here the
    card naming itself inside the quote is binding to the right permanent.
  */
  const card = (
    name: string, text: string, typeLine = 'Creature — Horror', cost = '{2}{B}',
    power = '2', toughness = '2',
  ) => compileCard({
    name, type_line: typeLine, mana_cost: cost, cmc: 4, colors: ['B'],
    layout: 'normal', power, toughness, oracle_text: text,
  });

  const thresholdOf = (read: ReturnType<typeof compileCard>) =>
    (read.ok ? read.script?.statics ?? [] : []).find((s) => s.effect.while !== undefined);

  it('reads Cephalid Sage: the quote is the whole predicate', () => {
    const read = card('Cephalid Sage', 'Threshold — As long as there are seven or more cards in '
      + 'your graveyard, Cephalid Sage has "When Cephalid Sage enters, draw three cards, then '
      + 'discard two cards."', 'Creature — Octopus', '{3}{U}', '2', '3');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedTriggers).toHaveLength(1);
    const threshold = thresholdOf(read);
    expect(threshold?.effect.grants).toEqual([0]);
    expect(threshold?.effect.while).toEqual({ kind: 'controller-graveyard', atLeast: 7 });
    // No pump: the whole of this card's threshold is the ability, and an empty bonus is a real
    // reading rather than a failure to find one.
    expect(threshold?.effect.power).toBeUndefined();
  });

  it('reads Fledgling Dragon: a pump AND a granted activated ability that names itself', () => {
    /*
      **The `selfGrant` row.** The quotation says "Fledgling Dragon gets +1/+0", which names the card
      granting it — and D512's guard refuses exactly that on an attachment, because an Aura's
      quotation binds its own name to the host. Here the grantor *is* the host, so the guard is off
      and the card reads. Without the flag this row fails and ten of the seventeen stay unread.
    */
    const read = card('Fledgling Dragon', 'Flying\nThreshold — As long as there are seven or more '
      + 'cards in your graveyard, Fledgling Dragon gets +3/+3 and has "{R}: Fledgling Dragon gets '
      + '+1/+0 until end of turn."', 'Creature — Dragon', '{2}{R}{R}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedAbilities).toHaveLength(1);
    expect(read.script?.grantedAbilities?.[0]?.cost.mana).toBe('{R}');
    const threshold = thresholdOf(read);
    expect(threshold?.effect.grantsAbilities).toEqual([0]);
    expect([threshold?.effect.power, threshold?.effect.toughness]).toEqual([3, 3]);
  });

  it('reads Possessed Aven: three parts, one of them a colour change', () => {
    /*
      `gets +1/+1, is black, and has "…"` — which is why the part splitter now splits on commas as
      well as "and", and why `is black` is a part at all. The colour is not decoration: the Aven's
      own ability destroys a **blue** creature, and a reader that kept the printed colour would have
      a blue creature holding a gun pointed at itself.
    */
    const read = card('Possessed Aven', 'Flying\nThreshold — As long as there are seven or more '
      + 'cards in your graveyard, Possessed Aven gets +1/+1, is black, and has "{2}{B}, {T}: '
      + 'Destroy target blue creature."', 'Creature — Bird Soldier Horror', '{2}{U}{U}', '3', '3');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const threshold = thresholdOf(read);
    expect(threshold?.effect.setColors).toEqual(['B']);
    expect([threshold?.effect.power, threshold?.effect.toughness]).toEqual([1, 1]);
    expect(threshold?.effect.grantsAbilities).toEqual([0]);
    expect(read.script?.grantedAbilities?.[0]?.cost.mana).toBe('{2}{B}');
    expect(read.script?.grantedAbilities?.[0]?.cost.tap).toBe(true);
  });

  it('reads Wayward Angel: four parts, the longest printing in the family', () => {
    const read = card('Wayward Angel', 'Flying, vigilance\nThreshold — As long as there are seven '
      + 'or more cards in your graveyard, Wayward Angel gets +3/+3, is black, has trample, and has '
      + '"At the beginning of your upkeep, sacrifice a creature."', 'Creature — Angel Horror',
      '{4}{W}{W}', '4', '4');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const threshold = thresholdOf(read);
    expect(threshold?.effect.keywords).toEqual(['trample']);
    expect(threshold?.effect.setColors).toEqual(['B']);
    expect(threshold?.effect.grants).toEqual([0]);
  });

  it.each([
    ['Centaur Chieftain',
      'When Centaur Chieftain enters, creatures you control get +1/+1 and gain trample until end of turn.'],
    ['Pardic Arsonist', 'When Pardic Arsonist enters, it deals 3 damage to any target.'],
  ])('reads the quoted trigger on printed %s', (name, inner) => {
    const read = card(name as string, 'Threshold — As long as there are seven or more cards in your '
      + `graveyard, ${name as string} has "${inner as string}"`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedTriggers).toHaveLength(1);
  });

  it('reads Boneshard Slasher, which D513 could not and D514 could', () => {
    /*
      **A refusal row that became a reading one increment later**, and worth keeping as the pair.
      D513 shipped with this card unread because its quotation — "When ~ becomes the target of a
      spell or ability, sacrifice it" — had no reader; D514 read that trigger and its tail for the
      15 cards that print it bare, and the quoted copy came with them for nothing. The whole-line
      rule is why it works at all: the pump in front of the quote was always readable, and refusing
      the line rather than keeping the half it understood is what left the card correct to finish
      rather than wrong and finished.
    */
    const read = card('Boneshard Slasher', 'Flying\nThreshold — As long as there are seven or more '
      + 'cards in your graveyard, Boneshard Slasher gets +2/+2 and has "When Boneshard Slasher '
      + 'becomes the target of a spell or ability, sacrifice it."');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.grantedTriggers).toHaveLength(1);
    const threshold = thresholdOf(read);
    expect(threshold?.effect.grants).toEqual([0]);
    expect([threshold?.effect.power, threshold?.effect.toughness]).toEqual([2, 2]);
  });

  it.each([
    ['Gloomdrifter: an ETB that pumps a colour-defined group',
      'Gloomdrifter has "When Gloomdrifter enters, nonblack creatures get -2/-2 until end of turn."'],
    ['Hunting Grounds: a trigger on an opponent casting a spell',
      'Hunting Grounds has "Whenever an opponent casts a spell, you may put a creature card from '
      + 'your hand onto the battlefield."'],
  ])('refuses the whole line when the quoted text does not read: %s', (_why, tail) => {
    /*
      D487 again, and the reason it matters more on this shape than on most: the pump in front of the
      quote *does* read. A reader that kept the half it understood would give Boneshard Slasher
      +2/+2 at threshold and silently drop the drawback that is the rest of the card — a strictly
      better creature than the one printed.
    */
    const read = card('Boneshard Slasher', 'Threshold — As long as there are seven or more cards in '
      + `your graveyard, ${tail as string}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
    expect(read.script?.grantedTriggers ?? []).toEqual([]);
    expect(read.script?.grantedAbilities ?? []).toEqual([]);
    expect(thresholdOf(read)).toBeUndefined();
  });

  it('still reads a threshold line with no quote at all (D502)', () => {
    // The regression row: this branch now goes through a wrapper, so the plain shape is checked
    // where the wrapper was added rather than only where it was written.
    const read = card('Mystic Enforcer', 'Threshold — As long as there are seven or more cards in '
      + 'your graveyard, Mystic Enforcer gets +3/+3 and has flying.',
      'Creature — Human Nomad Mystic', '{1}{G}{W}', '3', '3');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const threshold = thresholdOf(read);
    expect([threshold?.effect.power, threshold?.effect.toughness]).toEqual([3, 3]);
    expect(threshold?.effect.keywords).toEqual(['flying']);
    expect(threshold?.effect.grants).toBeUndefined();
    expect(threshold?.effect.grantsAbilities).toBeUndefined();
  });
});

describe('the Illusion drawback and the bare mill (D514)', () => {
  /*
    `When ~ becomes the target of a spell or ability, sacrifice it.` — **15 legal cards**, 13 of them
    with no other unread line, and three small things in the way of all of them:

      1. the prologue read `Whenever` and not `When`. CR 603.1 makes no distinction; the split is
         historical, the old Illusion drawback saying "When" and the modern upside "Whenever";
      2. the **opponent-restricted** printing had no row at all — `… an opponent controls`, which is
         what Old Fat Spider, Battle Mammoth and Ruric Thar print, and which differs in `by`;
      3. the tail `sacrifice it` had nowhere to go. `sacrifice <permanent>` elsewhere in this file is
         the sacrifice the controller *chooses*, so sending this clause there would ask a player
         which of their creatures to sacrifice when the card names one.

    Both additions are **clauses rather than lines**, which is why the coverage jump was five times
    the bucket: `sacrifice it` and `mill N cards` turn up in ETB triggers, activated abilities and
    spells as readily as in this trigger.
  */
  const creature = (
    name: string, text: string, typeLine = 'Creature — Illusion', cost = '{1}{U}',
    power = '2', toughness = '1',
  ) => compileCard({
    name, type_line: typeLine, mana_cost: cost, cmc: 2, colors: ['U'],
    layout: 'normal', power, toughness, oracle_text: text,
  });

  it.each([
    ['Frost Walker', 'When Frost Walker becomes the target of a spell or ability, sacrifice it.'],
    ['Gossamer Phantasm',
      'Flying\nWhen Gossamer Phantasm becomes the target of a spell or ability, sacrifice it.'],
    ['Illusionary Servant',
      'Flying\nWhen Illusionary Servant becomes the target of a spell or ability, sacrifice it.'],
  ])('reads printed %s whole', (name, text) => {
    const read = creature(name as string, text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const trigger = read.script?.triggers?.find((t) => t.on.kind === 'targeted');
    expect(trigger).toBeDefined();
    /*
      **`by: 'any'`, which is the whole of the card.** The event's default is `opponent`, because
      ward was the only thing that used it — and an Illusion that survived its own controller's
      Giant Growth would be a strictly better creature than the one printed.
    */
    expect(trigger?.on.kind === 'targeted' ? trigger.on.by : null).toBe('any');
  });

  it('reads the opponent-restricted printing, which is a different trigger', () => {
    const read = creature('Old Fat Spider', 'Reach\nThis creature can\'t be blocked by creatures '
      + 'with power 2 or less.\nWhenever this creature becomes the target of a spell or ability an '
      + 'opponent controls, draw a card.', 'Creature — Spider', '{4}{G}{G}', '6', '7');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const trigger = read.script?.triggers?.find((t) => t.on.kind === 'targeted');
    expect(trigger?.on.kind === 'targeted' ? trigger.on.by : null).toBe('opponent');
  });

  it('reads a bare mill as the controller milling (CR 701.13a)', () => {
    const read = creature('Cephalid Aristocrat', 'Whenever Cephalid Aristocrat becomes the target '
      + 'of a spell or ability, mill two cards.', 'Creature — Octopus Noble', '{4}{U}', '3', '3');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers).toHaveLength(1);
  });

  it.each([
    ['an optional draw, which needs a "you may" gate (#337)',
      'Whenever Battle Mammoth becomes the target of a spell or ability an opponent controls, you '
      + 'may draw a card.'],
    ['a sacrifice with a price attached, which is echo\'s shape (#196)',
      'Whenever Cursed Monstrosity becomes the target of a spell or ability, sacrifice it unless '
      + 'you discard a land card.'],
  ])('leaves the neighbour unread: %s', (_why, text) => {
    /*
      The two tails beside the one this increment read, pinned so the next person measuring the
      family sees where the line is. Neither is a reading this compiler has: the first needs the
      optional gate #337 is about, the second a cost vocabulary (the 44-card `unless you <cost>`
      family the sacrifice docblock counts).
    */
    const read = creature('Cursed Monstrosity', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('the Act of Treason sentence, read as one group (D516)', () => {
  /*
    `Gain control of target creature until end of turn. Untap that creature. It gains haste until
    end of turn.` — **15 legal cards** had it as their only unread line, and 38 printings print the
    first sentence of it.

    Read as a group rather than clause by clause, and the reason is D362 rather than convenience.
    "That creature" and "it" are the *target* here, and this compiler's referent machinery would
    read them as something else: `it gains haste` through `selfEffect` hands the **spell** haste and
    does nothing at all, which is a card that resolves and silently buys nothing. The three parts
    also cannot be allowed to drift apart — without the untap a stolen tapped creature does nothing,
    without the haste it is summoning-sick for its new controller (CR 302.6), and without the
    duration it never goes home — so `stealUntilEndOfTurn` is the one function all of it lives in,
    and the pool's hand-written Act of Treason was rewritten onto the same function.
  */
  const sorcery = (name: string, text: string, cost = '{2}{R}', cmc = 3) => compileCard({
    name, type_line: 'Sorcery', mana_cost: cost, cmc, colors: ['R'],
    layout: 'normal', oracle_text: text,
  });

  const STEAL = 'Gain control of target creature until end of turn. Untap that creature. '
    + 'It gains haste until end of turn.';

  it('reads Act of Treason, reminder text and all', () => {
    const read = sorcery('Act of Treason', `${STEAL} (It can attack and {T} this turn.)`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets).toHaveLength(1);
  });

  it('reads the bare printing, which is the commonest shape', () => {
    // Song-Mad Treachery's front face, Tentative Connection's and Take for a Ride's second line.
    const read = sorcery('Portent of Betrayal', `${STEAL} Scry 1.`, '{3}{R}', 4);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('reads the pump that rides with the haste (Malevolent Whispers)', () => {
    const read = sorcery('Malevolent Whispers', 'Gain control of target creature until end of turn.'
      + ' Untap that creature. It gets +2/+0 and gains haste until end of turn.', '{3}{R}', 4);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('reads the same pump with the duration at the front (Traitorous Instinct)', () => {
    /*
      One card, and the reason it is worth a row rather than a widened regex with no test: the
      duration is printed at *either* end of the clause and this reader accepts both, so a later
      change that drops one form has a row that says so.
    */
    const read = sorcery('Traitorous Instinct', 'Gain control of target creature until end of turn.'
      + ' Untap that creature. Until end of turn, it gets +2/+0 and gains haste.', '{3}{R}', 4);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it.each([
    ['menace, printed after the haste (Lose Calm)',
      'Gain control of target creature until end of turn. Untap that creature. It gains haste and '
      + 'menace until end of turn.'],
    ['trample, printed before it (Traitorous Blood)',
      'Gain control of target creature until end of turn. Untap it. It gains trample and haste '
      + 'until end of turn.'],
  ])('reads a second granted keyword: %s', (_why, text) => {
    /*
      The keyword list goes through `grantedKeywords`, which validates it against
      `printedKeywords` — the function the engine uses to read a keyword line back. So a word the
      engine could not apply refuses the line instead of granting nothing.
    */
    const read = sorcery('Lose Calm', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('reads the tail after the group, by handing it back to the ordinary composer', () => {
    // Bond of Passion. The steal is three clauses; the damage is the fourth and is read as itself.
    const read = sorcery('Bond of Passion',
      `${STEAL} Bond of Passion deals 2 damage to any other target.`, '{4}{R}{R}', 6);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Two independent target choices cannot share one `targets` list, so the line refuses (D487).
    expect(read.unread).toHaveLength(1);
  });

  it.each([
    ['a quoted ability granted to a creature you do not own (Furnace Reins)',
      'Gain control of target creature until end of turn. Untap that creature. Until end of turn, '
      + 'it gains haste and "Whenever this creature deals combat damage to a player or battle, '
      + 'create a Treasure token."'],
    ['a Blood token this compiler has no reader for (Bloody Betrayal)',
      'Gain control of target creature until end of turn. Untap that creature. It gains haste '
      + 'until end of turn. Create a Blood token.'],
    ['a counter put on before the untap (Mark of Mutiny)',
      'Gain control of target creature until end of turn. Put a +1/+1 counter on it and untap it. '
      + 'That creature gains haste until end of turn.'],
  ])('refuses the whole line rather than half of it: %s', (_why, text) => {
    /*
      D487 in three variants. Each of these *starts* with a sentence this reader knows, and reading
      the steal while dropping the rest would be a card that resolves and silently does part of what
      it prints. The first is refused by `grantedKeywords` (the quotation splits into fragments
      `printedKeywords` does not recognise), the second and third by the clauses around the group.
    */
    const read = sorcery('Bloody Betrayal', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('refuses a steal whose tail grants no haste at all', () => {
    /*
      No legal card prints this; it is the guard rather than a card. `stealUntilEndOfTurn` adds
      haste itself, so a tail that does not ask for it is a clause this reader has no business
      answering for, and letting it through would hand a creature haste its card never promised.
    */
    const read = sorcery('Not A Card', 'Gain control of target creature until end of turn. Untap '
      + 'that creature. It gains flying until end of turn.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('Devoid on a spell counts as read (D516)', () => {
  /*
    D515 made devoid real — `printedColors` returns no colours for a card that prints it — but only
    the permanent compile path said so. A spell's keyword declarations go through `spellScriptFor`,
    where a keyword nothing can *build* lands in `declared` and is reported unread, and devoid was
    going there. The same printed word was therefore compiled on a devoid creature and unread on a
    devoid instant, while the engine played both colourless.

    **Five legal spells** had `Devoid` as their only unread line: Turn Against, Consuming Sinkhole,
    Oblivion Strike, Reality Hemorrhage and Unnatural Endurance.
  */
  it('reads Turn Against, whose only unread line was Devoid', () => {
    const read = compileCard({
      name: 'Turn Against', type_line: 'Instant', mana_cost: '{4}{R}', cmc: 5, colors: ['R'],
      layout: 'normal',
      oracle_text: 'Devoid (This card has no color.)\nGain control of target creature until end of '
        + 'turn. Untap that creature. It gains haste until end of turn.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('still reports a keyword nothing reads as unread', () => {
    /*
      The complement, so the row above cannot be met by counting every keyword declaration on a
      spell compiled. Entwine is a cast-time choice this compiler has no reader for, and a spell
      that printed it would be played without it.
    */
    const read = compileCard({
      name: 'Not A Card', type_line: 'Instant', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
      layout: 'normal', oracle_text: 'Entwine {2}\nNot A Card deals 2 damage to any target.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual(['Entwine {2}']);
  });

  it('is the only part of its family a spell can print', () => {
    // See `isDevoidLine`: landwalk, protection and the combat statics are battlefield facts.
    expect(isDevoidLine('Devoid')).toBe(true);
    expect(isDevoidLine('Devoid (This card has no color.)')).toBe(true);
    expect(isDevoidLine('Islandwalk')).toBe(false);
    expect(isDevoidLine('Protection from red')).toBe(false);
    expect(isDevoidLine('Target creature becomes devoid until end of turn')).toBe(false);
  });
});

describe('the Unearth keyword line, read as one fragment (D517)', () => {
  /*
    `Unearth {cost}` (CR 702.84). **56 distinct legal names print it and 25 had it as their only
    unread line** — Dregscape Zombie, Hellspark Elemental, Corpse Connoisseur, First-Sphere
    Gargantua, Grixis Slavedriver, Hell's Thunder, Shambling Remains, Viscera Dragger and the rest.

    The mechanic was not the gap. The engine has played unearth since D183, and the pool carries two
    hand-written unearth cards. What stood in the way was the **shape**: the exile was a delayed
    trigger (CR 603.7) scheduled by its own *index* into the card's `triggers` list, so the ability
    builder took a `() => CardScript` thunk and read the index back off the finished script. A
    compiled card has no finished script while a line is being read — `compile.ts` assembles the
    trigger list from every line — so there was no fragment to emit, which is what the standing note
    in `keywordScriptFor` said.

    D517 reads the exile off the body's `UNEARTHED` counter instead. See `unearthExile` for why that
    is the same card and for the one difference worth stating; the point here is that it removes the
    index, so `unearthFragment` is one builder the pool's hand-written cards and this line share.
  */
  const creature = (
    name: string, text: string, typeLine = 'Creature — Zombie Warrior', cost = '{1}{B}',
    power = '2', toughness = '1',
  ) => compileCard({
    name, type_line: typeLine, mana_cost: cost, cmc: 2, colors: ['B'],
    layout: 'normal', power, toughness, oracle_text: text,
  });

  it('reads Dregscape Zombie, whose whole text is the keyword', () => {
    const read = creature('Dregscape Zombie', 'Unearth {B}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    // All three halves, because any subset is a card better than the printed one.
    expect(read.script?.abilities).toHaveLength(1);
    expect(read.script?.triggers).toHaveLength(1);
    expect(read.script?.replaces).toHaveLength(1);
  });

  it('emits the ability as a graveyard cost at sorcery speed, not a cast', () => {
    const read = creature('Dregscape Zombie', 'Unearth {B}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const ability = read.script?.abilities?.[0];
    expect(ability?.cost.mana).toBe('{B}');
    expect(ability?.cost.fromGraveyard).toBe(true);
    expect(ability?.sorcerySpeed).toBe(true);
  });

  it('does NOT claim the body leaves at end of turn', () => {
    /*
      The bot hint, and the one field the fragment deliberately leaves alone. `leavesAtEndOfTurn`
      answers "will this creature still be here next turn", and for a card with unearth the answer
      depends on *how it arrived*: a Dregscape Zombie cast from hand stays. Setting it from the
      keyword would tell the bot every unearth creature is a Ball Lightning.
    */
    const read = creature('Dregscape Zombie', 'Unearth {B}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.leavesAtEndOfTurn).toBeUndefined();
  });

  it('reads the keyword beside another line, and keeps both triggers', () => {
    // Corpse Connoisseur's shape: an ETB of its own plus the keyword. The merged script carries the
    // ETB *and* the exile, which is the case the old index-based scheduling could not survive.
    const read = creature('Corpse Connoisseur', 'When Corpse Connoisseur enters, mill three cards.'
      + '\nUnearth {3}{B}', 'Creature — Zombie Wizard', '{4}{B}', '3', '3');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers).toHaveLength(2);
    expect(read.script?.abilities).toHaveLength(1);
  });

  it.each([
    ['the bare word, which names no cost', 'Unearth'],
    ['a cost that is not mana symbols', 'Unearth three life'],
    ['the word inside a sentence rather than as a declaration',
      'Each Sliver creature card in your graveyard has unearth {2}.'],
  ])('refuses %s', (_why, text) => {
    /*
      The third of these is a real card — Dregscape Sliver — and the reason the reader matches a
      whole line rather than the word: it grants unearth to *other cards in the graveyard*, which is
      a continuous effect over a zone this fragment says nothing about. Reading it as the Sliver's
      own unearth would be a wrong card, not an unread line (D362).
    */
    const read = creature('Not A Card', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('is the same fragment the pool\'s hand-written card is built from', () => {
    /*
      Not a shape comparison — `compiled-vs-written.test.ts` already holds the pool against its
      compiled twins card by card, and Dregscape Zombie is in it. This row says the thing that test
      cannot: the hand-written script and the compiled one come from **one builder**, so there is no
      second implementation to drift. If `unearthFragment` stopped being shared, the two would start
      differing and that suite would say so.
    */
    const written = scriptFor('Dregscape Zombie');
    const read = creature('Dregscape Zombie', 'Unearth {B}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(written?.abilities?.[0]?.cost).toEqual(read.script?.abilities?.[0]?.cost);
    expect(written?.abilities?.[0]?.description).toBe(read.script?.abilities?.[0]?.description);
    expect(written?.triggers?.[0]?.on).toEqual(read.script?.triggers?.[0]?.on);
    expect(written?.replaces?.[0]?.on).toBe(read.script?.replaces?.[0]?.on);
    // And the exile is no longer a delayed trigger on either side, which is the D517 change.
    expect(written?.triggers?.[0]?.delayed).toBeUndefined();
    expect(read.script?.triggers?.[0]?.delayed).toBeUndefined();
  });
});

describe('a quantity read off the board (D520)', () => {
  /*
    `countOfThing` has been able to count a board since D444, and until this increment exactly **one**
    caller asked it: `tokenEffect`, for "create a 1/1 Goblin for each Mountain you control". The
    count was the hard part and it was already written; what was missing was every other clause that
    spends one. Measured over the legal corpus, the grammars that spend it are headed by:

    | clause                                                | cards |
    | ----------------------------------------------------- | ----- |
    | `draw N cards for each <T>`                           |   140 |
    | `you gain N life for each <T>`                        |   122 |
    | `deals X damage to <dest>, where X is the number of <T>` | 114 |
    | `deals damage to <dest> equal to the number of <T>`   |   112 |
    | `Add {M} for each <T>`                                |    76 |
    | `you lose life equal to the number of <T>`            |    26 |
    | `draw cards equal to the number of <T>`               |    25 |
    | `you gain life equal to the number of <T>`            |    22 |
    | `you lose N life for each <T>`                        |    13 |
    | `deals N damage to <dest> for each <T>`               |    11 |
    | `each opponent loses N life for each <T>`             |     8 |

    The damage rows are the sharpest statement of the gap: the reader `damageEffect` has carried
    since D444 reads "deals damage equal to the number of <T> **to** <dest>", and **no printed card
    says that**. Every one of the 226 prints the destination first. So the machinery was reachable
    from a grammar nothing printed and unreachable from the two everything printed.

    The vocabulary widened with it, against the phrases the corpus actually names: `creature(s) you
    control` (112 mentions), `card(s) in your hand` (84), the five basic land types (87 between
    them), `attacking creature(s)` (30), `instant and sorcery card(s) in your graveyard` (29),
    `other creature(s) you control` (15), `card(s) in your graveyard` (15),
    `creature card(s) in all graveyards` (9).
  */
  const spell = (name: string, text: string, typeLine = 'Sorcery', cost = '{2}{B}') => compileCard({
    name, type_line: typeLine, mana_cost: cost, cmc: 3, colors: ['B'],
    layout: 'normal', oracle_text: text,
  });
  const creature = (name: string, text: string) => compileCard({
    name, type_line: 'Creature — Zombie', mana_cost: '{4}{B}', cmc: 5, colors: ['B'],
    layout: 'normal', power: '4', toughness: '4', oracle_text: text,
  });

  it.each([
    ['a life gain multiplied by a count',
      'Ancestral Tribute', 'You gain 2 life for each card in your graveyard.'],
    ['a life gain that IS the count',
      'Not A Card', 'You gain life equal to the number of creatures you control.'],
    ['a life loss that is the count',
      'Not A Card', 'You lose life equal to the number of cards in your hand.'],
    ['a life loss multiplied by a count',
      'Not A Card', 'You lose 2 life for each creature you control.'],
    ['a draw multiplied by a count',
      'Not A Card', 'Draw a card for each artifact you control.'],
    ['a draw that IS the count',
      'Cosmic Epiphany', 'Draw cards equal to the number of instant and sorcery cards in your '
        + 'graveyard.'],
    ['the drain every opponent takes',
      'Not A Card', 'Each opponent loses 1 life for each creature card in your graveyard.'],
    ['mana multiplied by a count',
      'Battle Hymn', 'Add {R} for each creature you control.'],
    ['a count announced in a where-X tail',
      'Not A Card', 'You gain X life, where X is the number of lands you control.'],
  ])('reads %s', (_why, name, text) => {
    const read = spell(name as string, text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it.each([
    ['damage whose amount trails its destination',
      'Ground Assault',
      'Ground Assault deals damage to target creature equal to the number of lands you control.'],
    ['damage announced as X with the count in a tail',
      'Not A Card',
      'Not A Card deals X damage to any target, where X is the number of cards in your hand.'],
    ['damage printed per thing',
      'Not A Card',
      'Not A Card deals 1 damage to target opponent for each creature card in your graveyard.'],
  ])('reads %s', (_why, name, text) => {
    const read = spell(name as string, text as string, 'Instant', '{1}{R}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('reads the count through a prologue, with nothing new in the prologue', () => {
    /*
      The reason this increment is worth more than its own clause table: a count is read in the
      **clause**, so every prologue that already composes picks it up. Ancestor's Chosen is an ETB
      whose body is one of the rows above, and no trigger reader changed for it.
    */
    const read = creature("Ancestor's Chosen",
      "When Ancestor's Chosen enters, you gain 1 life for each card in your graveyard.");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers).toHaveLength(1);
  });

  it.each([
    ['a countable nothing can count', 'Draw a card for each Bird on the battlefield.'],
    ['a count qualified past the vocabulary',
      'Draw a card for each creature you control with a +1/+1 counter on it.'],
    ['a quantity that is not a count of the board at all',
      'You gain X life, where X is the amount of life you gained this turn.'],
    ['a verb this table has no row for', 'Scry 1 for each card in your hand.'],
    ['generic mana, which a pool cannot hold', 'Add {2} for each creature you control.'],
    ['a where-X tail whose body does not say X',
      'You gain 2 life, where X is the number of lands you control.'],
  ])('refuses %s', (_why, text) => {
    /*
      Each refused **whole** (D487), which is the point: a clause whose amount cannot be computed is
      not a clause that does nothing, it is a clause with no reading, and the line goes to a human
      (D362). "For each Bird on the battlefield" is the sharpest — it counts a board the vocabulary
      could be taught, and until it is, reading it as zero Birds would be a Airborne Aid that
      resolves and draws nothing.
    */
    const read = spell('Not A Card', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('refuses a basic land type rather than counting creatures by that name', () => {
    /*
      The wrong reading this increment had to fix before it could widen anything, and the one place
      in `countOfThing` where a defect was waiting rather than missing.

      "Swamps you control" and "Goblins you control" are the same five printed words and two
      different counts, and the tribal branch asks `ch.isCreature`. Until D520, no card reached that
      branch with a land type — Corrupt and Cabal Coffers print their counts in word orders nothing
      read — so the bug was latent. Reading those orders without `landsOfSubtype` would have made
      Cabal Coffers add no mana and resolve cleanly, which is worse than an unread line (D362).

      This row asserts the correct reading exists: a land count reads, and a creature type that no
      card can have still refuses nothing (it reads as a count of zero creatures, which is what
      "the number of Goblins you control" means on an empty board).
    */
    const coffers = compileCard({
      name: 'Cabal Coffers', type_line: 'Land', mana_cost: '', cmc: 0, colors: [],
      layout: 'normal', oracle_text: '{2}, {T}: Add {B} for each Swamp you control.',
    });
    expect(coffers.ok).toBe(true);
    if (!coffers.ok) return;
    expect(coffers.unread.map((u) => u.line)).toEqual([]);
    expect(coffers.script?.abilities).toHaveLength(1);
  });

  it('reads Plains, whose plural is itself', () => {
    /*
      CR 205.3i. The `-s` rule every other plural goes through would read "Plains" as "Plain", which
      is not a land type at all, so a card counting Plains would have counted nothing — the same
      quiet wrong as the row above. Taken first in both grammars for that reason.
    */
    const perThing = spell('Not A Card', 'You gain 1 life for each Plains you control.');
    const announced = spell('Not A Card',
      'You gain X life, where X is the number of Plains you control.');
    expect(perThing.ok && announced.ok).toBe(true);
    if (!perThing.ok || !announced.ok) return;
    expect(perThing.unread.map((u) => u.line)).toEqual([]);
    expect(announced.unread.map((u) => u.line)).toEqual([]);
  });

  it('leaves the fixed-amount readers alone', () => {
    // The complement: a clause with no count tail still reads the printed number, so the rows above
    // are a widening rather than a replacement.
    const read = spell('Not A Card', 'You gain 3 life.\nDraw a card.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });
});

describe('a size read off the board (D521, D522)', () => {
  /*
    D520 read the one-shot counted clauses — life, draw, damage, mana — and left the counted **size**
    out, because a size is not one-shot. Asking the corpus which cards are one unread line from
    finished and whose line is a counted size gives **355**, split by duration:

    |  | cards | why it is a different job |
    | --- | --- | --- |
    | TEMPORARY (`until end of turn`) | 222 | the amount is locked in as the effect is created (CR 611.2c, pinned by D301), so a count that is a function of `EffectContext` is enough — reader work only |
    | STATIC (no duration) | 133 | a continuous effect whose amount is a **live** count, and `state.effects` is serialised to Redis, so a function cannot make the trip |

    That 355 is a CEILING. Of it, **92** name a count `countOfThing` can already read — 52 temporary
    and 40 static — and the other 263 are held up by the vocabulary rather than by a size reader:
    `basic land type among lands you control` 11, `its power` 9, `creature blocking it` 8, then
    nothing above 6. So this increment is the temporary half, and the static half waits for the
    `definesSize` machinery to learn D520's vocabulary.

    ## The correction that had to come first (D521)

    D520 gave `countOfThing` a branch for the five basic land types and argued the rest of its
    tribal branch was safe. The probe written for *this* increment asked the compiler instead of the
    argument, and both of these read while counting **creatures** with the subtype — of which there
    are never any, because Food is an artifact type and Gate is a land type:

        You gain 1 life for each Food you control.
        You gain 1 life for each Gate you control.

    A card that resolves and does nothing is worse than an unread line, because an unread line is
    flagged for a human (D362). The fix counts **permanents** of the subtype, which is the rules
    answer (CR 109.2, CR 205.3) rather than a wider net: subtype namespaces are disjoint, so
    counting permanents equals counting within the right namespace. `scripts.test.ts` carries the
    rows that discriminate, because all four of these READ before the fix and only a life total says
    which number arrived.
  */
  const creature = (name: string, text: string) => compileCard({
    name, type_line: 'Creature — Human Soldier', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
    layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });
  const spell = (name: string, text: string) => compileCard({
    name, type_line: 'Instant', mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
    layout: 'normal', oracle_text: text,
  });

  it.each([
    ['a rate behind an attack trigger',
      'Whenever Not A Card attacks, it gets +1/+0 until end of turn for each attacking creature.'],
    ['an announced X behind an attack trigger',
      'Whenever Not A Card attacks, it gets +X/+X until end of turn, where X is the number of '
        + 'creatures you control.'],
    ['an announced X behind an activated cost',
      '{T}: Not A Card gets +X/+X until end of turn, where X is the number of creatures you control.'],
    ['a rate with a granted keyword',
      'Whenever Not A Card attacks, it gets +1/+1 and gains trample until end of turn for each '
        + 'artifact you control.'],
    ['a half that is printed beside a half that is counted',
      'Whenever Not A Card attacks, it gets +X/+0 until end of turn, where X is the number of '
        + 'lands you control.'],
  ])('reads the self-subject pump with %s', (_why, text) => {
    const read = creature('Not A Card', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it.each([
    ['an announced X',
      'Target creature gets +X/+X until end of turn, where X is the number of lands you control.'],
    ['a rate',
      'Target creature gets +1/+0 until end of turn for each artifact you control.'],
    ['a counted shrink',
      'Target creature gets -X/-X until end of turn, where X is the number of creature cards in '
        + 'your graveyard.'],
  ])('reads the targeted pump with %s', (_why, text) => {
    const read = spell('Not A Card', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('points a counted pump at a friendly creature and a counted shrink at a hostile one', () => {
    /*
      D252's rule, carried through the count: the **printed sign** decides whose creature the clause
      is for, and it is knowable without the count because it is in the word. A shrink also carries
      `expiresAtEndOfTurn`, which is Darkblast's reading — wearing off at end of turn is what kills
      the creature before the shrink expires.
    */
    const up = spell('Not A Card',
      'Target creature gets +X/+X until end of turn, where X is the number of lands you control.');
    const down = spell('Not A Card',
      'Target creature gets -X/-X until end of turn, where X is the number of lands you control.');
    expect(up.ok && down.ok).toBe(true);
    if (!up.ok || !down.ok) return;
    expect(up.script?.targets?.[0]?.friendly).toBe(true);
    expect(down.script?.targets?.[0]?.friendly).not.toBe(true);
    expect(down.script?.expiresAtEndOfTurn).toBe(true);
  });

  it.each([
    ['a mixed sign, which cannot say whose creature it is for',
      'Target creature gets +X/-X until end of turn, where X is the number of lands you control.'],
    ['a printed X under "for each", which is the cast-time X and not a count',
      'Target creature gets +X/+X until end of turn for each land you control.'],
    ['a count nothing can count',
      'Target creature gets +X/+X until end of turn, where X is its power.'],
    ['a granted word the engine would ignore',
      'Target creature gets +X/+X and gains protection from red until end of turn, where X is the '
        + 'number of lands you control.'],
    ['a size that is nought however big the count',
      'Target creature gets +0/+0 until end of turn for each land you control.'],
    ['a granted keyword on a counted SHRINK, which no printed card pairs',
      'Target creature gets -X/-X and gains trample until end of turn, where X is the number of '
        + 'lands you control.'],
  ])('refuses %s', (_why, text) => {
    const read = spell('Not A Card', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('left the static counted size to D523, which has since read it', () => {
    /*
      **This row asserted a refusal when D522 shipped, and D523 turned it into a reading.**

      It was the line between the two halves: a static counted size has no moment of creation to
      read a count at, so reading it as a fixed number would have been a Blanchwood Armor that
      stops growing — the quiet wrong this family exists to refuse. D523 did not read it as a fixed
      number; it gave `ContinuousEffect` a `sizePerCount` that carries the count as data and is
      re-read on every look, which is the only honest way to do it.

      Retargeted rather than deleted, for the reason D516's Act of Treason row was: a row that
      records *when* a shape started reading is worth more than one that quietly disappears, and a
      stale refusal is how a suite starts asserting the past.
    */
    const read = creature('Not A Card', 'Not A Card gets +1/+1 for each Forest you control.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });
});

describe('a STATIC size read off the board (D523)', () => {
  /*
    The other half of the counted size, and a different job from D522's. A static counted size is a
    continuous effect whose amount is a **live** count: there is no moment of creation to read a
    number at, so the effect carries the count as DATA and `characteristicsOf` reads it on every
    look. `state.effects` is serialised to Redis, which is why a closure cannot do it.

    133 one-away cards print one. 40 name a count that can be answered, and the split is not about
    the corpus but about where the count runs:

    | | cards | |
    | --- | --- | --- |
    | a ZONE count | 13 | free: `cardDefs` is printed data, and a card in a hand or a graveyard has no continuous effects on it |
    | a BATTLEFIELD count | 27 | possible only against the **printed** type line |
    | outside the vocabulary | 93 | `its power`, `creature blocking it`, `that card's mana value`, … |

    ## The constraint, and the cost it is paid with

    `staticCount` runs inside `characteristicsOf`, so it may not ask a permanent for its live
    characteristics: a live read re-enters the whole computation for every other conditional effect
    on the board, and two effects that read each other's types would not terminate. The engine says
    so in three places, and metalcraft already pays the same price with its own docblock recording
    the rules gap (CR 702.105a).

    So the cost here is the same and is stated rather than hidden: **a permanent whose type or
    subtype comes from a continuous effect is not counted.** A changeling is not seen by a tribal
    count and a crewed Vehicle is not seen as a creature. The row below pins that, because a limit
    nothing tests is a limit nobody will remember.

    It also means `countOfThing` and `staticCountOf` are deliberately *different* vocabularies:
    `creatures you control` is read in a one-shot clause (D520) and refused here, because a count of
    creatures cannot be answered without asking what is a creature. That is the constraint showing
    through, not an inconsistency — Pennon Blade and Bravado are refused for exactly this reason.
  */
  const creature = (name: string, text: string) => compileCard({
    name, type_line: 'Creature — Human Soldier', mana_cost: '{2}{W}', cmc: 3, colors: ['W'],
    layout: 'normal', power: '3', toughness: '3', oracle_text: text,
  });

  it.each([
    ['a rate on the card itself',
      'Not A Card gets +1/+1 for each Equipment you control.'],
    ['the same with "this creature" as the subject',
      'This creature gets +1/+1 for each Equipment you control.'],
    ['an announced X', 'Not A Card gets +X/+X, where X is the number of cards in your hand.'],
    ['a shrink', 'Not A Card gets -1/-1 for each card in your hand.'],
    ['a zone count', 'Not A Card gets +1/+0 for each creature card in your graveyard.'],
    ['a count of its own counters',
      'Not A Card gets +1/+1 for each +1/+1 counter on it.'],
    ['an artifact count', 'Not A Card gets +1/+1 for each artifact you control.'],
  ])('reads %s', (_why, text) => {
    const read = creature('Not A Card', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('adds to the printed size rather than replacing it (layer 7c, not 7a)', () => {
    /*
      The one thing that would be wrong in a way no refusal catches. `definesSize` is layer 7a and
      SETS a base — a Lhurgoyf *is* the creature cards in all graveyards — while this ADDS to
      whatever the base turns out to be (CR 613.4c). Read through `definesSize`, Adelbert Steiner
      would be a 1/1 whose printed 3/3 had been thrown away.
    */
    const read = creature('Not A Card', 'Not A Card gets +1/+1 for each Equipment you control.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const effect = read.script?.statics?.[0]?.effect as
      { sizePerCount?: unknown; definesSize?: unknown } | undefined;
    expect(effect?.sizePerCount).toEqual({
      of: { kind: 'permanents-of-subtype', subtype: 'Equipment' }, power: 1, toughness: 1,
    });
    expect(effect?.definesSize).toBeUndefined();
  });

  it.each([
    ['Enchanted creature gets +1/+1 for each Forest you control.'],
    ['Equipped creature gets +1/+1 for each artifact you control.'],
  ])('reads a counted size on an attachment: %s', (text) => {
    // An attachment's bonus is already a `PumpOptions`, so `sizePerCount` rides in it to
    // `staticEffect` and out to `characteristicsOf` the way `power` does — three lines, not a
    // second mechanism. 41 of the corpus's static counted sizes are printed on an attachment.
    const aura = compileCard({
      name: 'Not An Aura', type_line: /Equipped/i.test(text) ? 'Artifact — Equipment' : 'Enchantment — Aura',
      mana_cost: '{2}{G}', cmc: 3, colors: ['G'], layout: 'normal',
      oracle_text: /Equipped/i.test(text)
        ? `${text}\nEquip {2}`
        : `Enchant creature\n${text}`,
    });
    expect(aura.ok).toBe(true);
    if (!aura.ok) return;
    expect(aura.unread.map((u) => u.line)).toEqual([]);
  });

  it.each([
    ['a count of creatures, which cannot be answered without asking what is a creature',
      'Not A Card gets +1/+1 for each creature you control.'],
    ['a count of OTHER creatures, for the same reason',
      'Not A Card gets +1/+1 for each other creature you control.'],
    ['attacking creatures, which is a fact about combat rather than printed data',
      'Not A Card gets +1/+1 for each attacking creature.'],
    ['a quantity that is not a count of the board at all',
      'Not A Card gets +X/+X, where X is the number of its power.'],
    ['a mixed sign', 'Not A Card gets +1/-1 for each card in your hand.'],
    ['a size that is nought however big the count',
      'Not A Card gets +0/+0 for each card in your hand.'],
  ])('refuses %s', (_why, text) => {
    const read = creature('Not A Card', text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('refuses the three creature counts HERE that D520 reads in a one-shot clause', () => {
    /*
      Stated as its own row because it looks like an inconsistency and is not. The same printed
      phrase is answerable live (while an effect resolves) and unanswerable printed (inside
      `characteristicsOf`), so the same words are read in one place and refused in the other.
    */
    const oneShot = compileCard({
      name: 'Not A Spell', type_line: 'Sorcery', mana_cost: '{1}{B}', cmc: 2, colors: ['B'],
      layout: 'normal', oracle_text: 'You gain 1 life for each creature you control.',
    });
    const asStatic = creature('Not A Card', 'Not A Card gets +1/+1 for each creature you control.');
    expect(oneShot.ok && asStatic.ok).toBe(true);
    if (!oneShot.ok || !asStatic.ok) return;
    expect(oneShot.unread.map((u) => u.line)).toEqual([]);
    expect(asStatic.unread).toHaveLength(1);
  });
});

describe('"you may" outside a trigger (D525)', () => {
  /*
    The four "may" readings — the bare one (D447), the mana price (D448), the energy price (D451)
    and the `. If you do,` sequence (D472) — all lived **inside** `triggerFromLine`, so none of them
    could be reached from any other path a resolution has. Four increments measured and shipped
    behind a trigger and nothing said so, because every card they counted prints its "may" behind a
    trigger too. Asked directly, the compiler read the same clause two different ways depending on
    what printed it, which is what these rows now forbid.

    `optionalEffect` takes the reader its caller composes with, so the trigger path keeps
    `eventRelativeEffect` in front of the clause vocabulary and the others do not need it.

    ## What is deliberately still refused

    A modal bullet (15 legal ones begin with these two words, of which one — Witherbloom Charm —
    reads), and the great majority of the printed sightings on a spell: "you may cast this without
    paying its mana cost", "you may discard a Plains card rather than pay this spell's mana cost".
    Those are **costs**, not resolutions, and the inner half simply does not read — which is the
    right outcome, since a cost read as an effect would be a wrong card (D362).
  */
  const sorcery = (text: string) => compileCard({
    name: 'Not A Card', type_line: 'Sorcery', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
    layout: 'normal', oracle_text: text,
  });
  const artifact = (text: string) => compileCard({
    name: 'Not A Card', type_line: 'Artifact', mana_cost: '{2}', cmc: 2, colors: [],
    layout: 'normal', oracle_text: text,
  });
  const walker = (text: string) => compileCard({
    name: 'Not A Card', type_line: 'Legendary Planeswalker — Nobody', mana_cost: '{2}{R}', cmc: 3,
    colors: ['R'], layout: 'normal', loyalty: '4', oracle_text: text,
  });

  it.each([
    ['a bare may as a whole spell', 'You may draw a card.'],
    ['a mana price as a whole spell', 'You may pay {1}. If you do, draw a card.'],
    ['an energy price as a whole spell', 'You may pay {E}{E}. If you do, draw a card.'],
    ['a sequence as a whole spell', 'You may discard a card. If you do, draw two cards.'],
  ])('reads %s', (_why, text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.onResolve).toBeDefined();
    /*
      The **first** question is the gate, and the rest are the clause's own, held behind it by
      `askOnlyIfChosen` (D450). The sequence shape has two for that reason — the yes-or-no and the
      discard — so the count is not what these rows pin; the gate being first is.
      */
    const gate = (read.script?.decisions ?? [])[0];
    expect(typeof gate === 'object' && gate !== null && 'options' in gate && gate.options)
      .toBeTruthy();
  });

  it.each([
    ['a bare may on an activated ability', '{T}: You may draw a card.'],
    ['a priced may on an activated ability', '{1}, {T}: You may pay {1}. If you do, draw a card.'],
    ['a sequence on an activated ability',
      '{2}, {T}: You may discard a card. If you do, draw two cards.'],
  ])('reads %s', (_why, text) => {
    const read = artifact(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities ?? []).toHaveLength(1);
    const gate = ((read.script?.abilities ?? [])[0]?.decisions ?? [])[0];
    expect(typeof gate === 'object' && gate !== null && 'options' in gate && gate.options)
      .toBeTruthy();
  });

  it('reads a sequence on a loyalty ability, which is Sarkhan, Fireblood', () => {
    const read = walker('+1: You may discard a card. If you do, draw a card.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const ability = (read.script?.abilities ?? [])[0];
    expect(ability?.cost).toEqual({ loyalty: 1 });
    const gate = (ability?.decisions ?? [])[0];
    expect(typeof gate === 'object' && gate !== null && 'options' in gate && gate.options)
      .toEqual(['Yes', 'No']);
  });

  it.each([
    ['an alternative cost, which is not a resolution at all',
      'You may discard a Plains card rather than pay this spell’s mana cost.'],
    ['a free cast, for the same reason',
      'You may cast this card from your graveyard without paying its mana cost.'],
    ['a sequence whose first half does not read',
      'You may put a creature card from your hand onto the battlefield. If you do, draw a card.'],
    ['a sequence whose second half does not read',
      'You may discard a card. If you do, put a creature card from your hand onto the battlefield.'],
  ])('refuses %s', (_why, text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('refuses a two-line spell, so the second line is never silently dropped (D487)', () => {
    /*
      `optionalResolution` is a one-line reader, like the four spell shapes above it, and this row
      is why it has to be. Letting it see a longer resolution would have it read the first line and
      ignore the rest — the card would compile, resolve, and do half of what it prints, which is
      the failure D487 made the standing rule about.
    */
    const read = compileCard({
      name: 'Not A Card', type_line: 'Sorcery', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
      layout: 'normal', oracle_text: 'You may draw a card.\nClash with an opponent.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.onResolve).toBeUndefined();
    expect(read.unread.map((u) => u.line))
      .toEqual(['You may draw a card.', 'Clash with an opponent.']);
  });

  it('refuses a clause that is not a "may" at all, rather than reaching for a match it has not got', () => {
    /*
      The cheapest row here and the one that pins the function's own gate. Every spell whose
      resolution does not read reaches `optionalEffect`, most of them saying nothing about a "may",
      so the bare match is tested before anything is read off it.

      The unreadable line was `Proliferate.` for exactly one increment: D528 read it, and this row
      failed the moment it did. That is the right failure — a refusal row whose example has started
      reading is a test asserting the past (D516) — so the example moved to `Clash with an
      opponent.`, which is a keyword the engine does not have at all. Expect this to happen again.
    */
    const read = compileCard({
      name: 'Not A Card', type_line: 'Sorcery', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
      layout: 'normal', oracle_text: 'Clash with an opponent.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual(['Clash with an opponent.']);
  });

  it('refuses a modal bullet, which is the one place this was measured and left out', () => {
    /*
      One legal card would gain — Witherbloom Charm. A mode's gate would be the first
      `payIfChosen`-capable question inside a `ModeDef`, which nothing in the pool prints, and the
      scripts file says so where the decision lives. If a second card ever prints one, this row is
      what fails and tells whoever reads it that the count has moved.
    */
    const read = compileCard({
      name: 'Not A Card', type_line: 'Instant', mana_cost: '{B}{G}', cmc: 2, colors: ['B', 'G'],
      layout: 'normal',
      oracle_text: 'Choose one —\n• You may sacrifice a permanent. If you do, draw two cards.'
        + '\n• Draw a card.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.modal).toBeUndefined();
    // And the bullet stays unread rather than compiling to something outside a `modal`.
    expect(read.unread.map((u) => u.line)).toContain(
      '\u2022 You may sacrifice a permanent. If you do, draw two cards.',
    );
  });

  it('reads the same clause identically whether a trigger or a spell prints it', () => {
    /*
      The defect itself, as one assertion. Before D525 the left-hand side read and the right-hand
      side did not, for all four shapes.
    */
    const shapes = [
      'you may draw a card',
      'you may pay {1}. If you do, draw a card',
      'you may pay {E}{E}. If you do, draw a card',
      'you may discard a card. If you do, draw two cards',
    ];
    for (const shape of shapes) {
      const triggered = artifact(`When Not A Card enters, ${shape}.`);
      const resolved = sorcery(`${shape.charAt(0).toUpperCase()}${shape.slice(1)}.`);
      expect(triggered.ok && resolved.ok).toBe(true);
      if (!triggered.ok || !resolved.ok) return;
      expect(triggered.unread.map((u) => u.line)).toEqual([]);
      expect(resolved.unread.map((u) => u.line)).toEqual([]);
      // The same question, asked by the trigger and by the spell.
      const asTrigger = (triggered.script?.triggers ?? [])[0]?.decisions ?? [];
      const asSpell = resolved.script?.decisions ?? [];
      const prompts = (specs: readonly unknown[]) => specs.map((spec) => (
        typeof spec === 'object' && spec !== null && 'prompt' in spec ? spec.prompt : null));
      expect(prompts(asSpell).length).toBeGreaterThan(0);
      expect(prompts(asSpell)).toEqual(prompts(asTrigger));
    }
  });
});

describe('the graveyard clause family (D527)', () => {
  /*
    The queue, re-ranked by **cards finished per new reader** rather than by how many cards contain
    a shape (D434's rule, which D519 and D524 each broke one level up). Of 16,022 legal cards
    exactly one no-reader line short, 10,849 are short by exactly ONE clause — and the top of that
    ranking is one zone family:

    | cards | the clause |
    | --- | --- |
    | 25 | `Return <this card> from your graveyard to your hand` |
    | 21 | `Return target creature card from your graveyard to the battlefield` |
    | 16 | `Put target card from your graveyard on the bottom of your library` |
    | 13 | `Return this card from your graveyard to your hand` (the second wording) |
    | 13 | `Exile target card from a graveyard` |

    All five are moves between a graveyard and another zone, every primitive they need has been in
    `effects.ts` since the start, and graveyard targeting has been in the engine since #23 — so the
    work is a **target-phrase parser** (`graveyardCardPhrase`) plus four clause readers.

    The scope word is the half that would be a wrong card rather than an unread line: `your
    graveyard` is yours, `a graveyard` is anybody's, `an opponent's graveyard` is theirs, and the
    rows below pin all three.
  */
  const sorcery = (text: string, name = 'Not A Card') => compileCard({
    name, type_line: 'Sorcery', mana_cost: '{1}{B}', cmc: 2, colors: ['B'],
    layout: 'normal', oracle_text: text,
  });
  const creature = (text: string, name = 'Not A Card') => compileCard({
    name, type_line: 'Creature — Human Cleric', mana_cost: '{1}{B}', cmc: 2, colors: ['B'],
    layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it.each([
    ['reanimation, the plain wording',
      'Return target creature card from your graveyard to the battlefield.'],
    ['reanimation of an artifact', 'Return target artifact card from your graveyard to the battlefield.'],
    ['reanimation of a permanent card',
      'Return target permanent card from your graveyard to the battlefield.'],
    ['reanimation tapped', 'Return target creature card from your graveyard to the battlefield tapped.'],
    ['graveyard hate, any graveyard', 'Exile target card from a graveyard.'],
    ['graveyard hate with a type', 'Exile target creature card from a graveyard.'],
    ['graveyard hate with a type run and a scope',
      "Exile target instant or sorcery card from an opponent’s graveyard."],
    ['graveyard hate with a negated type', 'Exile target nonland card from your graveyard.'],
    ['a card under your own library',
      'Put target card from your graveyard on the bottom of your library.'],
    ['a card under its owner’s library',
      "Put target card from a graveyard on the bottom of its owner’s library."],
  ])('reads %s', (_why, text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets ?? []).toHaveLength(1);
  });

  it.each([
    ['a rider the move does not carry',
      'Return target creature card from your graveyard to the battlefield with a finality counter on it.'],
    ['a type run mixing a type with a subtype',
      'Return target creature or Vehicle card from your graveyard to the battlefield.'],
    ['a colour run this vocabulary does not read',
      'Return target white or black creature card from your graveyard to the battlefield.'],
    ['a subtype alone, which would match nothing (#341)',
      'Exile target Rebel card from a graveyard.'],
    ['two graveyards in one clause, which cannot share one targets list',
      "Exile target instant or sorcery card from your graveyard and target instant or sorcery card"
      + " from an opponent’s graveyard."],
  ])('refuses %s', (_why, text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('refuses a card out of ANY graveyard put under YOUR library, which nobody prints', () => {
    /*
      The one pairing that would be a card this compiler invented (D259). A card in a graveyard is
      owned by the player whose graveyard it is (CR 404.3), so "your graveyard … your library" and
      "a graveyard … its owner's library" name the same destination — but "a graveyard … your
      library" would take an opponent's card and put it in **your** deck.
    */
    const read = sorcery('Put target card from a graveyard on the bottom of your library.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('reads the self-return as an ability activated FROM the graveyard', () => {
    /*
      The clause decides something about the **cost**, which is why it is read on the ability path
      and not in the clause vocabulary: a card that returns itself from your graveyard is an
      ability used from there, and `AbilityCost.fromGraveyard` is the field `legalActions` reads to
      decide which zone an ability is offered in.
    */
    for (const [name, text] of [
      ['Not A Card', '{2}{B}: Return Not A Card from your graveyard to your hand.'],
      ['Not A Card', '{2}{B}: Return this card from your graveyard to your hand.'],
    ] as const) {
      const read = creature(text, name);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread.map((u) => u.line)).toEqual([]);
      const ability = (read.script?.abilities ?? [])[0];
      expect(ability?.cost).toEqual({ mana: '{2}{B}', fromGraveyard: true });
    }
  });

  it('leaves an ability that merely MENTIONS a graveyard on the battlefield', () => {
    /*
      The bound on that inference, stated as a row. Hanna and Scavenging Ooze both say "graveyard"
      and both are activated from the battlefield — the word is about their *target*. An inference
      wider than the one printed shape would take those abilities off the board, where they would
      compile, install, and never be offered.
    */
    const read = creature('{2}: Exile target card from a graveyard.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.script?.abilities ?? [])[0]?.cost).toEqual({ mana: '{2}' });
  });
});

describe('four clauses naming mechanics the engine already had (D528)', () => {
  /*
    D526's ranking is full of these: a printed clause whose rule the engine has implemented for
    dozens of increments and the **compiler** has no reading for. Four of them, with the increment
    that built the rule:

    | cards | clause | the rule |
    | --- | --- | --- |
    | 19 | `Proliferate` | #195, with two hand-written cards using it |
    | 16 | `Regenerate target creature` | #37, CR 701.15 |
    | 18 | `Target creature can't be blocked this turn` | D495 read it as a *printed* static |
    | 14 | `Target creature can't block this turn` | the same |

    The two blocking restrictions are a `PumpOptions` with no size: `cantBeBlocked` and `cantBlock`
    have been `ContinuousEffect` fields since D495 read them off printed type lines, so granting
    either until end of turn is `pump` with one flag and nothing else.

    **The two point at opposite halves of the table and the printed word says which.** "Can't be
    blocked" is for your attacker (so the spec is `friendly` and carries `helpsInCombat`); "can't
    block" is aimed at somebody else's creature. Guessing that round the wrong way is D252's
    failure, and here — unlike a mixed-sign pump — the sentence settles it.
  */
  const sorcery = (text: string) => compileCard({
    name: 'Not A Card', type_line: 'Sorcery', mana_cost: '{1}{R}', cmc: 2, colors: ['R'],
    layout: 'normal', oracle_text: text,
  });
  const creature = (text: string) => compileCard({
    name: 'Not A Card', type_line: 'Creature — Human Soldier', mana_cost: '{1}{G}', cmc: 2,
    colors: ['G'], layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });

  it.each([
    ['proliferate on its own', 'Proliferate.'],
    ['a regeneration shield on a target', 'Regenerate target creature.'],
    ['a shield on an artifact', 'Regenerate target artifact.'],
    ['a shield on a subtype', 'Regenerate target Zombie.'],
    ['an unblockable target', "Target creature can't be blocked this turn."],
    ['an unblockable target of your own',
      "Target creature you control can't be blocked this turn."],
    ['a creature kept out of blocks', "Target creature can't block this turn."],
    ['two creatures kept out of blocks', "Up to two target creatures can't block this turn."],
    ['three creatures kept out of blocks', "Up to three target creatures can't block this turn."],
  ])('reads %s', (_why, text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  /*
    The self forms. `Regenerate ~` is **not** D528's reader: this increment wrote one and the break
    run found that disabling it changed nothing, because `eventRelativeEffect` has read
    `^regenerate (?:~|it)$` since the referent machinery was built — and reads "it" too, which the
    new one did not. The duplicate is gone (D441, D438) and the row stays, because what it asserts
    is that the card reads, not which function reads it.
  */
  it.each([
    ['a shield on the card itself', '{G}: Regenerate Not A Card.'],
    ['the card making itself unblockable', "{U}: Not A Card can't be blocked this turn."],
    ['the same with "this creature" as the subject',
      "{U}: This creature can't be blocked this turn."],
  ])('reads %s', (_why, text) => {
    const read = creature(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.abilities ?? []).toHaveLength(1);
  });

  it('points the two restrictions at opposite halves of the table', () => {
    const unblockable = sorcery("Target creature can't be blocked this turn.");
    const held = sorcery("Target creature can't block this turn.");
    expect(unblockable.ok && held.ok).toBe(true);
    if (!unblockable.ok || !held.ok) return;
    const specOf = (read: typeof unblockable) =>
      (read.ok ? read.script?.targets ?? [] : [])[0];
    // "Can't be blocked" helps your attacker: both hints say aim it at one of yours that can swing.
    expect(specOf(unblockable)?.friendly).toBe(true);
    expect(specOf(unblockable)?.helpsInCombat).toBe(true);
    // "Can't block" is aimed at theirs, so it carries neither.
    expect(specOf(held)?.friendly).toBeUndefined();
    expect(specOf(held)?.helpsInCombat).toBeUndefined();
  });

  it.each([
    ['"it", whose referent no clause reader is handed', "It can't be blocked this turn."],
    ['an untargeted board scope', "Creatures without flying can't block this turn."],
    ['a power clause in the target phrase',
      "Target creature with power 2 or less can't be blocked this turn."],
    ['a pump and a restriction in one sentence',
      "Target creature gets +1/+0 and can’t be blocked this turn."],
    /*
      Without "this turn" it is not a one-shot at all: "can't be blocked" with no duration is a
      **printed static**, which `printedCombatStatics` reads off a creature's own type line (D495).
      Nothing prints it as a spell's resolution, and reading it as one would be a permanent effect
      where the card says nothing of the kind.
    */
    ['the same restriction with no duration, which is a printed static instead',
      "Target creature can't be blocked."],
  ])('refuses %s', (_why, text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });

  it('asks proliferate’s question with the spec the pool’s own two cards ask', () => {
    /*
      By reference, not by resemblance: Contagion Clasp and Steady Progress both carry `PROLIFERATE`
      and `compiled-vs-written.test.ts` compares the compiled form against theirs, so the compiled
      question has to be the same object rather than one that looks like it.
    */
    const read = sorcery('Proliferate.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const spec = (read.script?.decisions ?? [])[0];
    expect(typeof spec === 'object' && spec !== null && 'counters' in spec && spec.counters)
      .toBe(true);
  });
});

describe('the upkeep tax: sacrifice unless you pay (D529)', () => {
  /*
    D526's ranking put this shape at the top with 33 cards, and the measurement behind it is
    unusually concentrated: **137 legal lines** print the sentence, **116 of them on two prologues
    this compiler already reads** — "At the beginning of your upkeep," (74) and "When ~ enters,"
    (42) — and the price is a mana run on **52**.

    It is echo (#196, CR 702.29) with the keyword taken off, and nothing new was built.
    `payIfChosen` is the price on an answer and carries the rule nobody has to write: a cost the
    seat cannot afford is **not offered**, so a tapped-out player is not shown a question with one
    button — the permanent goes and the engine says so. `payIfChosen.energy` is the same price in
    the other currency (D451), which is Lathnu Hellion.

    `'Sacrifice it'` is first because `options[0]` is the engine's fallback and that fallback has to
    be the outcome the rules impose. `best` is written, and this is the **one** place a compiled
    card gets one: D448 left it off a compiled priced "may" because the compiler cannot know what
    declining costs, and here the clause says — the permanent.
  */
  const permanent = (text: string, name = 'Not A Card') => compileCard({
    name, type_line: 'Creature — Elemental', mana_cost: '{3}{B}', cmc: 4, colors: ['B'],
    layout: 'normal', power: '4', toughness: '4', oracle_text: text,
  });

  it.each([
    ['the upkeep form', 'At the beginning of your upkeep, sacrifice Not A Card unless you pay {1}{U}.'],
    ['the enters form, saying "it"', 'When Not A Card enters, sacrifice it unless you pay {1}.'],
    ['the end-step form with an energy price',
      'At the beginning of your end step, sacrifice Not A Card unless you pay {E}{E}.'],
    ['a hybrid price', 'At the beginning of your upkeep, sacrifice Not A Card unless you pay {R/W}.'],
  ])('reads %s', (_why, text) => {
    const read = permanent(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const trigger = (read.script?.triggers ?? [])[0];
    const spec = (trigger?.decisions ?? [])[0];
    expect(typeof spec === 'object' && spec !== null && 'options' in spec ? spec.options : null)
      .toEqual(['Sacrifice it', expect.stringContaining('Pay ')]);
  });

  it('puts the forced outcome first and the price second, with a bot hint to pay', () => {
    const read = permanent(
      'At the beginning of your upkeep, sacrifice Not A Card unless you pay {2}.',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const spec = ((read.script?.triggers ?? [])[0]?.decisions ?? [])[0];
    expect(typeof spec).toBe('object');
    if (typeof spec !== 'object' || spec === null) return;
    expect('options' in spec ? spec.options : null).toEqual(['Sacrifice it', 'Pay {2}']);
    expect('payIfChosen' in spec ? spec.payIfChosen : null)
      .toEqual({ option: 'Pay {2}', cost: '{2}' });
    // The one `best` a compiled card carries, and the clause is what makes it knowable.
    expect('best' in spec && typeof spec.best === 'function').toBe(true);
  });

  it.each([
    ['a discard price, which payIfChosen cannot express',
      'At the beginning of your upkeep, sacrifice Not A Card unless you discard a card.'],
    ['a sacrifice price',
      'At the beginning of your upkeep, sacrifice Not A Card unless you sacrifice a land.'],
    ['a price this engine cannot parse',
      'At the beginning of your upkeep, sacrifice Not A Card unless you pay {X}.'],
    ['a price of life, which is a cost and not mana',
      'At the beginning of your upkeep, sacrifice Not A Card unless you pay 3 life.'],
  ])('refuses %s', (_why, text) => {
    const read = permanent(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toHaveLength(1);
  });
});

describe('a referent subject, read by borrowing the targeted reader (D530)', () => {
  /*
    The measurement that chose this shape, and the two probes it took to get it right.

    D526's queue pointed at "that player" and the first probe answered **8 cards**, which was wrong
    twice over: it counted clauses rather than cards (D434), and it split each unread line with
    `clausesOf` and then tested only clauses *starting* with the pronoun — so a combat-damage tail
    sharing its sentence with the trigger prologue was never tested at all. The corrected probe
    strips the prologue the way `triggerFromLine` does and asks whether the CARD finishes:

      the event referent ("that player" named by the trigger's own event)      27 cards
        of which the player who was HIT     (`c.attacked.defender`)            18
        of which the player who ACTED       (`c.actor`, the D475 gate)          9
      the intra-resolution referent (the target an earlier clause chose)         9 cards

    The rows under the first are a long tail — `discards a card` 16, `discards two cards` 4,
    `mills two cards` 2, `loses N life` 2, then singletons — which is the whole argument for a
    borrow instead of a seventh hand-written sentence. See `referentEffect`.

    A third probe compiled each clause standalone and answered **4 cards**; it is recorded here as
    wrong because the failure is instructive. Standalone compilation breaks every clause whose
    reading depends on where it sits — the Equipment family refuses on "attach it to target creature
    you control", which only reads inside an ETB trigger — so the probe measured the probe.
  */
  const creature = (text: string, name = 'Not A Card') => compileCard({
    name, type_line: 'Creature — Specter', mana_cost: '{2}{B}{B}', cmc: 4, colors: ['B'],
    layout: 'normal', power: '2', toughness: '2', oracle_text: text,
  });
  const spell = (text: string, name = 'Not A Card') => compileCard({
    name, type_line: 'Instant', mana_cost: '{1}{G}', cmc: 2, colors: ['G'],
    layout: 'normal', oracle_text: text,
  });

  describe('the player the event names', () => {
    it.each([
      ['Abyssal Specter, the 16-card row',
        'Whenever Not A Card deals combat damage to a player, that player discards a card.'],
      ['Okiba-Gang Shinobi, two cards',
        'Whenever Not A Card deals combat damage to a player, that player discards two cards.'],
      ['Shriekgeist, a mill',
        'Whenever Not A Card deals combat damage to a player, that player mills two cards.'],
      ['Dimir Cutpurse, a second clause after the referent one',
        'Whenever Not A Card deals combat damage to a player, that player discards a card '
        + 'and you draw a card.'],
    ])('reads %s', (_why, text) => {
      const read = creature(text as string);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread.map((u) => u.line)).toEqual([]);
      const trigger = (read.script?.triggers ?? [])[0];
      expect(trigger?.on).toEqual({ kind: 'combat-damage' });
      /*
        And it asks for **nothing**. That is the point of the borrow rather than a side effect of
        it: the sentence reads through a reader written for a target, and if the spec survived, the
        table would stop and ask which player to discard — on a card that already knows.
      */
      expect(trigger?.targets ?? []).toEqual([]);
    });

    it('reads the actor where the event is about an action, not a hit (the D475 gate)', () => {
      const read = compileCard({
        name: 'Not A Card', type_line: 'Enchantment', mana_cost: '{3}{B}', cmc: 4, colors: ['B'],
        layout: 'normal',
        oracle_text: "At the beginning of each player's upkeep, that player discards a card.",
      });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread.map((u) => u.line)).toEqual([]);
      expect((read.script?.triggers ?? [])[0]?.targets ?? []).toEqual([]);
    });

    /*
      The refusal that matters most, and it is D475's rule unchanged rather than a new one: an
      `etb` passes the watcher's own side, so "that player" after one is a player this sentence
      cannot name. Reading it would compile a card that fires and does the wrong thing, which is
      worse than the unread line (D362).
    */
    it('refuses a referent after an event that names no player', () => {
      const read = creature(
        'Whenever another creature enters, that player discards a card.',
      );
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toHaveLength(1);
    });
  });

  describe('the target an earlier clause in the same resolution chose', () => {
    it.each([
      ['Arbor Armament',
        'Put a +1/+1 counter on target creature. That creature gains reach until end of turn.'],
      ['Stealth Mission',
        'Put two +1/+1 counters on target creature you control. '
        + "That creature can't be blocked this turn."],
      ['Battlefield Promotion, with a third clause after the borrow',
        'Put a +1/+1 counter on target creature. That creature gains first strike until end of '
        + 'turn. You gain 2 life.'],
    ])('reads %s', (_why, text) => {
      const read = spell(text as string);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread.map((u) => u.line)).toEqual([]);
      // One spec for the whole resolution — the borrow adds none, which is what makes the
      // composition legal at all (see the `targeted.length > 1` rule it sits beside).
      expect(read.script?.targets ?? []).toHaveLength(1);
      expect((read.script?.targets ?? [])[0]?.kind).toBe('creature');
    });

    it.each([
      ['no earlier clause pointed at anything',
        'You gain 2 life. That creature gains reach until end of turn.'],
      ['the earlier spec is "any target", which may hold a player',
        'Not A Card deals 3 damage to any target. That creature gains reach until end of turn.'],
      ['the pronoun names a kind the earlier spec is not',
        'Destroy target artifact. That creature gains reach until end of turn.'],
      ['two clauses would each want their own target',
        'Destroy target creature. Target player draws a card. '
        + 'That creature gains reach until end of turn.'],
    ])('refuses when %s', (_why, text) => {
      const read = spell(text as string);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread).toHaveLength(1);
    });
  });
});

describe('the chosen discard, read as one group of three sentences (D531)', () => {
  /*
    MEASURED (probe548, legal pool): **95 unread legal lines** contain "discards that/those card(s)",
    84 distinct shapes, and the head of the family is one idiom in a handful of spellings —
    "Target opponent reveals their hand. You choose a nonland card from it. That player discards that
    card." (8), the same with "target player" (3), with "a nonland permanent card" (2), with "a card"
    (2), and singletons for "a creature or planeswalker card" and "an instant or sorcery card".

    It is read as a **group** for `stealPrefix`'s reason (D516): three printed sentences and one
    play. The middle one is not even an effect — "you choose a card from it" *is* the question — so
    there is nothing for a clause reader to return for it.

    The engine could not express it before this increment and that is the whole of why it was
    unread: `who` named the chooser *and* the zone's owner at once, so the only available reading
    asked the discarding player to choose. That card already exists — it is Mind Rot — and
    compiling this family as Mind Rot would be a card that works and does the wrong thing, which
    D362 ranks below an unread line.
  */
  const sorcery = (text: string) => compileCard({
    name: 'Not A Card', type_line: 'Sorcery', mana_cost: '{1}{B}', cmc: 2, colors: ['B'],
    layout: 'normal', oracle_text: text,
  });
  const ask = (text: string) => {
    const read = sorcery(text);
    // `Compilation` is a union and `script` lives only on the ok arm, which the gate's
    // `typecheck:tests` pass is what catches (#246) — the ordinary typecheck does not read tests.
    if (!read.ok) return null;
    const spec = (read.script?.decisions ?? [])[0];
    return typeof spec === 'object' && spec !== null ? spec : null;
  };

  it.each([
    ['Dark Inquiry, the 8-card spelling', 'nonland'],
    ['Brainbite, with no qualifier at all', ''],
    ["Auntie's Sentence, a composed qualifier", 'nonland permanent'],
    ['Despise', 'creature or planeswalker'],
    ['Collective Brutality', 'instant or sorcery'],
  ])('reads %s', (_why, qualifier) => {
    const article = /^[aeiou]/i.test(qualifier) ? 'an' : 'a';
    const read = sorcery(
      'Target opponent reveals their hand. '
      + `You choose ${qualifier === '' ? 'a' : `${article} ${qualifier}`} card from it. `
      + 'That player discards that card.',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    // One target for the whole spell, and it is the player whose hand is read.
    expect((read.script?.targets ?? []).map((s) => s.kind)).toEqual(['player']);
  });

  it('asks the CASTER, out of the TARGET’s hand — both halves, or it is Mind Rot', () => {
    const spec = ask(
      'Target opponent reveals their hand. You choose a nonland card from it. '
      + 'That player discards that card.',
    );
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect('who' in spec ? spec.who : null).toBe('controller');
    expect('fromSeat' in spec ? spec.fromSeat : null).toBe('target-player');
    expect('from' in spec ? spec.from : null).toBe('hand');
    // Exactly one card: the printed sentence says "a card", singular, and so does the discard.
    expect('min' in spec ? spec.min : null).toBe(1);
    expect('max' in spec ? spec.max : null).toBe(1);
  });

  it('carries the printed qualifier as a filter, not as prose', () => {
    const spec = ask(
      'Target opponent reveals their hand. You choose a nonland card from it. '
      + 'That player discards that card.',
    );
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect('filter' in spec && typeof spec.filter === 'function').toBe(true);
    // And the prompt says which cards, so a player reading the question knows what it will accept.
    expect('prompt' in spec ? spec.prompt : '').toContain('nonland');
  });

  it.each([
    ['an X chosen as the spell is cast (Abandon Hope)',
      "Look at target opponent's hand and choose X cards from it. "
      + 'That player discards those cards.'],
    ['a random slice of the hand rather than the hand (Blackmail)',
      'Target player reveals three cards from their hand and you choose one of them. '
      + 'That player discards that card.'],
    ['an offer that has to gate the question (Cracked Skull)',
      'Target player reveals their hand. You may choose a nonland card from it. '
      + 'That player discards that card.'],
    ['a filter that is an earlier answer, not printed words (Addle)',
      'Choose a color. Target player reveals their hand and you choose a card of that color '
      + 'from it. That player discards that card.'],
    ['the reveal missing, so the caster would choose from cards never shown',
      'You choose a nonland card from it. That player discards that card.'],
    ['the discard missing, so a hand is revealed for nothing',
      'Target opponent reveals their hand. You choose a nonland card from it.'],
    /*
      These two exist because the break run found them missing. The rows above refuse for the
      *wrong reason* — the first sentence has no player in it, and the second has only two clauses
      — so loosening either regex left them green. A refusal row that would still refuse with the
      guard gone is not a check on the guard.
    */
    ['a first sentence that names a player but is not a reveal',
      'Target opponent loses 2 life. You choose a nonland card from it. '
      + 'That player discards that card.'],
    ['a third sentence that is not the discard, with all three clauses present',
      'Target opponent reveals their hand. You choose a nonland card from it. You gain 2 life.'],
  ])('refuses %s', (_why, text) => {
    const read = sorcery(text as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.length).toBeGreaterThan(0);
  });
});

describe('"This ability triggers only once each turn" (D532)', () => {
  /*
    D508's reading, one ability kind over: the activated version shipped under D508, and this is
    the triggered one. 143 legal printings carry the sentence.

    **The yield was measured by compiling, and the measurement is the point of this block.** The
    clause ranking that put this row at the head of the queue said 39 cards, and 39 is wrong by
    4.9x: that probe tests the clauses of a line's *body*, and the body is what is left after the
    trigger prologue comes off, so a card whose prologue has no `TRIGGER_SHAPE` counts as one
    clause short when it is two readers short. Strip the sentence from all 140 and compile, and
    **8 cards finish**. The honest figure and the reason the other one lied are recorded under
    D532 in `claude/decisions-log.md`; `scratchpad/p554.mjs` is the corrected ranking, which
    predicted this row at 8 and was right.
  */
  const trig = (text: string, name = 'Bloombrute') => compileCard({
    name, type_line: 'Creature — Plant Elemental', mana_cost: '{3}{G}', cmc: 4, colors: ['G'],
    layout: 'normal', power: '3', toughness: '3', oracle_text: text,
  });

  it('reads Bloombrute, whose whole card is the trigger and the restriction', () => {
    const read = trig('Whenever you gain life, draw a card. This ability triggers only once each turn.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.length).toBe(1);
    expect(read.script?.triggers?.[0]?.onceEachTurn).toBe(true);
    // And the trigger still watches what it printed, which is the half a restriction reader breaks.
    expect(read.script?.triggers?.[0]?.on.kind).toBe('life-gained');
  });

  it.each([
    ['Battle-Scarred Survivalist', 'Whenever another creature dies, put a +1/+1 counter on this creature. This ability triggers only once each turn.', 'dies'],
    ['Mary Jane Watson', 'Whenever a Spider you control enters, draw a card. This ability triggers only once each turn.', 'etb'],
    ['Nanoform Sentinel', 'Whenever this creature becomes tapped, untap another target permanent. This ability triggers only once each turn.', 'becomes-tapped'],
    ['Whispering Wizard', 'Whenever you cast a noncreature spell, create a 1/1 white Spirit creature token with flying. This ability triggers only once each turn.', 'spell-cast'],
  ])('reads it on printed %s', (name, text, kind) => {
    const read = trig(text as string, name as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.length).toBe(1);
    expect(read.script?.triggers?.[0]?.onceEachTurn).toBe(true);
    expect(read.script?.triggers?.[0]?.on.kind).toBe(kind as string);
  });

  it('reads it on Academy Wall, whose effect is two sentences before the restriction', () => {
    /*
      The restriction comes off the END of the line, and this is the printing that says the
      anchoring matters: the effect itself is "you may draw a card. If you do, discard a card",
      so the sentence this reader takes is the third of three and the two before it still have to
      compose.
    */
    const read = trig(
      'Defender\nWhenever you cast an instant or sorcery spell, you may draw a card. '
      + 'If you do, discard a card. This ability triggers only once each turn.',
      'Academy Wall',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.[0]?.onceEachTurn).toBe(true);
    expect(read.script?.triggers?.[0]?.decisions?.length).toBeGreaterThan(0);
  });

  it('does not set the flag on a trigger that does not print it', () => {
    /*
      The control, and the one that catches a reader setting the flag unconditionally — which is
      the failure that costs a player every firing after the first on a card with no restriction.
      Same card, same prologue, same effect, the sentence removed.
    */
    const read = trig('Whenever you gain life, draw a card.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.[0]?.onceEachTurn).toBeUndefined();
  });

  it('reads "once per turn", which is the same rule in the other printing', () => {
    const read = trig('Whenever you gain life, draw a card. This ability triggers only once per turn.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.[0]?.onceEachTurn).toBe(true);
  });

  it.each([
    ['once per game, not per turn', 'This ability triggers only once.'],
    ['a count this field cannot hold', 'This ability triggers only twice each turn.'],
    ['a restriction about the clash', 'This ability triggers after the clash ends.'],
    ['a restriction about the zone', 'This ability triggers only from the battlefield.'],
    ['a restriction about where the card is', 'This ability triggers only if Bloombrute is on the battlefield or in your graveyard.'],
  ])('refuses the line for %s', (_why, tail) => {
    /*
      Every other restriction sentence the legal corpus prints, and each must leave the LINE
      unread rather than be dropped. They are refused one layer down — the sentence stays in the
      line, no clause reader matches it, and `composeEffects` refuses the whole trigger — which is
      why `triggerRestriction` returns the text unchanged instead of refusing itself. The outcome
      is what this asserts, because the outcome is what a player meets: a restriction read in half
      is an ability that fires at a moment the card forbids (D362, D487).
    */
    const read = trig(`Whenever you gain life, draw a card. ${tail as string}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      `Whenever you gain life, draw a card. ${tail as string}`,
    ]);
    expect(read.script?.triggers ?? []).toEqual([]);
  });

  it('refuses the restriction on a line whose shape emits several events', () => {
    /*
      "When ~ enters or dies" is one printed ability over two events, and this compiler gives each
      event its own `TriggerDef` and so its own once-a-turn record. Carrying the restriction across
      them would be one printed ability firing twice a turn, so the line is refused whole. No legal
      printing is affected — of the 140 whose restricted line this compiler reads at all, 11 emit
      one event and none emit several — which is what makes this a reading that is right by
      construction rather than one measured into place.

      **The control below is what makes the refusal mean anything**, and writing this test without
      it is how D531's break run found three rows refusing for the wrong reason: the first draft
      used "When ~ enters and whenever you gain life", which has no shape at all, so the line was
      refused by the prologue and the restriction never came into it.
    */
    const read = trig(
      'When Bloombrute enters or dies, draw a card. This ability triggers only once each turn.',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'When Bloombrute enters or dies, draw a card. This ability triggers only once each turn.',
    ]);
    expect(read.script?.triggers ?? []).toEqual([]);
    // The same line without the restriction reads, as both events: the refusal is the
    // restriction's and not the prologue's.
    const plain = trig('When Bloombrute enters or dies, draw a card.');
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.unread.map((u) => u.line)).toEqual([]);
    expect((plain.script?.triggers ?? []).map((t) => t.on.kind)).toEqual(['etb', 'dies']);
  });

  it('leaves the activated-ability restriction alone, which is D508\'s', () => {
    // The two readers sit on different lines of the same card and must not read each other's.
    const read = trig(
      'Whenever you gain life, draw a card. This ability triggers only once each turn.\n'
      + '{2}{G}: Bloombrute gets +2/+2 until end of turn. Activate only once each turn.',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.[0]?.onceEachTurn).toBe(true);
    expect(read.script?.abilities?.[0]?.onceEachTurn).toBe(true);
  });
});

describe('the pronoun "it", and a referent anywhere in its clause (D533)', () => {
  /*
    D530 read a referent in **subject** position — "that player discards a card" — by swapping the
    first two words for a target phrase and borrowing the reader that already understands the result.
    The anchor was the limitation, and it was costing the head of the family: printed text puts a
    pronoun in **object** position at least as often, and "Untap it" was the top row of the corrected
    queue at 19 cards (`scripts/measure/one-blocker.mjs`).

    Three changes, all of them in service of that one:

     1. The pronoun is matched wherever it stands, and must stand exactly once.
     2. "it" joins the table as a third pronoun, tried as a creature and as a permanent — so the
        pronoun and the target kind are no longer one parameter.
     3. **The targeting clause has to come EARLIER in the chain.** D530 had no such rule and its
        licence cannot supply one, so a trigger whose own subject is "it" and whose later clause
        targets something would have bound the pronoun forwards onto the wrong object.

    Measured: 7,316 to 7,356 cards fully read, 22,803 to 22,849 lines.
  */
  const spell = (text: string, name = 'Probe Card') => compileCard({
    name, type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
    layout: 'normal', oracle_text: text,
  });

  it('reads Acrobatic Leap, the printing at the head of the queue', () => {
    const read = spell(
      'Target creature gets +1/+3 and gains flying until end of turn. Untap it.',
      'Acrobatic Leap',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    // One target between the two clauses, which is the whole point of a borrow.
    expect(read.script?.targets?.length).toBe(1);
    expect(read.script?.targets?.[0]?.kind).toBe('creature');
  });

  it.each([
    ['Abyssal Hunter', 'Creature — Human Assassin', '{B}, {T}: Tap target creature. This creature deals damage equal to its power to that creature.'],
    ['Aether Sting', 'Enchantment', 'Whenever an opponent casts a creature spell, Aether Sting deals 1 damage to that player.'],
    ['Furnace Scamp', 'Creature — Phyrexian Beast', 'Whenever Furnace Scamp deals combat damage to a player, you may sacrifice it. If you do, Furnace Scamp deals 3 damage to that player.'],
  ])('reads printed %s, whose pronoun is the object of its clause', (name, line, text) => {
    /*
      Three different paths to the same pronoun. The Hunter borrows from its own earlier clause
      (`composeEffects`); the Sting takes the **actor** of a cast; the Scamp takes the player it
      **hit**, which is a different seat from the actor and the reason D475's gate exists. All three
      print the pronoun after a verb rather than in front of one, which is what D530 could not read.
    */
    const read = compileCard({
      name: name as string, type_line: line as string, mana_cost: '{3}{B}', cmc: 4,
      colors: ['B'], layout: 'normal', power: '1', toughness: '1', oracle_text: text as string,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('refuses a pronoun with nothing before it to refer to', () => {
    /*
      The licence D530 already had, reached through the new pronoun: no targeting clause means
      `c.targets[0]` is `undefined` and the clause would resolve and do nothing (D362).
    */
    const read = spell('Draw a card. Untap it.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual(['Draw a card. Untap it.']);
  });

  it('refuses a pronoun that refers FORWARD to a later target', () => {
    /*
      D533's own rule, and the one that is not a refinement of D530's licence but a gap in it.
      "Whenever ~ attacks, untap it. Tap target creature." satisfies every count D530 checks — one
      targeting part, one creature, the pronoun names a creature — and the card means the attacker,
      not the creature being tapped. Bound forwards, the untap would land on the opponent's
      creature: a wrong card, not an unread one.

      Note which printing this had to be. The first draft used "it gets +1/+0 until end of turn",
      and that line **reads** — the clause vocabulary has a self-reference reader for a pump whose
      subject is "it", so nothing is borrowed and the composition is correct. A refusal row whose
      line reads for an unrelated reason is not a check on anything, which is the shape of error
      D531's break run found three of. "Untap it" has no self-reading, so the borrow is the only way
      this line could compile and the refusal is the rule's.
    */
    const read = compileCard({
      name: 'Probe Card', type_line: 'Creature — Human', mana_cost: '{1}{R}', cmc: 2,
      colors: ['R'], layout: 'normal', power: '2', toughness: '2',
      oracle_text: 'Whenever Probe Card attacks, untap it. Tap target creature.',
    });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('matches the pronoun to the kind the earlier clause really points at', () => {
    /*
      "it" is two swaps, and the clause vocabulary reads both "untap target creature" and "untap
      target permanent" — so the loop must not race. Both printings below have a correct reading and
      both get it; before the kind filter the permanent one was refused, because the creature swap
      read first and the licence then compared `creature` against a `permanent` spec.
    */
    for (const text of ['Tap target creature. Untap it.', 'Tap target permanent. Untap it.']) {
      const read = spell(text);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
    }
  });

  it('refuses a pronoun whose kind the earlier target cannot guarantee', () => {
    /*
      D530's reason for refusing `any`, restated through the new pronoun: "any target" *can* hold a
      creature, but whether it does is a fact about the game rather than about the text. A reading
      that assumed it would be right most of the time and silently wrong the rest, which is the
      trade D362 settles the other way.
    */
    const read = spell('Probe Card deals 3 damage to any target. That creature gets -1/-1 until end of turn.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('refuses a clause with two pronouns, which cannot say which one was swapped', () => {
    const read = spell('Tap target creature. It deals damage equal to its power to it.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('does not take "it" out of a word that merely contains those letters', () => {
    /*
      The word boundary. "until" contains the letters and that line still reads, which it would not
      if the match were a bare substring — "unt*target creature*l end of turn" is not a sentence.
    */
    const fine = spell('Target creature gets +2/+2 until end of turn.');
    expect(fine.ok).toBe(true);
    if (fine.ok) expect(fine.unread.map((u) => u.line)).toEqual([]);
    /*
      And "its" is a different word, which is still the rule here: `\bit\b` does not match it, so
      D533's pronoun table never offered a reading of this line.

      **The refusal this row used to assert is retired, one increment later.** It said the line
      "waits for its own reader", and D537 is that reader: "its controller" is a *possessive*
      referent with its own supply, and the line reads now. What the boundary still buys is which
      reader gets it — the possessive's, not the bare pronoun's — so the assertion is that it reads
      and declares one target rather than two.

      Second stale refusal retired this stretch, after the Furnace Scamp row in D533. Both were
      true when written and both were a note about a gap; D516's rule is that such a note has to be
      re-read when the gap closes, or the suite starts asserting the past.
    */
    const possessive = spell('Destroy target creature. Its controller loses 2 life.');
    expect(possessive.ok).toBe(true);
    if (possessive.ok) {
      expect(possessive.unread.map((u) => u.line)).toEqual([]);
      expect(possessive.script?.targets?.length).toBe(1);
    }
  });

  it('still reads D530\'s subject-position printings', () => {
    // The regression guard: widening the match must not have cost the rows it was built from.
    for (const text of [
      'Put a +1/+1 counter on target creature. That creature gains reach until end of turn.',
      'Target player discards a card. That player loses 2 life.',
    ]) {
      const read = spell(text);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
    }
  });
});

describe('a trigger that divides a quantity is not emitted (D534)', () => {
  /*
    D463's rule, one ability kind over, and found by a pod rather than by a reader test: seed 40607
    of D533's sweep ended with `the engine cannot divide a triggered ability yet`. `auto:choose`
    carries no division, so `chooseTargets` throws rather than dealing the whole amount to one
    target — and a compiler that emits such a trigger has turned an unread line into a game that
    ends with an engine error. An unread line is one a human resolves; an error is not (D362).

    **Gang of Devils is the only legal card in the corpus whose compiled trigger divided anything**,
    measured over all 31,654 legal rows, so this costs exactly that card its script line — a line
    that did not work. It is also not D533's doing: that clause is the only one on its line, so
    `composeEffects` has nothing aimed before it, the pronoun table is never consulted, and the
    reading comes from the clause vocabulary #119 added.
  */
  it('leaves Gang of Devils\' line unread rather than emitting a trigger that throws', () => {
    const read = compileCard({
      name: 'Gang of Devils', type_line: 'Creature — Devil', mana_cost: '{5}{R}', cmc: 6,
      colors: ['R'], layout: 'normal', power: '3', toughness: '3',
      oracle_text: 'When Gang of Devils dies, it deals 3 damage divided as you choose '
        + 'among one, two, or three targets.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.length).toBe(1);
    expect(read.script?.triggers ?? []).toEqual([]);
  });

  it('still divides on a SPELL, which the engine implements', () => {
    /*
      The discriminating half. A guard written one layer too high — on the shared clause reader
      rather than on `triggerFromLine` — would take Arc Lightning's whole family with it, and #119
      built the cast-time division that makes those cards work.
    */
    const read = compileCard({
      name: 'Arc Lightning', type_line: 'Sorcery', mana_cost: '{2}{R}', cmc: 3, colors: ['R'],
      layout: 'normal',
      oracle_text: 'Arc Lightning deals 3 damage divided as you choose among one, two, '
        + 'or three targets.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets?.[0]?.divided).toBe(3);
  });

  it('still emits an ordinary trigger that deals damage to one target', () => {
    // The other side of the guard: only `divided` is refused, not damage from a trigger.
    const read = compileCard({
      name: 'Probe Devil', type_line: 'Creature — Devil', mana_cost: '{3}{R}', cmc: 4,
      colors: ['R'], layout: 'normal', power: '3', toughness: '3',
      oracle_text: 'When Probe Devil dies, it deals 3 damage to any target.',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect((read.script?.triggers ?? []).length).toBe(1);
    expect(read.script?.triggers?.[0]?.targets?.[0]?.divided).toBeUndefined();
  });
});

describe('"It can\'t be regenerated", read as a rider on its sibling (D535)', () => {
  /*
    The head of the corrected queue (`scripts/measure/one-blocker.mjs`) at 17 cards, and **134 legal
    cards print the sentence** across eleven different destroy shapes — a targeted destroy, four
    sweepers, an activated ability, an upkeep trigger, a combat-damage trigger.

    It is the first clause this compiler reads that **modifies its sibling rather than doing anything
    itself**, and `composeEffects` had no way to say that: the parts run in order, each handed the
    state the one before produced, so a part cannot reach back and change how an earlier part
    behaves. `EffectContext.noRegeneration` is the answer. The rider is a fact about the
    *resolution*, every destroy in it reads the flag, and the composition is wrapped once to set it —
    so the eleven printed shapes cost one reader instead of eleven.
  */
  const spell = (text: string, name = 'Dark Banishing', type = 'Instant') => compileCard({
    name, type_line: type, mana_cost: '{2}{B}', cmc: 3, colors: ['B'], layout: 'normal',
    oracle_text: text,
  });

  it.each([
    ['Dark Banishing', 'Destroy target nonblack creature. It can\'t be regenerated.'],
    ['Wrath of God', 'Destroy all creatures. They can\'t be regenerated.'],
    ['Probe Shatter', 'Destroy target artifact. It can\'t be regenerated.'],
  ])('reads printed %s', (name, text) => {
    const read = spell(text as string, name as string, 'Sorcery');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('reads all four printed spellings of the rider', () => {
    /*
      Singular and plural, pronoun and spelled-out noun. The corpus prints all four, and they are
      one sentence rather than four readings.
    */
    for (const tail of [
      'Destroy target creature. It can\'t be regenerated.',
      'Destroy all creatures. They can\'t be regenerated.',
      'Destroy target creature. That creature can\'t be regenerated.',
      'Destroy all creatures. Those creatures can\'t be regenerated.',
    ]) {
      const read = spell(tail, 'Probe Card', 'Sorcery');
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
    }
  });

  it('refuses the rider on a sentence that does not destroy anything', () => {
    /*
      Without this the line would compile as a draw with a printed sentence silently dropped, which
      is the half-read line D487 is about.
    */
    const read = spell('Draw a card. It can\'t be regenerated.');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.unread.map((u) => u.line)).toEqual(['Draw a card. It can\'t be regenerated.']);
    }
  });

  it('refuses the rider on DAMAGE, which is a different rule', () => {
    /*
      Two legal printings pair the rider with damage — "~ deals 2 damage to target creature. It
      can't be regenerated." — and the flag does not cover them. Regeneration there is spent where
      lethal damage is noticed rather than in `destroy`, and the suppression lasts until end of turn
      on the creature, which is a continuous effect this engine has no field for. Reading those two
      as though the flag reached them would be a wrong card (D362), so they stay unread.
    */
    const read = spell('Dark Banishing deals 2 damage to target creature. It can\'t be regenerated.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('refuses the rider standing alone, with nothing to modify', () => {
    const read = spell('It can\'t be regenerated.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('leaves a destroy with no rider alone', () => {
    // The control: the flag is only set by the rider, so an ordinary destroy is unchanged.
    const read = spell('Destroy target creature.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });
});

describe('the ability a token arrives with (D536)', () => {
  /*
    The biggest single row of the corrected queue: 22 legal cards across two spellings, which is the
    Eldrazi Spawn family —

        At the beginning of your upkeep, create a 0/1 colorless Eldrazi Spawn creature token.
        It has "Sacrifice this creature: Add {C}."

    The second clause this file reads as a **rider on its sibling** (D535 was the first), and the
    mechanism is worth stating because it is almost free: a token is a `CardDef` like any other card,
    and `scriptForCard` hands a def with no hand-written script to the compiler. So writing the
    quoted sentence into the token's `oracleText` *is* the implementation — the compiler reads it
    back out when the ability is offered.

    What makes that safe is the read-back check `tokenFrom` already applies to a token's keyword
    list, extended to the quoted sentence: `lineScriptFor` has to produce an ability or a trigger
    from it, or the line is refused. A token whose printed text the engine cannot read is a token
    whose text lies, and the player is told it has an ability that does nothing.
  */
  const card = (text: string, name = 'Awakening Zone', type = 'Enchantment') => compileCard({
    name, type_line: type, mana_cost: '{2}{G}', cmc: 3, colors: ['G'], layout: 'normal',
    power: '3', toughness: '3', oracle_text: text,
  });

  it('reads Awakening Zone, the singular printing', () => {
    const read = card(
      'At the beginning of your upkeep, create a 0/1 colorless Eldrazi Spawn creature token. '
      + 'It has "Sacrifice this creature: Add {C}."',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect((read.script?.triggers ?? []).length).toBe(1);
  });

  it('reads Brood Monitor, the plural printing', () => {
    const read = card(
      'When Brood Monitor enters, create three 0/1 colorless Eldrazi Spawn creature tokens. '
      + 'They have "Sacrifice this creature: Add {C}."',
      'Brood Monitor', 'Creature — Eldrazi Drone',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('writes the quoted ability onto the token, where the engine will read it back', () => {
    /*
      The assertion that makes the rest mean something. Compiling the token's own definition — the
      `CardDef` the effect will hand `createToken` — has to produce the activated ability, because
      that is exactly what `scriptForCard` does at the table.
    */
    const token = compileCard({
      name: 'Eldrazi Spawn', type_line: 'Token Creature — Eldrazi Spawn', mana_cost: '', cmc: 0,
      colors: [], layout: 'normal', power: '0', toughness: '1',
      oracle_text: 'Sacrifice this creature: Add {C}.',
    });
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    expect(token.unread.map((u) => u.line)).toEqual([]);
    expect((token.script?.abilities ?? []).length).toBe(1);
    expect(token.script?.abilities?.[0]?.cost.sacrificeSelf).toBe(true);
  });

  it.each([
    ['a quoted triggered ability', 'When this token dies, you gain 1 life.'],
    ['a quoted mana ability', '{T}: Add {G}.'],
    ['a quoted regeneration', '{B}: Regenerate this creature.'],
  ])('reads %s, which is the tail of the 57 printings', (_what, quoted) => {
    /*
      36 of the 57 legal printings of this shape are the Eldrazi Spawn sentence; the rest are a tail
      of triggers, mana abilities and one regeneration. They come for free because the mechanism is
      "write it down and let the compiler read it", not a reader per sentence — which is the
      argument for doing it this way rather than as a row per printing.
    */
    const read = card(`Create a 1/1 green Saproling creature token. It has "${quoted as string}"`,
      'Probe Card', 'Sorcery');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('refuses a quoted ability the engine cannot read back', () => {
    /*
      The read-back check, and the row that would catch it being dropped. "Fly over the moon" is not
      an ability, so writing it onto the token would promise the player something the compiler
      cannot produce — the token would arrive with a line of text and no ability (D362).

      The check is `lineScriptFor(...) !== null` and nothing more. The first draft also demanded an
      ability or a trigger, and the break run showed that to be **both untestable and wrong**:
      untestable because this row is refused by the `null` one line above it, so the second half was
      never reached, and wrong because a quoted keyword or static is something the engine applies to
      a token too. Measured: of the 57 legal printings of this shape, **0 put a bare keyword in this
      position**, so the stricter version cost nothing — but it was a guard that could not fail,
      which is the thing this project does not keep.
    */
    const read = card('Create a 1/1 white Spirit creature token. It has "Fly over the moon."',
      'Probe Card', 'Sorcery');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('refuses the rider on a NAMED token, whose characteristics are a fixed table', () => {
    /*
      "Create a Treasure token" looks the token up in `TOKEN_DEFS`, which is shared and fixed.
      Writing text onto one would either mutate the definition every other Treasure uses or drop the
      sentence silently, so the line is refused instead.
    */
    const read = card('Create a Treasure token. It has "Sacrifice this creature: Add {C}."',
      'Probe Card', 'Sorcery');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('refuses a third clause rather than dropping a sentence', () => {
    /*
      The measured restriction: every legal printing of this shape is the token sentence and the
      rider with nothing else on the line, because the line is a trigger whose prologue has already
      come off. A longer list would need the token part sequenced after a prefix, which
      `composeEffects` can only do for parts it read itself — so it refuses (D487).
    */
    const read = card(
      'Draw a card. Create a 1/1 white Spirit creature token. It has "Sacrifice this creature: Add {W}."',
      'Probe Card', 'Sorcery',
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('still reads a token with no rider, and one with printed keywords', () => {
    // The controls: the rider is the only thing new, so both older shapes are unchanged.
    for (const text of [
      'Create a 1/1 white Spirit creature token.',
      'Create a 1/1 white Spirit creature token with flying.',
    ]) {
      const read = card(text, 'Probe Card', 'Sorcery');
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
    }
  });
});

describe('the possessive referent: "its controller" (D537)', () => {
  /*
    The joint head of the corrected queue, and the third combinator in three increments: a referent
    that is not the borrowed object but **a player derived from it**.

    "Destroy target creature. Its controller loses 2 life." is one target and two subjects — the
    first clause points at a creature, the second is about whoever controls it. D530's borrow could
    only hand a clause the object itself, so every possessive printing was unread; 139 legal cards
    put a possessive-controller clause after another sentence, and the biggest row is this one at 11.

    `ReferentSupply` is what the table grew: `'object'` is every pronoun D530 and D533 read, and
    `'controller'` reads the controller off the borrowed object's instance. The controller is read
    **live** (CR 109.4), so a permanent that changed hands between the two clauses is controlled by
    whoever controls it now.
  */
  const spell = (text: string, name = 'Probe Card', type = 'Sorcery') => compileCard({
    name, type_line: type, mana_cost: '{4}{B}{B}', cmc: 6, colors: ['B'], layout: 'normal',
    oracle_text: text,
  });

  it("reads Assassin's Strike, the printing this was built for", () => {
    const read = spell('Destroy target creature. Its controller discards a card.',
      "Assassin's Strike");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    // One target between the two clauses: the possessive borrows rather than asking again.
    expect(read.script?.targets?.length).toBe(1);
    expect(read.script?.targets?.[0]?.kind).toBe('creature');
  });

  it.each([
    ['the bare possessive', 'Destroy target creature. Its controller loses 2 life.'],
    ['the creature spelled out', "Destroy target creature. That creature's controller loses 2 life."],
    ['a permanent target', "Destroy target permanent. That permanent's controller loses 2 life."],
    ['a compound clause', 'Destroy target creature. Its controller loses 2 life and you gain 2 life.'],
  ])('reads %s', (_what, text) => {
    const read = spell(text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it("reads Bitter Downfall's removal line, and leaves its cost line unread", () => {
    /*
      An honest partial: the card is not finished, because "This spell costs {3} less to cast if it
      targets a creature that was dealt damage this turn" is its own unread row (10 cards in the
      queue). What this increment bought is the second line, and the test says exactly that rather
      than claiming the card.
    */
    const read = spell(
      'This spell costs {3} less to cast if it targets a creature that was dealt damage this turn.\n'
      + 'Destroy target creature. Its controller loses 2 life.',
      'Bitter Downfall', 'Instant',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'This spell costs {3} less to cast if it targets a creature that was dealt damage this turn.',
    ]);
  });

  it('refuses the possessive on a SPELL target, which has no instance to read', () => {
    /*
      Countersquall — "Counter target noncreature spell. Its controller loses 2 life." — and eight
      legal cards of that shape. A spell's controller lives on the stack object, not on an instance
      on the battlefield, so `'controller'` has nothing to read and the licence does not offer it.
      Stated as a measured negative rather than hidden: the counter path wants its own supply, and
      guessing a seat would be a wrong card (D362).
    */
    const read = spell('Counter target noncreature spell. Its controller loses 2 life.',
      'Countersquall', 'Instant');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('refuses the possessive with nothing before it, and on an "any target"', () => {
    for (const text of [
      'Draw a card. Its controller loses 2 life.',
      'Probe Card deals 3 damage to any target. Its controller loses 2 life.',
    ]) {
      const read = spell(text);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread.length).toBe(1);
    }
  });

  it("still reads D530's and D533's pronouns, which share the table", () => {
    for (const text of [
      'Put a +1/+1 counter on target creature. That creature gains reach until end of turn.',
      'Target player discards a card. That player loses 2 life.',
      'Tap target creature. Untap it.',
    ]) {
      const read = spell(text);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
    }
  });
});

describe('the freeze: "doesn\'t untap during its controller\'s next untap step" (D538)', () => {
  /*
    **The primitive has been in the engine since #52 and nothing could reach it.**
    `freezeNextUntap` was written for Wall of Frost, a hand-written card; the clause had no reader,
    so all 73 legal printings of the sentence compiled with that line unread. This is the reader,
    and it is the cheapest kind of increment there is — no new state, no new rule, one regex onto a
    primitive whose own tests have held since #52.

    What makes it worth more than one row is that the referent borrow does the rest. The printed
    sentence almost never names its subject: it says "That creature", or "It", or (Skyline Cascade)
    spells out a target of its own. D530 and D533 built the swap; this reader is what the swap had
    nothing to hand its result to.

    `one-blocker.mjs` ranked the family at 13 across its two pronoun rows and the real figure is
    **22 cards finished** — the instrument's fourth calibration and its largest under-read (exact
    at 8 in D532, under by 3 in D535, under by 2 in D536, under by 9 here). The reason is the same
    each time and is in its docblock: it only counts a card that is **exactly one** no-reader line
    short whose line has **exactly one** blocking clause, so Skyline Cascade's own-target form and
    every card two lines short are outside what it can see.

    The possessive is dropped on purpose. "its controller's next untap step" names no new subject —
    it is English for "the next untap step that would untap it" — and `untapAll` runs per seat over
    that seat's own battlefield, so the controller is read **at the step** (CR 502.2), which is both
    what the rules want and what D537's supply could not have given.
  */
  const row = (
    name: string, type: string, text: string,
    extra: Partial<CardDataRow> = {},
  ): ReturnType<typeof compileCard> => compileCard({
    name, type_line: type, mana_cost: '{2}{U}', cmc: 3, colors: ['U'], layout: 'normal',
    oracle_text: text, ...extra,
  });

  it('reads Frost Lynx, the printing this was built for', () => {
    const read = row('Frost Lynx', 'Creature — Elemental Cat',
      'When Frost Lynx enters, tap target creature an opponent controls. '
      + "That creature doesn't untap during its controller's next untap step.",
      { power: '2', toughness: '2' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    /*
      One target between the two sentences. The freeze borrows the tap's creature rather than
      asking for a second one, which is the whole of CR 608.2h for this card: a player who had to
      choose twice could freeze a creature the tap never touched.
    */
    expect(read.script?.triggers?.[0]?.targets?.length).toBe(1);
    expect(read.script?.triggers?.[0]?.targets?.[0]?.kind).toBe('creature');
  });

  it.each([
    ['the "It" pronoun, after a tap (Chillbringer)',
      'Flying\nWhen Chillbringer enters, tap target creature an opponent controls. '
      + "It doesn't untap during its controller's next untap step.",
      'Chillbringer', 'Creature — Elemental'],
    ['a spell whose second line is a draw (Crippling Chill)',
      "Tap target creature. It doesn't untap during its controller's next untap step.\n"
      + 'Draw a card.',
      'Crippling Chill', 'Instant'],
    ['a conjunction inside a "you may pay" (Quiet Contemplation)',
      'Whenever you cast a noncreature spell, you may pay {1}. If you do, tap target creature '
      + "an opponent controls and it doesn't untap during its controller's next untap step.",
      'Quiet Contemplation', 'Enchantment'],
  ])('reads %s', (_what, text, name, type) => {
    const read = row(name as string, type as string, text as string,
      (type as string).startsWith('Creature') ? { power: '3', toughness: '3' } : {});
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('reads the clause with no pronoun at all, where the borrow never runs', () => {
    /*
      Skyline Cascade names its own target — "target creature an opponent controls doesn't untap
      during its controller's next untap step" — so this is the reader working with the referent
      machinery switched off, and it is the row `one-blocker.mjs` could not see.
    */
    const read = row('Skyline Cascade', 'Land',
      'Skyline Cascade enters tapped.\n'
      + 'When Skyline Cascade enters, target creature an opponent controls '
      + "doesn't untap during its controller's next untap step.\n"
      + '{T}: Add {U}.',
      { mana_cost: '', cmc: 0, colors: [] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers?.[0]?.targets?.[0]?.kind).toBe('creature');
  });

  it("reads Barl's Cage, where the clause is a whole activated ability", () => {
    const read = row("Barl's Cage", 'Artifact',
      "{3}: Target creature doesn't untap during its controller's next untap step.",
      { mana_cost: '{4}', cmc: 4, colors: [] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect((read.script?.abilities ?? []).length).toBe(1);
    /*
      Not `friendly`. Holding your own creature down is a card thrown away, so the bot's default
      aim is the other side of the table — the same line the tap reader draws and Icy Manipulator's
      hand-written filter draws. Asserted because `friendly` is a *hint* nothing else can see: a
      reader that passed `true` would compile a card that works and plays badly, which nothing
      flags (D362).
    */
    expect(read.script?.abilities?.[0]?.targets?.[0]?.friendly).toBeUndefined();
  });

  it("reads Glacial Grasp, where D537's possessive and this clause share one target", () => {
    /*
      Three clauses off one target phrase: the tap, "Its controller mills two cards" (D537) and the
      freeze. The card is the first printing in the corpus that needs both referent supplies at
      once, and it is worth a row of its own because an increment that re-asked for a target would
      still pass every single-clause test above.
    */
    const read = row('Glacial Grasp', 'Instant',
      'Tap target creature. Its controller mills two cards. '
      + "That creature doesn't untap during its controller's next untap step. "
      + '(They put the top two cards of their library into their graveyard.)\n'
      + 'Draw a card.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets?.length).toBe(1);
  });

  it('refuses the Aura static, which is the same words and a different effect', () => {
    /*
      The biggest row in the whole family — 48 printings of "Enchanted creature doesn't untap
      during its controller's **untap step**" — and it is deliberately not read. Without the
      "next" the sentence is a continuous effect that holds the creature down for ever, and a
      reader that treated the two alike would make Claustrophobia a one-turn Frost Lynx: a card
      that works and is wrong (D259).

      **What refuses this printing is the subject, not the missing "next".** The break run proved
      it: making "next" optional in the pattern left this row green, because "Enchanted creature"
      is not a target phrase and `targetSpecFrom` turns it down first. The row below is the one
      that holds the "next", and it is a probe rather than a printing because no card in the corpus
      spells this sentence with a *target* and without the word.
    */
    const read = row('Claustrophobia', 'Enchantment — Aura',
      'Enchant creature\n'
      + 'When Claustrophobia enters, tap enchanted creature.\n'
      + "Enchanted creature doesn't untap during its controller's untap step.",
      { mana_cost: '{1}{U}{U}' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line))
      .toContain("Enchanted creature doesn't untap during its controller's untap step.");
  });

  it('refuses Dungeon Geists, whose freeze lasts as long as it is on the table', () => {
    // The same discrimination one card over, and with a referent: no "next", so no reading.
    const read = row('Dungeon Geists', 'Creature — Spirit',
      'Flying\n'
      + 'When this creature enters, tap target creature an opponent controls. That creature '
      + "doesn't untap during its controller's untap step for as long as you control this creature.",
      { mana_cost: '{2}{U}{U}', cmc: 4, power: '3', toughness: '3' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    /*
      Named rather than counted, because a refusal asserted as `length === 1` passes whichever line
      was refused — and this card prints three. Three of this stretch's rows refused for the wrong
      reason before being caught, so the line itself is the assertion.
    */
    expect(read.unread.map((u) => u.line)).toEqual([
      'When this creature enters, tap target creature an opponent controls. That creature '
      + "doesn't untap during its controller's untap step for as long as you control this creature.",
    ]);
  });

  it('refuses the plural referent, rather than freezing the first of two creatures', () => {
    /*
      Frost Breath taps **up to two** and then says "Those creatures". `referentEffect` supplies
      exactly one borrowed object, so a reader that accepted the plural would tap both and freeze
      one — the half-read card `foldCardTargets`' docblock calls worse than an unread line, because
      an unread line is badged for a human and a half-read one is not (D259, D362).

      18 printings wait on this: "Those creatures don't untap during their controller's next untap
      step" (11), "...their controllers' next untap steps" (4) and "They don't untap..." (3). The
      plural referent is a combinator rather than a row, and is its own increment.
    */
    const read = row('Frost Breath', 'Instant',
      'Tap up to two target creatures. '
      + "Those creatures don't untap during their controller's next untap step.");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'Tap up to two target creatures. '
      + "Those creatures don't untap during their controller's next untap step.",
    ]);

    /*
      The discriminating half: "up to two target creatures" is a phrase the tap reader has read
      since D469, so the refusal above is about the plural **referent** and not about the count.
      Without this row the test would also pass on a compiler that had never learnt to tap two.
    */
    const counted = row('Probe Breath', 'Instant', 'Tap up to two target creatures.');
    expect(counted.ok).toBe(true);
    if (counted.ok) expect(counted.unread.map((u) => u.line)).toEqual([]);
  });

  it('requires the word "next", which is the whole duration', () => {
    /*
      A probe, and deliberately so: the corpus has no printing of "target creature doesn't untap
      during its controller's untap step" — every static spelling names its subject some other way
      — so this is the only way to assert that the reader demands the word. The break run is why
      the row exists: the Claustrophobia row above passes with or without it.

      The discriminating half is in the same `it`, because the two sentences differ by one word and
      a reader that had stopped matching either would pass half of this test alone.
    */
    const forever = row('Probe Cage', 'Artifact',
      "{3}: Target creature doesn't untap during its controller's untap step.",
      { mana_cost: '{4}', cmc: 4, colors: [] });
    expect(forever.ok).toBe(true);
    if (forever.ok) expect(forever.unread.length).toBe(1);

    const oneStep = row('Probe Cage', 'Artifact',
      "{3}: Target creature doesn't untap during its controller's next untap step.",
      { mana_cost: '{4}', cmc: 4, colors: [] });
    expect(oneStep.ok).toBe(true);
    if (oneStep.ok) expect(oneStep.unread.map((u) => u.line)).toEqual([]);
  });

  it('refuses a subject that is not a permanent', () => {
    /*
      `pointsAtAPermanent` is the same guard the tap reader carries, and a probe again: no card
      aims this sentence at a player. Without the guard the clause would read and then quietly
      apply nothing, because `cardTargets` filters a player out — the silent half-card D362 is
      about. Asserted here so the guard is falsifiable rather than decorative; the break run found
      it was not.
    */
    const atAPlayer = row('Probe Cage', 'Artifact',
      "{3}: Target player doesn't untap during its controller's next untap step.",
      { mana_cost: '{4}', cmc: 4, colors: [] });
    expect(atAPlayer.ok).toBe(true);
    if (atAPlayer.ok) expect(atAPlayer.unread.length).toBe(1);
  });

  it('refuses a pronoun with nothing in front of it to borrow', () => {
    /*
      Apes of Rath's "it" is the attacker itself, not a target — there is no earlier clause, so
      `composeEffects` has nothing aimed and the pronoun table is never consulted. The honest
      reading is that the line is unread, and the discriminating half is the row above it: the same
      sentence after a tap reads, so this refusal is about the missing antecedent and not about the
      clause.
    */
    const alone = row('Apes of Rath', 'Creature — Ape',
      "Whenever Apes of Rath attacks, it doesn't untap during its controller's next untap step.",
      { mana_cost: '{2}{G}{G}', cmc: 4, colors: ['G'], power: '5', toughness: '4' });
    expect(alone.ok).toBe(true);
    if (alone.ok) expect(alone.unread.length).toBe(1);

    const borrowed = row('Probe Ape', 'Creature — Ape',
      'Whenever Probe Ape attacks, tap target creature an opponent controls. '
      + "It doesn't untap during its controller's next untap step.",
      { mana_cost: '{2}{G}{G}', cmc: 4, colors: ['G'], power: '5', toughness: '4' });
    expect(borrowed.ok).toBe(true);
    if (borrowed.ok) expect(borrowed.unread.map((u) => u.line)).toEqual([]);
  });
});

describe('"If that creature would die this turn, exile it instead" (D539)', () => {
  /*
    **The compiler's first floating replacement effect.** Every replacement before this one belonged
    to a permanent — a regeneration shield, "enters tapped", Kalitas — and was asked for by the pass
    over the battlefield. This sentence is printed on *spells*: Bleed Dry is in a graveyard by the
    time the creature it was aimed at dies, so the thing that must still be there is a
    `ContinuousEffect` with a duration, read by `replaceZoneChange`. See
    `ContinuousEffect.exiledInsteadOfDying`.

    26 legal printings say some version of this sentence and this reader takes the 16 that name
    their subject through a referent. Measured at **18 cards finished**, the instrument's fifth
    calibration and under by 2 again.

    The sentence names the same object twice — "If **that creature** would die this turn, exile
    **it** instead" — and `referentEffect` swaps one occurrence of one pronoun, so the text that
    arrives here has the target phrase in whichever slot the pronoun table reached first. Both slots
    are therefore read, and the **raw** sentence, with two pronouns and no target phrase at all,
    reads as nothing: that is the row below that matters most, because a reader which accepted it
    would arm a replacement over no objects and exile nothing, silently.
  */
  const row = (
    name: string, type: string, text: string, extra: Partial<CardDataRow> = {},
  ): ReturnType<typeof compileCard> => compileCard({
    name, type_line: type, mana_cost: '{2}{B}{B}', cmc: 4, colors: ['B'], layout: 'normal',
    oracle_text: text, ...extra,
  });

  it('reads Bleed Dry, the printing this was built for', () => {
    const read = row('Bleed Dry', 'Instant',
      'Target creature gets -13/-13 until end of turn. '
      + 'If that creature would die this turn, exile it instead.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    // One target across the two clauses: the replacement borrows rather than asking again.
    expect(read.script?.targets?.length).toBe(1);
    expect(read.script?.targets?.[0]?.kind).toBe('creature');
  });

  it('reads the "or planeswalker" printing, whose spec is a permanent', () => {
    /*
      Blitz of the Thunder-Raptor, and the row that makes the two-slot reading necessary: its spec
      is `kind: 'permanent'`, so the pronoun table reaches it through "it" as a permanent rather
      than through "that creature" as a creature — which puts the target phrase in the **object**
      slot of the swapped text.
    */
    const read = row('Blitz of the Thunder-Raptor', 'Instant',
      'Blitz of the Thunder-Raptor deals damage to target creature or planeswalker equal to the '
      + 'number of instant and sorcery cards in your graveyard. '
      + 'If that creature or planeswalker would die this turn, exile it instead.',
      { mana_cost: '{1}{R}', cmc: 2, colors: ['R'] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets?.length).toBe(1);
  });

  it('reads nothing out of the raw sentence, which names no target at all', () => {
    /*
      The most important refusal here. "If that creature would die this turn, exile it instead" on
      its own has two pronouns and no antecedent — `composeEffects` has nothing aimed before it, so
      the pronoun table is never consulted and the clause is handed to the reader as printed. Both
      slots are pronouns, neither parses as a spec, and the line stays unread.

      A probe, because no card prints this sentence as its whole text; the point is the reader's
      own shape, not a printing.
    */
    const read = row('Probe Rite', 'Sorcery',
      'If that creature would die this turn, exile it instead.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line))
      .toEqual(['If that creature would die this turn, exile it instead.']);
  });

  it('refuses a sentence whose other half is not a referent at all', () => {
    /*
      The other slot has to be a bare pronoun, not merely "something that is not a target phrase".
      Without that, `if target creature would die this turn, exile <anything> instead` reads as this
      clause and whatever the sentence actually said about the replacement is dropped on the floor —
      a card that resolves and does the wrong thing, which nothing flags (D362).

      A probe: no card prints this. It exists because a break run found the restriction was
      otherwise decorative.
    */
    const read = row('Probe Rite', 'Sorcery',
      'Destroy target creature. If that creature would die this turn, '
      + 'exile the top card of your library instead.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'Destroy target creature. If that creature would die this turn, '
      + 'exile the top card of your library instead.',
    ]);
  });

  it('refuses the sweeper form, which needs the set the sibling clause damaged', () => {
    /*
      Anger of the Gods, 8 printings: "If **a creature dealt damage this way** would die this turn,
      exile it instead". The subject is every creature the clause *before* it damaged, and nothing
      in `composeEffects` hands a clause what its sibling touched — that is a channel to build, not
      a phrase to match, and reading it as anything else would arm the replacement over the wrong
      set.
    */
    const read = row('Anger of the Gods', 'Sorcery',
      'Anger of the Gods deals 3 damage to each creature. '
      + 'If a creature dealt damage this way would die this turn, exile it instead.',
      { mana_cost: '{1}{R}{R}', cmc: 3, colors: ['R'] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'Anger of the Gods deals 3 damage to each creature. '
      + 'If a creature dealt damage this way would die this turn, exile it instead.',
    ]);
  });

  it('refuses the board-wide form, whose scope has to be read live', () => {
    /*
      Flaying Tendrils, 2 printings: "If **a** creature would die this turn, exile it instead" is
      about every creature, *including ones that arrive after it resolves*. The engine snapshots
      until-end-of-turn scopes deliberately (CR 611.2c, #280) — `pumpAll` converts a board-wide
      pump into a list of ids for exactly that reason — so there is no scope here that says "every
      creature, read when the question is asked". Unread rather than half-read.
    */
    const read = row('Flaying Tendrils', 'Sorcery',
      'Devoid (This card has no color.)\n'
      + 'All creatures get -2/-2 until end of turn. '
      + 'If a creature would die this turn, exile it instead.',
      { mana_cost: '{1}{B}{B}', cmc: 3 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'All creatures get -2/-2 until end of turn. '
      + 'If a creature would die this turn, exile it instead.',
    ]);
  });
});

describe('the graveyard return, opened up and counted (D540)', () => {
  /*
    **The reader was two words wide and the corpus prints eleven.** "Return target `creature|land`
    card from your graveyard to your hand" was written for Raise Dead and Grim Discovery, which
    print both halves of one sentence, and every other type ran into the literal alternation: `card`
    with no type at all (12 printings), `permanent` (14), `instant or sorcery` (8), `artifact` (6),
    `enchantment` (3), `sorcery` (2), `artifact or creature` (2), `artifact or enchantment` (2),
    `historic` (1).

    None of those needed new vocabulary. `graveyardCardPhrase` has read the type run, the
    disjunction, the `permanent` list and `nonland` composed with a second word since D527 — the
    reader simply was not asking it. Opening the phrase is one regex, and the measured result is
    **+88 cards with every printed line read**, which is 5.5x what the queue predicted for the two
    rows it could see. The reason it is so much more is that the counting quantifier went into
    `graveyardCardPhrase` rather than into this reader, so the exile-from-graveyard and reanimation
    families got it at the same time.

    And a count: "Return **up to two** target creature cards from your graveyard to your hand" is 17
    printings, read with `foldCardTargets` rather than `firstCardTarget` — the pair D469 made
    inseparable, because a reader that asks for two targets and moves one of them is a card that
    does half of what it says.
  */
  const row = (
    name: string, type: string, text: string, extra: Partial<CardDataRow> = {},
  ): ReturnType<typeof compileCard> => compileCard({
    name, type_line: type, mana_cost: '{3}{B}', cmc: 4, colors: ['B'], layout: 'normal',
    oracle_text: text, ...extra,
  });

  it('reads Dead Revels, and asks for both cards', () => {
    const read = row('Dead Revels', 'Sorcery',
      'Spectacle {1}{B} (You may cast this spell for its spectacle cost rather than its mana cost '
      + 'if an opponent lost life this turn.)\n'
      + 'Return up to two target creature cards from your graveyard to your hand.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets?.length).toBe(1);
    // "up to two" is both halves: two of them, and none is a legal answer.
    expect(read.script?.targets?.[0]?.count).toBe(2);
    expect(read.script?.targets?.[0]?.optional).toBe(true);
  });

  it.each([
    ['no type at all', 'Return target card from your graveyard to your hand.'],
    ['a permanent card', 'Return target permanent card from your graveyard to your hand.'],
    ['a disjunction', 'Return target instant or sorcery card from your graveyard to your hand.'],
    ['an artifact', 'Return target artifact card from your graveyard to your hand.'],
    ['up to one', 'Return up to one target creature card from your graveyard to your hand.'],
    ['two of them', 'Return up to two target permanent cards from your graveyard to your hand.'],
  ])('reads %s', (_what, text) => {
    const read = row('Probe Rite', 'Sorcery', text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('still gives Raise Dead the hand-written spec, which a ground-truth test compares', () => {
    /*
      The regression guard that matters most. `targetSpecFrom`'s exact-phrase switch keeps
      `target creature card in your graveyard` with a hand-written `filter` by reference, and
      `compiled-vs-written.test.ts` compares the compiled spec against Raise Dead's character for
      character. Opening the phrase rebuilds exactly that string for the plain printing — asserted
      here rather than left to the other file, because this is the reader that rebuilds it.
    */
    const read = row('Raise Dead', 'Sorcery',
      'Return target creature card from your graveyard to your hand.',
      { mana_cost: '{B}', cmc: 1 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.targets?.[0]?.kind).toBe('graveyard-creature');
    expect(read.script?.targets?.[0]?.description)
      .toBe('target creature card in your graveyard');
    expect(read.script?.targets?.[0]?.count).toBeUndefined();
  });

  it('refuses a relation between the two choices', () => {
    /*
      "Return **two target creature cards that share a creature type** from your graveyard to your
      hand" (3 printings). `TargetSpec.filter` is asked about one candidate at a time, so there is
      nowhere to say "and the same type as the other one" — a reader that dropped the clause would
      let a player take any two creatures, which is a strictly better card than the one printed
      (D259).
    */
    const read = row('Probe Rite', 'Sorcery',
      'Return two target creature cards that share a creature type from your graveyard '
      + 'to your hand.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.length).toBe(1);
  });

  it('refuses a target count that is X', () => {
    /*
      "Return **X** target creature cards from your graveyard to your hand" (5 printings). The
      engine's X is announced as a cost is paid and `TargetSpec.count` is a number read when the
      targets are asked for; a count of X is a third thing, and reading it as one or as two would
      be a different card either way.
    */
    const read = row('Probe Rite', 'Sorcery',
      'Return X target creature cards from your graveyard to your hand.',
      { mana_cost: '{X}{B}', cmc: 1 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.length).toBe(1);
  });
});

describe('the mass pump, read by its subject (D541)', () => {
  /*
    **Two regexes with one shape between them, and five scopes that had neither.** The compiler read
    `creatures you control get +N/+N until end of turn` — plus only — and `all creatures get ±N/±N`.
    The corpus prints **492 sentences** in this family and the subject is where they differ:
    `creatures your opponents control` (22 printings), `attacking creatures` (10), `other creatures
    you control` (7), `blocking creatures` (3), `creatures target player controls` (3). The first
    reader also refused a minus sign, so a penalty on your own team was unread.

    One reader now, with the subject looked up in `massPumpSubject`, and **+39 cards finished**.

    Every scope returns a **list** of ids, which `pump` freezes into the effect (CR 611.2c, #280) —
    which is what `pumpTeam` and `pumpAll` already did for an until-end-of-turn duration, so the two
    phrases this replaces behave identically. It is also the only way the two combat scopes are
    expressible at all: "the creatures attacking right now" is a fact about `state.combat` when the
    spell resolves, not a scope a continuous effect could keep asking.
  */
  const row = (
    name: string, type: string, text: string, extra: Partial<CardDataRow> = {},
  ): ReturnType<typeof compileCard> => compileCard({
    name, type_line: type, mana_cost: '{2}{W}', cmc: 3, colors: ['W'], layout: 'normal',
    oracle_text: text, ...extra,
  });

  it.each([
    ['the opponents\' board (Bewildering Blizzard)',
      'Draw three cards. Creatures your opponents control get -3/-0 until end of turn.'],
    ['the attackers (Army of Allah)', 'Attacking creatures get +2/+0 until end of turn.'],
    ['the blockers (Hold the Line)', 'Blocking creatures get +7/+7 until end of turn.'],
    ['one player\'s board (Arms of Hadar)',
      'Creatures target player controls get -2/-2 until end of turn.'],
    ['the rest of your team', 'Other creatures you control get +1/+1 until end of turn.'],
    ['a penalty on your own team', 'Creatures you control get -1/-1 until end of turn.'],
  ])('reads %s', (_what, text) => {
    const read = row('Probe Rite', 'Instant', text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('asks for the player, and only for that scope', () => {
    /*
      "Creatures target player controls" is the one subject here that is a question. Asserted
      alongside a scope that is **not**, because a reader that declared a target for every phrase
      would make Inspired Charge ask who to pump.
    */
    const aimed = row('Arms of Hadar', 'Sorcery',
      'Creatures target player controls get -2/-2 until end of turn.',
      { mana_cost: '{3}{B}', colors: ['B'] });
    expect(aimed.ok).toBe(true);
    if (aimed.ok) {
      expect(aimed.unread.map((u) => u.line)).toEqual([]);
      expect(aimed.script?.targets?.length).toBe(1);
      expect(aimed.script?.targets?.[0]?.kind).toBe('player');
    }

    const team = row('Inspired Charge', 'Instant',
      'Creatures you control get +2/+1 until end of turn.', { mana_cost: '{2}{W}{W}', cmc: 4 });
    expect(team.ok).toBe(true);
    if (team.ok) expect(team.script?.targets).toBeUndefined();
  });

  it('keeps the two readings it replaced exactly as they were', () => {
    /*
      The regression guard. `expiresAtEndOfTurn` is the bot's "hold this for the combat" hint, and
      the two readers this one replaced disagreed about it: the team pump set it (D364, where a
      compiled Inspired Charge otherwise gets cast in a main phase with nothing to attack with) and
      the sweeper did not. Both are preserved rather than unified, and the test says which is which
      so a future change has to decide on purpose.
    */
    const team = row('Inspired Charge', 'Instant',
      'Creatures you control get +2/+1 until end of turn.', { mana_cost: '{2}{W}{W}', cmc: 4 });
    expect(team.ok).toBe(true);
    if (team.ok) expect(team.script?.expiresAtEndOfTurn).toBe(true);

    const sweep = row('Golgari Charm', 'Instant',
      'All creatures get -1/-1 until end of turn.', { mana_cost: '{B}{G}', cmc: 2, colors: ['B', 'G'] });
    expect(sweep.ok).toBe(true);
    if (sweep.ok) {
      expect(sweep.unread.map((u) => u.line)).toEqual([]);
      expect(sweep.script?.expiresAtEndOfTurn).toBeUndefined();
    }

    /*
      And with a plus, which is the row that makes the preservation falsifiable: the sweeper reader
      set no hint whatever the sign, so a symmetric bonus gets none either. Without this row a
      change that flagged every bonus would pass, because both negative rows above are silent about
      a flag they were never going to have.
    */
    const bothWays = row('Probe Rite', 'Instant', 'All creatures get +1/+1 until end of turn.');
    expect(bothWays.ok).toBe(true);
    if (bothWays.ok) {
      expect(bothWays.unread.map((u) => u.line)).toEqual([]);
      expect(bothWays.script?.expiresAtEndOfTurn).toBeUndefined();
    }
  });

  it('tells the bot to hold a combat-only pump', () => {
    /*
      "Attacking creatures get +2/+0" does **nothing at all** outside combat, so it wants the hint
      more than anything else in the family — and it is the row that proves `holdForCombat` is read
      per subject rather than set for every bonus.
    */
    const attackers = row('Army of Allah', 'Instant',
      'Attacking creatures get +2/+0 until end of turn.', { mana_cost: '{1}{W}{W}' });
    expect(attackers.ok).toBe(true);
    if (attackers.ok) expect(attackers.script?.expiresAtEndOfTurn).toBe(true);

    // And off for the opponents' board, which is a sweep in one light and a trick in the other.
    const theirs = row('Bewildering Blizzard', 'Instant',
      'Creatures your opponents control get -3/-0 until end of turn.',
      { mana_cost: '{4}{U}{U}', cmc: 6, colors: ['U'] });
    expect(theirs.ok).toBe(true);
    if (theirs.ok) expect(theirs.script?.expiresAtEndOfTurn).toBeUndefined();
  });

  it('refuses a subject it has no scope for', () => {
    /*
      Tribal Unity's "creatures of the creature type of your choice" is a scope whose membership is
      chosen as the spell resolves, and `massPumpSubject` has no entry for it — so the line is
      unread rather than pumped as something else. The discriminating half is every row above: the
      refusal is about this subject, not about the sentence.
    */
    const read = row('Tribal Unity', 'Instant',
      'Creatures of the creature type of your choice get +2/+2 until end of turn.',
      { mana_cost: '{X}{2}{G}', colors: ['G'] });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });
});

describe('the bite and the fight: two targets pointed at each other (D542)', () => {
  /*
    **415 legal printings, split two ways.** The **bite** is one-way — "Target creature you control
    deals damage equal to its power to target creature you don't control" — and the **fight** is both
    ways, which is a keyword action with its own rule (CR 701.12a).

    `fight` has been in the compiler since Prey Upon and gets the one thing right that matters: both
    powers are read **before** either damage is dealt, so a creature that dies to the first half
    still deals its own. The bite cannot reuse it — one-way is one-way — but the two are read side by
    side so the pair stays legible.

    Damage comes from the **creature**, not from the spell, so deathtouch, lifelink, infect and
    wither all apply. A reader that passed the spell as the source would compile a card that works
    and silently turns off four keywords.
  */
  const row = (
    name: string, type: string, text: string, extra: Partial<CardDataRow> = {},
  ): ReturnType<typeof compileCard> => compileCard({
    name, type_line: type, mana_cost: '{1}{G}', cmc: 2, colors: ['G'], layout: 'normal',
    oracle_text: text, ...extra,
  });

  it.each([
    ['the bite (Rabid Bite)',
      "Target creature you control deals damage equal to its power to target creature you don't control."],
    ['a bite that may hit a planeswalker (Bite Down)',
      'Target creature you control deals damage equal to its power to target creature or '
      + "planeswalker you don't control."],
    ['the bite aimed at an opponent\'s board',
      'Target creature you control deals damage equal to its power to target creature an '
      + 'opponent controls.'],
    ['the fight (Prey Upon)',
      "Target creature you control fights target creature you don't control. "
      + '(Each deals damage equal to its power to the other.)'],
    ['a fight against another target (Pit Fight)',
      'Target creature you control fights another target creature. '
      + '(Each deals damage equal to its power to the other.)'],
  ])('reads %s', (_what, text) => {
    const read = row('Probe Rite', 'Sorcery', text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('declares both targets, in the order the sentence names them', () => {
    /*
      The order is the card: `cardTargets` hands them back in spec order, and a reader that swapped
      them would have the opponent's creature biting yours. Asserted by description rather than by
      kind, because both are creatures and the kind cannot tell them apart.
    */
    const read = row('Rabid Bite', 'Sorcery',
      "Target creature you control deals damage equal to its power to target creature you don't control.");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.targets?.map((t) => t.description))
      .toEqual(['target creature you control', "target creature you don't control"]);
  });

  it('aims the first target at your own side, and reads that off the words', () => {
    /*
      `friendly` is the bot's aim, not a restriction — the phrase's own filter already decides what
      is legal. Almost every printing bites with your creature, so the hint belongs there; but the
      corpus also prints a bite whose *subject* is an opponent's creature, and the same hint there
      would point the bot at a board it may not choose from. So it is read from the printed words and
      nowhere else, which is what the second half of this row asserts.
    */
    const mine = row('Rabid Bite', 'Sorcery',
      "Target creature you control deals damage equal to its power to target creature you don't control.");
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.script?.targets?.[0]?.friendly).toBe(true);
      expect(mine.script?.targets?.[1]?.friendly).toBeUndefined();
    }

    const theirs = row('Probe Rite', 'Sorcery',
      'Target creature an opponent controls deals damage equal to its power to another target '
      + 'creature that player controls.');
    expect(theirs.ok).toBe(true);
    // Unread for its own reason — "that player controls" is a phrase nothing reads — but if it ever
    // reads, the hint must not be friendly. Asserted as the refusal it is today.
    if (theirs.ok) expect(theirs.unread.length).toBe(1);

    /*
      **The rows that make "read it off the words" falsifiable**, which two break runs asked for in
      turn. The refusal above is silent about a flag it was never going to carry, and the fight row
      below exercises the *fight* reader — so neither one fails when the *bite* reader hardcodes the
      hint. Every bite printing in the corpus that reads today says "you control" in its subject
      (Mutiny and Breaking of the Fellowship are the two that do not, and both are unread for the
      phrase after the verb), so there is no real card that can tell the two readers apart here.

      That is what a probe row is for: a placeholder name over text no printing carries, asserting
      the behaviour a real card would need the day its other phrase reads. The subject names no
      controller, so the compiled spec must carry no aim.
    */
    const bareBite = row('Probe Rite', 'Sorcery',
      "Target creature deals damage equal to its power to target creature you don't control.");
    expect(bareBite.ok).toBe(true);
    if (bareBite.ok) {
      expect(bareBite.unread.map((u) => u.line)).toEqual([]);
      expect(bareBite.script?.targets?.[0]?.friendly).toBeUndefined();
    }

    /*
      The fight's own version of the same row (Pit Fight, 2 printings) — a real printing that names
      no controller on its second target, so a fight reader that aimed both halves at your side
      fails here.
    */
    const unowned = row('Pit Fight', 'Instant',
      'Target creature you control fights another target creature. '
      + '(Each deals damage equal to its power to the other.)');
    expect(unowned.ok).toBe(true);
    if (unowned.ok) expect(unowned.script?.targets?.[1]?.friendly).toBeUndefined();

    const neither = row('Probe Rite', 'Instant', 'Target creature fights another target creature.');
    expect(neither.ok).toBe(true);
    if (neither.ok) {
      expect(neither.unread.map((u) => u.line)).toEqual([]);
      expect(neither.script?.targets?.[0]?.friendly).toBeUndefined();
    }
  });

  it('refuses the referent forms, which declare two targets and borrow one', () => {
    /*
      The bigger half of the family, and refused on purpose. "It fights target creature you don't
      control" (Epic Confrontation's second sentence) borrows its first target from the clause
      before it — and `referentEffect` turns down any reading that declares more than one target,
      because it supplies exactly one object. Supplying one of two is a real extension to the
      borrow, so these wait for it rather than being half-read now.

      Asserted on the real printing, with the sentence that reads shown beside the one that does
      not: Epic Confrontation's pump is read and its fight is not.
    */
    const read = row('Epic Confrontation', 'Sorcery',
      'Target creature you control gets +1/+2 until end of turn. '
      + "It fights target creature you don't control. "
      + '(Each deals damage equal to its power to the other.)');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.length).toBe(1);
  });

  it('refuses a bite whose subject is not a creature', () => {
    /*
      A probe, and the guard that keeps the open phrase honest: `kind === 'creature'` on the biter,
      because "equal to its power" is a question only a creature can answer. Without it a land or a
      player target would reach `characteristicsOf` and read a power of zero, which is a card that
      resolves and does nothing.
    */
    const read = row('Probe Rite', 'Sorcery',
      'Target land you control deals damage equal to its power to target creature you don\'t control.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });
});

describe("the blink's second half, read as a clause (D543)", () => {
  /*
    **The pair the compiler could read half of.** "Exile another target permanent you control" has
    had a reader since D404; "then return it to the battlefield under its owner's control" had none,
    and D487's rule meant the whole line went unread rather than compiling into removal of your own
    permanent.

    `blinkResolution` has read Cloudshift since it was written, but it takes the **whole spell line**
    — so the 18 cards this increment finishes were out of its reach by construction: a trigger
    (Felidar Guardian, Wispweaver Angel), activated abilities (Distinguished Conjurer, Nephalia
    Smuggler, Ruin Ghost), an end-step trigger (Conjurer's Closet, Teleportation Circle), a mode
    (Settle Beyond Reality) and four spells with a third sentence after the blink (Justiciar's
    Portal, Personify, Scrollshift, Momentary Blink's flashback). Read as a clause it works on every
    path at once, because `composeEffects` runs on the clause chain of a spell, a trigger and an
    ability alike.
  */
  const row = (
    name: string, type: string, text: string, extra: Partial<CardDataRow> = {},
  ): ReturnType<typeof compileCard> => compileCard({
    name, type_line: type, mana_cost: '{1}{W}', cmc: 2, colors: ['W'], layout: 'normal',
    oracle_text: text, ...extra,
  });

  it.each([
    ['the spell, with "it" (Ephemerate)', 'Instant',
      "Exile target creature you control, then return it to the battlefield under its owner's control.",
      {}],
    ['the spell, with "that card" (Acrobatic Maneuver)', 'Instant',
      "Exile target creature you control, then return that card to the battlefield under its owner's"
      + ' control.', {}],
    ['under your control (Nephalia Smuggler\'s wording)', 'Instant',
      'Exile another target creature you control, then return that card to the battlefield under '
      + 'your control.', {}],
    ['a permanent rather than a creature (Felidar Guardian)', 'Creature — Cat Beast',
      'When this creature enters, you may exile another target permanent you control, then return '
      + "that card to the battlefield under its owner's control.", { power: '3', toughness: '4' }],
    ['a land (Ruin Ghost)', 'Creature — Spirit',
      '{W}, {T}: Exile target land you control, then return it to the battlefield under your '
      + 'control.', { power: '1', toughness: '1' }],
    ['one that may point anywhere (Flicker of Fate)', 'Instant',
      "Exile target creature or enchantment, then return it to the battlefield under its owner's"
      + ' control.', {}],
    ['one with a sentence after it (Justiciar\'s Portal)', 'Instant',
      "Exile target creature you control, then return that card to the battlefield under its owner's"
      + ' control. It gains first strike until end of turn.', {}],
  ])('reads %s', (_what, type, text, extra) => {
    const read = row(
      'Probe Rite', type as string, text as string, (extra ?? {}) as Partial<CardDataRow>,
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('carries the blink hint, which is the whole reason this is a composition rule', () => {
    /*
      `TargetSpec.blinks` is #209's subject: what a permanent loses by leaving is what decides
      whether a blink helps or hurts, a token ceases to exist (CR 111.7), and the bot cannot read any
      of that off a candidate list. The exile clause cannot set it — "exile another target permanent
      you control" is the same sentence Hidden Dragonslayer prints — so `composeEffects` is the only
      layer that can, and it does it by finding a part that returns the object.
    */
    const read = row('Probe Rite', 'Instant',
      "Exile target creature you control, then return it to the battlefield under its owner's control.");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.script?.targets?.[0]).toMatchObject({ blinks: true });
  });

  it('aims at your own side only when the printed phrase says so', () => {
    /*
      D542's discipline, and this family needs it for a real printing rather than a probe. Flicker of
      Fate says "exile target creature **or enchantment**" and names no controller: blinking an
      opponent's creature to strip the Aura off it, or to reset a creature they have just pumped, is
      a line a player takes. `friendly` there would aim the bot at its own board for a card the print
      lets point anywhere, and a hint pointing the wrong way plays worse than none (D362).

      `blinks` is on both, because that one is a fact about the effect rather than about the aim.
    */
    const ours = row('Probe Rite', 'Instant',
      "Exile target creature you control, then return it to the battlefield under its owner's control.");
    expect(ours.ok).toBe(true);
    if (ours.ok) expect(ours.script?.targets?.[0]).toMatchObject({ blinks: true, friendly: true });

    const either = row('Flicker of Fate', 'Instant',
      "Exile target creature or enchantment, then return it to the battlefield under its owner's"
      + ' control.');
    expect(either.ok).toBe(true);
    if (either.ok) {
      expect(either.script?.targets?.[0]?.blinks).toBe(true);
      expect(either.script?.targets?.[0]?.friendly).toBeUndefined();
    }
  });

  it('stops claiming to remove a creature, which the exile clause asked for on its own', () => {
    /*
      **The falsifying card, and it is a real printing.** `removesACreature` tells the bot to hold a
      card for a board it can answer, and the exile reader sets it off the printed phrase: Flicker of
      Fate's "target creature or enchantment" mentions a creature, so its exile half declares it.
      With the return clause after it the flag is a lie — nothing is removed — and a bot holding
      Flicker of Fate as its answer to a threat is a bot that never answers the threat.

      Asserted on the card rather than on a probe, so a change that stopped dropping the flag fails
      here. Ephemerate cannot catch it: its phrase is "target creature you control", which the exile
      reader flags too, but `removesACreature` on a card that can only point at your own board is
      wrong for a second reason and this row is about the first.
    */
    const read = row('Flicker of Fate', 'Instant',
      "Exile target creature or enchantment, then return it to the battlefield under its owner's"
      + ' control.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.script?.removesACreature).toBeUndefined();

    // And the flag really is what the exile clause alone produces, so the row above is not vacuous.
    const exileOnly = row('Probe Rite', 'Instant', 'Exile target creature or enchantment.');
    expect(exileOnly.ok).toBe(true);
    if (exileOnly.ok) expect(exileOnly.script?.removesACreature).toBe(true);
  });

  it.each([
    ['the delayed return (Flickerwisp, 8 printings)',
      'When this creature enters, exile another target permanent. Return that card to the '
      + "battlefield under its owner's control at the beginning of the next end step."],
    ['a counter on the way back (Long Road Home)',
      'Exile target creature. At the beginning of the next end step, return that card to the '
      + "battlefield under its owner's control with a +1/+1 counter on it."],
    ['tapped (Feign Death\'s granted ability)',
      "Exile target creature you control, then return it to the battlefield tapped under its owner's"
      + ' control.'],
    ['transformed (Aclazotz\'s wording)',
      'Exile target creature you control, then return it to the battlefield tapped and transformed '
      + "under its owner's control."],
    ['the plural (Displace)',
      'Exile up to two target creatures you control, then return those cards to the battlefield '
      + "under their owner's control."],
  ])('refuses %s', (_what, text) => {
    /*
      Each refuses the **line** (D487), and each for its own reason rather than for a shared one.
      The delayed return needs a delayed trigger (CR 603.7) and a different card: Flickerwisp exiles
      a permanent its controller does not own and gives it back a step later, which is removal for a
      turn rather than a blink. `tapped`, `transformed` and the counter are riders this reader does
      not read, and silently dropping any of them makes a strictly different card — an Aclazotz that
      came back un-transformed is the wrong card entirely.

      The plural waits on the plural referent, which `referentEffect` cannot supply: it hands the
      clause exactly one object, and "those cards" is two. That is the same deferral D538 recorded
      and it is now the biggest single row left in this family.
    */
    const read = row('Probe Rite', 'Instant', text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBeGreaterThan(0);
  });
});

describe('the single-target pump, opened up (D544)', () => {
  /*
    The reader's subject was a fixed list of three phrases while `targetSpecFrom` had been parsing a
    far wider vocabulary for several increments — the same gap D540 closed on the graveyard return,
    and worth the same. These rows are the vocabulary, not the arithmetic: the sizes and the aim are
    asserted in the D454 table above, across all four sign quadrants.
  */
  const row = (text: string, type = 'Instant'): ReturnType<typeof compileCard> => compileCard({
    name: 'Probe Rite', type_line: type, mana_cost: '{G}', cmc: 1, colors: ['G'], layout: 'normal',
    oracle_text: text,
  });

  it.each([
    ['a filter on the creature (Gallantry)',
      'Target creature with flying gets +2/+2 until end of turn.'],
    ['a type run (Fang Guardian\'s trigger)',
      'Target creature or Vehicle you control gets +2/+2 until end of turn.'],
    ['the "another" quantifier (Imperial Aerosaur)',
      'Another target creature you control gets +1/+1 until end of turn.'],
    ['"up to one other" (Mabel\'s Mettle)',
      'Up to one other target creature you control gets +1/+1 until end of turn.'],
    ['a grant on a mixed size (Flowstone Strike)',
      'Target creature gets +1/-1 and gains trample until end of turn.'],
  ])('reads %s', (_what, text) => {
    const read = row(text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('refuses a phrase that does not point at a permanent', () => {
    /*
      `pointsAtAPermanent` is the guard that lets the subject be an open phrase, and it is the same
      guard destroy and exile use. `targetSpecFrom` can build a player, and `pump` writes power and
      toughness — "target player gets +2/+2" is not a card, and without the guard it would be the
      first printed sentence of that shape compiling into something the engine cannot apply.

      A probe row: no printing says this, which is exactly why the guard needs one (D538's pattern).
    */
    const read = row('Target player gets +2/+2 until end of turn.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('refuses a quantifier that asks for more than one, because the effect pumps one', () => {
    /*
      D469's pair: the effect is `firstCardTarget`, so a spec asking for two would pump one of them
      and silently do half of what it says. No printed plural reaches here — the plural is spelled
      "two target creatures **get**" and this reader demands "gets" — so this is a probe for the day
      a quantifier admits one that does.
    */
    const read = row('Two target creatures gets +1/+1 until end of turn.');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('tells the bot a keyword helps in combat only when the size helps too', () => {
    /*
      `helpsInCombat` means "the whole value of this is in the attack" — Tainted Strike and Crimson
      Wisps, the two hand-written specs that carry it. A *penalty* that grants haste is Flowstone
      Strike pointed at somebody else's creature, and the flag there would tell the bot to aim a
      removal spell at its own board.

      The discriminating pair: the same granted keyword, one size helping and one not.
    */
    const helping = row('Target creature gets +1/+1 and gains haste until end of turn.');
    expect(helping.ok).toBe(true);
    if (helping.ok) expect(helping.script?.targets?.[0]?.helpsInCombat).toBe(true);

    const hurting = row('Target creature gets +1/-1 and gains haste until end of turn.');
    expect(hurting.ok).toBe(true);
    if (hurting.ok) {
      expect(hurting.unread.map((u) => u.line)).toEqual([]);
      expect(hurting.script?.targets?.[0]?.helpsInCombat).toBeUndefined();
    }
  });
});

describe('the counter-exile rider (D545)', () => {
  /*
    `noRegenerationRider`'s sibling, and the second clause this file reads as a modifier on another
    clause rather than as an effect of its own. Twenty legal cards print it over six different
    counter sentences, so one flag on the context covers what six readers would have had to.

    What it changes is not cosmetic: a buried spell can be recast from the graveyard, reanimated or
    dredged back, and exiling it is the whole reason Dissipate costs one more than Cancel.
  */
  const row = (text: string): ReturnType<typeof compileCard> => compileCard({
    name: 'Probe Rite', type_line: 'Instant', mana_cost: '{1}{U}{U}', cmc: 3, colors: ['U'],
    layout: 'normal', oracle_text: text,
  });
  const RIDER = 'If that spell is countered this way, exile it instead of putting it into its '
    + "owner's graveyard.";

  it.each([
    ['the plain counter (Dissipate)', `Counter target spell. ${RIDER}`],
    ['a filtered counter (Deny Existence)', `Counter target creature spell. ${RIDER}`],
    ['a counter with a cost filter (Liquify)',
      `Counter target spell with mana value 3 or less. ${RIDER}`],
    ['the "unless its controller pays" form (Spell Shrivel)',
      `Counter target spell unless its controller pays {4}. ${RIDER}`],
    ['"a spell" rather than "that spell" (Defabricate\'s mode)',
      'Counter target artifact or enchantment spell. If a spell is countered this way, exile it '
      + "instead of putting it into its owner's graveyard."],
    /*
      **The rider in the middle of the chain**, which is where Devious Cover-Up and Spelljack print
      it and the one place this differs from `noRegenerationRider`. Position cannot matter for a flag
      set around the whole composition, so the reader finds the rider wherever it stands rather than
      anchoring to the last clause — and this row is what makes that a rule rather than an accident.
    */
    ['the rider with a sentence after it', `Counter target spell. ${RIDER} Draw a card.`],
    /*
      And a **tail on the rider's own sentence**, which `clausesOf` splits at ", then " so that the
      two halves compose: the rider is removed from the chain and "draw a card" stays in it. Here
      because the refusal row below needs it — it is what shows that the Transcendent Dragon case is
      refused by its free cast rather than by the rider's pattern.
    */
    ['a readable tail after the rider',
      'Counter target spell. If that spell is countered this way, exile it instead of putting it '
      + "into its owner's graveyard, then draw a card."],
  ])('reads %s', (_what, text) => {
    const read = row(text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('refuses the rider with no counter beside it', () => {
    /*
      The sibling test, and it is on the **printed word** rather than on the composed reading, for
      `noRegenerationRider`'s reason. Without it this compiles as a draw with a sentence silently
      dropped, which is the half-read line D487 is about — and because the test is on the text, a
      counter sentence this engine cannot read (a cost computed off the board, a cost that is not
      mana) refuses the whole line instead of having the rider read onto a counter that is not there.
    */
    const read = row(`Draw a card. ${RIDER}`);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBeGreaterThan(0);
  });

  it.each([
    ['a condition on the countered spell\'s type (Thranduil\'s Decree)',
      'Counter target spell. If a permanent spell is countered this way, exile it instead of '
      + "putting it into its owner's graveyard."],
    ['the replacement on resolution, not on being countered (Rod of Absorption)',
      'Counter target spell. Whenever a player casts an instant or sorcery spell, exile it instead '
      + 'of putting it into a graveyard as it resolves.'],
    /*
      **A promise after the comma** (Transcendent Dragon): "… exile it instead of putting it into its
      owner's graveyard, **then you may cast it without paying its mana cost**." It refuses, and the
      refusal is right — exiling the spell and silently dropping the permission is the
      strictly-worse-card failure D487 is about.

      **But it is not the pattern's anchor that refuses it, and a break run proved that.** `clausesOf`
      splits on ", then ", so the tail is a *separate clause* and the rider's own pattern never sees
      it: what refuses the line is the free cast having no reader. The row above this one is the
      evidence — the same shape with a readable tail ("…, then draw a card") compiles, both halves.

      So the `$` on the pattern is belt-and-braces given the splitter, and that is recorded here
      rather than defended with a break that cannot fail (D533's vacuous four).
    */
    ['a promise after the comma (Transcendent Dragon)',
      "Counter target spell. If that spell is countered this way, exile it instead of putting it "
      + "into its owner's graveyard, then you may cast it without paying its mana cost."],
  ])('refuses %s', (_what, text) => {
    /*
      Two near-misses, and each would be a wrong card rather than an unread line. "A **permanent**
      spell" is a condition the flag cannot express, so reading it would exile an instant the card
      leaves in the graveyard. "As it **resolves**" is a different mechanic — a replacement on a
      spell finishing — and a counter is not a resolution.
    */
    const read = row(text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBeGreaterThan(0);
  });
});

describe('two clauses the engine already had the primitive for (D546)', () => {
  /*
    The bounce one zone further back, and the bite pointed at itself. Neither is a new mechanic: one
    is `relocate` to the top of a library, the other is D542's bite with a single target. They ship
    together because that is what they have in common — the engine could already do both, and only
    the sentence was missing.
  */
  const row = (text: string, type = 'Instant'): ReturnType<typeof compileCard> => compileCard({
    name: 'Probe Rite', type_line: type, mana_cost: '{1}{U}', cmc: 2, colors: ['U'],
    layout: 'normal', oracle_text: text,
  });

  it.each([
    ['a creature (Excommunicate)', "Put target creature on top of its owner's library."],
    ['one you control (Civic Guildmage)',
      "Put target creature you control on top of its owner's library."],
    ['a nonland permanent (Set Adrift)',
      "Put target nonland permanent on top of its owner's library."],
    ['one read off combat (Aethertow)',
      "Put target attacking or blocking creature on top of its owner's library."],
    ['a land (Fallow Earth)', "Put target land on top of its owner's library."],
    ['any permanent (Gone Missing)', "Put target permanent on top of its owner's library."],
  ])('puts %s on top of its library', (_what, text) => {
    const read = row(text as string);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('refuses a phrase that does not point at a permanent', () => {
    // `pointsAtAPermanent`, the same guard the bounce uses and for the same reason: `targetSpecFrom`
    // can build a player, and a player does not go on top of a library. A probe, because no printing
    // says it.
    const read = row("Put target player on top of its owner's library.");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.length).toBe(1);
  });

  it('reads the self-bite, and refuses the shapes beside it', () => {
    /*
      Inner Struggle's sentence (7 printings). One target where D542's bite has two, which is why it
      is its own pattern: a reader that made the bite's second target optional would accept "target
      creature deals damage equal to its power to" with nothing after it.
    */
    const read = row('Target creature deals damage to itself equal to its power.');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.unread.map((u) => u.line)).toEqual([]);
      expect(read.script?.targets?.[0]?.description).toBe('target creature');
      // No aim: the card is removal, and the hostile default is what no `friendly` means (D544).
      expect(read.script?.targets?.[0]?.friendly).toBeUndefined();
    }

    /*
      **The sweeper is refused**, and it is the bigger half of the family by printings — Solar Blaze
      and The Akroan War's third chapter say "**Each** creature deals damage to itself equal to its
      power", which is a destination with no target and belongs with the sweep readers rather than
      here. Reading it through a target phrase would ask for a choice the card does not offer.
    */
    const sweeper = row('Each creature deals damage to itself equal to its power.');
    expect(sweeper.ok).toBe(true);
    if (sweeper.ok) expect(sweeper.unread.length).toBe(1);

    // And a quantifier asking for two, which the effect cannot honour: `firstCardTarget` bites one
    // of them (D469). A probe — the printed plural says "creatures deal", not "deals".
    const two = row('Two target creatures deals damage to itself equal to its power.');
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.unread.length).toBe(1);

    /*
      **And a subject that is not a creature**, which a break run asked for: the `kind` guard had no
      row, so deleting it left the suite green. `firstCardTarget` returns nothing for a player
      target, so the line would *read* and the effect would silently do nothing — the half-read line
      D487 is about, in the form that is hardest to see because the card appears to work.

      A probe, because no printing says it; `pointsAtAPermanent` is not enough here, since a land
      passes that and has no power to deal.
    */
    const person = row('Target player deals damage to itself equal to its power.');
    expect(person.ok).toBe(true);
    if (person.ok) expect(person.unread.length).toBe(1);

    const land = row('Target land deals damage to itself equal to its power.');
    expect(land.ok).toBe(true);
    if (land.ok) expect(land.unread.length).toBe(1);
  });
});

describe('the Equipment that arrives already attached (D547)', () => {
  /*
    **46 printings that were worse than unread.** `Living weapon` and `For Mirrodin!` are both in
    `KEYWORD_ABILITY_NAMES`, so their line counted as a recognised keyword declaration while nothing
    implemented it: the Equipment arrived with no creature to hold it, nothing happened, and no badge
    told the player. `Job select` — the same mechanic under a third name — was missing from that list
    entirely, so it at least had an unread line to show for itself.

    That is why the one-blocker instrument never surfaced this: it counts lines nothing can read, and
    these read. The mechanic had to be looked for.
  */
  const equipment = (text: string, name = 'Probe Rite'): ReturnType<typeof compileCard> =>
    compileCard({
      name, type_line: 'Artifact — Equipment', mana_cost: '{1}', cmc: 1, colors: [],
      layout: 'normal', oracle_text: text,
    });

  it.each([
    ['Living weapon (Flayer Husk)', 'Living weapon', '0/0 black Phyrexian Germ'],
    ['For Mirrodin! (Barbed Batterfist)', 'For Mirrodin!', '2/2 red Rebel'],
    ['Job select (Astrologian\'s Planisphere)', 'Job select', '1/1 colorless Hero'],
  ])('reads %s and makes its own creature to hold it', (_what, keyword, token) => {
    const read = equipment(`${keyword}\nEquipped creature gets +1/+1.\nEquip {2}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The keyword line is **claimed**, not merely recognised: nothing is left unread.
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const triggers = read.script?.triggers ?? [];
    expect(triggers).toHaveLength(1);
    // The token is the rule's own, named in the description so a player can see what arrived.
    expect(triggers[0]?.description).toContain(token);
  });

  it('reads the targeted shape, and aims it at your own board', () => {
    /*
      Baseball Bat's wording — 27 printings — which puts the Equipment on a creature you already
      have rather than making one. `friendly` because an Equipment attaching itself to your creature
      is help, and the bot's default aim is the enemy's board (D252); beside a filter that already
      restricts to your side, which is what D419 settled.
    */
    const read = equipment(
      'When Probe Rite enters, attach it to target creature you control.\n'
      + 'Equipped creature gets +1/+1.\nEquip {3}',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    const trigger = (read.script?.triggers ?? [])[0];
    expect(trigger?.targets?.[0]).toMatchObject({
      kind: 'creature', description: 'target creature you control', friendly: true,
    });
  });

  it.each([
    ['this Equipment', 'When this Equipment enters, attach it to target creature you control.'],
    ['the card\'s own name', 'When Probe Rite enters, attach it to target creature you control.'],
    ['"the battlefield" spelled out',
      'When Probe Rite enters the battlefield, attach it to target creature you control.'],
  ])('reads the arrival written as %s', (_what, line) => {
    // Three printed spellings of one sentence; `selfRef` and `ENTERS` already read the other two
    // everywhere else, so this costs nothing beyond saying which ones are covered.
    const read = equipment(`${line}\nEquipped creature gets +1/+1.\nEquip {3}`);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  /*
    **`job select` joins `KEYWORD_ABILITY_NAMES` and no test can tell**, which a break run and then a
    probe established in that order.

    The break — deleting the entry — came back uncaught, so a row was written to catch it: an
    Equipment printing `Job select` with no `Equip {N}` line, which `attachmentScriptFor` turns down,
    so the keyword line would fall through to the per-line path where the list decides. **The row
    failed.** Not because the list is wrong but because such a card does not compile at all: with the
    attachment reading refused there is nothing to carry the rest of the text, so D487 makes *every*
    line unread and the keyword's status is invisible.

    So the entry is correct and unfalsifiable. It stays, on D259's standard — writing down the name
    of a keyword invents nothing, and `Living weapon` and `For Mirrodin!` have been in that list
    since before this increment — and it is recorded here as a vacuous break rather than defended
    with a test that passes for the wrong reason (D533's four).
  */
  it('does not read the keyword onto something that is not an Equipment', () => {
    /*
      A probe, and the guard is `attachmentScriptFor`'s own type-line test rather than anything new:
      the reading lives there **because that is the only function that has the whole card**, and the
      bonus the Equipment gives is on a different printed line. A reader in `keywordScriptFor` — which
      is handed one line and a name — could have attached the Equipment and silently given the
      creature nothing, which is the strictly-worse card D362 rules out.
    */
    const creature = compileCard({
      name: 'Probe Rite', type_line: 'Creature — Phyrexian Horror', mana_cost: '{3}', cmc: 3,
      colors: [], power: '2', toughness: '2', layout: 'normal',
      oracle_text: 'Living weapon',
    });
    expect(creature.ok).toBe(true);
    // Still recognised as a keyword declaration, so it is not reported unread — but no trigger is
    // emitted, because there is no Equipment to attach.
    if (creature.ok) expect(creature.script?.triggers ?? []).toEqual([]);
  });
});

/*
  **The Evoke keyword line** (D548), and the reason it is a whole-card shape rather than a row in
  `keywordScriptFor`'s table.

  Head of the D548 keyword audit — 18 legal cards finished, 30 printings — and the whole increment
  is one regex, because the engine already had `CardScript.evoke` and `evokeSacrifice()`. What it
  did not have was a way to put the sacrifice in the right *place*: Evoke prints last on all 30
  cards, `merge` appends to `triggers`, and the engine stacks a permanent's triggers in list order,
  so a fragment appended by the per-line loop would resolve the sacrifice **before** the card's own
  ETB ability. The second test below is the one that would catch that, and it is why the reader
  lives in `wholeCardShapeFor`.
*/
describe('the Evoke keyword line, read ahead of the other lines (D548)', () => {
  /** Mulldrifter's own printed text, reminder text and all, as the corpus carries it. */
  const MULLDRIFTER: CardDataRow = {
    name: 'Mulldrifter',
    type_line: 'Creature — Elemental',
    mana_cost: '{4}{U}',
    cmc: 5,
    colors: ['U'],
    power: '2',
    toughness: '2',
    layout: 'normal',
    oracle_text: 'Flying\nWhen Mulldrifter enters, draw two cards.\n'
      + 'Evoke {2}{U} (You may cast this spell for its evoke cost. '
      + "If you do, it's sacrificed when it enters.)",
  };

  it('reads the cost off the line, and the whole card with it', () => {
    const read = compileCard(MULLDRIFTER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.evoke).toEqual({ cost: '{2}{U}' });
  });

  it('lists the sacrifice FIRST, so it resolves after the card draws', () => {
    /*
      The assertion the increment exists for. Triggers go on the stack in list order, so the first
      listed is at the bottom and resolves last (CR 603.3b, and `evokeSacrifice`'s docblock). A
      Mulldrifter whose sacrifice were listed second would die before it drew — and nothing else in
      this file would notice, because every printed line would still read.
    */
    const read = compileCard(MULLDRIFTER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.script?.triggers ?? []).map((t) => t.description)).toEqual([
      'sacrifice it, because its evoke cost was paid',
      'draw two cards',
    ]);
  });

  it('is offered as a second way to cast the card, at the evoke cost', () => {
    // The engine's half, which was already there: `collectLegalActions` reads `script.evoke` off
    // whatever script it is handed, so a compiled card is offered the cast a hand-written one is.
    const read = compileCard(MULLDRIFTER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.evoke?.cost).toBe('{2}{U}');
    /*
      And the body is still the body: `Flying` emits no script field at all, because
      `characteristicsOf` reads it off the card definition and restating it in the script would be
      a second source for one fact (see `isPrintedAbilityLine`). So the evoke reading has to leave
      the keyword line alone rather than claim it.
    */
    expect(read.script?.keywords).toBeUndefined();
    expect(printedKeywords(read.def.oracleText)).toEqual(['flying']);
  });

  it.each([
    ['the five Elemental Incarnations', 'Evoke—Exile a green card from your hand.'],
    ['Infestation', 'Evoke—{1}{B}{B}, Pay 3 life.'],
  ])('leaves the non-mana evoke cost of %s unread', (_which, line) => {
    /*
      `CardScript.evoke.cost` is a mana cost the engine pays through the ordinary cost path, so
      these six printings stay unread and reported rather than being read as a cost they are not
      (D362). Note both end in a full stop, so `isKeywordDeclaration` already refuses them — which
      is why the audit's row of 30 is the mana form alone and these are counted as `no-reader`.
    */
    expect(isKeywordDeclaration(line)).toBe(false);
    const read = compileCard({ ...MULLDRIFTER, oracle_text: `Flying\n${line}` });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread).toEqual([{ line, why: 'no-reader' }]);
    expect(read.script?.evoke).toBeUndefined();
  });

  it('does not read a cost with a word in it as mana', () => {
    // The anchored `$` doing its job: a trailing clause is not part of the cost, and reading
    // `{2}{U}` off this line would make up a card whose evoke cost has no condition on it.
    const read = compileCard({
      ...MULLDRIFTER,
      oracle_text: 'Flying\nEvoke {2}{U} if you control an Elemental',
    });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.script?.evoke).toBeUndefined();
  });

  it('does not read a sentence that merely ends in a cost as the declaration', () => {
    /*
      The `^` anchor, which the break run found undefended. **No printed line in the legal corpus
      discriminates** — measured: zero lines that the un-anchored pattern reads and the anchored one
      does not — so this row is a guard against a shape the pool does not print rather than a
      regression test for one it does, and it is written down as such.

      It is still worth a row, because the anchor carries the claim that makes this reader safe at
      all: the line IS the declaration, not a line that mentions the keyword. A resolution sentence
      ending in a mana cost would otherwise hand the card a free alternative casting, which is a
      strictly better card than the one printed (D259, D362) — the one direction this module must
      never err in.
    */
    const read = compileCard({
      ...MULLDRIFTER,
      oracle_text: 'Flying\nWhen this creature enters, evoke {2}{U}',
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.evoke).toBeUndefined();
  });

  /*
    **The chain's order is unfalsifiable, and that is a measurement rather than a shrug.**

    `evokeShapeFor` is written last in `wholeCardShapeFor`, and moving it first passes the entire
    engine suite. Probed rather than guessed: of the 30 legal cards printing a mana evoke cost,
    **none** also prints an `Enchant` line, an exile-until-it-leaves or `Soulbond`, so no card can
    tell the two orders apart. Recorded here as a vacuous break, with the preference kept in that
    function's docblock as the defensive choice it is (D545's precedent, and D547's).
  */
});

/*
  **Renown N** (D549), the keyword audit's head row after evoke: 12 legal cards finished, 20
  printings. Like evoke it needed no new mechanism — `renownTrigger` *is* Topan Freeblade's own
  trigger, now taking its count as an argument — and unlike evoke it reads in `keywordScriptFor`,
  because its one line is the whole ability and nothing on the card orders against it.
*/
describe('the Renown keyword line (D549)', () => {
  const renown = (text: string) => compileCard({
    name: 'Akroan Sergeant', type_line: 'Creature — Human Soldier', mana_cost: '{2}{R}', cmc: 3,
    colors: ['R'], power: '2', toughness: '2', layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Renown 1', 1, 'it becomes renowned and gets a +1/+1 counter'],
    ['Renown 2', 2, 'it becomes renowned and gets 2 +1/+1 counters'],
    ['Renown 6', 6, 'it becomes renowned and gets 6 +1/+1 counters'],
  ])('reads %s, and says so in the log', (line, _count, description) => {
    // All three counts the pool prints: 15 cards print `Renown 1`, four `Renown 2`, one `Renown 6`.
    const read = renown(`First strike\n${line}`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect((read.script?.triggers ?? []).map((t) => t.description)).toEqual([description]);
  });

  it('fires on combat damage, and only while the creature is not already renowned', () => {
    /*
      The intervening-if, which is the whole of renown's "once" (CR 702.112a). The engine's answer
      to *renowned* is a counter rather than a flag, so a creature that leaves and comes back is a
      new object with renown available again — which is what the rules say about any such marker.
    */
    const read = renown('Renown 1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const trigger = (read.script?.triggers ?? [])[0];
    expect(trigger?.on).toEqual({ kind: 'combat-damage' });
    expect(trigger?.condition).toBeTypeOf('function');
  });

  it('is the same code as the pool card it was factored out of', () => {
    /*
      Topan Freeblade prints `Renown 1` and its hand-written script now calls the same factory, so
      compiling its text has to produce the trigger the pool card carries. This is the check that
      stops the two readings drifting — the reason every keyword in `keywordScriptFor` is built from
      a factory a hand-written card also calls (D364).
    */
    expect(POOL.get('Topan Freeblade')).toBeDefined();
    const written = scriptFor('Topan Freeblade')?.triggers ?? [];
    expect(written.length).toBe(1);
    const compiled = renown('Vigilance\nRenown 1').ok
      ? (renown('Vigilance\nRenown 1') as { script?: { triggers?: readonly unknown[] } })
        .script?.triggers ?? []
      : [];
    expect(compiled.map((t) => (t as { description: string }).description))
      .toEqual(written.map((t) => t.description));
  });

  it.each([
    ['no count at all', 'Renown'],
    ['a word for the count', 'Renown two'],
  ])('leaves %s unread', (_what, line) => {
    // Every printing carries a digit, so a bare or spelled-out count is a shape this has not seen;
    // reading one would be inventing a number (D259).
    const read = renown(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.triggers).toBeUndefined();
  });

  it('leaves a line that only starts with the keyword unread', () => {
    /*
      The end anchor, which the break run found undefended. **No printed line discriminates** —
      measured: zero lines in the legal corpus that the un-anchored pattern reads and the anchored
      one refuses — so this row guards a shape the pool does not print, and says so rather than
      posing as a regression test.

      It earns its place on a sharper argument than the start anchor's, though: reading this as a
      plain `Renown 1` would take the trigger and **silently drop the rest of the line**, which is
      the one thing `readResolution` refuses by design — a line is read whole or not at all (D487).
    */
    const read = renown('Renown 1 as long as you control a Knight');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.triggers).toBeUndefined();
    expect(read.unread.map((u) => u.line)).toEqual(['Renown 1 as long as you control a Knight']);
  });
});

/*
  **The relational blocker clause** (D551): intimidate, skulk, and the printed phrase that says
  skulk's rule in its own words.

  `characteristics.ts` had recorded for two increments why these were absent: each needs a clause
  whose answer depends on **both** creatures — "creatures that share a color with it", "creatures
  with greater power" — and `clauseMatches` read one. It takes the facing creature now, and
  `other` is **required** so the compiler names every call site rather than letting one answer a
  relational clause against nothing.
*/
describe('the relational blocker clause (D551)', () => {
  it.each([
    ['intimidate', 'Intimidate'],
    ['skulk', 'Skulk'],
  ])('reads a bare %s line off the card definition', (word, line) => {
    /*
      Both are enforced from `KEYWORD_BLOCK_RULES` against the printed keyword, so the line emits
      no script at all — like flying, the engine reads it off the definition. That is also what
      makes them *counted* read, and why they had to be enforced before being listed: a word in
      `KEYWORDS` that nothing applies is the D547 failure (D362 ranks a wrong reading below an
      unread line).
    */
    const read = compileCard({
      name: 'Probe Sneak', type_line: 'Creature — Human Rogue', mana_cost: '{1}{B}', cmc: 2,
      colors: ['B'], power: '2', toughness: '1', layout: 'normal', oracle_text: line,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script).toBeUndefined();
    expect(printedKeywords(read.def.oracleText)).toEqual([word]);
  });

  it('puts both keywords in the rules table, with the clauses their rules name', () => {
    const named = KEYWORD_BLOCK_RULES.filter((r) => r.keyword === 'intimidate' || r.keyword === 'skulk');
    expect(named.map((r) => r.keyword).sort()).toEqual(['intimidate', 'skulk']);
    // Intimidate is fear's shape with the fixed colour replaced by a comparison (CR 702.13a).
    expect(named.find((r) => r.keyword === 'intimidate')?.blockedOnlyBy).toEqual([
      { kind: 'type', type: 'artifact' }, { kind: 'shares-a-colour' },
    ]);
    /*
      And skulk as an allow list of power at most this creature's, which is the same rule as
      "can't be blocked by creatures with greater power" read from the other end (CR 702.118a).
      `KeywordBlockRule` has no ban field, and "not greater" is "at most".
    */
    expect(named.find((r) => r.keyword === 'skulk')?.blockedOnlyBy).toEqual([
      { kind: 'power-vs', cmp: 'at-most' },
    ]);
  });

  it('reads the printed phrase that says skulk in its own words', () => {
    // Three legal cards print this rather than carrying the keyword.
    const read = compileCard({
      name: 'Probe Lurker', type_line: 'Creature — Elf Scout', mana_cost: '{2}{G}', cmc: 3,
      colors: ['G'], power: '3', toughness: '3', layout: 'normal',
      oracle_text: "Probe Lurker can't be blocked by creatures with greater power.",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });
});

/*
  **Improvise** (D552), the keyword audit's head row that the engine already had the mechanism for:
  14 legal cards finished, 23 printings. Unlike evoke and renown it emits no trigger and no ability
  at all — it is a flag on the script, and the whole of the reading is `tapToPayPlan` being
  convoke's planner with two parameters rather than convoke's planner.
*/
describe('the Improvise keyword line (D552)', () => {
  /** Foundry Assembler's printed row, whose only line is the keyword, with the text swapped in. */
  const improvise = (text: string) => compileCard({
    name: 'Foundry Assembler', type_line: 'Artifact Creature — Assembly-Worker',
    mana_cost: '{5}', cmc: 5, colors: [], power: '3', toughness: '3', layout: 'normal',
    oracle_text: text,
  });

  const REMINDER = 'Improvise (Your artifacts can help cast this spell. Each artifact you tap'
    + ' after you’re done activating mana abilities pays for {1}.)';

  it('reads the keyword off a card whose only printed line it is', () => {
    /*
      The 14 cards this reader finishes are the ones shaped like this: one line, the keyword, and
      the reminder text in brackets that `printedRulesLines` strips before anything reads it. So the
      row is asked with the reminder still on, which is how the corpus prints it.
    */
    const read = improvise(REMINDER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.improvise).toBe(true);
    // And nothing else: it is a payment rule, so it has no ability and no trigger of its own.
    expect(read.script?.triggers).toBeUndefined();
    expect(read.script?.abilities).toBeUndefined();
  });

  it('reads it beside the rest of a card, in either printed order', () => {
    // 9 of the 23 printings carry other text. The keyword is a line like any other, so the loop
    // that reads it does not care where it sits.
    for (const text of [`${REMINDER}\nFlying`, `Flying\n${REMINDER}`]) {
      const read = improvise(text);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unread.map((u) => u.line)).toEqual([]);
      expect(read.script?.improvise).toBe(true);
    }
  });

  it('does not set convoke, which is the sibling flag it must not be confused with', () => {
    /*
      The two flags differ by what may be tapped and what it may pay, and they go through one
      planner — so the only thing keeping them apart downstream is which flag the card carries.
      A reader that set `convoke` here would make a board of creatures pay for this spell and let
      an artifact pay a coloured pip, both wrong, and every other assertion in this block would
      still pass.
    */
    const read = improvise(REMINDER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.convoke).toBeUndefined();
  });

  it.each([
    ['a line that only starts with the keyword', 'Improvise 2'],
    ['the word inside a sentence', 'Artifacts you control have improvise.'],
  ])('leaves %s unread', (_what, line) => {
    /*
      Both anchors, and the second is the one that matters: "artifacts you control have improvise"
      is a static ability granting the keyword to other spells, and reading it as this card having
      improvise would be a different card (D362 — a wrong reading is worse than an unread line).
      `Improvise 2` is not printed on anything; it guards the shape rather than a card.
    */
    const read = improvise(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.improvise).toBeUndefined();
  });

  it('reads the word whatever its case', () => {
    /*
      The corpus prints it capitalised as a keyword line; `keywordScriptFor` lowercases first, and
      this is the row that says so rather than leaving it to the regex flags of a neighbour.

      Written out with a narrowing guard rather than `read.ok && read.script?...`, because the
      failure union has no `script` at all and the test typecheck (#246) refuses the short form —
      two calls to the same function are two values as far as the narrowing is concerned.
    */
    for (const word of ['improvise', 'IMPROVISE', 'Improvise']) {
      const read = improvise(word);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.script?.improvise).toBe(true);
    }
  });
});

/*
  **Flanking** (D554), and the first row in this family that needed no reader at all: the word went
  into `KEYWORDS` and `isPrintedAbilityLine` claimed the line before `keywordScriptFor` was asked.
  12 cards finished by the audit's count, 15 by measurement, because a keyword in that list is
  consumed in more printed shapes than the bare line.
*/
describe('the Flanking keyword line (D554)', () => {
  const flanker = (text: string) => compileCard({
    name: 'Benalish Cavalry', type_line: 'Creature — Human Knight', mana_cost: '{1}{W}', cmc: 2,
    colors: ['W'], power: '2', toughness: '2', layout: 'normal', oracle_text: text,
  });

  const REMINDER = 'Flanking (Whenever a creature without flanking blocks this creature, the'
    + ' blocking creature gets -1/-1 until end of turn.)';

  it('reads the bare line, and emits no script for it', () => {
    /*
      The line is read off the `CardDef` by `printedKeywords`, so the compile claims it and the
      script stays empty — "restating it in the script would be a second source for one fact", which
      is `compileUncached`'s own reason. `combat.ts` is the enforcement, and the table block in
      `scripts.test.ts` is where that is driven.
    */
    const read = flanker(REMINDER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers).toBeUndefined();
    expect(printedKeywords(REMINDER)).toEqual(['flanking']);
  });

  it('reads it out of a mixed list, with the other keyword on the line', () => {
    // Knight of Sursi prints "Flying; flanking" and Riftmarked Knight "Protection from black;
    // flanking". D424's reason for asking `isPrintedAbilityLine` rather than `printedKeywords`
    // alone is this shape, and these are the two legal cards that have it.
    expect(printedKeywords('Flying; flanking')).toEqual(['flying', 'flanking']);
    const read = flanker('Flying; flanking');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
  });

  it('leaves a tribal static that grants flanking unread, and reads the two grants that do work', () => {
    /*
      Measured rather than claimed, because the KEYWORDS note says which grants came along and a
      note like that is exactly the kind that rots.

      Jabari's Banner ("gains flanking until end of turn") and Agility ("has flanking") read now,
      because every grant reader asks `isKeyword` and the answer changed when the word joined the
      list. Sidewinder Sliver's "All Sliver creatures have flanking" does not: a tribal static is a
      shape nothing reads yet, and it is **reported** rather than guessed at (D362).
    */
    const banner = compileCard({
      name: "Jabari's Banner", type_line: 'Artifact', mana_cost: '{3}', cmc: 3, colors: [],
      layout: 'normal', oracle_text: '{1}, {T}: Target creature gains flanking until end of turn.',
    });
    expect(banner.ok).toBe(true);
    if (banner.ok) expect(banner.unread.map((u) => u.line)).toEqual([]);

    const sliver = compileCard({
      name: 'Sidewinder Sliver', type_line: 'Creature — Sliver', mana_cost: '{1}{W}', cmc: 2,
      colors: ['W'], power: '1', toughness: '1', layout: 'normal',
      oracle_text: 'All Sliver creatures have flanking.',
    });
    expect(sliver.ok).toBe(true);
    if (sliver.ok) {
      expect(sliver.unread.map((u) => u.line)).toEqual(['All Sliver creatures have flanking.']);
    }
  });

  it('leaves a line that only mentions the word unread', () => {
    /*
      Old Fogey prints "Phasing, cumulative upkeep {1}, echo {G}{G}, fading 3, bands with other
      Dinosaurs, protection from Homarids, snow-covered plainswalk, flanking, rampage 2" — a list
      with several things in it this engine cannot read. A line is read whole or not at all (D487),
      so the whole line is reported rather than mined for the one word it recognises.
    */
    expect(printedKeywords('Flanking, rampage 2')).toEqual([]);
    const read = flanker('Flanking, rampage 2');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual(['Flanking, rampage 2']);
  });
});

/*
  **Toxic N** (D556): 40 legal lines, 13 cards finished — the audit's figure exactly, the fourth
  keyword row in a row to land on it. Like flanking it needed no script reader: the line is a
  printed part, read off the card by `printedToxic` and enforced by `hit` in `combat.ts`. Unlike
  flanking it is not a `Keyword`, because a set of words cannot say how much.
*/
describe('the Toxic keyword line (D556)', () => {
  const toxic = (text: string) => compileCard({
    name: 'Branchblight Stalker', type_line: 'Creature — Phyrexian Elf Scout', mana_cost: '{1}{G}',
    cmc: 2, colors: ['G'], power: '3', toughness: '1', layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Toxic 1 (Players dealt combat damage by this creature also get a poison counter.)', 1],
    ['Toxic 2 (Players dealt combat damage by this creature also get two poison counters.)', 2],
    ['Toxic 6', 6],
  ])('reads %s as a number off the card, with no script', (line, amount) => {
    // 1, 2, 3, 4 and 6 are every count the legal corpus prints. The reminder text spells the number
    // out in words, which is why it is stripped before anything reads the line.
    expect(printedToxic(line)).toBe(amount);
    const read = toxic(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.triggers).toBeUndefined();
  });

  it('reads it beside a keyword on the same card, and in a mixed list', () => {
    // Pestilent Syphoner prints "Flying" and "Toxic 1" on two lines; a list on one line is the
    // Phyrexian Crusader shape, and a toxic part has to sit in it like any other.
    expect(printedToxic('Flying\nToxic 1')).toBe(1);
    expect(printedKeywords('Flying\nToxic 1')).toEqual(['flying']);
    expect(printedToxic('Flying, toxic 2')).toBe(2);
    expect(printedKeywords('Flying, toxic 2')).toEqual(['flying']);
  });

  it('sums two instances rather than taking the larger', () => {
    // CR 702.164b: a creature's total toxic value is the sum of its toxic abilities. No legal card
    // prints two, so this guards the rule rather than a printing — and says so.
    expect(printedToxic('Toxic 1\nToxic 2')).toBe(3);
  });

  it.each([
    ['no count at all', 'Toxic'],
    ['a word for the count', 'Toxic two'],
    ['a line that only starts with the keyword', 'Toxic 2 as long as you control an artifact'],
    ['a grant, which is somebody else having it', 'Creatures you control have toxic 1.'],
  ])('leaves %s unread', (_what, line) => {
    /*
      A count this has not seen would be an invented number (D259), a longer line read as the bare
      keyword would silently drop its condition (D487), and a grant is a different card. Each is
      reported rather than guessed at.
    */
    expect(printedToxic(line)).toBe(0);
    const read = toxic(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([line]);
  });
});

/*
  **Mentor, Afterlife N and Rampage N** (D557): three keyword rows read in one increment, because
  each was a factory away. 8, 7 and 9 cards by the audit; the three of them share a gate, a break
  run and a pod sweep, which is the point of batching rows whose mechanisms already exist.
*/
describe('the Mentor, Afterlife and Rampage keyword lines (D557)', () => {
  const creature = (text: string) => compileCard({
    name: 'Blade Instructor', type_line: 'Creature — Human Soldier', mana_cost: '{2}{W}', cmc: 3,
    colors: ['W'], power: '3', toughness: '1', layout: 'normal', oracle_text: text,
  });
  const descriptions = (text: string): string[] => {
    const read = creature(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return [];
    expect(read.unread.map((u) => u.line)).toEqual([]);
    return (read.script?.triggers ?? []).map((t) => t.description);
  };

  it('mentor compiles to the same trigger the pool card carries', () => {
    /*
      Sunhome Stalwart prints `Mentor` and its hand-written script calls the factory the reader
      calls, so compiling the keyword has to produce what the pool card has — the check that stops
      the two drifting, and the reason every keyword here is built from a factory a hand-written
      card also uses (D364, and D549's row for renown).
    */
    expect(POOL.get('Sunhome Stalwart')).toBeDefined();
    const written = scriptFor('Sunhome Stalwart')?.triggers ?? [];
    expect(written).toHaveLength(1);
    expect(descriptions('Mentor (Whenever this creature attacks, put a +1/+1 counter on target'
      + ' attacking creature with lesser power.)')).toEqual(written.map((t) => t.description));
    const read = creature('Mentor');
    expect(read.ok && read.script?.triggers?.[0]?.on).toEqual({ kind: 'attacks' });
    expect(read.ok && read.script?.triggers?.[0]?.targets).toHaveLength(1);
  });

  it.each([
    ['Afterlife 1', 'create a 1/1 white and black Spirit creature token with flying'],
    ['Afterlife 2', 'create 2 1/1 white and black Spirit creature tokens with flying'],
    ['Afterlife 3', 'create 3 1/1 white and black Spirit creature tokens with flying'],
  ])('reads %s as a dies trigger, and says so in the log', (line, description) => {
    // 1, 2 and 3 are every count the legal corpus prints.
    expect(descriptions(line)).toEqual([description]);
    const read = creature(line);
    expect(read.ok && read.script?.triggers?.[0]?.on).toEqual({ kind: 'dies' });
  });

  it.each([
    ['Rampage 1', 1], ['Rampage 2', 2], ['Rampage 3', 3], ['Rampage 4', 4],
  ])('reads %s as a becomes-blocked trigger', (line, count) => {
    expect(descriptions(line)).toEqual(
      [`it gets +${count}/+${count} until end of turn for each creature blocking it beyond the first`],
    );
    const read = creature(line);
    // The batched event, not the per-blocker one: see `rampageTrigger` and D482.
    expect(read.ok && read.script?.triggers?.[0]?.on).toEqual({ kind: 'blocked-creature' });
  });

  it.each([
    ['a counted mentor, which no card prints', 'Mentor 2'],
    ['afterlife with no count', 'Afterlife'],
    ['afterlife with a word for the count', 'Afterlife two'],
    ['rampage with no count', 'Rampage'],
    ['a line that only starts with a keyword', 'Rampage 2 as long as it is attacking'],
    ['an afterlife line with a condition after it', 'Afterlife 2 if it was attacking'],
    ['a grant, which is somebody else having it', 'Other creatures you control have mentor.'],
  ])('leaves %s unread', (_what, line) => {
    // An invented number (D259), a dropped condition (D487) or a different card: each reported.
    const read = creature(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.triggers).toBeUndefined();
    expect(read.unread.map((u) => u.line)).toEqual([line]);
  });
});

/*
  **Bloodthirst N** (D558): 21 legal lines, 14 cards finished by the audit. The reading is a flag
  with a number in it; the work was the fact it asks about — "an opponent was dealt damage this
  turn" — which the engine did not record and which is deliberately not `lifeLostThisTurn`.
*/
describe('the Bloodthirst keyword line (D558)', () => {
  const thirsty = (text: string) => compileCard({
    name: 'Bloodrage Vampire', type_line: 'Creature — Vampire', mana_cost: '{2}{B}', cmc: 3,
    colors: ['B'], power: '3', toughness: '1', layout: 'normal', oracle_text: text,
  });

  it.each([
    ['Bloodthirst 1 (If an opponent was dealt damage this turn, this creature enters with a +1/+1 counter on it.)', 1],
    ['Bloodthirst 2', 2],
    ['Bloodthirst 3', 3],
    ['Bloodthirst 6', 6],
  ])('reads %s as the count and nothing else', (line, count) => {
    // 1, 2, 3 and 6 are every fixed count the legal corpus prints.
    const read = thirsty(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([]);
    expect(read.script?.bloodthirst).toBe(count);
    // Not `entersWith`: that field is unconditional, and this one is the same counters behind a
    // condition. A reader that set both would hand the creature its counters every time.
    expect(read.script?.entersWith).toBeUndefined();
    expect(read.script?.triggers).toBeUndefined();
  });

  it.each([
    ['Bloodthirst X, whose count is the damage dealt and not a number on the card', 'Bloodthirst X'],
    ['no count at all', 'Bloodthirst'],
    ['a line that only starts with the keyword', 'Bloodthirst 2 if you control a Vampire'],
  ])('leaves %s unread', (_what, line) => {
    /*
      Two legal cards print `Bloodthirst X` (Petrified Wood-Kin and its kin), where X is the damage
      your opponents were dealt this turn. Reading that as a fixed number would be inventing one
      (D259), so it is reported — the same answer `Renown` and `Toxic` give to a count they have
      not seen.
    */
    const read = thirsty(line);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script?.bloodthirst).toBeUndefined();
    expect(read.unread.map((u) => u.line)).toEqual([line]);
  });
});

describe('the Fabricate, Riot and Unleash keyword lines (D559)', () => {
  const creature = (text: string) => compileCard({
    name: 'Zhur-Taa Goblin', type_line: 'Creature — Goblin Berserker', mana_cost: '{R}{G}', cmc: 2,
    colors: ['R', 'G'], power: '2', toughness: '2', layout: 'normal', oracle_text: text,
  });
  const read = (text: string) => {
    const got = creature(text);
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };

  it.each([
    ['Fabricate 1 (When this creature enters, put a +1/+1 counter on it or create a 1/1 colorless Servo artifact creature token.)', 'a +1/+1 counter', 'a 1/1 colorless Servo artifact creature token'],
    ['Fabricate 2', '2 +1/+1 counters', '2 1/1 colorless Servo artifact creature tokens'],
    ['Fabricate 3', '3 +1/+1 counters', '3 1/1 colorless Servo artifact creature tokens'],
  ])('reads %s as an enters trigger that says both halves', (line, counters, tokens) => {
    // 1, 2 and 3 are every count the legal corpus prints.
    const got = read(line);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.triggers).toHaveLength(1);
    const trigger = got.script!.triggers![0]!;
    expect(trigger.on).toEqual({ kind: 'etb' });
    expect(trigger.description).toBe(`put ${counters} on it or create ${tokens}`);
    // A question on the trigger, not on the spell: fabricate can be responded to.
    expect(trigger.decisions).toHaveLength(1);
    expect(got.script?.decisions).toBeUndefined();
    expect(got.script?.entersChoice).toBeUndefined();
  });

  it('reads Riot as a question the spell asks, with the counter first', () => {
    const got = read('Riot (This creature enters with your choice of a +1/+1 counter or haste.)');
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.entersChoice).toBe('riot');
    expect(got.script?.decisions).toHaveLength(1);
    const spec = got.script!.decisions![0]!;
    expect(typeof spec === 'function' ? null : spec.options).toEqual(['+1/+1 counter', 'Haste']);
    // Not a trigger and not a keyword on the body: haste is only there if it is chosen.
    expect(got.script?.triggers).toBeUndefined();
    expect(got.script?.keywords ?? []).not.toContain('haste');
    expect(got.script?.statics).toBeUndefined();
  });

  it('reads Unleash as the same question and a static about the counter', () => {
    const got = read("Unleash (You may have this creature enter with a +1/+1 counter on it. It can't block as long as it has a +1/+1 counter on it.)");
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.entersChoice).toBe('unleash');
    const spec = got.script!.decisions![0]!;
    expect(typeof spec === 'function' ? null : spec.options).toEqual(['+1/+1 counter', 'No counter']);
    expect(got.script?.statics).toEqual([{
      scope: 'self',
      effect: {
        cantBlock: true,
        while: { kind: 'source-has-counter', counter: '+1/+1', atLeast: 1 },
      },
    }]);
  });

  it('reads all three lines of Chaos Imps, two of them statics on the same counter', () => {
    const got = read("Flying\nUnleash (You may have this creature enter with a +1/+1 counter on it. It can't block as long as it has a +1/+1 counter on it.)\nZhur-Taa Goblin has trample as long as it has a +1/+1 counter on it.");
    expect(got.unread.map((u) => u.line)).toEqual([]);
    const counter = { kind: 'source-has-counter', counter: '+1/+1', atLeast: 1 };
    expect(got.script?.statics).toEqual([
      { scope: 'self', effect: { cantBlock: true, while: counter } },
      { scope: 'self', effect: { keywords: ['trample'], while: counter } },
    ]);
  });

  it.each([
    ['Zhur-Taa Goblin has reach as long as it has a +1/+1 counter on it.', ['reach'], '+1/+1'],
    ['As long as Zhur-Taa Goblin has a +1/+1 counter on it, it has flying and trample.', ['flying', 'trample'], '+1/+1'],
    ['Zhur-Taa Goblin has trample as long as it has a -1/-1 counter on it.', ['trample'], '-1/-1'],
  ])('reads the counter-conditional keyword static: %s', (line, keywords, counter) => {
    const got = read(line);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.statics).toEqual([{
      scope: 'self',
      effect: { keywords, while: { kind: 'source-has-counter', counter, atLeast: 1 } },
    }]);
  });

  it.each([
    ['a counter the engine keeps under no agreed name', 'Zhur-Taa Goblin has indestructible as long as it has a divinity counter on it.'],
    ['a grant that is not a keyword', "As long as Zhur-Taa Goblin has a +1/+1 counter on it, it can attack as though it didn't have defender."],
    ['a condition about some other creature', 'As long as a creature has a -1/-1 counter on it, Zhur-Taa Goblin has vigilance and deathtouch.'],
    ['a mismatched counter', 'Zhur-Taa Goblin has trample as long as it has a +1/-1 counter on it.'],
  ])('leaves %s unread', (_what, line) => {
    const got = read(line);
    expect(got.script?.statics ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });

  it('reads riot beside modular without either line taking the other field', () => {
    // Arcbound Slasher. Modular sets `entersWith`; riot sets `entersChoice`. Two fields because
    // the counters add up, and a shared one would make the second line a field conflict.
    const got = read('Modular 4 (This creature enters with four +1/+1 counters on it. When it dies, you may put its +1/+1 counters on target artifact creature.)\nRiot (This creature enters with your choice of an additional +1/+1 counter or haste.)');
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.entersWith).toEqual({ counter: '+1/+1', amount: 4 });
    expect(got.script?.entersChoice).toBe('riot');
  });

  it.each([
    ['a fabricate with no count', 'Fabricate'],
    ['a fabricate with a letter for a count', 'Fabricate X'],
    ['a line that only starts with fabricate', 'Fabricate 1 if you control an artifact'],
    ['riot granted to other creatures', 'Nontoken creatures you control have riot.'],
    ['riot with a number it does not print', 'Riot 2'],
    ['unleash granted to other creatures', 'Other Dogs you control have unleash.'],
    ['a spell that merely starts with the word', 'Unleash Shell deals 5 damage to target creature or planeswalker and 2 damage to that permanent\'s controller.'],
  ])('leaves %s unread', (_what, line) => {
    const got = read(line);
    expect(got.script?.entersChoice).toBeUndefined();
    expect(got.script?.triggers ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });
});

describe('kicker on a permanent: the declaration and its kicked line, as one unit (D561)', () => {
  const creature = (text: string) => {
    const got = compileCard({
      name: 'Citanul Woodreaders', type_line: 'Creature — Human Druid', mana_cost: '{2}{G}', cmc: 3,
      colors: ['G'], power: '1', toughness: '4', layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };
  const KICKER = 'Kicker {2}{G} (You may pay an additional {2}{G} as you cast this spell.)';

  it('reads the declaration and the kicked enters trigger together', () => {
    const got = creature(`${KICKER}\nWhen Citanul Woodreaders enters, if it was kicked, draw two cards.`);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.kicker).toEqual({ cost: '{2}{G}', description: 'Kicker {2}{G}' });
    expect(got.script?.triggers).toHaveLength(1);
    const trigger = got.script!.triggers![0]!;
    expect(trigger.on).toEqual({ kind: 'etb', who: 'self' });
    expect(trigger.description).toBe('if it was kicked, draw two cards');
    // An intervening-if, so it is a condition on the trigger and not a branch inside the effect.
    expect(typeof trigger.condition).toBe('function');
    expect(got.script?.kickedEntersWith).toBeUndefined();
  });

  it('gives the kicked trigger the same targets the unkicked sentence would have', () => {
    const kicked = creature(`${KICKER}\nWhen Citanul Woodreaders enters, if it was kicked, destroy target creature.`);
    const plainly = creature('When Citanul Woodreaders enters, destroy target creature.');
    expect(kicked.unread.map((u) => u.line)).toEqual([]);
    expect(kicked.script!.triggers![0]!.targets).toHaveLength(1);
    expect(kicked.script!.triggers![0]!.targets![0]!.description)
      .toBe(plainly.script!.triggers![0]!.targets![0]!.description);
    // And the plain sentence has no condition, which is what the kicked one adds.
    expect(plainly.script!.triggers![0]!.condition).toBeUndefined();
    expect(plainly.script?.kicker).toBeUndefined();
  });

  it.each([
    ['If Citanul Woodreaders was kicked, it enters with two +1/+1 counters on it.', 2, undefined],
    ['If Citanul Woodreaders was kicked, it enters with a +1/+1 counter on it.', 1, undefined],
    ['If Citanul Woodreaders was kicked, it enters with five +1/+1 counters on it.', 5, undefined],
    ['If Citanul Woodreaders was kicked, it enters with two +1/+1 counters on it and with haste.', 2, ['haste']],
    ['If Citanul Woodreaders was kicked, it enters with three +1/+1 counters on it and with first strike.', 3, ['first strike']],
  ])('reads %s', (line, amount, keywords) => {
    const got = creature(`${KICKER}\n${line}`);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.kicker?.cost).toBe('{2}{G}');
    expect(got.script?.kickedEntersWith).toEqual({
      counter: '+1/+1', amount, ...(keywords === undefined ? {} : { keywords }),
    });
    // Not `entersWith`: that one is unconditional and D560 applies it to every arrival.
    expect(got.script?.entersWith).toBeUndefined();
    expect(got.script?.triggers).toBeUndefined();
  });

  it('never reads the declaration alone', () => {
    // A kick with nothing to buy is a way to pay extra for no effect. The card has no kicked line
    // here, so the declaration stays the unimplemented keyword it was.
    const got = creature(`${KICKER}\nFlying`);
    expect(got.script?.kicker).toBeUndefined();
    expect(got.unread).toEqual([{ line: 'Kicker {2}{G}', why: 'unimplemented-keyword' }]);
  });

  it.each([
    ['a kicked effect the enters reader cannot read',
      'When Citanul Woodreaders enters, if it was kicked, each player votes for wind or rain.'],
    ['kicked counters whose number is not printed',
      'If Citanul Woodreaders was kicked, it enters with X +1/+1 counters on it.'],
    ['kicked counters with a tail that is not a keyword',
      'If Citanul Woodreaders was kicked, it enters with a +1/+1 counter on it and with "This creature can attack as though it didn\'t have defender."'],
    ['a kicked trigger on some other event',
      'Whenever Citanul Woodreaders attacks, if it was kicked, draw a card.'],
    ['a count that depends on the board',
      'If Citanul Woodreaders was kicked, it enters with a +1/+1 counter on it for each nonbasic land your opponents control.'],
  ])('leaves both lines unread for %s', (_what, line) => {
    // Both, not just the one it could not read: the declaration goes with it (see above).
    const got = creature(`${KICKER}\n${line}`);
    expect(got.script?.kicker).toBeUndefined();
    expect(got.script?.kickedEntersWith).toBeUndefined();
    expect(got.unread.map((u) => u.line)).toEqual(['Kicker {2}{G}', line]);
  });

  it('refuses a card with two kicked lines rather than reading one of them', () => {
    const first = 'When Citanul Woodreaders enters, if it was kicked, draw two cards.';
    const second = 'If Citanul Woodreaders was kicked, it enters with two +1/+1 counters on it.';
    const got = creature(`${KICKER}\n${first}\n${second}`);
    expect(got.script?.kicker).toBeUndefined();
    expect(got.unread.map((u) => u.line)).toEqual(['Kicker {2}{G}', first, second]);
  });

  it.each([
    'Kicker {2} and/or {1}{R}',
    'Kicker—Sacrifice a land.',
    'Multikicker {1}{G}',
  ])('does not take %s for the plain mana form', (declaration) => {
    const line = 'When Citanul Woodreaders enters, if it was kicked, draw two cards.';
    const got = creature(`${declaration}\n${line}`);
    expect(got.script?.kicker).toBeUndefined();
    expect(got.unread.map((u) => u.line)).toContain(line);
  });

  it('leaves the rest of the card to the ordinary readers', () => {
    // Heartstabber Mosquito's three lines: the unit takes two, and `Flying` is read as it always was.
    const got = creature(`${KICKER}\nFlying\nWhen Citanul Woodreaders enters, if it was kicked, destroy target creature.`);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.compiled).toHaveLength(3);
  });
});

describe('a kicked spell with a second clause: also, or instead (D562)', () => {
  const spell = (text: string) => {
    const got = compileCard({
      name: 'Into the Roil', type_line: 'Instant', mana_cost: '{1}{U}', cmc: 2, colors: ['U'],
      layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };
  const KICKER = 'Kicker {1}{U} (You may pay an additional {1}{U} as you cast this spell.)';
  const read = (body: string) => spell(`${KICKER}\n${body}`);

  it.each([
    ["Return target nonland permanent to its owner's hand. If this spell was kicked, draw a card.", 1],
    ['Destroy target artifact or enchantment. If this spell was kicked, draw two cards.', 1],
    // Three sentences: everything before the last is the base.
    ["Return target creature to its owner's hand. Draw a card. If this spell was kicked, you gain 3 life.", 1],
    ['Target creature gets +2/+2 until end of turn. If this spell was kicked, that creature gets +5/+5 until end of turn instead.', 1],
    ['Draw two cards. If this spell was kicked, draw three cards instead.', 0],
    ['Creatures you control get +1/+1 until end of turn. If this spell was kicked, instead creatures you control get +2/+2 and gain first strike until end of turn.', 0],
  ])('reads %s', (body, targets) => {
    const got = read(body);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.kicker).toEqual({ cost: '{1}{U}', description: 'Kicker {1}{U}' });
    expect(got.script?.targets ?? []).toHaveLength(targets);
    expect(typeof got.script?.onResolve).toBe('function');
  });

  it('keeps the base spell\'s own targets, and adds none for the kicked half', () => {
    const kicked = read("Return target nonland permanent to its owner's hand. If this spell was kicked, draw a card.");
    const plainly = spell("Return target nonland permanent to its owner's hand.");
    expect(kicked.script!.targets!.map((t) => t.description))
      .toEqual(plainly.script!.targets!.map((t) => t.description));
    expect(plainly.script?.kicker).toBeUndefined();
  });

  it.each([
    ['a kicked half with a target of its own, chosen only when kicked',
      "Return target creature to its owner's hand. If this spell was kicked, it deals 2 damage to another target creature."],
    ['a kicked half that asks a question',
      'Destroy target tapped creature. If this spell was kicked, scry 2.'],
    ['an "instead" that points at something different',
      'Exile target artifact or enchantment. If this spell was kicked, exile target nonland permanent instead.'],
    ['an "instead" with a different restriction on the same kind of target',
      'Counter target spell with mana value 2 or less. If this spell was kicked, counter target spell instead.'],
    ['a referent the base never named',
      'Draw two cards. If this spell was kicked, that creature gets +5/+5 until end of turn instead.'],
    ['a kicked half that refers back without replacing',
      'Target creature gets +2/+2 until end of turn. If this spell was kicked, that creature gets +7/+0 until end of turn.'],
    ['a kicked half nothing can read',
      'Draw a card. If this spell was kicked, each player votes for wind or rain.'],
    ['a base nothing can read',
      'Each player votes for wind or rain. If this spell was kicked, draw a card.'],
    ['two halves that each ask a question, which cannot be listed once for both',
      'Target player discards a card. If this spell was kicked, target player discards a card instead.'],
    ['"of those tokens", which is a count and not a clause',
      'Create two 1/1 green Saproling creature tokens. If this spell was kicked, create four of those tokens instead.'],
  ])('leaves both lines unread for %s', (_what, body) => {
    // Both: the declaration is never read alone, for the reason D561 gives.
    const got = read(body);
    expect(got.script?.kicker).toBeUndefined();
    expect(got.unread.map((u) => u.line)).toEqual(['Kicker {1}{U}', body]);
  });

  it('still reads the two-number damage family the way D423 did', () => {
    const got = read('Into the Roil deals 2 damage to any target. If this spell was kicked, it deals 4 damage instead.');
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.kicker?.cost).toBe('{1}{U}');
    expect(got.script?.targets).toHaveLength(1);
  });
});

describe('an intervening-if in a trigger (D563)', () => {
  const creature = (text: string) => {
    const got = compileCard({
      name: 'Scholar of Stars', type_line: 'Creature — Human Artificer', mana_cost: '{3}{U}',
      cmc: 4, colors: ['U'], power: '3', toughness: '2', layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };

  it.each([
    ['When this creature enters, if you control an artifact, draw a card.',
      'if you control an artifact, draw a card', 'etb'],
    ['When Scholar of Stars enters, if you control two or more Gates, you gain 7 life.',
      'if you control two or more Gates, you gain 7 life', 'etb'],
    ['At the beginning of your upkeep, if you control six or more lands, create a 5/5 red Dragon creature token with flying.',
      'if you control six or more lands, create a 5/5 red Dragon creature token with flying', 'step'],
    ['When Scholar of Stars enters, if an opponent lost life this turn, each opponent loses 2 life and you gain 2 life.',
      'if an opponent lost life this turn, each opponent loses 2 life and you gain 2 life', 'etb'],
    ['Whenever Scholar of Stars attacks, if you control a Dinosaur, Scholar of Stars gets +1/+1 until end of turn.',
      'if you control a Dinosaur, Scholar of Stars gets +1/+1 until end of turn', 'attacks'],
    ['At the beginning of your upkeep, if there are three or more creature cards in your graveyard, you gain 5 life.',
      'if there are three or more creature cards in your graveyard, you gain 5 life', 'step'],
    ['When Scholar of Stars enters, if you control seven or more Plains, draw a card.',
      'if you control seven or more Plains, draw a card', 'etb'],
  ])('reads %s', (line, description, event) => {
    const got = creature(line);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.triggers).toHaveLength(1);
    const trigger = got.script!.triggers![0]!;
    expect(trigger.description).toBe(description);
    expect(trigger.on.kind).toBe(event);
    expect(typeof trigger.condition).toBe('function');
  });

  it('is the shorter sentence\'s trigger with a condition, and nothing else changed', () => {
    const iffy = creature('When this creature enters, if you control an artifact, destroy target creature.');
    const plainly = creature('When this creature enters, destroy target creature.');
    const a = iffy.script!.triggers![0]!;
    const b = plainly.script!.triggers![0]!;
    expect(a.on).toEqual(b.on);
    expect(a.targets!.map((t) => t.description)).toEqual(b.targets!.map((t) => t.description));
    expect(b.condition).toBeUndefined();
  });

  it.each([
    // Retargeted by D564, which reads "a creature with power 4 or greater": a keyword filter is
    // the nearest condition still out of reach.
    ['a condition that needs a filter',
      'When this creature enters, if you control a creature with flying, draw a card.'],
    ['"another", which needs to know whether the card asking is one of them',
      'When this creature enters, if you control another Wizard, draw a card.'],
    ['a choice of two things',
      'When this creature enters, if you control an artifact or enchantment, draw a card.'],
    ['a number it does not print',
      'When this creature enters, if you control X or more lands, draw a card.'],
    ['an irregular plural, which would count a subtype nothing has',
      'When this creature enters, if you control two or more Fungi, draw a card.'],
    ['a condition about how the card was cast',
      'When this creature enters, if you cast it from your hand, draw a card.'],
    ['a readable condition in front of an unreadable effect',
      'When this creature enters, if you control an artifact, each player votes for wind or rain.'],
    ['an "if" that is not the first clause after the event',
      'When this creature enters, draw a card, then if you control an artifact, draw a card.'],
    ['your own life, where the card says an opponent\'s',
      'When this creature enters, if you lost life this turn, draw a card.'],
  ])('leaves %s unread', (_what, line) => {
    const got = creature(line);
    expect(got.script?.triggers ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });
});

describe('the second condition vocabulary, and the ability word in front of it (D564)', () => {
  const creature = (text: string) => {
    const got = compileCard({
      name: 'Mardu Hordechief', type_line: 'Creature — Human Warrior', mana_cost: '{2}{W}', cmc: 3,
      colors: ['W'], power: '2', toughness: '3', layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };

  it.each([
    ['Raid — When Mardu Hordechief enters, if you attacked this turn, create a 1/1 white Warrior creature token.',
      'if you attacked this turn, create a 1/1 white Warrior creature token'],
    ['Morbid — At the beginning of your end step, if a creature died this turn, put a +1/+1 counter on Mardu Hordechief.',
      'if a creature died this turn, put a +1/+1 counter on Mardu Hordechief'],
    ['Revolt — When Mardu Hordechief enters, if a permanent you controlled left the battlefield this turn, you gain 5 life.',
      'if a permanent you controlled left the battlefield this turn, you gain 5 life'],
    ['Metalcraft — When Mardu Hordechief enters, if you control three or more artifacts, draw a card.',
      'if you control three or more artifacts, draw a card'],
    ['Lieutenant — When Mardu Hordechief enters, if you control your commander, draw a card.',
      'if you control your commander, draw a card'],
    // And the same conditions with no ability word, which is how the older printings read.
    ['When Mardu Hordechief enters, if a creature died this turn, draw a card.',
      'if a creature died this turn, draw a card'],
    ['At the beginning of each end step, if you gained 4 or more life this turn, create a 4/4 white Angel creature token with flying.',
      'if you gained 4 or more life this turn, create a 4/4 white Angel creature token with flying'],
    ["At the beginning of your end step, if you're the monarch, draw a card.",
      "if you're the monarch, draw a card"],
    ['At the beginning of your upkeep, if you have 10 or less life, you gain 1 life.',
      'if you have 10 or less life, you gain 1 life'],
    ['When Mardu Hordechief enters, if you control a creature with power 4 or greater, draw a card.',
      'if you control a creature with power 4 or greater, draw a card'],
  ])('reads %s', (line, description) => {
    const got = creature(line);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script?.triggers).toHaveLength(1);
    expect(got.script!.triggers![0]!.description).toBe(description);
    expect(typeof got.script!.triggers![0]!.condition).toBe('function');
  });

  it.each([
    ['coven, which counts distinct powers',
      'Coven — At the beginning of your end step, if you control three or more creatures with different powers, draw a card.'],
    ['a comparison between two players',
      'When Mardu Hordechief enters, if an opponent controls more lands than you, draw a card.'],
    ['a per-turn fact the engine does not keep',
      'When Mardu Hordechief enters, if you descended this turn, draw a card.'],
    ['a narrower death than "a creature"',
      'When Mardu Hordechief enters, if a nontoken creature died this turn, draw a card.'],
    ['more than one death',
      'When Mardu Hordechief enters, if two or more creatures died this turn, draw a card.'],
    ['a size it does not print',
      'When Mardu Hordechief enters, if you control a creature with power X or greater, draw a card.'],
    ['a life total it does not print',
      'When Mardu Hordechief enters, if you gained X or more life this turn, draw a card.'],
    ['a keyword cost that only looks like an ability word',
      'Kicker — When Mardu Hordechief enters, if you attacked this turn, draw a card.'],
  ])('leaves %s unread', (_what, line) => {
    const got = creature(line);
    expect(got.script?.triggers ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });
});

describe('one sentence, two events — and two death prologues (D565)', () => {
  const creature = (text: string) => {
    const got = compileCard({
      name: 'Grave Titan', type_line: 'Creature — Giant', mana_cost: '{4}{B}{B}', cmc: 6,
      colors: ['B'], power: '6', toughness: '6', layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };

  it.each([
    ['Whenever Grave Titan enters or attacks, create two 2/2 black Zombie creature tokens.',
      [{ kind: 'etb', who: 'self' }, { kind: 'attacks' }]],
    ['Whenever this creature enters or attacks, draw a card.',
      [{ kind: 'etb', who: 'self' }, { kind: 'attacks' }]],
    ['Whenever Grave Titan attacks or blocks, each player draws a card.',
      [{ kind: 'attacks' }, { kind: 'blocking-creature' }]],
    ['When Grave Titan enters or leaves the battlefield, you gain 2 life.',
      [{ kind: 'etb', who: 'self' }, { kind: 'leaves' }]],
    ['Whenever a creature dies, you gain 1 life.',
      [{ kind: 'dies', who: 'any', what: 'creature' }]],
    ['Whenever a creature an opponent controls dies, put a +1/+1 counter on Grave Titan.',
      [{ kind: 'dies', who: 'any', of: 'opponent', what: 'creature' }]],
  ])('reads %s as one trigger per event', (line, events) => {
    const got = creature(line);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script!.triggers!.map((t) => t.on)).toEqual(events);
    // One printed ability: every trigger it becomes says the same thing.
    expect(new Set(got.script!.triggers!.map((t) => t.description)).size).toBe(1);
  });

  it.each([
    ['a once-a-turn restriction on two events, which would be two records',
      'Whenever Grave Titan enters or attacks, draw a card. This ability triggers only once each turn.'],
    ['three events', 'Whenever Grave Titan enters, attacks, or blocks, draw a card.'],
    ['a pair one of whose halves is not an event row', 'Whenever Grave Titan attacks or becomes untapped, draw a card.'],
    ['a narrower death', 'Whenever a nontoken creature dies, you gain 1 life.'],
  ])('leaves %s unread', (_what, line) => {
    const got = creature(line);
    expect(got.script?.triggers ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });
});

describe('damage as an event: the five prologues (D566)', () => {
  const card = (text: string, type = 'Creature — Vampire') => {
    const got = compileCard({
      name: 'Sengir Vampire', type_line: type, mana_cost: '{3}{B}{B}', cmc: 5, colors: ['B'],
      ...(type.startsWith('Creature') ? { power: '4', toughness: '4' } : {}),
      layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };
  const AURA = 'Enchantment — Aura';

  it.each([
    ['Whenever Sengir Vampire is dealt damage, draw a card.', undefined, { kind: 'damaged' }],
    ['Enrage — Whenever this creature is dealt damage, you gain 2 life.', undefined, { kind: 'damaged' }],
    ['Whenever Sengir Vampire deals damage to an opponent, draw a card.', undefined,
      { kind: 'deals-damage', to: 'opponent' }],
    ['Whenever Sengir Vampire deals damage to an opponent, that player discards a card.', undefined,
      { kind: 'deals-damage', to: 'opponent' }],
    ['Enchant creature\nWhenever enchanted creature deals damage to an opponent, you may draw a card.', AURA,
      { kind: 'deals-damage', who: 'attached', to: 'opponent' }],
    ['Whenever Sengir Vampire deals combat damage to an opponent, draw a card.', undefined,
      { kind: 'deals-damage', to: 'opponent', combatOnly: true }],
    ['Enchant creature\nWhenever enchanted creature deals combat damage to an opponent, you may draw a card.', AURA,
      { kind: 'deals-damage', who: 'attached', to: 'opponent', combatOnly: true }],
    ['Whenever a creature you control deals combat damage to an opponent, you may draw a card.', 'Enchantment',
      { kind: 'deals-damage', who: 'any', of: 'you', to: 'opponent', combatOnly: true }],
    ['Whenever a creature dealt damage by Sengir Vampire this turn dies, put a +1/+1 counter on Sengir Vampire.',
      undefined, { kind: 'dies', who: 'any', what: 'creature', damagedBy: 'self' }],
  ])('reads %s', (text, type, event) => {
    const got = card(text, type);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script!.triggers!.map((t) => t.on)).toEqual([event]);
  });

  it('keeps "deals combat damage to a PLAYER" on the event it has always had', () => {
    const got = card('Whenever Sengir Vampire deals combat damage to a player, draw a card.');
    expect(got.script!.triggers!.map((t) => t.on.kind)).toEqual(['combat-damage']);
  });

  it.each([
    ['"equipped creature is dealt damage", whose host may be dead and detached by then',
      'Whenever equipped creature is dealt damage, you gain 1 life.', 'Artifact — Equipment'],
    ['"dealt damage by enchanted creature", whose one card means the enchanted creature by "that creature"',
      'Whenever a creature dealt damage by enchanted creature this turn dies, put a +1/+1 counter on that creature.', AURA],
    ['a threshold on the damage', 'Whenever Sengir Vampire is dealt 3 or more damage, draw a card.', undefined],
    ['damage to "a player", which is not the printed sentence this event reads',
      'Whenever Sengir Vampire deals damage to a player, draw a card.', undefined],
    ['damage to a creature', 'Whenever Sengir Vampire deals damage to a creature, draw a card.', undefined],
    ['a characteristic on the dead creature',
      'Whenever a creature with flying dealt damage by Sengir Vampire this turn dies, draw a card.', undefined],
  ])('leaves %s unread', (_what, line, type) => {
    const got = card(line, type);
    expect(got.script?.triggers ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });
});

describe('discarding and cycling as events, and attacking alone (D567)', () => {
  const card = (text: string, type = 'Creature — Human Cleric') => {
    const got = compileCard({
      name: 'Drannith Healer', type_line: type, mana_cost: '{1}{W}', cmc: 2, colors: ['W'],
      ...(type.startsWith('Creature') ? { power: '2', toughness: '2' } : {}),
      layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };

  it.each([
    ['Whenever you discard a card, you gain 1 life.', [{ kind: 'discards', by: 'you' }]],
    ['Whenever you cycle or discard a card, you gain 1 life.', [{ kind: 'discards', by: 'you' }]],
    ['Whenever you cycle or discard another card, you gain 1 life.', [{ kind: 'discards', by: 'you' }]],
    ['Whenever an opponent discards a card, that player loses 2 life.', [{ kind: 'discards', by: 'opponent' }]],
    ['Whenever a player discards a card, you gain 1 life.', [{ kind: 'discards', by: 'any' }]],
    ['Whenever you cycle a card, you gain 1 life.', [{ kind: 'cycles', by: 'you' }]],
    ['Whenever you cycle another card, you gain 1 life.', [{ kind: 'cycles', by: 'you' }]],
    ['Whenever a player cycles a card, you gain 1 life.', [{ kind: 'cycles', by: 'any' }]],
    ['When you cycle Drannith Healer, you gain 1 life.', [{ kind: 'cycles', self: true }]],
    ['When you cycle this card, you gain 1 life.', [{ kind: 'cycles', self: true }]],
    ['When you cycle Drannith Healer or it dies, you gain 1 life.',
      [{ kind: 'cycles', self: true }, { kind: 'dies' }]],
    ['Whenever Drannith Healer attacks alone, it gets +3/+0 until end of turn.',
      [{ kind: 'attacks', alone: true }]],
    ['Whenever a creature you control attacks alone, put a +1/+1 counter on it.',
      [{ kind: 'attacks', who: 'any', of: 'you', alone: true }]],
  ])('reads %s', (text, events) => {
    const got = card(text);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script!.triggers!.map((t) => t.on)).toEqual(events);
  });

  it('marks the Cycling keyword\'s ability as cycling, which its cost alone does not say', () => {
    const got = card('Cycling {1} ({1}, Discard this card: Draw a card.)');
    expect(got.unread).toEqual([]);
    expect(got.script!.abilities).toHaveLength(1);
    expect(got.script!.abilities![0]!.cost.discardSelf).toBe(true);
    expect(got.script!.abilities![0]!.cycling).toBe(true);
  });

  it('and does not mark an ability that merely discards its own card', () => {
    const got = card('{1}{R}, Discard this card: You gain 2 life.');
    expect(got.unread).toEqual([]);
    expect(got.script!.abilities![0]!.cost.discardSelf).toBe(true);
    expect(got.script!.abilities![0]!.cycling).toBeUndefined();
  });

  it.each([
    ['a discard narrowed by card type', 'Whenever you discard a creature card, you gain 1 life.'],
    ['a batched discard', 'Whenever you discard one or more cards, you gain 1 life.'],
    ['a discard somebody else caused',
      'When a spell or ability an opponent controls causes you to discard Drannith Healer, you gain 1 life.'],
    ['a first-cycle-each-turn restriction',
      'Whenever you cycle another card for the first time each turn, you gain 1 life.'],
    ['a tribe attacking alone', 'Whenever a Samurai or Warrior you control attacks alone, you gain 1 life.'],
  ])('leaves %s unread', (_what, line) => {
    const got = card(line);
    expect(got.script?.triggers ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });
});

describe('sacrifice as an event: every printed combination of the three slots (D570)', () => {
  const card = (text: string, type = 'Creature — Devil') => {
    const got = compileCard({
      name: 'Mayhem Devil', type_line: type, mana_cost: '{1}{B}{R}', cmc: 3, colors: ['B', 'R'],
      ...(type.startsWith('Creature') ? { power: '3', toughness: '3' } : {}),
      layout: 'normal', oracle_text: text,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('refused');
    return got;
  };

  it.each([
    ['Whenever you sacrifice a permanent, you gain 1 life.', { kind: 'sacrifices', by: 'you' }],
    ['Whenever you sacrifice another permanent, you gain 1 life.', { kind: 'sacrifices', by: 'you', who: 'another' }],
    ['Whenever you sacrifice a creature, draw a card.', { kind: 'sacrifices', by: 'you', what: 'creature' }],
    ['Whenever you sacrifice another creature, draw a card.',
      { kind: 'sacrifices', by: 'you', who: 'another', what: 'creature' }],
    ['Whenever you sacrifice an artifact, you gain 1 life.', { kind: 'sacrifices', by: 'you', what: 'artifact' }],
    ['Whenever you sacrifice a token, you gain 1 life.', { kind: 'sacrifices', by: 'you', what: 'token' }],
    ['Whenever you sacrifice a Clue, you gain 1 life.', { kind: 'sacrifices', by: 'you', ofSubtypes: ['Clue'] }],
    ['Whenever you sacrifice a Treasure, you gain 1 life.', { kind: 'sacrifices', by: 'you', ofSubtypes: ['Treasure'] }],
    ['Whenever you sacrifice a Blood token, you gain 1 life.', { kind: 'sacrifices', by: 'you', ofSubtypes: ['Blood'] }],
    ['Whenever a player sacrifices a permanent, Mayhem Devil deals 1 damage to any target.',
      { kind: 'sacrifices', by: 'any' }],
    ['Whenever a player sacrifices another permanent, you gain 1 life.',
      { kind: 'sacrifices', by: 'any', who: 'another' }],
    ['Whenever an opponent sacrifices a creature, you gain 1 life.',
      { kind: 'sacrifices', by: 'opponent', what: 'creature' }],
    ['When you sacrifice Mayhem Devil, you gain 10 life.', { kind: 'sacrifices', who: 'self' }],
  ])('reads %s', (text, event) => {
    const got = card(text);
    expect(got.unread.map((u) => u.line)).toEqual([]);
    expect(got.script!.triggers!.map((t) => t.on)).toEqual([event]);
  });

  it('reads "enters and when you sacrifice it" as two events with one effect', () => {
    const got = card('When Mayhem Devil enters and when you sacrifice it, you gain 3 life.', 'Artifact — Food');
    expect(got.unread).toEqual([]);
    expect(got.script!.triggers!.map((t) => t.on)).toEqual([
      { kind: 'etb', who: 'self' }, { kind: 'sacrifices', who: 'self' },
    ]);
  });

  it.each([
    ['a card type the event has no answer for', 'Whenever you sacrifice a land, you gain 1 life.'],
    ['two filters at once', 'Whenever you sacrifice a creature token, you gain 1 life.'],
    ['a negated filter', 'Whenever you sacrifice a nontoken creature, you gain 1 life.'],
    ['a creature subtype, which is not in the closed list', 'Whenever you sacrifice a Goblin, you gain 1 life.'],
    ['a batch', 'Whenever you sacrifice one or more Foods, you gain 1 life.'],
    ['an either-or', 'Whenever you sacrifice an artifact or creature, you gain 1 life.'],
  ])('leaves %s unread', (_what, line) => {
    const got = card(line);
    expect(got.script?.triggers ?? []).toEqual([]);
    expect(got.unread.map((u) => u.line)).toEqual([line]);
  });
});
