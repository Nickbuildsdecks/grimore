const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const db = require('./db');

// Delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper to make HTTPS requests with User-Agent
/**
 * GET a JSON document.
 *
 * The status code used to be ignored, so an error response -- Scryfall's own JSON error, a proxy's
 * HTML page, a 429 -- was handed straight to JSON.parse. When it was not valid JSON the caller got
 * a bare `SyntaxError: Unexpected token '<'` with no URL and no status, which is what the startup
 * log showed on 2026-09-26 and says nothing about what actually went wrong. Both failure modes now
 * name the URL and the status.
 */
/**
 * The formats a card has to be legal in for this import to keep it.
 *
 * Scryfall's `legalities` map carries sixteen or so keys, and the filter here used to accept a card
 * legal in **any** of them. That is wider than what this corpus is for: a rules engine for the
 * games Nick and his friends will actually sit down and play. Alchemy, Historic, Timeless, Brawl,
 * Oathbreaker and PreDH are all in that map, and a card that exists only in one of them has no
 * paper table to be brought to.
 *
 * These seven are the named list, and `restricted` counts alongside `legal` because a restricted
 * card is legal at one copy. Scryfall spells the keys exactly as below; a key this list misspelled
 * would read as `undefined` and quietly narrow the whole corpus, which is why the tally now prints
 * `not-legal-anywhere-played` as a line of its own rather than folding it into one total.
 */
const PLAYED_FORMATS = [
  "standard", "pioneer", "modern", "legacy", "vintage", "pauper", "commander",
];

/**
 * Whether this bulk-data object belongs in the corpus, or the reason it does not.
 *
 * Returns `true` to keep, or a short reason string to drop. A **reason** rather than a bare
 * `false`, because one total cannot tell "the dump was all tokens" from "the legality list got too
 * narrow", and those are opposite bugs. The filtered counter exists to make a broken import
 * visible (see the tally below, and D329), and a single number only half does that.
 *
 * A pure function of one Scryfall object, lifted out of the import loop so it can be exercised
 * without a database and a 500MB file. The filter decides what the whole corpus *is*, which makes
 * it the part of this service most worth being able to test directly.
 */
function importFilter(card) {
  // Not a card object at all: tokens, emblems, art series, memorabilia.
  const layout = (card && card.layout) || "";
  if (["token", "double_faced_token", "emblem", "art_series", "memorabilia"].includes(layout)) {
    return "not-a-card";
  }

  const setType = (card && card.set_type) || "";
  if (["funny", "token", "memorabilia"].includes(setType)) return "funny-set";

  // Un-cards and the gold-bordered reprints, which are not legal objects in any real format.
  const borderColor = (card && card.border_color) || "";
  if (borderColor === "silver" || borderColor === "gold") return "not-black-bordered";

  if (card && card.digital) return "digital-only";

  /*
    Legal or restricted in one of the formats people actually play. `digital` catches most of what
    this adds and not all of it — a paper card rebalanced for Alchemy keeps its paper printing.
  */
  const leg = (card && card.legalities) || {};
  const playable = PLAYED_FORMATS.some((format) => {
    const status = leg[format];
    return status === "legal" || status === "restricted";
  });
  if (!playable) return "not-legal-anywhere-played";

  return true;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          // Keep a slice of the body: Scryfall returns a JSON error with a useful `details` field,
          // and even an HTML error page tells you whether a proxy answered instead of the origin.
          return reject(new Error(`GET ${url} failed with HTTP ${status}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`GET ${url} returned HTTP ${status} with a body that is not JSON: ${e.message}`));
        }
      });
    }).on('error', (err) => reject(new Error(`GET ${url} failed: ${err.message}`)));
  });
}

// Download compressed file and extract it
function downloadBulkFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    https.get(url, {
      headers: {
        'User-Agent': 'Grimore/1.0 (grimore@lgs.com)'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download bulk file: ${response.statusCode} ${response.statusMessage}`));
        return;
      }

      // Check if response is gzipped
      const contentEncoding = response.headers['content-encoding'];
      let decompressor = null;
      if (contentEncoding === 'gzip' || url.endsWith('.gz')) {
        decompressor = zlib.createGunzip();
      }

      response.on('error', reject);
      fileStream.on('error', reject);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      if (decompressor) {
        decompressor.on('error', reject);
        response.pipe(decompressor).pipe(fileStream);
      } else {
        response.pipe(fileStream);
      }
    }).on('error', reject);
  });
}

