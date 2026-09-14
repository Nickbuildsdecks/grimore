/**
 * Typed client for the v2 API (`apps/api`).
 *
 * Response and input types come from `@grimore/shared` — the same Zod contracts the API validates
 * against — so a route and its caller cannot drift apart without a typecheck failure.
 *
 * ## Two bases, because this is a strangler migration
 *
 * `apiUrl()` addresses `apps/api`; `legacyUrl()` addresses the original `server.js`. Routes that have
 * not been ported yet (Moxfield import, password reset, Google sign-in) still have to reach the legacy
 * server, and marking those call sites explicitly is what keeps the remaining work visible. Both default
 * to the empty string, i.e. same-origin, which is how the deployed app runs behind one reverse proxy.
 *
 * In development they are separate servers, so set:
 *   VITE_API_URL=http://localhost:4000     (apps/api)
 *   VITE_LEGACY_API_URL=http://localhost:3000  (server.js)
 * or rely on the Vite dev proxy, which already routes /api to apps/api and /legacy-api to server.js.
 */
import type {
  AuthStatus,
  Deck,
  DeckSummary,
  LoginInput,
  MePlayer,
  PageMeta,
  RegisterInput,
} from "@grimore/shared"

const API_BASE: string = import.meta.env.VITE_API_URL ?? ""
const LEGACY_BASE: string = import.meta.env.VITE_LEGACY_API_URL ?? ""

export const apiUrl = (path: string): string => API_BASE + path
/** Explicitly reaches the un-ported legacy server. Every call site is a remaining migration task. */
export const legacyUrl = (path: string): string => (LEGACY_BASE ? LEGACY_BASE + path : `/legacy-api${path}`)

/**
 * The v2 error envelope is `{ error: { code, message, details? } }`.
 *
 * The previous client did `String(data.error)` on that object, which yields "[object Object]" — so every
 * failure from apps/api surfaced to the user as a toast reading "[object Object]". The legacy server's
 * shape is `{ error: "some string" }`, and both are handled here.
 */
export class ApiError extends Error {
  // Declared as fields rather than constructor parameter properties: tsconfig sets
  // `erasableSyntaxOnly`, so the parameter-property shorthand is not available here.
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.details = details
  }

  /** Field errors from a Zod `VALIDATION` response, when the server sent them. */
  get fieldErrors(): Record<string, string[]> {
    return this.details && typeof this.details === "object" ? (this.details as Record<string, string[]>) : {}
  }
}

function errorFrom(status: number, data: unknown): ApiError {
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error: unknown }).error
    if (typeof err === "string") return new ApiError(status, "LEGACY", err)
    if (err && typeof err === "object") {
      const { code, message, details } = err as { code?: string; message?: string; details?: unknown }
      return new ApiError(status, code ?? "UNKNOWN", message ?? `Request failed (${status})`, details)
    }
  }
  return new ApiError(status, "UNKNOWN", `Request failed (${status})`)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      credentials: "include", // session cookie
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
    })
  } catch {
    // A network failure is not an HTTP status; surfacing it as one would be a lie.
    throw new ApiError(0, "NETWORK", "Could not reach Grimore. Check your connection and try again.")
  }

  // 204 and an empty body are both legitimate successes.
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) throw errorFrom(res.status, data)
  return data as T
}

const json = (body: unknown) => (body === undefined ? undefined : JSON.stringify(body))

/** Low-level verbs. Prefer the typed groups below; these exist for routes with no contract yet. */
export const http = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) => request<T>(url, { method: "POST", body: json(body ?? {}) }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: "PUT", body: json(body ?? {}) }),
  delete: <T>(url: string, body?: unknown) => request<T>(url, { method: "DELETE", body: json(body) }),
}

/** `GET /api/decks` and other list routes answer `{ items, meta }`. */
export interface Paginated<T> {
  items: T[]
  meta: PageMeta
}

export interface DiscoverParams {
  q?: string
  format?: string
  sort?: "newest" | "popular" | "likes"
  page?: number
  limit?: number
}

function qs(params: Record<string, string | number | undefined | boolean>): string {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v))
  }
  const s = search.toString()
  return s ? `?${s}` : ""
}

export const apiClient = {
  auth: {
    status: () => http.get<AuthStatus>(apiUrl("/api/auth/status")),
    me: () => http.get<MePlayer>(apiUrl("/api/auth/me")),
    login: (body: LoginInput) => http.post<{ success: true; user: MePlayer }>(apiUrl("/api/auth/login"), body),
    register: (body: RegisterInput) => http.post<{ success: true; message: string }>(apiUrl("/api/auth/register"), body),
    logout: () => http.post<{ success: true }>(apiUrl("/api/auth/logout")),
    /** Not ported to apps/api yet — still served by server.js. */
    forgotPassword: (usernameOrEmail: string) =>
      http.post<{ message?: string }>(legacyUrl("/api/auth/forgot-password"), { usernameOrEmail }),
    /** Not ported to apps/api yet — still served by server.js. */
    resetPassword: (token: string, newPassword: string) =>
      http.post<{ success: boolean }>(legacyUrl("/api/auth/reset-password"), { token, newPassword }),
  },

  decks: {
    mine: () => http.get<DeckSummary[]>(apiUrl("/api/decks/my-decks")),
    discover: (params: DiscoverParams = {}) => http.get<Paginated<DeckSummary>>(apiUrl(`/api/decks${qs({ ...params })}`)),
    byId: (deckId: string) => http.get<Deck>(apiUrl(`/api/decks/${encodeURIComponent(deckId)}`)),
    remove: (deckId: string) => http.delete<{ success: true }>(apiUrl(`/api/decks/${encodeURIComponent(deckId)}`)),
    clone: (deckId: string) =>
      http.post<{ success: true; newDeckId: string }>(apiUrl(`/api/decks/${encodeURIComponent(deckId)}/clone`)),
    /** Moxfield import is not ported to apps/api yet — still served by server.js. */
    importMoxfield: (moxfieldUrl: string) =>
      http.post<{ deckId: string }>(legacyUrl("/api/decks/register"), { moxfieldUrl }),
  },
}

/** Scryfall's content-addressed image path, rebuilt from a card id. */
export function cardImage(scryfallId?: string | null, size: "normal" | "small" = "normal"): string {
  if (!scryfallId || scryfallId.length < 2) return ""
  return `https://cards.scryfall.io/${size}/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`
}

/** Affiliate-attributed TCGplayer link (affiliate id xJoE0d). */
export function buyLink(cardName: string): string {
  const target = `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(cardName)}`
  return `https://partner.tcgplayer.com/xJoE0d?u=${encodeURIComponent(target)}`
}
