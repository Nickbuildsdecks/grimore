import { z } from "zod";
import { Password, PlayerRole, PremiumStatus, StoreNickname, Username } from "./auth.js";
import { Id, IntBool, Timestamp } from "./common.js";

export const PROFILE_BIO_MAX = 500;
export const PROFILE_THEME_DEFAULT = "default";

/** Free-text profile fields: trimmed, length-capped, and "" normalized to null so the column stays clean. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

/**
 * A player's profile as served by GET /api/players/:playerId/profile.
 *
 * `profile_theme`, `featured_deck_id`, `discord_handle` and `moxfield_username` were read and written by
 * the legacy handlers but were missing from the baseline schema; migration 0006 adds them.
 *
 * `email` is deliberately absent: it is PII and is only merged in when the requester is the owner.
 */
export const PlayerProfile = z.object({
  id: Id,
  username: z.string(),
  store_nickname: z.string(),
  avatar_url: z.string().nullable().default(null),
  profile_commander: z.string().nullable().default(null),
  profile_bio: z.string().nullable().default(null),
  profile_theme: z.string().default(PROFILE_THEME_DEFAULT),
  featured_deck_id: Id.nullable().default(null),
  discord_handle: z.string().nullable().default(null),
  moxfield_username: z.string().nullable().default(null),
  is_admin: IntBool.default(false),
  role: PlayerRole.default("player"),
  premium_status: PremiumStatus.default("free"),
  created_at: Timestamp,
});
export type PlayerProfile = z.infer<typeof PlayerProfile>;

/** The owner's own view adds the fields only they may see. */
export const OwnPlayerProfile = PlayerProfile.extend({
  email: z.string().nullable().default(null),
});
export type OwnPlayerProfile = z.infer<typeof OwnPlayerProfile>;

/** One `player_stats` row, with the season name joined in when the row is tagged with a season. */
export const PlayerStats = z.object({
  player_id: Id,
  total_games: z.coerce.number().int().default(0),
  total_wins: z.coerce.number().int().default(0),
  total_kills: z.coerce.number().int().default(0),
  total_points: z.coerce.number().int().default(0),
  win_rate: z.coerce.number().default(0),
  season_id: Id.nullable().default(null),
  season_name: z.string().nullable().default(null),
});
export type PlayerStats = z.infer<typeof PlayerStats>;

/** A deck as it appears in the profile's public deck list. */
export const ProfileDeck = z.object({
  id: Id,
  deck_name: z.string(),
  cheapest_total_price: z.coerce.number().default(0),
  featured_card_name: z.string().nullable().default(null),
  is_public: IntBool.default(false),
  commander_name: z.string().nullable().default(null),
  commander_scryfall_id: z.string().nullable().default(null),
});
export type ProfileDeck = z.infer<typeof ProfileDeck>;

/** POST /api/players/profile/update — legacy body keys (camelCase) are kept so the existing UI still works. */
export const ProfileUpdateInput = z.object({
  storeNickname: StoreNickname,
  avatarUrl: optionalText(2048),
  profileCommander: optionalText(200),
  profileBio: optionalText(PROFILE_BIO_MAX),
  profileTheme: z.string().trim().max(40).optional().default(PROFILE_THEME_DEFAULT),
  featuredDeckId: Id.nullable().optional().transform((v) => v || null),
  discordHandle: optionalText(64),
  moxfieldUsername: optionalText(64),
});
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateInput>;

/**
 * POST /api/players/account/update — changing any credential requires the current password.
 *
 * Legacy required it only for a password change, so a hijacked session could silently take over the
 * account by swapping the username and email. At least one field must actually be changing.
 */
export const AccountUpdateInput = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newUsername: Username.optional(),
    newPassword: Password.optional(),
    newEmail: z.string().trim().email().max(254).optional(),
  })
  .refine((v) => Boolean(v.newUsername || v.newPassword || v.newEmail), {
    message: "At least one of newUsername, newPassword or newEmail must be provided",
  });
export type AccountUpdateInput = z.infer<typeof AccountUpdateInput>;

export const PlayerProfileResponse = z.object({
  profile: PlayerProfile.or(OwnPlayerProfile),
  stats: z.array(PlayerStats),
  publicDecks: z.array(ProfileDeck),
  featuredDeck: ProfileDeck.nullable().default(null),
  isOwner: z.boolean().default(false),
});
export type PlayerProfileResponse = z.infer<typeof PlayerProfileResponse>;
