-- Guest mode is removed (`POST /api/auth/guest` and the `handleGuestLogin` caller are both deleted,
-- and the always-false `is_guest` plumbing in apps/api is gone with them).
--
-- Deleting the route does not close the hole it opened. Legacy created a single SHARED `guest`
-- player whose password is the literal `guestpass123`, hashed and stored like any other. That
-- account answers the ordinary login form, so anyone who knows the string is signed in as it —
-- the guest route was never needed to reach it. On SQLite the row was created on first use; on
-- Postgres the INSERT omits `id` (TEXT NOT NULL, no default) and always failed, so a row exists
-- today only if it came across in the SQLite -> Postgres cutover dump. It may or may not be there;
-- this migration is written to be correct either way.
--
-- The row is NOT deleted. If it exists it may own decks, collection rows and league history, and a
-- delete would cascade that away. Login is disabled instead, by overwriting the hash with a value
-- that is not a bcrypt digest at all. bcryptjs `compare()` returns false for a malformed hash
-- rather than throwing (verified), and both login paths — legacy server.js and apps/api's
-- routes/auth.ts — go through `compare()`, so no password can ever match it again.
--
-- To undo: set a real bcrypt hash on this row. Nothing else here is destructive.
--
-- The WHERE clause is deliberately narrow. It matches the exact pair legacy wrote, so a genuine
-- player who happens to have registered the username "guest" keeps their account and password.
UPDATE players
   SET password_hash = 'disabled:guest-mode-removed-0012'
 WHERE username = 'guest'
   AND email = 'guest@grimore.local'
   AND password_hash <> 'disabled:guest-mode-removed-0012';
