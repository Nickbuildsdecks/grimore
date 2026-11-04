/**
 * The cards the goal actually asks for: "legal in normal format, so like standard, legacy, modern,
 * pauper, commander, and the actual played competitive formats".
 *
 * Two measures want this and the rule must be the same in both, so it lives here rather than twice.
 * It reads the `legalities` object `scripts/corpus/legality.mjs` attaches, which is Scryfall's
 * shape — so when Scryfall egress opens and the bulk file replaces the Forge-derived map, this
 * function does not change.
 *
 * `LEGAL` is read from the environment rather than passed, because every caller is a measuring
 * script whose knobs are already environment variables:
 *
 *   LEGAL=1            legal (or restricted) in at least one of the formats below
 *   LEGAL=modern       legal (or restricted) in that one format
 *   (unset)            no filter at all, which is what every measurement before this did
 *
 * A row with **no** `legalities` field is kept when the filter is off and dropped when it is on.
 * Dropped rather than kept, because the corpus builder omits the field only for a name the legality
 * map has never heard of, and a card no set lists is a card nobody can put in a deck.
 */

/** The formats the goal names, plus Pioneer, which is the other one people actually play. */
export const GOAL_FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'commander'];

/** Whether this row passes the filter the environment asks for. */
export function isLegal(row) {
  const want = process.env.LEGAL;
  if (want === undefined || want === '') return true;
  const legalities = row.legalities;
  if (legalities === undefined) return false;
  const ok = (status) => status === 'legal' || status === 'restricted';
  if (want === '1') return GOAL_FORMATS.some((f) => ok(legalities[f]));
  return ok(legalities[want]);
}

/** One line saying what the filter did, so a number is never printed without its scope. */
export function legalLine(before, after) {
  const want = process.env.LEGAL;
  if (want === undefined || want === '') return 'Legality filter: off (every row kept)';
  const scope = want === '1' ? `any of ${GOAL_FORMATS.join(', ')}` : want;
  return `Legality filter: ${scope} — ${after} of ${before} rows kept`;
}
