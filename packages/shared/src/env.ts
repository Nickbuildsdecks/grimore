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

export const envSchema = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: intFromString(3000, 1),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    SESSION_SECRET: z.string().min(1),
    SOCKET_ALLOWED_ORIGINS: commaList,
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_PRICE_ID: z.string().min(1).optional(),
    PREMIUM_GATING: z.enum(["on", "off"]).default("off"),
    FREE_DECK_LIMIT: intFromString(10, 0),
    SENTRY_DSN: z.string().url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === "production" && cfg.SESSION_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SESSION_SECRET"],
        message: "must be at least 32 characters in production",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

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
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  const result = envSchema.safeParse(cleaned);
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
