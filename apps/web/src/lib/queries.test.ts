import { describe, it, expect } from "vitest"
import { ApiError } from "./apiClient"
import { errorMessage, queryKeys, shouldRetry } from "./queries"

describe("query keys", () => {
  it("nest under their domain so one invalidation clears the whole group", () => {
    expect(queryKeys.decks.mine()).toEqual(["decks", "mine"])
    expect(queryKeys.decks.detail("d_1")).toEqual(["decks", "detail", "d_1"])
    // Every deck key starts with the domain prefix, which is what makes
    // invalidateQueries({ queryKey: queryKeys.decks.all }) reach all of them.
    for (const key of [queryKeys.decks.mine(), queryKeys.decks.detail("d_1"), queryKeys.decks.discover({})]) {
      expect(key[0]).toBe(queryKeys.decks.all[0])
    }
  })

  it("keys a discover query by its parameters", () => {
    expect(queryKeys.decks.discover({ sort: "likes", page: 2 })).not.toEqual(queryKeys.decks.discover({ sort: "likes" }))
  })
})

describe("retry policy", () => {
  it("never retries a 4xx: the server already answered", () => {
    expect(shouldRetry(0, new ApiError(401, "UNAUTHENTICATED", "Not logged in."))).toBe(false)
    expect(shouldRetry(0, new ApiError(404, "NOT_FOUND", "Deck not found."))).toBe(false)
    expect(shouldRetry(0, new ApiError(409, "CONFLICT", "Already friends."))).toBe(false)
  })

  it("retries a server error and a network failure, up to a limit", () => {
    expect(shouldRetry(0, new ApiError(500, "INTERNAL", "Internal server error"))).toBe(true)
    expect(shouldRetry(0, new ApiError(0, "NETWORK", "Could not reach Grimore."))).toBe(true)
    expect(shouldRetry(2, new ApiError(500, "INTERNAL", "Internal server error"))).toBe(false)
  })
})

describe("errorMessage", () => {
  it("prefers the server's message, then the Error message, then the fallback", () => {
    expect(errorMessage(new ApiError(409, "USERNAME_TAKEN", "Username is already taken."))).toBe("Username is already taken.")
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage({ weird: true }, "Could not import deck")).toBe("Could not import deck")
  })
})