/**
 * The card upsert, one statement per dialect, hoisted out of the import loop so a test can execute
 * it against the real migrated schema. Nothing else in the loop is reachable without a ~500MB
 * download from Scryfall, which is how the two bugs below survived.
 *
 * Postgres: the column list used to carry `scryfall_id`, which `scryfall_cards` does not have and
 * never had — the rest of the codebase reads the Scryfall UUID as `sc.id` on Postgres and
 * `sc.scryfall_id` only on SQLite (see the `db.isPostgres ? "sc.id" : "sc.scryfall_id"` switches in
 * server.js). Every insert therefore raised `column "scryfall_id" of relation "scryfall_cards" does
 * not exist`, and the import loop's catch — labelled "Ignore parse errors" but wrapping the write
 * too — discarded it. The Postgres bulk sync has never written a row.
 *
 * The conflict clause also refreshed only six of the fourteen columns, so on a re-sync an oracle
 * text correction, a rarity change or a set rename could never land. It now refreshes everything
 * except the key.
 *
 * **And it wrote fourteen columns of a table that has twenty-eight.** Five of the missing ones
 * already existed in the baseline and were simply never filled — `color_identity`, `legalities`,
 * `keywords`, `card_faces`, `edhrec_rank` — and each is load-bearing somewhere:
 *
 *  * `color_identity` is what Commander legality is made of, and `colors` is **not** a substitute:
 *    a card with a black mana symbol in its text box and no black in its cost has black identity.
 *    Every colour-identity check in the product has been reading a column nobody wrote.
 *  * `legalities` is the ban list. `apps/api`'s recommender reads it, and with the column empty
 *    the check read "no legality recorded, allow it" — a card banned in Commander could be
 *    recommended into a Commander deck.
 *  * `keywords` is Scryfall's own parsed keyword list, which maps directly onto the engine's
 *    declared mechanics and is the cheapest way to ask "how much of this pool can we already
 *    script?".
 *  * `card_faces` is split / adventure / modal-DFC / transform, all of which the engine supports
 *    and none of which can be read off a single front face.
 *  * `edhrec_rank` is the order the deck-suggestions route asks for.
 *
 * The other six (`power`, `toughness`, `loyalty`, `layout`, `oracle_id`, `produced_mana`) had no
 * column at all and are added by migration 0015, which says why each one matters.
 *
 * SQLite is deliberately **not** widened. The live SQLite table is the card_name-keyed shape the
 * statement below describes, this container's `grimore.db` has no `scryfall_cards` table at all to
 * check against, and widening the one dialect I cannot verify is how the `scryfall_id` bug above
 * happened in the first place. Postgres is where the card data is going.
 */
const CARD_UPSERT_PG = `
  INSERT INTO scryfall_cards
    (id, name, card_name, set_code, set_name, collector_number, type_line, oracle_text,
     mana_cost, cmc, colors, price, image_uri, rarity,
     color_identity, legalities, keywords, card_faces, edhrec_rank, scryfall_uri, foil_price,
     power, toughness, loyalty, layout, oracle_id, produced_mana, last_updated)
  VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, CURRENT_TIMESTAMP)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, card_name = EXCLUDED.card_name, set_code = EXCLUDED.set_code,
    set_name = EXCLUDED.set_name, collector_number = EXCLUDED.collector_number,
    type_line = EXCLUDED.type_line, oracle_text = EXCLUDED.oracle_text,
    mana_cost = EXCLUDED.mana_cost, cmc = EXCLUDED.cmc, colors = EXCLUDED.colors,
    price = EXCLUDED.price, image_uri = EXCLUDED.image_uri, rarity = EXCLUDED.rarity,
    color_identity = EXCLUDED.color_identity, legalities = EXCLUDED.legalities,
    keywords = EXCLUDED.keywords, card_faces = EXCLUDED.card_faces,
    edhrec_rank = EXCLUDED.edhrec_rank, scryfall_uri = EXCLUDED.scryfall_uri,
    foil_price = EXCLUDED.foil_price,
    power = EXCLUDED.power, toughness = EXCLUDED.toughness, loyalty = EXCLUDED.loyalty,
    layout = EXCLUDED.layout, oracle_id = EXCLUDED.oracle_id,
    produced_mana = EXCLUDED.produced_mana,
    last_updated = CURRENT_TIMESTAMP`;

