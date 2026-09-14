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
  ActiveMatch,
  ArtVoteInput,
  AuthStatus,
  Card,
  CardPrinting,
  CardSwipeInput,
  Collection,
  CollectionCard,
  Deck,
  DeckCard,
  DeckStanding,
  DeckSummary,
  DeletedItem,
  DirectMessage,
  Friend,
  FriendRequest,
  FriendshipState,
  LoginInput,
  MePlayer,
  Notification,
  PageMeta,
  PlayerProfileResponse,
  PlayerStanding,
  RegisterInput,
  RosterEntry,
  Season,
  SeasonMeta,
  WishlistCard,
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
/** Extra methods for the rest of the ported surface. Grouped by the router that serves them. */
export const cards = {
  search: (params: { q: string; sort?: string; dir?: string; page?: number; limit?: number; format?: string; colors?: string }) =>
    http.get<{ cards: (Card & { scryfallId: string; price: number; image_uri: string })[]; totalCards: number; hasMore: boolean }>(
      apiUrl(`/api/cards/search${qs(params)}`),
    ),
  autocomplete: (q: string) =>
    http.get<{ name: string; card_name: string; scryfallId: string; type_line: string }[]>(
      apiUrl(`/api/cards/autocomplete${qs({ q })}`),
    ),
  details: (name: string) => http.get<Card & { price: number }>(apiUrl(`/api/cards/details${qs({ name })}`)),
  detailsBatch: (names: string[]) =>
    http.post<{ cards: (Card | null)[]; byName: Record<string, Card>; missing: string[] }>(
      apiUrl("/api/cards/details-batch"), { names },
    ),
  versions: (name: string) => http.get<CardPrinting[]>(apiUrl(`/api/cards/versions${qs({ name })}`)),
  swipe: (body: CardSwipeInput) => http.post<{ success: true }>(apiUrl("/api/cards/swipes"), body),
  voteArt: (scryfallId: string, body: ArtVoteInput) =>
    http.post<{ success: true; likes: number; dislikes: number }>(
      apiUrl(`/api/cards/versions/${encodeURIComponent(scryfallId)}/vote`), body,
    ),
}

export const decks = {
  cards: (deckId: string) => http.get<DeckCard[]>(apiUrl(`/api/decks/${encodeURIComponent(deckId)}/cards`)),
  addCard: (deckId: string, body: { name: string; scryfallId?: string | null; price?: number }) =>
    http.post<{ success: true; quantity: number }>(apiUrl(`/api/decks/${encodeURIComponent(deckId)}/cards`), body),
  social: (deckId: string) =>
    http.get<{ likes: number; hasLiked: boolean; comments: unknown[]; customTags: string[]; isOwner: boolean }>(
      apiUrl(`/api/decks/${encodeURIComponent(deckId)}/social`),
    ),
  like: (deckId: string) =>
    http.post<{ success: true; liked: boolean; likes_count: number }>(apiUrl(`/api/decks/${encodeURIComponent(deckId)}/like`)),
  comment: (deckId: string, commentText: string) =>
    http.post<{ success: true }>(apiUrl(`/api/decks/${encodeURIComponent(deckId)}/comment`), { commentText }),
  reloadCheapest: (deckId: string) =>
    http.post<{ success: true; totalPrice: number; isLegal: boolean; reason: string | null }>(
      apiUrl(`/api/decks/${encodeURIComponent(deckId)}/reload-cheapest`),
    ),
}

export const collections = {
  list: () => http.get<{ success: true; collections: Collection[] }>(apiUrl("/api/collections")),
  create: (body: { name: string; description?: string | null; is_public?: boolean }) =>
    http.post<{ success: true; collectionId: string }>(apiUrl("/api/collections"), body),
  cards: (id: string) =>
    http.get<{ success: true; cards: CollectionCard[] }>(apiUrl(`/api/collections/${encodeURIComponent(id)}/cards`)),
  // The v2 card routes address a printing by an explicit key object rather than loose body fields.
  addCard: (id: string, body: { card_name: string; scryfall_id?: string | null; quantity?: number; foil?: boolean; condition?: string; language?: string }) =>
    http.post<{ success: true }>(apiUrl(`/api/collections/${encodeURIComponent(id)}/cards`), body),
  updateCard: (id: string, key: CollectionCardKey, changes: Record<string, unknown>) =>
    http.put<{ success: true; removed: boolean }>(apiUrl(`/api/collections/${encodeURIComponent(id)}/cards`), { key, changes }),
  removeCard: (id: string, key: CollectionCardKey) =>
    http.delete<{ success: true }>(apiUrl(`/api/collections/${encodeURIComponent(id)}/cards`), key),
}

/** Identifies one printing/variant row inside a collection (mirrors the server contract). */
export interface CollectionCardKey {
  card_name: string
  scryfall_id?: string | null
  foil?: boolean
  condition?: string
  language?: string
}

