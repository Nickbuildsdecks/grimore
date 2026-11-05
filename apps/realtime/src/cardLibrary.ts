/**
 * The card table, as the table reads it: printed rows for the names somebody pasted in.
 *
 * ## Why this exists
 *
 * `customDeck` resolves a pasted name three ways — the 348 hand-written pool cards, then the
 * printed data a caller supplies, then cardboard (a name and nothing else, moved by hand). D430
 * made the data step ask the oracle-text compiler, so a row from the card table becomes a card that
 * casts for its real cost and does as much as the compiler read, with the rest flagged for a person
 * (D362). D458 put 33,847 rows in that table.
 *
 * And **no caller supplied any data**. `customDeck.ts`' own header says why: its three call sites in
 * this app run inside a synchronous compare-and-set write where no query can happen, so the rows
 * have to arrive as data or not at all. So every pasted deck was 348 cards of pool and cardboard for
 * everything else, with a whole card table sitting unread. This is the missing half.
 *
 * ## An in-process cache, not a column on the pod record
 *
 * Measured before choosing: **150 rows is 60 KB of JSON**, so a four-seat pod's lists are 240 KB.
 * Storing them on the pod record would put that inside the CAS value, which is written whole on
 * every move — and doubled, because one step of undo keeps a serialized copy of the record
 * (`PodRecord.previous`). Half a megabyte written per move, to carry data that never changes.
 *
 * So nothing is stored. Printed card text is immutable reference data, which is the ideal thing to
 * cache in memory: `warm` fetches the rows a pod's lists need and `rowFor` answers synchronously
 * afterwards. `PodStore.mutate` warms after reading the record and before running the mutation, so
 * every reading of a list inside that mutation — the ack, the lobby summary and the deck actually
 * dealt — sees the same rows. That three-way agreement is tested, and it is the reason the warm is
 * in `mutate` rather than at the two call sites that obviously need it.
 *
 * A cold cache is not a correctness problem, only a worse table: a name with no row is cardboard,
 * exactly as it was before this file existed.
 *
 * ## Misses are cached too
 *
 * A name the table does not have is cached as a miss, because a player who types `Lightnng Bolt`
 * would otherwise have that name queried again on every move for the rest of the game. The cost of
 * the negative entry is that a card arriving in the table later is not picked up until the process
 * restarts — acceptable for a corpus that is loaded by hand and never edited live.
 *
 * **A query that fails is not a miss**, and the distinction is the whole reason the two are
 * separate: a database hiccup must not turn a deck to cardboard permanently. On an error nothing is
 * cached, the names stay unresolved for that call, and the next warm tries again.
 */
import pg from 'pg';
import type { CardDataRow } from '@grimore/rules-engine';

/** Just enough of a logger to report a failed lookup; pino satisfies it, so does a test double. */
export interface CardLibraryLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface CardLibrary {
  /**
   * Fetches rows for these names, so `rowFor` can answer for them.
   *
   * Only names not already known are queried, so a warm with nothing new costs nothing. Never
   * throws: a lookup that fails is reported and leaves the names unresolved.
   */
  warm: (names: readonly string[]) => Promise<void>;
  /** The printed row for that name, or undefined. Case and surrounding space do not matter. */
  rowFor: (name: string) => CardDataRow | undefined;
  close: () => Promise<void>;
}

/**
 * The columns `CardDataRow` reads, and `DISTINCT ON` so one name is one row.
 *
 * The de-duplication is not decoration. `scryfall_cards` is keyed by **printing**, so a real
 * Scryfall import holds one row per printing and a join by name fans out — the bug D23 and D24 both
 * found elsewhere in this product. Here a fan-out would mean an arbitrary printing's text winning,
 * differently on different nodes, which is the kind of disagreement nobody would think to look for.
 * `ORDER BY LOWER(name), id` makes the choice the same everywhere.
 */
const LOOKUP = `
  SELECT DISTINCT ON (LOWER(name))
    name, type_line, oracle_text, mana_cost, cmc, colors, color_identity, keywords,
    power, toughness, loyalty, layout, produced_mana, image_uri, id, oracle_id
  FROM scryfall_cards
  WHERE LOWER(name) = ANY($1::text[])
  ORDER BY LOWER(name), id`;

/**
 * How many names to remember.
 *
 * A pasted list is at most 151 distinct names (`DECKLIST_LIMITS.maxDistinct` plus a commander), so
 * this is upwards of a hundred tables' worth of entirely distinct decks. Over the cap the cache is
 * cleared rather than evicted in order: what a clear costs is one query per list still in play, and
 * an eviction order would buy nothing a table would notice. The compiler's own cache makes the same
 * trade for the same reason.
 */
const DEFAULT_MAX_NAMES = 20_000;

/** A key that ignores case and surrounding space, matching how `customDeck` indexes the pool. */
const keyFor = (name: string): string => name.trim().toLowerCase();

export function createCardLibrary(opts: {
  readonly databaseUrl: string;
  readonly log?: CardLibraryLog;
  readonly maxNames?: number;
}): CardLibrary {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 2 });
  const maxNames = opts.maxNames ?? DEFAULT_MAX_NAMES;
  // `null` is a name the table does not have. See "Misses are cached too".
  const known = new Map<string, CardDataRow | null>();

  return {
    async warm(names: readonly string[]): Promise<void> {
      const wanted = [...new Set(names.map(keyFor))].filter((k) => k !== '' && !known.has(k));
      if (wanted.length === 0) return;
      let rows: CardDataRow[];
      try {
        const got = await pool.query(LOOKUP, [wanted]);
        rows = got.rows as CardDataRow[];
      } catch (err) {
        // Reported and dropped. Nothing is cached, so the next warm asks again; the names stay
        // unresolved for this one, which makes them cardboard — the behaviour before D459.
        opts.log?.warn({ err, names: wanted.length }, 'card lookup failed; pasted names stay unread');
        return;
      }
      if (known.size + wanted.length > maxNames) known.clear();
      for (const key of wanted) known.set(key, null);
      for (const row of rows) {
        const key = keyFor(row.name ?? '');
        if (key !== '') known.set(key, row);
      }
    },
    rowFor(name: string): CardDataRow | undefined {
      return known.get(keyFor(name)) ?? undefined;
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
