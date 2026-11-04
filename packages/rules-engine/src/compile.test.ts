import { describe, expect, it } from 'vitest';
import { compileCard, fullyCompiled } from './compile.js';
import { STARTER_DECKS } from './starterDecks.js';
import { isKeywordDeclaration, scriptFor } from './scripts.js';
import { zoneKey, type CardDef } from './cards.js';
import type { CardDataRow } from './fromCardData.js';
import { tap, type EffectContext } from './effects.js';
import type { TargetSpec, TriggerDef } from './scriptTypes.js';
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
  describe('keyword declarations, which are a different kind of incomplete', () => {
    it('reads the resolution of a spell whose keyword line it cannot build, and names the keyword', () => {
      /*
        Thunderous Wrath is `Miracle {R}` plus "deals 5 damage to any target". Before
        `isKeywordDeclaration`, the keyword line fell into the resolution, and the resolution is
        all-or-nothing — so a damage clause this module reads perfectly well was refused by a line
        that is not part of resolving the spell at all. Four pool spells were refused that way.
      */
      const wrath = compiledScript('Thunderous Wrath');
      expect(wrath.script).toBeDefined();
      expect(wrath.unread).toEqual([{ line: 'Miracle {R}', why: 'unimplemented-keyword' }]);
      expect(wrath.compiled).toEqual(['Thunderous Wrath deals 5 damage to any target.']);
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
        oracle_text: 'Miracle {R}\nPrevent all combat damage that would be dealt this turn.',
      });
      expect(half.ok).toBe(true);
      if (!half.ok) return;
      expect(half.script).toBeUndefined();
      expect(half.unread).toEqual([
        { line: 'Miracle {R}', why: 'unimplemented-keyword' },
        {
          line: 'Prevent all combat damage that would be dealt this turn.',
          why: 'no-reader',
        },
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
});
