import { describe, it, expect } from 'vitest';
import { passwordPolicyError, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from './passwordPolicy.js';

const ok = (p: unknown, ctx?: { username?: string; email?: string }) => passwordPolicyError(p, ctx) === null;

describe('password policy', () => {
  it('accepts a long passphrase with spaces', () => {
    // 800-63B requires accepting all printing characters, spaces included. A policy that strips or
    // rejects them is the one that pushes people to `Password1!`.
    expect(ok('correct horse battery staple')).toBe(true);
  });

  it('accepts unicode and does not double-count astral characters against the length', () => {
    // Astral (surrogate-pair) characters, not emoji: the repo's no-emoji rule covers source as well as
    // UI, and mathematical script letters exercise the same UTF-16 arithmetic.
    const astral = '𝐀𝐁𝐂';
    expect(ok(`paß${astral}word-ünïcode`)).toBe(true);
    // Seven code points, fourteen UTF-16 units. Counting units would pass this; counting code points
    // refuses it, and the person is owed the stricter reading of "eight characters".
    expect(ok('𝐀𝐁𝐂𝐃𝐄𝐅𝐆')).toBe(false);
  });

  it('enforces the minimum length', () => {
    expect(passwordPolicyError('short')).toMatch(/at least 8/);
    expect(ok('a'.repeat(PASSWORD_MIN_LENGTH - 1) + 'b')).toBe(true);
  });

  it('refuses whitespace padded out to the minimum', () => {
    expect(passwordPolicyError('        ')).toMatch(/at least 8/);
    expect(passwordPolicyError('  ab    ')).toMatch(/at least 8/);
  });

  it('caps the length well clear of bcrypt truncating at 72 bytes', () => {
    // Not a repeated character: `'x'.repeat(n)` trips the repeated-character rule first, which would
    // make this assert the wrong thing.
    const long = 'quiet-library-morning-'.repeat(20).slice(0, PASSWORD_MAX_LENGTH);
    expect(long).toHaveLength(PASSWORD_MAX_LENGTH);
    expect(ok(long)).toBe(true);
    expect(passwordPolicyError(long + 'x')).toMatch(/at most/);
    // An unbounded field is an unauthenticated CPU sink on register, since bcrypt hashes whatever it
    // is handed.
    expect(PASSWORD_MAX_LENGTH).toBeLessThanOrEqual(256);
  });

  it('rejects what the old length-only policy accepted', () => {
    // Every one of these passed `length >= 8`, which was the entire previous policy.
    for (const p of ['password', 'PASSWORD', 'Password', '12345678', 'qwertyui', 'iloveyou', 'letmein1']) {
      expect(passwordPolicyError(p), p).toMatch(/commonly used|sequence|repeated/);
    }
  });

  it('blocks this app\'s own vocabulary and the retired guest password', () => {
    expect(ok('grimore')).toBe(false);
    expect(ok('grimoire')).toBe(false);
    expect(ok('commander')).toBe(false);
    // The shared guest account's password, retired in migration 0012. Nobody should be able to set it.
    expect(ok('guestpass123')).toBe(false);
  });

  it('rejects a single repeated character', () => {
    expect(passwordPolicyError('aaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordPolicyError('999999999999')).toMatch(/repeated|commonly used/);
  });

  it('rejects straight runs in either direction', () => {
    expect(passwordPolicyError('abcdefgh')).toMatch(/sequence/);
    expect(passwordPolicyError('hgfedcba')).toMatch(/sequence/);
    expect(passwordPolicyError('87654321')).toMatch(/sequence/);
    // Not a run: one step out of line is enough, because the rule is about predictability, not
    // resemblance.
    expect(ok('abcdefgi')).toBe(true);
  });

  it('rejects a password containing the username', () => {
    expect(passwordPolicyError('nickbuildsdecks99', { username: 'nickbuildsdecks' })).toMatch(/username/);
    expect(passwordPolicyError('xxNICKBUILDSxx', { username: 'nickbuilds' })).toMatch(/username/);
    expect(ok('an-unrelated-passphrase', { username: 'nickbuildsdecks' })).toBe(true);
  });

  it('rejects a password containing the email local part, and ignores the domain', () => {
    expect(passwordPolicyError('gothard-secret', { email: 'gothard@example.com' })).toMatch(/email/);
    // The domain is shared by everyone on it, so matching on it would refuse good passwords for no gain.
    expect(ok('example.com-is-my-host', { email: 'gothard@example.com' })).toBe(true);
  });

  it('ignores a username or email too short to be meaningful', () => {
    // A two-character username appears inside almost every passphrase; refusing on it would reject
    // most good passwords.
    expect(ok('a-perfectly-fine-passphrase', { username: 'ab' })).toBe(true);
    expect(ok('a-perfectly-fine-passphrase', { email: 'ab@example.com' })).toBe(true);
  });

  it('handles a missing or non-string password without throwing', () => {
    for (const v of [undefined, null, 12345678, {}, [], true]) {
      expect(passwordPolicyError(v as unknown)).toMatch(/required/);
    }
    expect(passwordPolicyError('')).toMatch(/required/);
  });

  it('never quotes the attempt back in the message', () => {
    // A rejection that repeats what was typed puts it into logs, screenshots and error trackers.
    //
    // Tested with distinctive attempts. Asserting that the message for `password` does not contain the
    // substring "password" only tests the English of the message, since the word appears in it for
    // ordinary reasons -- a check that fails for the wrong reason is not a check.
    expect(passwordPolicyError('abcdefgh')).not.toContain('abcdefgh');
    expect(passwordPolicyError('nickbuildsdecks99', { username: 'nickbuildsdecks' })).not.toContain(
      'nickbuildsdecks99',
    );
    expect(passwordPolicyError('gothard-secret', { email: 'gothard@example.com' })).not.toContain('gothard-secret');
    expect(passwordPolicyError('zzzzzzzzzzzz')).not.toContain('zzzzzzzzzzzz');
  });

  it('imposes no composition rules, which 800-63B explicitly discourages', () => {
    // All-lowercase, no digits, no symbols: acceptable, because length and unpredictability are what
    // matter and forced composition produces worse passwords.
    expect(ok('quietlibrarymorning')).toBe(true);
  });
});
