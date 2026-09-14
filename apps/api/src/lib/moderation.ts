/**
 * Route-side wrapper over `@grimore/shared`'s word filter, so a call site is one line and every
 * slice rejects the same way. The matcher itself lives in the shared package (decisions log D7), so
 * `apps/web` can run the same rules to warn before a submit rather than after one. Nothing on the
 * web side calls it yet; the server check is the one that counts either way.
 *
 * The matched word is never put in the response. It is the user's own text coming back at them, and
 * echoing it turns a rejection into a slur the server rendered.
 */
import { firstProfaneField, isProfane } from '@grimore/shared';
import { ApiError } from './errors.js';

const reject = (label: string): never => {
  throw new ApiError(400, 'PROFANITY', `${label} contains language that is not allowed.`);
};

/** Reject if any field is profane, naming the field. Key by the user-facing label. */
export function rejectProfanity(fields: Record<string, string | null | undefined>): void {
  const label = firstProfaneField(fields);
  if (label) reject(label);
}

/** The same, for a repeated field — a deck's tag array, a list of per-card tags. */
export function rejectProfaneList(label: string, values: readonly (string | null | undefined)[]): void {
  if (values.some((value) => isProfane(value))) reject(label);
}
