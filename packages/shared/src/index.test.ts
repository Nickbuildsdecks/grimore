import { describe, expect, it } from "vitest";
import {
  ACTION_MAX_BYTES,
  AddCollectionCardInput,
  ApiError,
  CAS_LUA,
  CHAT_MAX_BYTES,
  Card,
  CardSearchQuery,
  CreateDeckInput,
  Deck,
  DeckCard,
  EnvError,
  LoginInput,
  POD_CODE_REGEX,
  Pagination,
  PodActionInput,
  PodChatInput,
  PodCode,
  PodCreateInput,
  PodJoinInput,
  PodStateEvent,
  PublicPlayer,
  RegisterInput,
  STATE_MAX_BYTES,
  UpdateDeckInput,
  Username,
  apiError,
  casEvalArgs,
  parseEnv,
  playerPodKey,
  podKey,
  podSeatsKey,
  podStateKey,
} from "./index.js";

const baseEnv = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/grimore",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "short",
};

describe("env", () => {
  it("parses a minimal dev config with defaults", () => {
    const env = parseEnv(baseEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.PREMIUM_GATING).toBe("off");
    expect(env.FREE_DECK_LIMIT).toBe(10);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.SOCKET_ALLOWED_ORIGINS).toEqual([]);
  });

  it("throws a readable error listing missing keys", () => {
    expect(() => parseEnv({})).toThrow(EnvError);
    try {
      parseEnv({ SESSION_SECRET: "x" });
    } catch (e) {
      const err = e as EnvError;
      expect(err.missing).toEqual(expect.arrayContaining(["DATABASE_URL", "REDIS_URL"]));
      expect(err.message).toContain("DATABASE_URL: missing");
      expect(err.message).toContain("Missing keys:");
    }
  });

  it("treats empty strings as missing", () => {
    expect(() => parseEnv({ ...baseEnv, DATABASE_URL: "" })).toThrow(/DATABASE_URL: missing/);
  });

  it("requires a 32+ char SESSION_SECRET in production only", () => {
    expect(() => parseEnv({ ...baseEnv, NODE_ENV: "production" })).toThrow(/SESSION_SECRET.*32/);
    const ok = parseEnv({ ...baseEnv, NODE_ENV: "production", SESSION_SECRET: "a".repeat(32) });
    expect(ok.SESSION_SECRET).toHaveLength(32);
    expect(parseEnv({ ...baseEnv, NODE_ENV: "test" }).SESSION_SECRET).toBe("short");
  });

  it("splits SOCKET_ALLOWED_ORIGINS on commas and trims", () => {
    const env = parseEnv({ ...baseEnv, SOCKET_ALLOWED_ORIGINS: " https://a.com, https://b.com ,,http://localhost:5173 " });
    expect(env.SOCKET_ALLOWED_ORIGINS).toEqual(["https://a.com", "https://b.com", "http://localhost:5173"]);
  });

  it("coerces PORT / FREE_DECK_LIMIT and rejects bad values", () => {
    expect(parseEnv({ ...baseEnv, PORT: "8080", FREE_DECK_LIMIT: "3" })).toMatchObject({ PORT: 8080, FREE_DECK_LIMIT: 3 });
    expect(() => parseEnv({ ...baseEnv, PORT: "abc" })).toThrow(/PORT/);
    expect(() => parseEnv({ ...baseEnv, PREMIUM_GATING: "maybe" })).toThrow(/PREMIUM_GATING/);
  });
});

