import { z } from "zod";
import { Id, IntBool, Timestamp } from "./common.js";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Legacy lowercases usernames on register/login; we do the same. */
export const Username = z
  .string()
  .trim()
  .min(USERNAME_MIN)
  .max(USERNAME_MAX)
  .regex(USERNAME_REGEX, "Username may only contain letters, numbers and underscores")
  .transform((s) => s.toLowerCase());
export type Username = z.infer<typeof Username>;

export const Password = z.string().min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters long.`).max(PASSWORD_MAX);
export type Password = z.infer<typeof Password>;

export const StoreNickname = z.string().trim().min(1).max(40);

export const PremiumStatus = z.enum(["free", "premium", "lifetime", "trial", "canceled"]).catch("free");
export type PremiumStatus = z.infer<typeof PremiumStatus>;

export const PlayerRole = z.enum(["player", "scorekeeper", "judge", "admin"]).catch("player");
export type PlayerRole = z.infer<typeof PlayerRole>;

/** POST /api/auth/register — legacy body: { username, password, storeNickname, email } */
export const RegisterInput = z.object({
  username: Username,
  password: Password,
  storeNickname: StoreNickname,
  email: z.string().trim().email().max(254),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

/** POST /api/auth/login */
export const LoginInput = z.object({
  username: Username,
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginInput = z.infer<typeof LoginInput>;

/**
 * POST /api/auth/google — legacy accepts an ID-token `credential` (GIS One Tap)
 * or an OAuth `accessToken`; at least one is required. Client-supplied
 * email/googleId are never trusted.
 */
export const GoogleLoginInput = z
  .object({
    credential: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.credential || v.accessToken), {
    message: "credential or accessToken is required",
  });
export type GoogleLoginInput = z.infer<typeof GoogleLoginInput>;

/** POST /api/auth/forgot-password */
export const ForgotPasswordInput = z.object({
  usernameOrEmail: z.string().trim().min(1).max(254),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;

/** POST /api/auth/reset-password */
export const ResetPasswordInput = z.object({
  token: z.string().min(1).max(256),
  newPassword: Password,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>;

/**
 * Public-facing player. Mirrors the `players` table columns (snake_case) minus
 * secrets. Note: the legacy session object used camelCase (storeNickname,
 * isAdmin, avatarUrl, profileCommander); v2 standardizes on the DB column names.
 */
export const PublicPlayer = z.object({
  id: Id,
  username: z.string(),
  store_nickname: z.string(),
  avatar_url: z.string().nullable().default(null),
  profile_commander: z.string().nullable().default(null),
  profile_bio: z.string().nullable().default(null),
  is_admin: IntBool.default(false),
  role: PlayerRole.default("player"),
  premium_status: PremiumStatus.default("free"),
  created_at: Timestamp,
});
export type PublicPlayer = z.infer<typeof PublicPlayer>;

/** The authenticated player's own view — adds fields only the owner may see. */
export const MePlayer = PublicPlayer.extend({
  email: z.string().nullable().default(null),
  premium_until: Timestamp.nullable().default(null),
  is_guest: z.boolean().default(false),
});
export type MePlayer = z.infer<typeof MePlayer>;

/** GET /api/auth/status and GET /api/auth/me */
export const AuthStatus = z.discriminatedUnion("loggedIn", [
  z.object({
    loggedIn: z.literal(true),
    user: MePlayer,
    googleClientId: z.string().default(""),
  }),
  z.object({
    loggedIn: z.literal(false),
    googleClientId: z.string().default(""),
  }),
]);
export type AuthStatus = z.infer<typeof AuthStatus>;

export const LoginResponse = z.object({ success: z.literal(true), user: MePlayer });
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RegisterResponse = z.object({ success: z.literal(true), message: z.string() });
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const ForgotPasswordResponse = z.object({
  success: z.literal(true),
  message: z.string(),
  /** Only present outside production. */
  devResetLink: z.string().optional(),
});
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponse>;