// The live SQLite table is card_name-keyed and has no id/name/set_code/image_uri columns.
const CARD_UPSERT_SQLITE = `
  INSERT OR REPLACE INTO scryfall_cards
    (card_name, scryfall_id, type_line, oracle_text, mana_cost, cmc, colors, price, rarity, last_updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

async function downloadAndImportScryfallBulk(force = false) {
  // Opt-in escape hatch for test environments. The oracle-cards dump is hundreds of megabytes and
  // this runs on every boot, so a CI job that boots the server would download it on every run --
  // and the boot tasks that follow this call would not start until it finished. Off unless the
  // variable is explicitly set, so no deployment can lose its card data by default.
  if (process.env.SKIP_SCRYFALL_BULK_SYNC === '1') {
    console.log('Scryfall bulk sync skipped (SKIP_SCRYFALL_BULK_SYNC=1).');
    return;
  }
  // Check if we already have cards and don't need a force reload
  if (!force) {
    const existing = await db.get("SELECT count(*) as count FROM scryfall_cards");
    if (existing && existing.count > 1000) {
      console.log(`Local Scryfall database already populated with ${existing.count} cards. Skipping initial sync.`);
      return;
    }
  }

  console.log("Starting Scryfall bulk data synchronization...");
  /*
    `SCRYFALL_BULK_FILE` imports from a file already on disk instead of downloading.

    Two reasons, and neither is only about tests. The import loop was unreachable without a
    hundreds-of-megabytes download from a host that an egress allowlist may not permit at all —
    which is how the `scryfall_id` bug lived in it for months, and why every field below this line
    had never been exercised against a real database. A file path makes the loop runnable.

    And it is the honest path for a machine that cannot reach api.scryfall.com: download
    `oracle_cards` anywhere, copy the JSON over, point this at it. The file is the same artifact
    the downloader would have produced, so nothing else in the loop behaves differently.

    The file is **not** deleted afterwards when it was supplied this way: it is the caller's file,
    not a temporary this function made.
  */
  const suppliedPath = process.env.SCRYFALL_BULK_FILE || null;
  const tempPath = suppliedPath ?? path.join(__dirname, 'scryfall-oracle-cards.json');

  try {
    if (suppliedPath !== null) {
      console.log(`Importing from a supplied bulk file, no download: ${suppliedPath}`);
    } else {
      // 1. Fetch metadata
      console.log("Retrieving Scryfall bulk metadata...");
      const metadata = await fetchJson('https://api.scryfall.com/bulk-data');
      const oracleCardsObj = (metadata.data || []).find(d => d.type === 'oracle_cards');

      if (!oracleCardsObj || !oracleCardsObj.download_uri) {
        throw new Error("Could not locate oracle_cards download_uri in Scryfall bulk data.");
      }

      console.log(`Oracle cards download size: ${(oracleCardsObj.size / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Downloading bulk file from: ${oracleCardsObj.download_uri}`);

      // 2. Download and decompress
      const startTime = Date.now();
      await downloadBulkFile(oracleCardsObj.download_uri, tempPath);
      console.log(`Download completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    }

    // 3. Read and parse bulk data using streaming readline to keep memory footprint under 30MB
    console.log("Importing card objects to database using streaming reader...");
    const insertStart = Date.now();
    if (!db.isPostgres) await db.run("BEGIN TRANSACTION");
    
    let cardCount = 0;
    // Write failures were being counted as parse failures and dropped. Track them separately so a
    // sync that cannot write a single row reports that instead of "Parsed 0 cards."
    let parseFailures = 0;
    let writeFailures = 0;
    /*
      Cards `insertCard` deliberately did not write: tokens, emblems, art series, memorabilia,
      silver and gold borders, digital-only printings, and anything legal in no format.
      **`cardCount` used to include every one of them**, because the loop incremented it whenever
      `insertCard` returned without throwing and a filtered card returns exactly like a written
      one. On the seven-card fixture that reads "Wrote 7 cards" over six rows; on the real bulk
      file the gap is every token in the dump.

      That is not only a wrong number. The guard below — the one that turns a sync that wrote
      nothing into a thrown error — tests `cardCount === 0`, and with filtered cards counted as
      written it could not fire: a run that filtered all 30,000 rows and wrote none would report
      30,000 written, 0 rejected, and raise nothing. The check that is supposed to catch a broken
      import was unable to fail. So the two outcomes are counted apart, and the tally prints both.
    */
    let filtered = 0;
    /** How many rows each refusal reason accounted for, so the tally can name them. */
    const filteredBy = new Map();
    const countFiltered = (reason) => {
      filtered++;
      const key = typeof reason === "string" ? reason : "unknown";
      filteredBy.set(key, (filteredBy.get(key) || 0) + 1);
    };
    let firstWriteError = null;
    try {
      const readline = require('readline');
      const fileStream = fs.createReadStream(tempPath, { encoding: 'utf8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      const insertCard = async (card) => {
        // Every refusal, and the reason for it, lives in `importFilter`: a pure function with its
        // own tests. This loop only carries the verdict through to the tally.
        const verdict = importFilter(card);
        if (verdict !== true) return verdict;

        const layout = card.layout || "";
        const name = card.name;
        const scryfallId = card.id || null;
        const type_line = card.type_line || "";
        const oracle_text = card.oracle_text || "";
        const mana_cost = card.mana_cost || "";
        const cmc = card.cmc !== undefined ? card.cmc : 0;
        const colors = JSON.stringify(card.colors || []);
        const rarity = card.rarity || "common";
        
        const set_code = (card.set || "unk").toLowerCase();
        const collector_number = card.collector_number || "1";
        const set_name = card.set_name || "";
        const image_uri = (card.image_uris && (card.image_uris.normal || card.image_uris.large || card.image_uris.small)) || (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris && card.card_faces[0].image_uris.normal) || "";
        
        // Leave price NULL when Scryfall has no USD price, so the single documented
        // COALESCE(..., 0.15) floor applies everywhere instead of a divergent 0.05 default.
        let price = null;
        if (card.prices) {
          const usd = parseFloat(card.prices.usd);
          const usdLow = parseFloat(card.prices.usd_low);
          if (usd) price = usd;
          if (usdLow && (price === null || usdLow < price)) price = usdLow;
        }

        /*
          The rules fields, which this loop has always had in hand and always thrown away.

          `layout` is already computed above, for the token/art-series filter. The rest come
          straight off the Scryfall object; the only judgement here is `card_faces`.

          **Faces are trimmed on the way in.** Scryfall's faces carry `image_uris`, `artist`,
          `illustration_id`, `flavor_text` and more, and a modal-DFC row with two full faces is
          several kilobytes of which the engine reads maybe a tenth. So each face keeps the eight
          fields that are rules: its name, cost, type line, oracle text, P/T, loyalty and colours,
          plus the one image a face needs to be drawn. Storing the whole blob would make the
          biggest column in the table the one nothing queries.
        */
        const color_identity = JSON.stringify(card.color_identity || []);
        const legalities = JSON.stringify(card.legalities || {});
        const keywords = JSON.stringify(card.keywords || []);
        const faces = Array.isArray(card.card_faces)
          ? card.card_faces.map((f) => ({
            name: f.name ?? '',
            mana_cost: f.mana_cost ?? '',
            type_line: f.type_line ?? '',
            oracle_text: f.oracle_text ?? '',
            power: f.power ?? null,
            toughness: f.toughness ?? null,
            loyalty: f.loyalty ?? null,
            colors: f.colors ?? [],
            image_uri: (f.image_uris && (f.image_uris.normal || f.image_uris.large || f.image_uris.small)) || null,
          }))
          : null;
        const card_faces = faces === null ? null : JSON.stringify(faces);
        const edhrec_rank = Number.isInteger(card.edhrec_rank) ? card.edhrec_rank : null;
        const scryfall_uri = card.scryfall_uri || null;
        // Power, toughness and loyalty stay strings: `*`, `1+*` and `X` are all printed values.
        const power = card.power ?? null;
        const toughness = card.toughness ?? null;
        const loyalty = card.loyalty ?? null;
        const oracle_id = card.oracle_id || null;
        const produced_mana = Array.isArray(card.produced_mana) ? JSON.stringify(card.produced_mana) : null;
        let foil_price = null;
        if (card.prices) {
          const foil = parseFloat(card.prices.usd_foil);
          if (foil) foil_price = foil;
        }

        if (db.isPostgres) {
          await db.run(CARD_UPSERT_PG,
            [scryfallId, name, set_code, set_name, collector_number, type_line, oracle_text, mana_cost, cmc, colors, price, image_uri, rarity,
             color_identity, legalities, keywords, card_faces, edhrec_rank, scryfall_uri, foil_price,
             power, toughness, loyalty, layout || null, oracle_id, produced_mana]
          );
        } else {
          // Write exactly the columns the LIVE SQLite scryfall_cards table has
          // (card_name-keyed schema — no id/name/set_code/image_uri). Verified against the
          // production grimore.db. `name` is the card's name, stored as card_name.
          await db.run(CARD_UPSERT_SQLITE,
            [name, scryfallId, type_line, oracle_text, mana_cost, cmc, colors, price, rarity]
          );
        }
        return true;
      };

      let currentObjectLines = [];
      let isAccumulating = false;

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 1. Check if the line is a complete card JSON object (minified format)
        if (trimmed.startsWith('{"') && (trimmed.endsWith('}') || trimmed.endsWith('},'))) {
          let jsonStr = trimmed;
          if (jsonStr.endsWith(',')) {
            jsonStr = jsonStr.slice(0, -1);
          }
          let parsed = null;
          try {
            parsed = JSON.parse(jsonStr);
          } catch (e) {
            parseFailures++;
          }
          if (parsed) {
            try {
              const verdict = await insertCard(parsed);
              if (verdict === true) cardCount++;
              else countFiltered(verdict);
            } catch (writeErr) {
              writeFailures++;
              if (!firstWriteError) firstWriteError = writeErr;
            }
          }
          continue;
        }

        // 2. Fallback to pretty-printed accumulator format
        if (trimmed === '{') {
          isAccumulating = true;
          currentObjectLines = [trimmed];
        } else if (isAccumulating) {
          currentObjectLines.push(line);
          if (trimmed === '}' || trimmed === '},') {
            isAccumulating = false;
            let jsonStr = currentObjectLines.join('\n').trim();
            if (jsonStr.endsWith(',')) {
              jsonStr = jsonStr.slice(0, -1);
            }
            let parsed = null;
            try {
              parsed = JSON.parse(jsonStr);
            } catch (e) {
              parseFailures++;
            }
            if (parsed) {
              try {
                const verdict = await insertCard(parsed);
                if (verdict === true) cardCount++;
                else countFiltered(verdict);
              } catch (writeErr) {
                writeFailures++;
                if (!firstWriteError) firstWriteError = writeErr;
              }
            }
          }
        }
      }

      if (!db.isPostgres) await db.run("COMMIT");
      console.log(
        `Import completed in ${((Date.now() - insertStart) / 1000).toFixed(2)}s. ` +
        `Wrote ${cardCount} cards (${filtered} filtered out, ${parseFailures} unparseable, ` +
        `${writeFailures} rejected by the database).`
      );
      /*
        And what was filtered, by reason, biggest first. A line nobody reads costs nothing; a line
        that would have said `not-legal-anywhere-played=30000` the first time the format list was
        wrong is worth the four it takes to print.
      */
      if (filtered > 0) {
        const byReason = [...filteredBy.entries()].sort((a, b) => b[1] - a[1]);
        console.log(`  filtered by reason: ${byReason.map(([why, n]) => `${why}=${n}`).join(", ")}`);
      }
      // A handful of rejects is bad data in the dump. Every row rejected is a broken statement or a
      // schema mismatch, and reporting that as a successful sync is what hid the missing column.
      if (writeFailures > 0 && cardCount === 0) {
        throw new Error(
          `Scryfall import wrote no rows: all ${writeFailures} inserts were rejected by the database. ` +
          `First error: ${firstWriteError && firstWriteError.message}`
        );
      }
      /*
        And a sync that wrote nothing at all, with nothing rejected, is still a broken sync — an
        empty file, a dump of nothing but tokens, a filter that got too wide. It used to be
        unreachable (see `filtered`); now it is the one case the counters can actually show.
      */
      if (cardCount === 0 && (filtered > 0 || parseFailures > 0)) {
        throw new Error(
          `Scryfall import wrote no rows: ${filtered} card(s) were filtered out and ` +
          `${parseFailures} could not be parsed, and nothing was left to write.`
        );
      }
      if (writeFailures > 0) {
        console.warn(`Scryfall import: ${writeFailures} rows rejected. First error:`, firstWriteError);
      }
    } catch (writeErr) {
      if (!db.isPostgres) {
        try {
          await db.run("ROLLBACK");
        } catch (rollbackErr) {}
      }
      throw writeErr;
    }

  } catch (err) {
    console.error("Scryfall bulk import failed:", err);
  } finally {
    // 5. Cleanup temp file — but never a file the caller supplied. Deleting somebody's own
    // download because an import read it would be a surprising thing for a sync to do.
    if (suppliedPath === null && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
        console.log("Temporary bulk data JSON file deleted.");
      } catch (cleanupErr) {
        console.warn("Failed to delete temp file:", cleanupErr.message);
      }
    }
  }
}

// Setup background sync intervals every 24 hours
function setupDailySync() {
  const INTERVAL_24H = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    console.log("Triggering scheduled 24-hour Scryfall bulk database update...");
    await downloadAndImportScryfallBulk(true);
  }, INTERVAL_24H);
}

module.exports = {
  downloadAndImportScryfallBulk,
  setupDailySync,
  // Exported for the schema test in apps/api — see the comment on CARD_UPSERT_PG.
  CARD_UPSERT_PG,
  CARD_UPSERT_SQLITE,
  // Exported so its failure paths can be exercised; they are the whole point of the function.
  fetchJson,
  // Exported for its own tests: the filter decides what the whole corpus is.
  importFilter,
  PLAYED_FORMATS
};