describe("auth contracts", () => {
  it("accepts valid usernames and lowercases them", () => {
    expect(Username.parse("Nick_01")).toBe("nick_01");
  });

  it("rejects usernames that are too short, too long, or have bad chars", () => {
    expect(Username.safeParse("ab").success).toBe(false);
    expect(Username.safeParse("a".repeat(25)).success).toBe(false);
    expect(Username.safeParse("nick-g").success).toBe(false);
    expect(Username.safeParse("nick g").success).toBe(false);
  });

  it("enforces password min 8 on register but not login", () => {
    const base = { username: "nick", storeNickname: "Nick", email: "nick@example.com" };
    expect(RegisterInput.safeParse({ ...base, password: "1234567" }).success).toBe(false);
    expect(RegisterInput.safeParse({ ...base, password: "12345678" }).success).toBe(true);
    expect(RegisterInput.safeParse({ ...base, password: "12345678", email: "nope" }).success).toBe(false);
    expect(LoginInput.safeParse({ username: "nick", password: "x" }).success).toBe(true);
  });

  it("normalizes a legacy players row into PublicPlayer", () => {
    const p = PublicPlayer.parse({
      id: "p_1",
      username: "nick",
      store_nickname: "Nick",
      is_admin: 1,
      premium_status: "weird",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(p.is_admin).toBe(true);
    expect(p.premium_status).toBe("free");
    expect(p.avatar_url).toBeNull();
    expect(p.role).toBe("player");
  });
});

describe("deck contracts", () => {
  it("validates CreateDeckInput with defaults", () => {
    const d = CreateDeckInput.parse({ deck_name: "Krenko", cards: [{ card_name: "Krenko, Mob Boss", is_commander: true }] });
    expect(d.format).toBe("commander");
    expect(d.is_public).toBe(true);
    expect(d.cards[0]?.quantity).toBe(1);
    expect(d.cards[0]?.board).toBe("main");
  });

  it("rejects empty deck names, bad formats and zero quantities", () => {
    expect(CreateDeckInput.safeParse({ deck_name: "" }).success).toBe(false);
    expect(CreateDeckInput.safeParse({ deck_name: "x", format: "chess" }).success).toBe(false);
    expect(CreateDeckInput.safeParse({ deck_name: "x", cards: [{ card_name: "a", quantity: 0 }] }).success).toBe(false);
  });

  it("UpdateDeckInput requires at least one field", () => {
    expect(UpdateDeckInput.safeParse({}).success).toBe(false);
    expect(UpdateDeckInput.safeParse({ is_public: false }).success).toBe(true);
  });

  it("parses legacy deck_cards rows (0/1 ints, JSON strings)", () => {
    const c = DeckCard.parse({
      deck_id: "abc",
      card_name: "Sol Ring",
      quantity: "1",
      is_commander: 0,
      image_uris: '{"normal":"https://img/x.jpg"}',
      cheapest_card_price: "0.15",
    });
    expect(c.is_commander).toBe(false);
    expect(c.image_uris?.normal).toBe("https://img/x.jpg");
    expect(c.cheapest_card_price).toBe(0.15);
  });

  it("parses a legacy deck row with custom_tags as JSON text", () => {
    const d = Deck.parse({
      id: "d1",
      player_id: "p1",
      deck_name: "Test",
      format: "commander",
      is_public: 1,
      custom_tags: '["ramp","draw"]',
    });
    expect(d.custom_tags).toEqual(["ramp", "draw"]);
    expect(d.stats.total_wins).toBe(0);
    expect(d.cards).toEqual([]);
  });
});

describe("cards / collections / common", () => {
  it("parses a scryfall-ish card and stringified JSON columns", () => {
    const c = Card.parse({
      id: "x",
      name: "Sol Ring",
      colors: "[]",
      color_identity: [],
      legalities: '{"commander":"legal"}',
      prices: { usd: "1.50", usd_foil: null },
    });
    expect(c.legalities.commander).toBe("legal");
    expect(c.prices?.usd).toBe("1.50");
  });

  it("CardSearchQuery applies legacy defaults (limit 60)", () => {
    const q = CardSearchQuery.parse({ q: "bolt", page: "2" });
    expect(q.limit).toBe(60);
    expect(q.page).toBe(2);
    expect(q.sort).toBe("relevance");
    expect(CardSearchQuery.safeParse({ q: "" }).success).toBe(false);
  });

  it("Pagination caps limit at 100", () => {
    expect(Pagination.safeParse({ limit: 101 }).success).toBe(false);
    expect(Pagination.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it("AddCollectionCardInput defaults condition/language", () => {
    const i = AddCollectionCardInput.parse({ card_name: "Sol Ring" });
    expect(i).toMatchObject({ quantity: 1, foil: false, condition: "NM", language: "EN" });
  });

  it("ApiError shape round-trips", () => {
    const e = apiError("not_found", "Deck not found");
    expect(ApiError.parse(e)).toEqual({ error: { code: "not_found", message: "Deck not found" } });
    expect(ApiError.safeParse({ error: { code: "nope", message: "x" } }).success).toBe(false);
  });
});

describe("realtime events", () => {
  it("pod code regex matches WORD-WORD-NN and normalizes case", () => {
    expect(POD_CODE_REGEX.test("BRAVE-OTTER-42")).toBe(true);
    expect(POD_CODE_REGEX.test("brave-otter-42")).toBe(false);
    expect(POD_CODE_REGEX.test("BRAVE-OTTER-4")).toBe(false);
    expect(POD_CODE_REGEX.test("BRAVE-42")).toBe(false);
    expect(PodCode.parse(" brave-otter-42 ")).toBe("BRAVE-OTTER-42");
    expect(PodJoinInput.safeParse({ code: "bad", name: "Nick" }).success).toBe(false);
  });

  it("caps chat at 500 bytes (multi-byte aware)", () => {
    expect(PodChatInput.safeParse({ text: "a".repeat(CHAT_MAX_BYTES) }).success).toBe(true);
    expect(PodChatInput.safeParse({ text: "a".repeat(CHAT_MAX_BYTES + 1) }).success).toBe(false);
    // 200 x 3-byte chars = 600 bytes but only 200 code units
    expect(PodChatInput.safeParse({ text: "€".repeat(200) }).success).toBe(false);
    expect(PodChatInput.safeParse({ text: "   " }).success).toBe(false);
  });

  it("caps action payload at 2KB and requires expectedVersion", () => {
    const small = { type: "pass", data: "x".repeat(100) };
    expect(PodActionInput.safeParse({ action: small, expectedVersion: 3 }).success).toBe(true);
    const big = { type: "pass", data: "x".repeat(ACTION_MAX_BYTES) };
    expect(PodActionInput.safeParse({ action: big, expectedVersion: 3 }).success).toBe(false);
    expect(PodActionInput.safeParse({ action: small }).success).toBe(false);
    expect(PodActionInput.safeParse({ action: small, expectedVersion: -1 }).success).toBe(false);
  });

  it("caps state at 64KB", () => {
    const pod = {
      code: "BRAVE-OTTER-42",
      name: "Pod",
      format: "commander",
      visibility: "public",
      status: "lobby",
      hostPlayerId: "p1",
      seats: [],
      createdAt: 1,
    };
    expect(PodStateEvent.safeParse({ pod, state: { life: 40 }, stateVersion: 1 }).success).toBe(true);
    expect(PodStateEvent.safeParse({ pod, state: { blob: "x".repeat(STATE_MAX_BYTES) }, stateVersion: 1 }).success).toBe(false);
  });

  it("pod:create applies defaults and length limits", () => {
    expect(PodCreateInput.parse({ name: "Friday" })).toEqual({ name: "Friday", format: "commander", visibility: "private" });
    expect(PodCreateInput.safeParse({ name: "x".repeat(33) }).success).toBe(false);
    expect(PodCreateInput.safeParse({ name: "ok", visibility: "hidden" }).success).toBe(false);
  });
});

describe("redis helpers", () => {
  it("builds namespaced keys", () => {
    expect(podKey("A-B-01")).toBe("grimore:pod:A-B-01");
    expect(podSeatsKey("A-B-01")).toBe("grimore:pod:A-B-01:seats");
    expect(podStateKey("A-B-01")).toBe("grimore:pod:A-B-01:state");
    expect(playerPodKey("p_1")).toBe("grimore:player:p_1:pod");
  });

  it("CAS_LUA is a non-empty script using redis.call with the documented args", () => {
    expect(typeof CAS_LUA).toBe("string");
    expect(CAS_LUA.length).toBeGreaterThan(0);
    expect(CAS_LUA).toContain("redis.call");
    for (const tok of ["KEYS[1]", "ARGV[1]", "ARGV[2]", "ARGV[3]", "ARGV[4]", "ARGV[5]", "'create'", "return -1", "return 0", "return 1"]) {
      expect(CAS_LUA).toContain(tok);
    }
  });

  it("casEvalArgs lays out EVAL arguments in order", () => {
    const args = casEvalArgs({ key: "k", expectedVersion: 2, newStateJson: "{}", newVersion: 3, ttlSeconds: 10, create: true });
    expect(args).toEqual([1, "k", "2", "{}", "3", "10", "create"]);
    expect(casEvalArgs({ key: "k", expectedVersion: 0, newStateJson: "{}", newVersion: 1 })[6]).toBe("");
  });
});
