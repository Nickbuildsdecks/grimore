import { describe, expect, it } from 'vitest';
import { compileCard, fullyCompiled } from './compile.js';
import { STARTER_DECKS } from './starterDecks.js';
import { scriptFor } from './scripts.js';
import type { CardDef } from './cards.js';
import type { CardDataRow } from './fromCardData.js';
import type { EffectContext } from './effects.js';
import type { GameState, SeatIndex } from './types.js';
import { arena } from './testkit.js';

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
