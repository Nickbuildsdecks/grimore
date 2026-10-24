/**
 * Transactional email.
 *
 * There is no mail provider configured for this project, and choosing one is Nick's call — so the
 * provider sits behind an interface and the only concrete transport that talks to the outside world
 * speaks SMTP, which every provider offers. Nothing here needs to change when one is picked.
 *
 * The important decision is what happens with nothing configured: **it fails closed**. Not a silent
 * no-op, and not a log line containing the link.
 *
 * Both alternatives were live in the legacy code and both are worse:
 *
 * - A no-op makes "we've sent you a reset link" true in the response and false in reality. That is how
 *   the broken recovery flow survived unnoticed: the route appeared to work.
 * - Logging the link, which legacy did unconditionally under an `[SMTP SIMULATOR]` banner, puts a
 *   working account-takeover credential into every aggregated log and its retention window.
 *
 * So: `SMTP_URL` set means real mail. `MAIL_TRANSPORT=console` means a development transport that
 * prints the recipient and subject and *not* the body. Neither set means every send throws, loudly,
 * naming what to configure.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. Kept the only body format: a reset mail needs no markup, and HTML mail needs escaping. */
  text: string;
}

export interface Transport {
  /** A name for logs and for the fail-closed error. */
  readonly name: string;
  /**
   * Can this transport actually deliver?
   *
   * Callers check this BEFORE doing any per-account work. A password-recovery route that only discovers
   * the problem at the send has already resolved the account, and failing at that point answers
   * differently for a known account than an unknown one — which is an enumeration oracle, open for as
   * long as mail is misconfigured. Checking up front makes the answer identical for everyone.
   */
  readonly configured: boolean;
  send(message: EmailMessage): Promise<void>;
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'No mail transport is configured, so this email was not sent. Set SMTP_URL to deliver mail, or ' +
        'MAIL_TRANSPORT=console for local development. Refusing to report a send that did not happen.',
    );
    this.name = 'MailNotConfiguredError';
  }
}

/**
 * The default. Throws on every send.
 *
 * A caller that wants "try to notify, carry on if we cannot" must catch this explicitly and say so at
 * the call site — which is the point. Recovery mail is not that kind of caller: if the mail cannot go,
 * the user must be told the request failed rather than be left waiting for something that is not coming.
 */
export class FailClosedTransport implements Transport {
  readonly name = 'fail-closed';
  readonly configured = false;
  async send(_message: EmailMessage): Promise<void> {
    throw new MailNotConfiguredError();
  }
}

/**
 * Development transport. Prints that a mail would have gone and to whom — never the body.
 *
 * The body is where the token is. A developer who needs the link reads it from the database or from the
 * route's own dev-only response, both of which are gated on an explicit flag; the log is not a
 * reasonable channel for a credential because nobody controls who reads logs later.
 */
export class ConsoleTransport implements Transport {
  readonly name = 'console';
  readonly configured = true;
  constructor(private readonly log: (line: string) => void = console.log) {}
  async send(message: EmailMessage): Promise<void> {
    this.log(`[mail:console] to=${message.to} subject=${JSON.stringify(message.subject)} (body withheld)`);
  }
}

/** Captures messages instead of sending them. For tests, which need to assert on the body. */
export class MemoryTransport implements Transport {
  readonly name = 'memory';
  readonly configured = true;
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push({ ...message });
  }
  last(): EmailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
  clear(): void {
    this.sent.length = 0;
  }
}

export interface MailerConfig {
  /** Any provider's SMTP URL, e.g. smtps://user:pass@smtp.example.com:465 */
  smtpUrl?: string;
  /** Set to 'console' to opt into the development transport. Anything else is ignored. */
  mailTransport?: string;
  /** The From address. Required for a real send; a transport that cannot send does not need one. */
  from?: string;
}

/**
 * Pick a transport from configuration.
 *
 * Order is deliberate: an explicit `MAIL_TRANSPORT=console` wins over `SMTP_URL`, so a developer with
 * production credentials in their environment cannot accidentally mail real users while testing.
 */
export function selectTransport(config: MailerConfig, smtp?: (url: string, from: string) => Transport): Transport {
  if (config.mailTransport === 'console') return new ConsoleTransport();
  if (config.smtpUrl) {
    if (!config.from) {
      throw new Error('SMTP_URL is set but MAIL_FROM is not. A real send needs a From address.');
    }
    if (!smtp) {
      // The SMTP client is injected rather than imported, so this package stays dependency-free and a
      // test can exercise selection without a network stack. `apps/api` supplies the real one.
      throw new Error('SMTP_URL is set but no SMTP transport factory was provided.');
    }
    return smtp(config.smtpUrl, config.from);
  }
  return new FailClosedTransport();
}
