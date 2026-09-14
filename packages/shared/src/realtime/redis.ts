/**
 * Redis key helpers and the compare-and-set Lua script used by the realtime
 * gateway to advance pod game state without lost updates.
 */

export const REDIS_PREFIX = "grimore";

/** Hash: pod metadata (name, format, visibility, status, host, createdAt). */
export const podKey = (code: string): string => `${REDIS_PREFIX}:pod:${code}`;

/** Hash: seat index -> JSON seat record. */
export const podSeatsKey = (code: string): string => `${REDIS_PREFIX}:pod:${code}:seats`;

/** Hash with fields `state` (JSON) and `version` (int). Target of CAS_LUA. */
export const podStateKey = (code: string): string => `${REDIS_PREFIX}:pod:${code}:state`;

/** String: the pod code a player is currently seated in. */
export const playerPodKey = (playerId: string): string => `${REDIS_PREFIX}:player:${playerId}:pod`;

/** Set: codes of public pods currently in lobby (for pod:list). */
export const publicPodsKey = (): string => `${REDIS_PREFIX}:pods:public`;

/** String: seatToken -> "code:seat" for reconnects. */
export const seatTokenKey = (token: string): string => `${REDIS_PREFIX}:seat-token:${token}`;

export const POD_TTL_SECONDS = 60 * 60 * 6;

export const CAS_RESULT = {
  OK: 1,
  VERSION_MISMATCH: 0,
  MISSING: -1,
} as const;
export type CasResult = (typeof CAS_RESULT)[keyof typeof CAS_RESULT];

/**
 * Compare-and-set on a pod state hash.
 *
 *   KEYS[1] = state key (podStateKey)
 *   ARGV[1] = expectedVersion
 *   ARGV[2] = newStateJson
 *   ARGV[3] = newVersion
 *   ARGV[4] = ttlSeconds (0 or empty = no expiry change)
 *   ARGV[5] = 'create' to allow writing when the key is missing (optional)
 *
 * Returns 1 on success, 0 on version mismatch, -1 if the key is missing and
 * creation was not requested.
 */
export const CAS_LUA = `
local key = KEYS[1]
local expected = tonumber(ARGV[1])
local newState = ARGV[2]
local newVersion = ARGV[3]
local ttl = tonumber(ARGV[4]) or 0
local mode = ARGV[5]

local current = redis.call('HGET', key, 'version')
if not current then
  if mode ~= 'create' then
    return -1
  end
else
  if tonumber(current) ~= expected then
    return 0
  end
end

redis.call('HSET', key, 'state', newState, 'version', newVersion)
if ttl > 0 then
  redis.call('EXPIRE', key, ttl)
end
return 1
`.trim();

export interface CasArgs {
  key: string;
  expectedVersion: number;
  newStateJson: string;
  newVersion: number;
  ttlSeconds?: number;
  create?: boolean;
}

/** Builds the [numKeys, ...keys, ...argv] tuple for EVAL / EVALSHA. */
export function casEvalArgs(args: CasArgs): [number, string, string, string, string, string, string] {
  return [
    1,
    args.key,
    String(args.expectedVersion),
    args.newStateJson,
    String(args.newVersion),
    String(args.ttlSeconds ?? POD_TTL_SECONDS),
    args.create ? "create" : "",
  ];
}
