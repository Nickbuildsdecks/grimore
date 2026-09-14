import { z } from "zod";
import { Id, IntBool, Timestamp } from "./common.js";

export const SEASON_NAME_MAX = 80;
/** Commander pods seat 3-5; the pairing engine never builds anything outside that range. */
export const POD_MIN = 3;
export const POD_MAX = 5;

/** Mirrors `seasons`. budget_limit / banlist / max_rares are added by migration 0009. */
export const Season = z.object({
  id: Id,
  name: z.string(),
  points_entry: z.coerce.number().int().default(1),
  points_kill: z.coerce.number().int().default(1),
  points_win: z.coerce.number().int().default(2),
  points_draw: z.coerce.number().int().default(1),
  remainder_pref: z.string().default("3"),
  use_point_pairing: IntBool.default(true),
  checkin_enabled: IntBool.default(true),
  is_active: IntBool.default(false),
  schedule_mode: z.string().nullable().default(null),
  budget_limit: z.coerce.number().nullable().default(null),
  banlist: z
    .preprocess((v) => {
      if (typeof v === "string") {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return v ?? [];
    }, z.array(z.string()))
    .default([]),
  max_rares: z.coerce.number().int().default(-1),
  created_at: Timestamp,
});
export type Season = z.infer<typeof Season>;

const scoringRules = {
  points_entry: z.coerce.number().int().min(0).max(100),
  points_kill: z.coerce.number().int().min(0).max(100),
  points_win: z.coerce.number().int().min(0).max(100),
  points_draw: z.coerce.number().int().min(0).max(100),
  remainder_pref: z.enum(["3", "4", "5"]),
  use_point_pairing: z.boolean(),
  checkin_enabled: z.boolean(),
  budget_limit: z.coerce.number().min(0).nullable(),
  banlist: z.array(z.string().trim().min(1).max(200)).max(1000),
  /** -1 means "no cap". */
  max_rares: z.coerce.number().int().min(-1).max(100),
};

/** POST /api/seasons — creating a season makes it the active one. */
export const CreateSeasonInput = z
  .object({ name: z.string().trim().min(1).max(SEASON_NAME_MAX) })
  .extend(Object.fromEntries(Object.entries(scoringRules).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof scoringRules]: z.ZodOptional<(typeof scoringRules)[K]>;
  });
export type CreateSeasonInput = z.infer<typeof CreateSeasonInput>;

/** POST /api/seasons/rules — edits the active season. */
export const UpdateSeasonRulesInput = z
  .object({ name: z.string().trim().min(1).max(SEASON_NAME_MAX).optional() })
  .extend(Object.fromEntries(Object.entries(scoringRules).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof scoringRules]: z.ZodOptional<(typeof scoringRules)[K]>;
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });
export type UpdateSeasonRulesInput = z.infer<typeof UpdateSeasonRulesInput>;

/** One checked-in player, with the deck they registered. */
export const RosterEntry = z.object({
  player_id: Id,
  store_nickname: z.string(),
  username: z.string().nullable().default(null),
  deck_id: Id.nullable().default(null),
  deck_name: z.string().nullable().default(null),
  is_legal: IntBool.default(true),
  cheapest_total_price: z.coerce.number().default(0),
  checked_in: IntBool.default(true),
  checked_in_at: Timestamp,
});
export type RosterEntry = z.infer<typeof RosterEntry>;

export const CheckInInput = z.object({ deckId: Id.nullable().optional() });
export type CheckInInput = z.infer<typeof CheckInInput>;

export const AdminCheckInInput = z.object({ playerId: Id, deckId: Id.nullable().optional() });
export type AdminCheckInInput = z.infer<typeof AdminCheckInInput>;

/** A seat at a league pod table. Distinct from realtime `PodSeat`, which is a multiplayer lobby seat. */
export const LeagueSeat = z.object({
  pod_id: Id,
  player_id: Id,
  store_nickname: z.string(),
  deck_id: Id.nullable().default(null),
  deck_name: z.string().nullable().default(null),
  is_legal: IntBool.default(true),
  kills: z.coerce.number().int().default(0),
  placed_first: IntBool.default(false),
  placed_draw: IntBool.default(false),
  points_awarded: z.coerce.number().int().default(0),
});
export type LeagueSeat = z.infer<typeof LeagueSeat>;

export const LeaguePod = z.object({
  id: Id,
  season_id: Id,
  round_num: z.coerce.number().int().min(1),
  label: z.coerce.number().int().min(1),
  completed: IntBool.default(false),
  players: z.array(LeagueSeat).default([]),
});
export type LeaguePod = z.infer<typeof LeaguePod>;

export const GeneratePairingsInput = z.object({ roundNum: z.coerce.number().int().min(1).max(99) });
export type GeneratePairingsInput = z.infer<typeof GeneratePairingsInput>;

/**
 * POST /api/pairings/report/:podId. A pod has at most one winner and, if it was a draw, no winner —
 * enforced here so an impossible result cannot be stored at all.
 */
export const ReportPodInput = z.object({
  results: z
    .array(
      z.object({
        player_id: Id,
        kills: z.coerce.number().int().min(0).max(20).default(0),
        placed_first: z.coerce.boolean().default(false),
        placed_draw: z.coerce.boolean().default(false),
      }),
    )
    .min(POD_MIN)
    .max(POD_MAX)
    .refine((rows) => rows.filter((r) => r.placed_first).length <= 1, {
      message: "A pod can have at most one winner",
    })
    .refine((rows) => !(rows.some((r) => r.placed_first) && rows.some((r) => r.placed_draw)), {
      message: "A pod cannot have both a winner and a draw",
    })
    .refine((rows) => new Set(rows.map((r) => r.player_id)).size === rows.length, {
      message: "Each player may appear only once",
    }),
});
export type ReportPodInput = z.infer<typeof ReportPodInput>;

export const PlayerStanding = z.object({
  player_id: Id,
  store_nickname: z.string(),
  username: z.string().nullable().default(null),
  season_id: Id.nullable().default(null),
  total_points: z.coerce.number().int().default(0),
  total_kills: z.coerce.number().int().default(0),
  total_wins: z.coerce.number().int().default(0),
  /** `player_stats.total_games` — the column is named differently here than on `deck_stats`. */
  total_games: z.coerce.number().int().default(0),
  win_rate: z.coerce.number().default(0),
});
export type PlayerStanding = z.infer<typeof PlayerStanding>;

export const DeckStanding = z.object({
  deck_id: Id,
  deck_name: z.string(),
  store_nickname: z.string(),
  moxfield_url: z.string().nullable().default(null),
  cheapest_total_price: z.coerce.number().default(0),
  is_legal: IntBool.default(true),
  season_id: Id.nullable().default(null),
  total_points: z.coerce.number().int().default(0),
  total_kills: z.coerce.number().int().default(0),
  total_wins: z.coerce.number().int().default(0),
  total_matches: z.coerce.number().int().default(0),
  win_rate: z.coerce.number().default(0),
});
export type DeckStanding = z.infer<typeof DeckStanding>;
