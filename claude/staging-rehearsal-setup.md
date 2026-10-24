# Staging rehearsal — setup runbook

Everything here runs on the VM. I have no path there: no `.env`, no `VM_IP`/`VM_USER`, an empty
`~/.ssh`, and no `ssh`, `scp`, `gcloud` or PowerShell binary — checked, not assumed. The standing rule
is also unchanged: I do not touch the live VM or production data, and a read-only grant is not
permission to write.

## Read this first: the connection strings cannot reach me

You asked where to put them. The honest answer is that putting them anywhere will not give me access as
things stand, and I would rather say so than have you build a role and a dump for nothing.

Two independent blocks:

1. **`docker-compose.yml` gives postgres `expose: - "5432"`, not `ports:`.** `expose` publishes the port
   to other containers on the same Docker network and to nothing else — not to the VM's host interface,
   let alone the internet. There is no listener for anything outside that network to connect to.
2. **This environment's outbound access is a domain allowlist in front of HTTP(S).** Raw TCP to a
   database port is not what that policy is shaped for; a probe to port 53 on a public address was
   filtered.

Making a remote connection work would mean publishing your production database beyond the Docker
network and getting raw TCP egress allowed to it. **I am not going to recommend that.** A
production database on a public interface is a worse problem than the one it solves, and it would
undo the reason `expose` was used in the first place.

### What to do instead

**You run the read-only commands on the VM; only their output comes back to me.** Every script this
needs is now shipped in the deploy bundle (`scripts/` was never included before — that is fixed), and
all of it is read-only except one command that refuses to run against a database whose name does not
contain `staging`.

That gets me exactly the measured figures I want, with no credentials near this chat and no inbound
access to anything.

### If you do want the strings in the environment anyway

For completeness, and it is worth having for the staging copy later even if not for production: they go
in the environment's settings — the cloud environment menu in this session's title bar, then **Edit**.
Use the **API credentials** section if it is offered there, otherwise add them as environment variables.
The names I would read are:

- `STAGING_READONLY_URL` — the read-only role against production
- `STAGING_REHEARSAL_URL` — the throwaway staging copy

**A new session picks them up; this one will not.** And do not paste a connection string, password or
token into the chat — not here, not abbreviated. If a secret does reach the chat, treat it as disclosed
and rotate it.

---

## 1. The read-only Postgres role

Run as the owner. `grimore_user` owns the schema; the SQL below assumes you run it as that role, which
matters for the default-privileges step.

```bash
docker exec -it grimore-postgres psql -U grimore_user -d grimore_db
```

Then, choosing your own password — do not send it to me:

```sql
-- A login role with no inherited privileges beyond what is granted below.
CREATE ROLE grimore_readonly LOGIN PASSWORD 'choose-a-strong-one';

GRANT CONNECT ON DATABASE grimore_db TO grimore_readonly;
GRANT USAGE   ON SCHEMA   public     TO grimore_readonly;
GRANT SELECT  ON ALL TABLES IN SCHEMA public TO grimore_readonly;

-- Future tables. This is the clause people leave out, and then a table added next month is invisible.
-- `FOR ROLE` is load-bearing: default privileges attach to the role that CREATES the object, so without
-- naming grimore_user this only covers objects created by whoever ran this statement.
ALTER DEFAULT PRIVILEGES FOR ROLE grimore_user IN SCHEMA public
  GRANT SELECT ON TABLES TO grimore_readonly;

-- Explicit, though PostgreSQL 15+ already removes CREATE from PUBLIC on the public schema.
REVOKE CREATE ON SCHEMA public FROM grimore_readonly;
```

**Deliberately not granted:** `USAGE` on sequences. It looks harmless and reads like a read, but it
permits `nextval()`, which increments — a write. A SELECT-only role does not need it.

### Verify it is actually read-only

I tested this exact SQL locally against Postgres 16 before writing it down, including the negative case:
with the `ALTER DEFAULT PRIVILEGES` line, a table created afterwards was readable; with it revoked, the
same table was `permission denied`. So the clause does what the comment claims.

Verify on your side by attempting writes and watching them refused:

```bash
docker exec -i grimore-postgres psql -U grimore_readonly -d grimore_db <<'SQL'
SELECT count(*) FROM players;                      -- must SUCCEED
INSERT INTO players (id, username, store_nickname, email, password_hash)
  VALUES ('probe','probe','P','p@probe.test','x');  -- must be refused
UPDATE players SET store_nickname = 'x' WHERE id = 'nobody';
DELETE FROM players WHERE id = 'nobody';
CREATE TABLE readonly_probe (x integer);
TRUNCATE card_price_cache;
SQL
```

Expected: the SELECT returns a number, and the five writes come back
`permission denied for table players` / `permission denied for schema public` /
`permission denied for table card_price_cache`.

Or use the script, which does the same probes inside transactions it always rolls back, so even a role
that turns out to be writable leaves nothing behind:

```bash
docker exec -i grimore-app node scripts/staging-rehearsal.js guard \
  "postgres://grimore_readonly:PASSWORD@postgres:5432/grimore_db"
```

Look for `"writes_all_refused": true` and `"can_read": true`. I verified this reports a **writable**
role as `writes_all_refused: false` rather than passing it — a guard that cannot fail is not a guard.

---

## 2. The staging copy

