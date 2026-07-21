const BASE = ""

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : "{}" }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", body: body ? JSON.stringify(body) : undefined }),
}

/* ── Domain types (matching the Express API) ─────────────────────────── */

export interface Player {
  id: string
  username: string
  storeNickname: string
  isAdmin: boolean
  role: string
  avatarUrl: string
  profileCommander: string
}

export interface Deck {
  id: string
  deck_name: string
  player_id: string
  format?: string
  is_public?: number
  moxfield_url?: string | null
  commander_name?: string | null
  commander_scryfall_id?: string | null
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

export function cardImage(scryfallId?: string | null, size: "normal" | "small" = "normal") {
  if (!scryfallId) return ""
  return `https://cards.scryfall.io/${size}/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`
}
