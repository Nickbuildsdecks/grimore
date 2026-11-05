import { describe, expect, it } from 'vitest';
import { compileCard, fullyCompiled } from './compile.js';
import { STARTER_DECKS } from './starterDecks.js';
import { CLUE_TOKEN, isKeywordDeclaration, scriptFor } from './scripts.js';
import { zoneKey, type CardDef } from './cards.js';
import { characteristicsOf, printedLandwalk } from './characteristics.js';
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
    { card: 'Ainok Survivalist', keyword: 'Morph', fields: ['morph'] },
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
    // Mystic Remora is cumulative upkeep plus one triggered ability. The keyword compiles; the
    // sentence does not, and the card is still a card.
    const remora = compiledScript('Mystic Remora');
    expect(remora.source).toBe('lines');
    expect(fullyCompiled(remora)).toBe(false);
    expect(remora.unread.map((u) => u.line).join(' ')).toContain('noncreature spell');
    expect(remora.unread.every((u) => u.why === 'no-reader')).toBe(true);
    // And the printed data survived regardless, which is what hybrid mode plays with.
    expect(remora.def.name).toBe('Mystic Remora');
    expect(remora.def.typeLine).toContain('Enchantment');
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
      ['Ravenous Rats', 'each opponent discards a card at random'],
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

    it.each([
      ['Lightning Bolt'],
      ['Doom Blade'],
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
        'Whenever this creature deals damage to a player, draw a card'". The pool declares that as
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
    }[] = [
      { card: 'Goblin Arsonist', kind: 'dies' },
      { card: 'Borderland Marauder', kind: 'attacks' },
      { card: 'Thieving Magpie', kind: 'combat-damage' },
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
        const ctx = contextOn(base, 0 as SeatIndex, source, targets);
        expect(mine.effect(ctx)).toEqual(written.effect(ctx));
        // Not vacuous: the printed trigger has to change the board on this fixture.
        expect(mine.effect(ctx), `${row.card}: the effect changed nothing`).not.toEqual(base);
      },
    );

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

    it('refuses an Aura that grants a quoted ability rather than a keyword', () => {
      /*
        Ophidian Eye: `Enchanted creature has "Whenever this creature deals damage to a player, draw
        a card."` The hand-written script expresses that with `grants`, an index into a table of
        abilities this module cannot build — and a reader that dropped the quoted text would be an
        Aura you can cast, that attaches, and that silently grants nothing. So the pair is refused
        and the card is reported unread, which is what gets it played by hand (D362).
      */
      const eye = compiledScript('Ophidian Eye');
      expect(field(eye.script, 'aura')).toBeUndefined();
      expect(eye.unread.map((u) => u.line)).toContain(
        'Enchanted creature has "Whenever this creature deals damage to a player, draw a card."',
      );
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

    it('refuses a keyword the engine would not read back out of what it wrote', () => {
      /*
        The same validation `tokenEffect` uses, for the same reason: the bonus's keywords are read
        by `printedKeywords`, so the reader asks that function whether the text it is about to write
        down yields the keywords the line named. An Equipment printed "has soaring" would otherwise
        grant nothing at all.
      */
      const nonsense = compileCard({
        name: 'Soaring Blade', type_line: 'Artifact — Equipment', mana_cost: '{1}', cmc: 1,
        colors: [], oracle_text: 'Equipped creature has soaring.\nEquip {1}',
      });
      expect(nonsense.ok).toBe(true);
      if (nonsense.ok) expect(nonsense.script).toBeUndefined();
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

    it('will not let a card exile itself where the print says "another"', () => {
      /*
        `another target nonland permanent` on Banishing Light, checked through the filter rather than
        through the description: the phrase is the only thing that stops an Oblivion-Ring-shaped
        card answering itself and locking its own target in exile for ever.
      */
      const light = compiledScript('Banishing Light');
      const spec = ((field(light.script, 'triggers') as readonly TriggerDef[])
        .find((t) => t.on.kind === 'etb')?.targets ?? [])[0];
      expect(spec).toBeDefined();
      const board = arena({ battlefield: { 0: ['Mountain'], 1: ['Grizzly Bears'] } });
      const bear = find(board, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      const land = find(board, 0 as SeatIndex, 'battlefield', 'Mountain');
      const admits = (id: string, source: string) =>
        spec?.filter?.(board, { kind: 'card', id }, 0 as SeatIndex, source) ?? false;
      // Somebody else's creature: yes. Itself: no. A land: no, because it says nonland.
      expect(admits(bear, 'some-other-id')).toBe(true);
      expect(admits(bear, bear)).toBe(false);
      expect(admits(land, 'some-other-id')).toBe(false);
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
        skipped. `Sacrifice another creature`, a counter removal and a discard are all in the pool
        and all refused here.

        A life payment is deliberately **not** in this list: `AbilityCost.life` exists and the
        engine honours it, so that component is said rather than dropped. The test below pins that
        from the other side. An earlier draft of this test asserted a life cost was refused and
        failed against `cardFromData`, which was already reading one correctly — which is how the
        distinction between "cannot be expressed" and "this reader does not read it" was found.
      */
      for (const text of [
        '{B}{G}, Sacrifice another creature: You gain 1 life.',
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
      */
      for (const text of [
        'Target creature gets +2/+2 and gains protection from red until end of turn.',
        'Target creature gets +2/+2 and gains flanking until end of turn.',
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
    it('refuses Healing Salve whole, all 3 lines, because one bullet has no reader', () => {
      /*
        This row has emptied twice, exactly as its own note said it would. Golgari Charm left when
        its regenerate mode was read; **Selesnya Charm** left with D404's exile-by-power, and it is
        asserted mode for mode further down instead. Healing Salve is the last pool card holding
        the property — its second bullet prevents damage, which nothing reads — and the synthetic
        row below it is what will hold the property when that one goes too.
      */
      const compiled = compiledScript('Healing Salve');
      expect(compiled.source).toBe('printed-only');
      expect(compiled.script).toBeUndefined();
      expect(compiled.unread).toHaveLength(3);
      // Including the header, which is the line that would otherwise look readable on its own.
      expect(compiled.unread[0]!.line).toMatch(/^Choose one/);
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
    it.each([
      ['Zulaport Cutthroat'],
      ['Cruel Celebrant'],
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
        Not vacuous, and read off the card rather than written as a literal: this pool's Redcap is a
        **1/1**, which is why its own comment says the body persist returns deals nothing — a 1/1
        with a −1/−1 counter is a 0/0. So the damage is its live power, and the assertion that it is
        above zero is what stops this passing on a reader that always dealt none.
      */
      const power = characteristicsOf(base, base.instances[redcap]!).power;
      expect(power).toBeGreaterThan(0);
      expect(mine.instances[bear]!.damage).toBe(power);
    });

    it('deals nothing when its power is zero, which persist makes the common case', () => {
      const base = arena({
        decks: { 0: 'ashen-rite', 1: 'verdant-guard' },
        battlefield: { 0: ['Murderous Redcap'], 1: ['Grizzly Bears'] },
        turn: 3,
      });
      const redcap = find(base, 0 as SeatIndex, 'battlefield', 'Murderous Redcap');
      const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
      // One −1/−1 counter on a 1/1: power 0, exactly the body persist returns (CR 702.78a).
      const shrunk = addCounters(base, redcap, '-1/-1', 1);
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

    it('drains a life per creature card from every opponent, as Lotleth Giant’s trigger does', () => {
      const base = yard();
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = triggerOf(compiledScript('Lotleth Giant').script)!.effect(ctx);
      const theirs = triggerOf(scriptFor('Lotleth Giant'))!.effect(ctx);
      expect(mine).toEqual(theirs);
      /*
        Two bodies, so two life — and the caster's own total is the control twice over: a reader
        that drained "each player" would take it too, and a reader that read the whole graveyard
        would take three.
      */
      const before = base.seats[1]!.life;
      expect(mine.seats[1]!.life).toBe(before - 2);
      expect(mine.seats[0]!.life).toBe(base.seats[0]!.life);
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

    it('does not read the same sacrifice behind a different prologue', () => {
      /*
        The restriction the flag forces. "Sacrifice ~" is not a clause this module reads on its
        own, because behind another prologue it does not mean the permanent leaves at *end of
        turn* — and emitting the trigger there with the flag would be a lie about the card, while
        emitting it without the flag would be the badly played card above. So the pair is read and
        anything else is refused.
      */
      const other = compileCard({
        name: 'Doomed Hound', type_line: 'Creature — Dog', mana_cost: '{R}', cmc: 1, colors: ['R'],
        power: '3', toughness: '1',
        oracle_text: 'Whenever Doomed Hound attacks, sacrifice Doomed Hound.',
      });
      expect(other.ok).toBe(true);
      if (other.ok) expect(other.script).toBeUndefined();
    });

    it('does not read "your end step" as "the end step"', () => {
      // `of: 'you'` and `of: 'any'` are different cards: a creature that dies only on your own
      // turn survives being cast on somebody else's, which is not what Ball Lightning does.
      const mine = compileCard({
        name: 'Polite Lightning', type_line: 'Creature — Elemental', mana_cost: '{R}', cmc: 1,
        colors: ['R'], power: '6', toughness: '1',
        oracle_text: 'At the beginning of your end step, sacrifice Polite Lightning.',
      });
      expect(mine.ok).toBe(true);
      if (mine.ok) expect(mine.script).toBeUndefined();
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
      // "1 damage divided as you choose among one or two targets" — one damage, two targets, which
      // is the pair that proves the two numbers are read separately.
      ['Pyromatics', 1, 2],
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
      expect(slayerSpec.description).toBe('target creature an opponent controls with power 4 or greater');
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

    it('does nothing when the event had no actor, and never hits its own controller', () => {
      /*
        The guard, which is the hand-written cards' own and the reason this reader is trigger-only.
        "That player" is `c.actor`; a stack object that is not a triggered ability carries none, so
        a reading reachable from a spell would silently do nothing — the hazard D399's X spells have
        in reverse.

        And the controller is never the victim. Fate Unraveler had `?? c.controller` there until
        D407, which would have drained **the caster** on an actorless event: the opposite of the
        card, and the kind of wrongness that only shows up in a game nobody can reconstruct.
      */
      const base = arena({ decks: { 0: 'ashen-rite', 1: 'hollow-tide' }, turn: 3 });
      for (const card of ['Kambal, Consul of Allocation', 'Fate Unraveler']) {
        const trigger = triggerOf(compiledScript(card).script)!;
        // No actor at all.
        expect(trigger.effect(contextOn(base, 0 as SeatIndex, 'c1'))).toEqual(base);
        // And an actor who is the controller — a seat drawing its own card, say.
        expect(trigger.effect(contextOn(base, 0 as SeatIndex, 'c1', 0 as SeatIndex))).toEqual(base);
      }
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

    it("will not read a return under its owner's control", () => {
      /*
        Flickerwisp's wording, and a different card twice over: the permanent comes back under its
        **owner's** control and at the beginning of the next end step. Read as this shape it would
        be a blink of somebody else's creature handed straight back to you, so the phrase is matched
        as printed and the other wording stays unread (D362).
      */
      const card = compileCard({
        name: 'Borrowed Shift', type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
        oracle_text: "Exile target creature you control, then return that card to the battlefield under its owner's control.",
      });
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.script).toBeUndefined();
    });

    it('will not read the shape as part of a longer resolution', () => {
      // Whole resolution or none of it, as with the loot sentence: a second line means the reader
      // has not seen everything the spell does.
      const card = compileCard({
        name: 'Busy Shift', type_line: 'Instant', mana_cost: '{W}', cmc: 1, colors: ['W'],
        oracle_text: 'Exile target creature you control, then return that card to the battlefield under your control.\nYou gain 2 life.',
      });
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.script).toBeUndefined();
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
    it.each([
      ['Jace, Memory Adept'],
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

    it('owes the controller a card for "You draw a card", as the hand-written minus does', () => {
      const base = arena({ decks: { 0: 'tidal-mind' } });
      const ctx = contextOn(base, 0 as SeatIndex, 'c1');
      const mine = abilitiesOf(compiledScript('Jace Beleren').script)[1]!.effect!(ctx);
      const theirs = abilitiesOf(scriptFor('Jace Beleren'))[1]!.effect!(ctx);
      expect(mine).toEqual(theirs);
      expect(mine.drawsOwed.filter((seat) => seat === 0)).toHaveLength(1);
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
      three quarters automated is the hybrid D362 is about, not a finished reading. All five in the
      pool now read whole.
    */
    it.each([
      ['Jace, Memory Adept'],
      ['Jace Beleren'],
      ['Ajani, Caller of the Pride'],
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
  describe('printed ability lines the engine reads off the card definition', () => {
    it.each([
      ['River Boa', 'Islandwalk', 'landwalk, read since #324 and miscounted ever since'],
      ['Paladin en-Vec', 'Protection from black and from red', 'the and-from printing'],
      [
        'Phyrexian Crusader',
        'First strike, protection from red, protection from white, infect',
        'a mixed list no single reader would take',
      ],
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
  The cast family, read off the prologue (D435).

  Which printed sentence becomes which trigger. The runtime tests in `scripts.test.ts` cover the
  three rows whose *behaviour* was new — `ofType`, the unused `spell: 'creature'`, and `self: true`
  from a compiled card — and this covers the mapping for all seven, plus the three spellings that
  are refused on the mechanism rather than on a count.
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
      Refused on the mechanism rather than on the count, which is the distinction worth asserting:
      these are not "not yet", they are "not expressible without lying about the card".

      `ofType` holds one card type. Historic is artifact *or* legendary *or* Saga and multicolored
      is a fact about the mana cost, so reading either as a type would fire the ability on the wrong
      spells — and a trigger that fires on the wrong spells is worse than a line left for a human
      (D362). The opponent-creature row is the other kind of refusal and is here to keep the two
      apart: it is held back only on the count, and D435's table records that nothing it would read
      has a readable body yet.
    */
    ['Whenever you cast a historic spell', 'artifact or legendary or Saga, not a card type'],
    ['Whenever you cast a multicolored spell', 'a fact about the mana cost'],
    ['Whenever an opponent casts a creature spell', 'expressible, but 0 cards to exercise it'],
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

  it('refuses the batched plural, which this engine would fire once per attacker', () => {
    /*
      "Whenever **one or more** creatures you control deal combat damage to a player" is 26 legal
      lines and 8 compilable cards, and it is left unread on purpose. It fires **once** however many
      creatures connected; this engine raises one `combat-damage` event per creature, so the row
      would pay Grim Hireling two Treasures per attacker instead of two per combat.

      A reading that is wrong is worse than a line left unread (D362), so it waits for a batched
      event. This row's job is to fail if someone adds the prologue without the event — at which
      point the plural would be read, and read wrongly.
    */
    const read = permanent('Whenever one or more creatures you control deal combat damage to a'
      + ' player, you gain 1 life.');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unread.map((u) => u.line)).toEqual([
      'Whenever one or more creatures you control deal combat damage to a player, you gain 1 life.',
    ]);
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
