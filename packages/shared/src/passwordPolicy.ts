/**
 * Password policy, per NIST SP 800-63B §5.1.1.2.
 *
 * What the standard actually requires, as against what people assume it requires:
 *
 * - **Required:** a minimum of 8 characters for a user-chosen secret; acceptance of at least 64; and —
 *   the part missing here entirely — comparison against "a list that contains values known to be
 *   commonly-used, expected, or compromised."
 * - **Explicitly discouraged:** composition rules (one upper, one digit, one symbol) and mandatory
 *   rotation. Both push people towards `Password1!` and towards writing it down. So neither is here,
 *   and that is deliberate rather than an omission.
 *
 * The previous policy was `length >= 8` and nothing else, so `password` and `12345678` were both
 * accepted. Those are the first two guesses anyone makes.
 *
 * **On the size of the blocklist.** A real deployment should check against a corpus of breached
 * passwords — Have I Been Pwned's range API is the usual answer, and it needs no secret and leaks
 * nothing (it is queried by the first five characters of the SHA-1, so the server never learns which
 * password was asked about). That is a network call, which does not belong inside a pure validator and
 * needs a decision about behaviour when the service is unreachable. So this is the offline floor: the
 * passwords that appear at the top of every breach corpus, plus the structural checks a remote list
 * cannot make — a password that contains the person's own username or email local part.
 */

/**
 * The top of every published breach corpus, plus the ones this app invites specifically. Lowercased;
 * comparison is case-insensitive because `PASSWORD` is not meaningfully stronger than `password`.
 *
 * Kept short on purpose. A long list embedded in source gives a false sense of coverage while still
 * missing almost everything; the real answer is the remote corpus noted above, and this is the floor
 * that stops the guesses an attacker makes first.
 */
const BLOCKED = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', '123123123', '11111111', '00000000',
  'qwertyui', 'qwerty123', 'asdfghjk', 'iloveyou', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'batman12', 'trustno1', 'starwars',
  'letmein1', 'welcome1', 'welcome123', 'admin123', 'administrator', 'changeme',
  'abc12345', 'monkey12', 'dragon12', 'whatever', 'qazwsxedc', 'zaq12wsx',
  // This app's own vocabulary: the first thing anyone tries on a Magic site.
  'grimore', 'grimoire', 'magicthegathering', 'commander', 'planeswalker', 'blacklotus',
  'guestpass123',
]);

export const PASSWORD_MIN_LENGTH = 8;
/**
 * bcrypt silently truncates at 72 bytes, so anything past that adds no strength while looking like it
 * does. Refusing above 128 keeps the cap well clear of that boundary and bounds the hashing cost, which
 * is otherwise an unauthenticated CPU sink on the register route.
 */
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordContext {
  username?: string;
  email?: string;
}

/**
 * Returns a message if the password must be refused, or null if it is acceptable.
 *
 * The messages say what to change, because a rejection the person cannot act on just produces another
 * rejected attempt. They never echo the password back.
 */
export function passwordPolicyError(password: unknown, context: PasswordContext = {}): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required.';
  }
  // Length in code points, not UTF-16 units, so an emoji or an accented character is not counted twice
  // against someone.
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`;
  }
  // Whitespace-only clears the length check but is not a secret. Trimmed length, not a trim of the
  // password itself: 800-63B requires accepting all printing characters including spaces, so a
  // passphrase with spaces must survive intact.
  if (password.trim().length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }

  const lower = password.toLowerCase();
  if (BLOCKED.has(lower)) {
    return 'That password is one of the most commonly used ones. Please choose something less predictable.';
  }
  // A single repeated character passes every length check and is on nobody's list of the top thousand.
  if (new Set(lower).size === 1) {
    return 'Password cannot be a single repeated character.';
  }
  // Runs like `abcdefgh` and `87654321`: predictable, and too numerous to blocklist individually.
  if (isSequentialRun(lower)) {
    return 'Password cannot be a simple sequence of characters.';
  }

  const username = context.username?.trim().toLowerCase();
  if (username && username.length >= 3 && lower.includes(username)) {
    return 'Password cannot contain your username.';
  }
  const localPart = context.email?.trim().toLowerCase().split('@')[0];
  if (localPart && localPart.length >= 3 && lower.includes(localPart)) {
    return 'Password cannot contain your email address.';
  }
  return null;
}

/** Is every character one step from the last, in the same direction? `abcdef`, `54321`. */
function isSequentialRun(value: string): boolean {
  if (value.length < PASSWORD_MIN_LENGTH) return false;
  const codes = [...value].map((c) => c.codePointAt(0)!);
  const step = codes[1] - codes[0];
  if (step !== 1 && step !== -1) return false;
  return codes.every((code, i) => i === 0 || code - codes[i - 1] === step);
}
