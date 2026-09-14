import { describe, it, expect, vi, afterEach } from "vitest"
import {
  ApiError, apiClient, apiUrl, buyLink, cardImage, cards, collections, http, league, legacyUrl, players, social,
} from "./apiClient"

/** Minimal fetch stub: records the call and replies with the given status/body. */
function stubFetch(status: number, body: unknown, opts: { text?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => opts.text ?? (body === undefined ? "" : JSON.stringify(body)),
    } as Response
  })
  vi.stubGlobal("fetch", fn)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Runs a request expected to fail and returns the ApiError it threw. */
async function failing(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error("expected the request to reject")
}

describe("error envelopes", () => {
  it("reads the v2 envelope's message instead of stringifying the object", async () => {
    // The previous client did String(data.error) on this object, so users saw "[object Object]".
    stubFetch(401, { error: { code: "UNAUTHENTICATED", message: "Not logged in." } })
    const err = await failing(() => http.get("/api/auth/me"))
    expect(err.message).toBe("Not logged in.")
    expect(err.code).toBe("UNAUTHENTICATED")
    expect(err.status).toBe(401)
    expect(String(err.message)).not.toContain("object Object")
  })

  it("exposes Zod field errors from a VALIDATION response", async () => {
    stubFetch(400, {
      error: { code: "VALIDATION", message: "Invalid request", details: { username: ["Too short"] } },
    })
    const err = await failing(() => http.post("/api/auth/register", {}))
    expect(err.code).toBe("VALIDATION")
    expect(err.fieldErrors.username).toEqual(["Too short"])
  })

  it("still understands the legacy string envelope", async () => {
    stubFetch(404, { error: "User not found." })
    const err = await failing(() => http.get("/api/whatever"))
    expect(err.message).toBe("User not found.")
    expect(err.code).toBe("LEGACY")
  })

  it("falls back to a readable message when the body is not an envelope", async () => {
    stubFetch(500, undefined, { text: "<html>Bad Gateway</html>" })
    const err = await failing(() => http.get("/api/whatever"))
    expect(err.status).toBe(500)
    expect(err.message).toBe("Request failed (500)")
  })

  it("reports a network failure as status 0, not as an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    const err = await failing(() => http.get("/api/auth/status"))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(0)
    expect(err.code).toBe("NETWORK")
  })
})

describe("requests", () => {
  it("sends the session cookie and a JSON content type on writes", async () => {
    const calls = stubFetch(200, { success: true })
    await http.post("/api/auth/logout")
    expect(calls[0].init?.credentials).toBe("include")
    expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
  })

  it("omits a body and its content type on a plain GET", async () => {
    const calls = stubFetch(200, [])
    await http.get("/api/decks/my-decks")
    expect(calls[0].init?.body).toBeUndefined()
    expect(calls[0].init?.headers).toBeUndefined()
  })

  it("treats an empty body as a success, not a parse failure", async () => {
    stubFetch(204, undefined, { text: "" })
    await expect(http.delete("/api/decks/d_1")).resolves.toBeNull()
  })
})

describe("route targeting", () => {
  it("addresses apps/api for ported routes", async () => {
    const calls = stubFetch(200, [])
    await apiClient.decks.mine()
    expect(calls[0].url).toBe(apiUrl("/api/decks/my-decks"))
  })

  it("addresses the legacy server for routes that are not ported yet", async () => {
    const calls = stubFetch(200, { deckId: "d_1" })
    await apiClient.decks.importMoxfield("https://www.moxfield.com/decks/abc")
    // Moxfield import, password reset and Google sign-in still live in server.js.
    expect(calls[0].url).toBe(legacyUrl("/api/decks/register"))
    expect(calls[0].url).not.toBe(apiUrl("/api/decks/register"))
  })

  it("encodes ids into the path", async () => {
    const calls = stubFetch(200, { success: true })
    await apiClient.decks.remove("d_1/../admin")
    expect(calls[0].url).toBe(apiUrl("/api/decks/d_1%2F..%2Fadmin"))
  })

  it("drops empty query parameters rather than sending blanks", async () => {
    const calls = stubFetch(200, { items: [], meta: {} })
    await apiClient.decks.discover({ q: "", sort: "popular", page: 2 })
    expect(calls[0].url).toBe(apiUrl("/api/decks?sort=popular&page=2"))
  })
})

describe("link builders", () => {
  it("builds a Scryfall image path from the card id", () => {
    expect(cardImage("33333333-3333-4333-8333-333333333333")).toBe(
      "https://cards.scryfall.io/normal/front/3/3/33333333-3333-4333-8333-333333333333.jpg",
    )
    expect(cardImage("abcd1234-0000-4000-8000-000000000000", "small")).toContain("/small/front/a/b/")
    expect(cardImage(null)).toBe("")
    expect(cardImage("x")).toBe("")
  })

  it("attributes buy links to the affiliate id", () => {
    const link = buyLink("Sol Ring")
    expect(link.startsWith("https://partner.tcgplayer.com/xJoE0d?u=")).toBe(true)
    expect(decodeURIComponent(link.split("?u=")[1])).toContain("q=Sol%20Ring")
  })
})

describe("the ported surface", () => {
  it("reads the discover feed from GET /api/decks, not the legacy /api/decks/discover", async () => {
    const calls = stubFetch(200, { items: [], meta: {} })
    await apiClient.decks.discover({ sort: "popular" })
    // Legacy had a separate /api/decks/discover returning a bare array; v2 paginates from /api/decks.
    expect(calls[0].url).toBe(apiUrl("/api/decks?sort=popular"))
    expect(calls[0].url).not.toContain("/discover")
  })

  it("asks for notifications with a limit and reads the counted envelope", async () => {
    const calls = stubFetch(200, { items: [], unreadCount: 3 })
    const r = await social.notifications({ limit: 20 })
    expect(calls[0].url).toBe(apiUrl("/api/notifications?limit=20"))
    // v2 answers { items, unreadCount }; legacy returned a bare array and the client counted unread
    // itself, using a `read_status` column that does not exist on Postgres.
    expect(r.unreadCount).toBe(3)
  })

  it("marks one notification read by its integer id", async () => {
    const calls = stubFetch(200, { success: true, updated: 1 })
    await social.markNotificationRead({ id: 42 })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ id: 42 })
  })

  it("sends the current password on every credential change", async () => {
    const calls = stubFetch(200, { success: true })
    await players.updateAccount({ currentPassword: "hunter2", newEmail: "new@example.com" })
    const body = JSON.parse(String(calls[0].init?.body))
    // v2 requires it for ANY change: legacy let a hijacked session move the account to another email
    // with no re-authentication at all.
    expect(body.currentPassword).toBe("hunter2")
    expect(body.newEmail).toBe("new@example.com")
  })

  it("addresses a collection card by an explicit key object", async () => {
    const calls = stubFetch(200, { success: true, removed: false })
    await collections.updateCard("col_1", { card_name: "Sol Ring", foil: false }, { quantity: 3 })
    const body = JSON.parse(String(calls[0].init?.body))
    // Legacy sent loose top-level fields and overwrote every column, so an omitted field was reset.
    expect(body).toEqual({ key: { card_name: "Sol Ring", foil: false }, changes: { quantity: 3 } })
  })

  it("routes league and card reads at apps/api", async () => {
    const calls = stubFetch(200, [])
    await league.standings("season_1")
    await cards.versions("Sol Ring")
    expect(calls[0].url).toBe(apiUrl("/api/leaderboards/season?seasonId=season_1"))
    expect(calls[1].url).toBe(apiUrl("/api/cards/versions?name=Sol+Ring"))
  })
})
