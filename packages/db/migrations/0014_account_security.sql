-- Account security: password recovery, email verification, a session epoch, and an audit trail.
--
-- The driving finding is that password recovery does not work at all: `password_resets` is created by
-- neither dialect of `db.js` and by no migration, so `POST /api/auth/forgot-password` raises into its
-- own catch and nobody can recover an account. See claude/account-system-design.md for the full set;
-- the schema decisions worth stating are here.

-- ---------------------------------------------------------------------------------------------------
-- Password reset
--
-- Keyed on `player_id`, NOT on username. The legacy table stored `player.username` and redeemed with
-- `UPDATE players SET password_hash = ? WHERE LOWER(username) = LOWER(?)`, and this app lets people
-- change their username — so a reset issued before a rename and redeemed after it matched either
-- nobody or, if someone had taken the freed username, a DIFFERENT person's account.
--
-- `token_hash`, never the token. The legacy row held the token as issued, so any read of the table —
-- a backup, a replica, a dump in a bucket — was a live credential for every pending reset. SHA-256
-- rather than bcrypt is deliberate: the token is 256 bits of CSPRNG output, so there is nothing to
-- brute-force, and a deterministic hash is what allows an indexed single-row lookup instead of a scan.
--
-- `consumed_at` rather than deleting the row on use, so "this token was already redeemed, at this time,
-- from this address" survives as an answer after an incident.
CREATE TABLE IF NOT EXISTS password_resets (
  id           BIGSERIAL PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  requested_ip TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);
-- Redemption looks a token up by hash and nothing else, so this is the hot path and it must be unique:
-- two rows sharing a hash would make "which one did they redeem" unanswerable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets (token_hash);
-- Invalidating every other outstanding token for an account on redemption, and throttling per account,
-- both scan by player.
CREATE INDEX IF NOT EXISTS idx_password_resets_player ON password_resets (player_id, created_at DESC);
-- The cleanup sweep deletes by age; a partial index keeps it off the live rows.
CREATE INDEX IF NOT EXISTS idx_password_resets_expiry ON password_resets (expires_at)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------------------------------
-- Email verification
--
-- Same token discipline. Separate table rather than a `kind` column on one: the lifetimes differ (30
-- minutes against 24 hours), the rate limits differ, and a bug in one flow should not be able to mint
-- a token the other accepts.
CREATE TABLE IF NOT EXISTS email_verifications (
  id          BIGSERIAL PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- The address being proven, captured at request time. A later email change must not retroactively
  -- verify the new address via a token issued for the old one.
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications (token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verifications_player ON email_verifications (player_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------------
-- Session epoch
--
-- Ending sessions the current request holds no handle on. `req.session.regenerate()` destroys and
-- reissues only the CALLER's session, so a session someone else holds survives the victim's password
-- change untouched — verified in apps/api/src/session-epoch.test.ts, against the comment in
-- players.ts that claimed otherwise.
--
-- Scanning the session store for a player's keys is store-specific and racy. An epoch is O(1) on a
-- column already being read: each session records the epoch it was issued under, and any request whose
-- session predates `sessions_valid_from` is rejected and destroyed.
--
-- Defaults to now() so existing sessions are not all invalidated by the migration itself; NULL would
-- have meant "compare against nothing" at every call site.
ALTER TABLE players ADD COLUMN IF NOT EXISTS sessions_valid_from TIMESTAMPTZ NOT NULL DEFAULT now();

-- When the address was proven, or NULL. Nullable rather than a boolean with a default: "never verified"
-- and "verified at some unknown time" are different facts, and a default of false would assert the
-- former about every account that predates this column.
ALTER TABLE players ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------------------------------
-- Audit trail
--
-- There is no record today of logins, failures, resets or credential changes, so after an incident
-- there is nothing to read.
--
-- `player_id` is nullable and deliberately NOT a foreign key: a failed login against a username that
-- does not exist is exactly the event worth keeping, and a deleted account's history should outlive
-- the row rather than cascade away with it.
CREATE TABLE IF NOT EXISTS account_events (
  id         BIGSERIAL PRIMARY KEY,
  event      TEXT NOT NULL,
  player_id  TEXT,
  -- The identifier as supplied, for failures where no player resolved. Never a password or a token.
  identifier TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_events_player ON account_events (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_events_recent ON account_events (created_at DESC);
-- Per-account throttling counts recent failures for one identifier, which is this exact shape.
CREATE INDEX IF NOT EXISTS idx_account_events_throttle ON account_events (event, identifier, created_at DESC);