export const players = {
  profile: (playerId: string) => http.get<PlayerProfileResponse>(apiUrl(`/api/players/${encodeURIComponent(playerId)}/profile`)),
  updateProfile: (body: Record<string, unknown>) =>
    http.post<{ success: true; profile: PlayerProfileResponse["profile"] }>(apiUrl("/api/players/profile/update"), body),
  // v2 requires the current password for ANY credential change, not just a password one.
  updateAccount: (body: { currentPassword: string; newUsername?: string; newEmail?: string; newPassword?: string }) =>
    http.post<{ success: true }>(apiUrl("/api/players/account/update"), body),
  activeMatch: () => http.get<ActiveMatch>(apiUrl("/api/players/active-match")),
  toggleFollow: (playerId: string) =>
    http.post<{ success: true; following: boolean }>(apiUrl(`/api/players/${encodeURIComponent(playerId)}/follow`)),
}

export const social = {
  friends: () => http.get<Friend[]>(apiUrl("/api/friends")),
  friendRequests: () => http.get<FriendRequest[]>(apiUrl("/api/friends/requests")),
  friendStatus: (playerId: string) => http.get<FriendshipState>(apiUrl(`/api/friends/status/${encodeURIComponent(playerId)}`)),
  inbox: () => http.get<DirectMessage[]>(apiUrl("/api/messages/inbox")),
  sent: () => http.get<DirectMessage[]>(apiUrl("/api/messages/sent")),
  unreadCount: () => http.get<{ count: number }>(apiUrl("/api/messages/unread-count")),
  sendMessage: (body: { recipientUsername: string; subject?: string; body: string }) =>
    http.post<{ success: true; messageId: string }>(apiUrl("/api/messages/send"), body),
  // v2 answers { items, unreadCount }; legacy returned a bare array.
  notifications: (params: { limit?: number; unreadOnly?: boolean } = {}) =>
    http.get<{ items: Notification[]; unreadCount: number }>(apiUrl(`/api/notifications${qs(params)}`)),
  markNotificationRead: (body: { id?: number; all?: boolean }) =>
    http.post<{ success: true; updated: number }>(apiUrl("/api/notifications/read"), body),
}

export const wishlist = {
  list: () => http.get<{ success: true; wishlist: WishlistCard[]; totalValue: number }>(apiUrl("/api/wishlist")),
  add: (body: { cardName: string; scryfallId?: string | null; quantity?: number }) =>
    http.post<{ success: true }>(apiUrl("/api/wishlist"), body),
  remove: (cardName: string) => http.delete<{ success: true }>(apiUrl(`/api/wishlist/${encodeURIComponent(cardName)}`)),
}

export const recovery = {
  list: () => http.get<{ success: true; items: DeletedItem[] }>(apiUrl("/api/recovery/deleted-items")),
  restore: (id: string) => http.post<{ success: true }>(apiUrl(`/api/recovery/restore/${encodeURIComponent(id)}`)),
  discard: (id: string) => http.delete<{ success: true }>(apiUrl(`/api/recovery/deleted-items/${encodeURIComponent(id)}`)),
}

export const league = {
  activeSeason: () => http.get<Season | null>(apiUrl("/api/seasons/active")),
  seasons: () => http.get<Season[]>(apiUrl("/api/seasons")),
  registerForSeason: (seasonId: string) =>
    http.post<{ success: true }>(apiUrl(`/api/seasons/${encodeURIComponent(seasonId)}/register`)),
  seasonMeta: (seasonId: string) => http.get<SeasonMeta>(apiUrl(`/api/seasons/${encodeURIComponent(seasonId)}/meta`)),
  rosterStatus: () => http.get<{ checkedIn: boolean; deckId: string | null }>(apiUrl("/api/roster/status")),
  rosterList: () => http.get<RosterEntry[]>(apiUrl("/api/roster/list")),
  checkIn: (deckId: string | null) => http.post<{ success: true }>(apiUrl("/api/roster/checkin"), { deckId }),
  checkOut: () => http.post<{ success: true }>(apiUrl("/api/roster/checkout")),
  standings: (seasonId?: string) => http.get<PlayerStanding[]>(apiUrl(`/api/leaderboards/season${qs({ seasonId })}`)),
  deckStandings: (seasonId?: string) => http.get<DeckStanding[]>(apiUrl(`/api/leaderboards/decks${qs({ seasonId })}`)),
  round: (roundNum: number, seasonId?: string) =>
    http.get<unknown[]>(apiUrl(`/api/pairings/round/${roundNum}${qs({ seasonId })}`)),
}

export const misc = {
  affiliates: () => http.get<{ tcgplayerAffiliateId: string }>(apiUrl("/api/config/affiliates")),
  followedArtists: () => http.get<{ name: string; key: string; followedAt: string }[]>(apiUrl("/api/artists/followed")),
  followArtist: (body: { artist: string; following: boolean; printing?: Record<string, unknown> }) =>
    http.post<{ success: true }>(apiUrl("/api/artists/follow"), body),
  recordPreference: (body: { eventType: string; entityType: string; entityKey: string; source?: string }) =>
    http.post<{ success: true }>(apiUrl("/api/preferences/events"), body),
  semanticSearch: (q: string) => http.get<Card[]>(apiUrl(`/api/search/semantic${qs({ q })}`)),
  movers: () => http.get<unknown[]>(apiUrl("/api/movers")),
}

export function buyLink(cardName: string): string {
  const target = `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(cardName)}`
  return `https://partner.tcgplayer.com/xJoE0d?u=${encodeURIComponent(target)}`
}
