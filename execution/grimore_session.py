#!/usr/bin/env python3
"""
A logged-in HTTP opener for the verification suites, and the reason one is needed.

## The gap this closes

`/api/sandbox/ai-advisor` refuses an anonymous caller with `401 {"error":"Not logged in."}`. Two
suites in the master orchestrator — `verify_youtube_replays.py` and `verify_a2ui_chat_and_tuner.py`
— POST to it with no session and then assert that the answer is non-empty, so **as written they
could never pass**. They were failing for a second reason too (the route was mounted above the
session middleware, so it answered nothing at all: see D354), and the two faults hid each other:
the suites reported a timeout, which looked like a slow endpoint rather than a check aimed at a
door it had no key to.

This module is the key. It registers a throwaway account if that account does not exist yet, logs
in, and hands back an opener carrying the session cookie.

## It fails loudly, which is the whole point

`verify_account_importer.py` has the shape this deliberately avoids:

    try:
        res = opener.open(login_request)
    except urllib.error.HTTPError:
        res = opener.open(register_request)   # registering does NOT log you in

`/api/auth/register` answers `{"success": true, "message": "Registration successful! You can now
log in."}` and sets no session — the login step is skipped, not retried. So on a database where
that account is missing, the suite carries on **anonymously** and every later assertion is about
a logged-out caller. Here, a failure at either step raises: a suite that cannot log in must say so
rather than quietly measure something else.

## The account

Deterministic rather than timestamped, so repeated runs reuse one row instead of filling the local
`players` table with one account per run. `Username already taken.` on the register step is
therefore the expected answer on every run after the first, and is accepted; any **other** 400 is
raised, because "the password policy refused this" must not read the same as "this account is
already here".

Local store only: the suites target `http://localhost:3000`, and CLAUDE.md's workflow says to
verify on the local server. Nothing here should ever be pointed at the VM.
"""
import json
import http.cookiejar
import urllib.error
import urllib.request

BASE_URL = "http://localhost:3000"

SUITE_USERNAME = "grimore_suite_bot"
# Passes `passwordPolicy.js`: 8+ characters, not in the blocked corpus, and contains neither the
# username nor the email local part (the policy refuses a password that contains either).
SUITE_PASSWORD = "Kessig-Wolf-Run-71"
SUITE_NICKNAME = "Suite Bot"
SUITE_EMAIL = "grimore.suite.bot@example.test"


def _post(opener, path, payload, timeout=10):
    """POSTs JSON, returning `(status, parsed_body)` and treating a 4xx as data rather than a throw."""
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with opener.open(request, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8")
        try:
            return err.code, json.loads(body)
        except json.JSONDecodeError:
            return err.code, {"error": body}


def logged_in_opener():
    """
    Returns an opener holding a logged-in session for the suite account.

    Raises `RuntimeError` if either step fails, so a suite can never proceed anonymously under the
    impression that it is authenticated.
    """
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    status, body = _post(opener, "/api/auth/register", {
        "username": SUITE_USERNAME,
        "password": SUITE_PASSWORD,
        "storeNickname": SUITE_NICKNAME,
        "email": SUITE_EMAIL,
    })
    taken = status == 400 and "already" in str(body.get("error", "")).lower()
    if status != 200 and not taken:
        raise RuntimeError(f"could not register the suite account: HTTP {status} {body}")

    status, body = _post(opener, "/api/auth/login", {
        "username": SUITE_USERNAME,
        "password": SUITE_PASSWORD,
    })
    if status != 200 or not body.get("success"):
        raise RuntimeError(f"could not log the suite account in: HTTP {status} {body}")

    return opener


def post_json(opener, path, payload, timeout=10):
    """`_post` under a name a suite can read, for calls made with the logged-in opener."""
    return _post(opener, path, payload, timeout=timeout)
