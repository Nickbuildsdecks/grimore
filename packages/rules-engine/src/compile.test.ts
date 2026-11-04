import { describe, expect, it } from 'vitest';
import { compileCard, fullyCompiled } from './compile.js';
import { STARTER_DECKS } from './starterDecks.js';
import { isKeywordDeclaration, scriptFor } from './scripts.js';
import { zoneKey, type CardDef } from './cards.js';
import type { CardDataRow } from './fromCardData.js';
import { tap, type EffectContext } from './effects.js';
import type { AbilityDef, TargetSpec, TriggerDef } from './scriptTypes.js';
import type { GameState, SeatIndex } from './types.js';
import type { Target } from './turnTypes.js';
import { arena, find } from './testkit.js';

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

    for (const card of ['Young Wolf', 'Bloodbraid Elf', 'Grapeshot', 'Arcbound Worker', 'Calciderm', 'Blastoderm']) {
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
      // "exile target creature" needs a target spec, which is the next increment. Until then the
      // line is reported unread and the card is a manual object inside an automated game (D362).
      const banisher = compileCard({
        name: 'Reader Test', type_line: 'Creature — Human', mana_cost: '{3}', cmc: 3,
        power: '2', toughness: '2', colors: [],
        oracle_text: 'When Reader Test enters the battlefield, exile target creature.',
      });
      expect(banisher.ok).toBe(true);
      if (!banisher.ok) return;
      expect(banisher.script).toBeUndefined();
      expect(banisher.unread).toEqual([
        { line: 'When Reader Test enters the battlefield, exile target creature.', why: 'no-reader' },
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

        "Draw two cards, then discard two cards." is real printed text from the pool whose first
        clause this module reads and whose second it does not. A compiler that drew the cards and
        skipped the discard would be a strictly better Divination, which is a wrong card rather than
        an unread one, and wrong in a way nothing at the table would flag.
      */
      const half = compileCard({
        name: 'Half Reader', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: 'Draw two cards, then discard two cards.',
      });
      expect(half.ok).toBe(true);
      if (!half.ok) return;
      expect(half.script).toBeUndefined();
      expect(half.source).toBe('printed-only');
      expect(half.unread).toEqual([
        { line: 'Draw two cards, then discard two cards.', why: 'no-reader' },
      ]);
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
      */
      const drawFirst = compileCard({
        name: 'Draw Then Scry', type_line: 'Instant', mana_cost: '{U}', cmc: 1, colors: ['U'],
        oracle_text: 'Draw a card. Scry 2.',
      });
      expect(drawFirst.ok).toBe(true);
      if (!drawFirst.ok) return;
      expect(drawFirst.unread).toEqual([]);

      const base = arena();
      const after = (field(drawFirst.script, 'onResolve') as (c: EffectContext) => GameState)(
        contextOn(base, 0 as SeatIndex, 'c1'),
      );
      // Drawn, not owed: the scry that follows has to be looking at the library the draw left.
      expect(after.zones[zoneKey(0 as SeatIndex, 'hand')]).toHaveLength(1);
      expect(after.drawsOwed.filter((seat) => seat === 0)).toHaveLength(0);

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
          The sentence was a Fog until the Fog clause became readable, which is the right kind of
          churn and the reason this fixture names its own text rather than borrowing a card's: a
          sentence nothing reads today is a moving target, and the property is about the two kinds
          of unread line rather than about any particular one.
        */
        oracle_text: 'Kicker {4}\nEach player sacrifices a creature.',
      });
      expect(half.ok).toBe(true);
      if (!half.ok) return;
      expect(half.script).toBeUndefined();
      expect(half.unread).toEqual([
        { line: 'Kicker {4}', why: 'unimplemented-keyword' },
        { line: 'Each player sacrifices a creature.', why: 'no-reader' },
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

    it('does not read "sacrifice ~", because the flag belongs to the shape and not the clause', () => {
      /*
        Ball Lightning is "At the beginning of the end step, sacrifice Ball Lightning", and it also
        sets `leavesAtEndOfTurn: true` — its own comment: "the trigger below is what happens, and
        the flag is how the bot knows it is coming. Without it the evaluation holds the creature
        back to protect it."

        So the flag belongs to the **pair** of prologue and clause: a sacrifice at end of turn means
        the creature is leaving, a sacrifice on some other trigger does not. `selfEffect` sees only
        the clause, so reading it there would build a card that works and plays badly, which is
        worse than an unread line (D362). This is the test that keeps that omission deliberate
        rather than forgotten.
      */
      const ball = compiledScript('Ball Lightning');
      expect(ball.unread.map((u) => u.line))
        .toContain('At the beginning of the end step, sacrifice Ball Lightning.');
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
      // A count read off the board, not the X chosen at cast time.
      ['Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.'],
      // The same thing in another spelling.
      ['Create a 1/1 black and green Insect creature token for each creature card in your graveyard.'],
      // A granted ability, not a keyword: `printedKeywords` reads nothing out of it.
      ['Create a 1/1 black Pest creature token with "When this creature dies, you gain 1 life."'],
      // No printed power and toughness, and the token carries rules text of its own.
      ['Create a Treasure token.'],
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
        The invariant, on the two shapes that would break it. A declaration with no static line is
        an Aura that attaches and does nothing; a static line with no declaration is a bonus with
        nothing to attach it to. Either one emitted alone is a card that **works and does nothing**,
        which is worse than an unread card, because an unread card is flagged and a blank Aura is
        not.
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

    it('refuses a bare exile with no return anywhere on the card', () => {
      /*
        The one refusal here that is about correctness rather than coverage. A printed `exile target
        creature` ETB with neither an `until ~ leaves` clause nor a `leaves` line is **permanent
        exile**, and emitting the pair for it would hand back a creature the print says is gone for
        good — a card that works and is a different, weaker card.
      */
      const permanent = compileCard({
        name: 'Gone For Good', type_line: 'Creature — Avatar', mana_cost: '{3}{W}', cmc: 4,
        colors: ['W'], power: '2', toughness: '2',
        oracle_text: 'When Gone For Good enters the battlefield, exile target creature.',
      });
      expect(permanent.ok).toBe(true);
      if (!permanent.ok) return;
      expect(permanent.script).toBeUndefined();
      expect(permanent.unread.map((u) => u.line)).toEqual([
        'When Gone For Good enters the battlefield, exile target creature.',
      ]);
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
      // And the grant that is not protection keeps the pump hint, which is what it is for.
      expect(field(compiledScript('Tainted Strike').script, 'expiresAtEndOfTurn')).toBe(true);
      expect(field(compiledScript('Tainted Strike').script, 'protectsACreature')).toBeUndefined();
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
        And not on the hexproof pair, which is the other half of `helpsInCombat`'s own rule: a
        bonus is only "for the attack" when its whole value is, and hexproof is as useful on a
        blocker. The one remaining difference from the hand-written spec is `friendly`, which the
        compiler sets on every helpful phrase and `protectFromRemoval` leaves off — moot either
        way, because its filter already restricts the candidates to your own creatures (see
        `targetSpecFrom`). Recorded here rather than asserted equal, since the difference is real
        and changes no legal target.
      */
      const defence = specOf(compiledScript('Blossoming Defense').script);
      expect(defence?.helpsInCombat).toBeUndefined();
      expect(defence?.friendly).toBe(true);
      expect(specOf(scriptFor('Blossoming Defense'))?.friendly).toBeUndefined();
    });
  });
});
