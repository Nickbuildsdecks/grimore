/**
 * The engine's own pool, read back as card-data rows.
 *
 * A `CardDef` carries what a card prints, which is what a row carries, so this is a rename rather
 * than a conversion. The one field it cannot supply is `produced_mana`, so the land cross-check
 * inside `cardFromData` does not run against these rows — stated here rather than left to be found,
 * since it makes this arm slightly more permissive about lands than a real import would be.
 *
 * Extracted because two harnesses now need it (`compilable.mjs` measures what share of this text
 * compiles, `compile-at-scale.mjs` measures whether the compiler survives a corpus-sized one), and a
 * second copy of this conversion is a second place for the field names to drift from `CardDataRow`.
 */
import { STARTER_DECKS } from './engine.mjs';

export function poolRows() {
  const seen = new Map();
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const entry of deck.cards) if (!seen.has(entry.card.name)) seen.set(entry.card.name, entry.card);
    if (deck.commander && !seen.has(deck.commander.name)) seen.set(deck.commander.name, deck.commander);
  }
  return [...seen.values()].map((def) => ({
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
  }));
}
