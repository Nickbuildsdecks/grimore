import { z } from "zod";

/**
 * Environment schema for Grimore v2 services (api, realtime, workers).
 *
 * Parsing is done from a plain string map (process.env by default) so the
 * same schema can be used in tests with a synthetic source.
 */

const nodeEnv = z.enum(["development", "test", "production"]).default("development");

const commaList = z
  .string()
  .default("")
  .transform((raw) =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const intFromString = (def: number, min = 0) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      const n = typeof v === "number" ? v : Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

/**
 * Every key any service reads. Kept as a plain object (rather than going straight into the refined
 * `envSchema`) so a service can `pick` the subset it actually uses — see `realtimeEnvSchema`.
 */
export const envBaseSchema = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: intFromString(3000, 1),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    SESSION_SECRET: z.string().min(1),
    SOCKET_ALLOWED_ORIGINS: commaList,
    // Google sign-in. With no GOOGLE_CLIENT_ID the route is served but refuses every credential,
    // because a token cannot be checked against an audience that was never configured.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    // Verified Google addresses that resolve to the `p_admin` account, exact match only. Legacy
    // hard-coded two personal addresses as the default; committing an identity-to-admin grant to
    // source is not something to carry forward, so this is configuration-only and empty by default.
    ADMIN_GOOGLE_EMAILS: commaList,
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_PRICE_ID: z.string().min(1).optional(),
    PREMIUM_GATING: z.enum(["on", "off"]).default("off"),
    FREE_DECK_LIMIT: intFromString(10, 0),
    // Mail. No provider is configured for this project, and the transport is chosen from these three
    // (see @grimore/mailer): SMTP_URL delivers, MAIL_TRANSPORT=console prints without the body, and
    // neither set fails closed. Deliberately not defaulted to a no-op -- reporting a send that did not
    // happen is how the broken recovery flow went unnoticed.
    SMTP_URL: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(1).optional(),
    MAIL_TRANSPORT: z.enum(["console"]).optional(),
    // The origin recovery and verification links are built against. Taken from configuration rather
    // than from the request's Host header, which an attacker controls: a poisoned Host turns a reset
    // mail into a link that sends the token to them.
    APP_BASE_URL: z.string().url().optional(),
    SENTRY_DSN: z.string().url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  ;

export const envSchema = envBaseSchema.superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV === "production" && cfg.SESSION_SECRET.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SESSION_SECRET"],
      message: "must be at least 32 characters in production",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * What `apps/realtime` actually needs: a port, Redis, the socket origin allow list, a log level, and
 * — optionally — the card table.
 *
 * It had been calling `parseEnv()`, the whole-platform schema, so it refused to boot without
 * `DATABASE_URL` and `SESSION_SECRET` — neither of which it read. That is worse than inconvenient:
 * a process that demands a database URL it never opens invites someone to put the production one
 * into its environment, and it makes "the table will not start" look like a database problem when
 * there is no database involved.
 *
 * **`DATABASE_URL` is now read, and is optional, and the difference matters.** D459 taught the
 * table to resolve a pasted decklist's names out of `scryfall_cards`, which is the only way a deck
 * of cards nobody hand-wrote can be played with the rules engine rather than by hand. So realtime
 * does open a database now — read-only, one `SELECT` over at most 151 names per pasted list.
 *
 * Optional because the original objection still stands for every other deployment of this process.
 * With no `DATABASE_URL` the table boots, deals the built-in decks, and treats every pasted name the
 * pool does not have exactly as it did before: cardboard, moved by hand. That is a worse table, not
 * a broken one, and it is what the 47 realtime tests run against — they need Redis and nothing else.
 * A service that refuses to start without a database it only reads card text from would be the same
 * mistake as before, pointing the other way.
 */
export const realtimeEnvSchema = envBaseSchema
  .pick({
    NODE_ENV: true,
    PORT: true,
    REDIS_URL: true,
    SOCKET_ALLOWED_ORIGINS: true,
    LOG_LEVEL: true,
  })
  .extend({ DATABASE_URL: z.string().url().optional() });

export type RealtimeEnv = z.infer<typeof realtimeEnvSchema>;

export class EnvError extends Error {
  constructor(
    message: string,
    public readonly missing: string[],
    public readonly invalid: string[],
  ) {
    super(message);
    this.name = "EnvError";
  }
}

/**
 * Parse and validate a config source. Empty-string values are treated as
 * unset so `FOO=` in a .env file behaves like a missing key.
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return parseWith(envSchema, source);
}

/** The narrow parse for `apps/realtime`. See `realtimeEnvSchema`. */
export function parseRealtimeEnv(source: Record<string, string | undefined> = process.env): RealtimeEnv {
  return parseWith(realtimeEnvSchema, source);
}

/** Shared parse-and-report, so every service reports a bad environment the same way. */
function parseWith<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;

  const missing: string[] = [];
  const invalid: string[] = [];
  const lines: string[] = [];
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "(root)";
    const isMissing =
      issue.code === z.ZodIssueCode.invalid_type && (issue as z.ZodInvalidTypeIssue).received === "undefined";
    if (isMissing) {
      missing.push(key);
      lines.push(`  - ${key}: missing`);
    } else {
      invalid.push(key);
      lines.push(`  - ${key}: ${issue.message}`);
    }
  }
  const summary = [
    "Invalid environment configuration:",
    ...lines,
    missing.length ? `Missing keys: ${missing.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  throw new EnvError(summary, missing, invalid);
}
