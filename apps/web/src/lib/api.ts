/**
 * Legacy untyped helper, kept for the pages not yet moved onto `apiClient`.
 *
 * It now delegates to the typed client so every caller shares one error path: the previous
 * implementation did `String(data.error)` on the v2 envelope's error OBJECT, which renders as
 * "[object Object]" — the message users actually saw on any failure from apps/api.
 *
 * New code should import from `@/lib/apiClient` and `@/lib/queries` instead.
 */
import { apiUrl, cardImage as cardImageFn, http } from "./apiClient"

export { ApiError } from "./apiClient"

export const api = {
  get: <T>(path: string) => http.get<T>(apiUrl(path)),
  post: <T>(path: string, body?: unknown) => http.post<T>(apiUrl(path), body),
  put: <T>(path: string, body?: unknown) => http.put<T>(apiUrl(path), body),
  delete: <T>(path: string, body?: unknown) => http.delete<T>(apiUrl(path), body),
}

/* ── Domain types (matching the Express API) ─────────────────────────── */

export interface Deck {
  id: string
  deck_name: string
  player_id: string
  format?: string
  is_public?: number
  moxfield_url?: string | null
  commander_name?: string | null
  commander_scryfall_id?: string | null
  featured_scryfall_id?: string | null
  total_points?: number | null
  total_wins?: number | null
  total_matches?: number | null
  creator_name?: string
  tags?: string | null
  last_checked?: string
}

export interface CardResult {
  name: string
  scryfallId?: string
  type_line: string
  oracle_text: string
  mana_cost: string
  cmc: number
  colors: string[]
  rarity: string
  image_uri: string
  price?: number
  artist?: string
  artistFollowed?: boolean
  preferredArt?: boolean
  set_name?: string
}

export interface DeckCard {
  deck_id: string
  card_name: string
  cheapest_card_price: number | null
  quantity: number
  is_commander: number
  custom_tag: string | null
  scryfall_id: string | null
  type_line: string | null
  oracle_text: string | null
  colors: string | null
  cmc: number | null
  rarity: string | null
}

export interface Season {
  id: string
  season_name?: string
  name?: string
  is_active: number
  start_date?: string
  end_date?: string
  rules_win_points?: number
  rules_kill_points?: number
  rules_entry_points?: number
}

export interface Collection {
  id: string
  name: string
  theme?: string
  is_public?: number
  is_wishlist?: number
  total_cards: number
  total_value: number
}

export const cardImage = cardImageFn