```bash
cd ~/grimore

# Dump as the OWNER, not the read-only role. This matters: pg_dump only dumps what the dumping role can
# see, so a read-only role with an incomplete grant produces a dump that is quietly missing tables — and
# the rehearsal would then "pass" on data that is not all there.
docker exec grimore-postgres pg_dump -U grimore_user -d grimore_db -Fc -f /tmp/prod.dump
docker exec grimore-postgres ls -lh /tmp/prod.dump      # confirm it is not zero bytes

# A throwaway database in the same container.
docker exec grimore-postgres createdb -U grimore_user grimore_staging

# Restore. Do NOT pass --exit-on-error away; read the output.
docker exec grimore-postgres pg_restore -U grimore_user -d grimore_staging --no-owner /tmp/prod.dump
echo "pg_restore exit code: $?"
```

### What a dump-and-restore is and is not

It is **not** byte-identical to the original, and the ways it differs are the ways a rehearsal can
mislead you:

- **Objects the dumping role cannot see are silently absent.** This is why the dump is taken as
  `grimore_user` and not as the read-only role. Silence from `pg_dump` is not proof of completeness.
- **`pg_restore` loads data, then adds constraints and indexes.** If production holds rows that an
  existing constraint is not actually enforcing — an index built `CONCURRENTLY` that failed, a
  constraint left `NOT VALID` — the restore either errors on that object or skips it, and the staging
  copy then has a *stricter* shape than production. **Read `pg_restore`'s stderr and exit code.** A
  non-zero exit with "errors ignored on restore" is a finding, not noise.
- **Nothing outside the database comes across**: roles, grants, extensions installed at cluster level,
  the contents of the `postgres_data` volume beyond this database.
- **Physical layout, bloat, index statistics and `VACUUM` state all differ.** Timings measured on the
  copy are indicative, not predictive.
- **The copy is idle.** Nothing in it reproduces concurrent writes during the real migration.

**So the rehearsal will prove:** that 0002–0014 apply without error against production's real data
shapes and volumes; exactly how many rows 0013's dedupe deletes; and whether 0005 and 0009 preserve
`collections`, `collection_cards`, `player_stats` and `deck_stats` row for row.

**It will not prove:** how long the migration holds locks under live traffic; that nothing the dump
omitted exists; or that a concurrent write during the real migration is safe. For those, the mitigation
is the backup in step 2 of `claude/cutover-runbook.md`, not the rehearsal.

---

## 3. What I will run once the output exists

All of it read-only against production; the one writing command is scoped to the staging copy and
refuses anything else.

### Against the read-only role — replacing inferred figures with measured ones

```bash
docker exec -i grimore-app node scripts/audit-postgres-schema-gap.js \
  "postgres://grimore_readonly:PASSWORD@postgres:5432/grimore_db"
```

Every figure I have quoted about production so far — 9 missing tables, 12 missing columns, 5 surviving a
cutover — was measured against a database I *built to look like production* from
`0001_baseline.sql` + `initDb()`. This replaces all of them with the real thing. If production has
drifted from that reconstruction in any way, this is what says so.

```bash
docker exec -i grimore-app node scripts/staging-rehearsal.js predict \
  "postgres://grimore_readonly:PASSWORD@postgres:5432/grimore_db"
```

This is the number I most want and have never had: **how many rows migration 0013's dedupe will
actually delete.** It prints the current `card_price_cache` row count, how many names have duplicates,
the exact delete count, the resulting count, and the ten worst offenders. I have been describing that
dedupe as safe on the grounds that the table is a regenerable cache; this turns that from an argument
into a number.

### Against the staging copy — the full cutover

```bash
docker exec -i grimore-app node scripts/staging-rehearsal.js snapshot \
  "postgres://grimore_user:PASSWORD@postgres:5432/grimore_staging" > /tmp/before.json

# The only writing step, and only against the staging database.
docker run --rm --network grimore_default \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://grimore_user:PASSWORD@postgres:5432/grimore_staging" \
  -e REDIS_URL="redis://redis:6379" \
  -e SESSION_SECRET="rehearsal-only-at-least-32-characters-long" \
  -e APP_BASE_URL="https://rehearsal.invalid" \
  grimore-api:latest

docker exec -i grimore-app node scripts/staging-rehearsal.js snapshot \
  "postgres://grimore_user:PASSWORD@postgres:5432/grimore_staging" > /tmp/after.json

docker exec -i grimore-app node scripts/staging-rehearsal.js compare /tmp/before.json /tmp/after.json
```

`compare` prints a row-for-row verdict on the four tables 0005 and 0009 rewrite, then every table's
count before and after, then `PASS` or `FAIL`. Send me the output of `compare`, `predict` and the audit —
no connection strings.

I have already run this exact sequence locally against a database built to production's shape with data
in it: every watched row survived byte-identical, `collections.id` converted from integer to text with
values preserved, the foreign key held, and re-running the migrator applied 0 migrations. The staging
rehearsal is the same check against *your* data rather than my reconstruction of it.

---

## 4. What happens if the rehearsal is clean

Nothing automatic. The production migration stays two commands you run yourself, with your eyes on the
output, exactly as you said:

```bash
docker exec grimore-postgres pg_dump -U grimore_user grimore_db > grimore-$(date +%F-%H%M).sql
docker compose --profile v2 up -d api
```

The read-only role does not change that, and neither does a clean rehearsal. Full sequence, including
the rollback at each step and the three environment variables that gate recovery, is in
`claude/cutover-runbook.md`.

## Cleaning up afterwards

```bash
docker exec grimore-postgres dropdb -U grimore_user grimore_staging
docker exec grimore-postgres rm -f /tmp/prod.dump
```

Keep the read-only role — it is useful for every future audit, and it cannot write.
