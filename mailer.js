/**
 * Transactional email for the legacy server. The CommonJS counterpart to `packages/mailer`, for the
 * same module-system reason as `accountTokens.js`.
 *
 * The behaviour that matters is the default: with neither `SMTP_URL` nor `MAIL_TRANSPORT=console` set,
 * every send throws. It does not silently succeed, and it does not log the link.
 *
 * Both of those were live here. `forgot-password` printed the entire recovery link to stdout on every
 * request under an `[SMTP SIMULATOR]` banner — putting a working account-takeover credential into every
 * aggregated log and its whole retention window — while the response told the user a link had been
 * sent. Nothing had been sent, which is how the flow stayed broken without anyone noticing.
 */
class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'No mail transport is configured, so this email was not sent. Set SMTP_URL to deliver mail, or ' +
        'MAIL_TRANSPORT=console for local development. Refusing to report a send that did not happen.',
    );
    this.name = 'MailNotConfiguredError';
  }
}

/**
 * Picks a transport from the environment.
 *
 * Each returned transport carries `configured`, which callers check BEFORE doing any per-account work.
 * A recovery route that only discovers a missing transport at the send has already resolved the account,
 * so it answers differently for a known account than an unknown one -- an enumeration oracle that stays
 * open for as long as mail is misconfigured.
 *
 * `MAIL_TRANSPORT=console` wins over `SMTP_URL` on purpose, so a developer with production credentials
 * in their environment cannot mail real users by accident.
 */
function createMailer(env = process.env) {
  if (env.MAIL_TRANSPORT === 'console') {
    return {
      name: 'console',
      configured: true,
      async send(message) {
        // Recipient and subject only. The body is where the token is, and nobody controls who reads
        // logs later.
        console.log(
          `[mail:console] to=${message.to} subject=${JSON.stringify(message.subject)} (body withheld)`,
        );
      },
    };
  }
  if (env.SMTP_URL) {
    if (!env.MAIL_FROM) {
      return {
        name: 'misconfigured',
        configured: false,
        async send() {
          throw new Error('SMTP_URL is set but MAIL_FROM is not. A real send needs a From address.');
        },
      };
    }
    // nodemailer is not a dependency of this project yet, and adding one to send zero mail would be
    // premature. When Nick picks a provider this is the single place that changes; until then an
    // SMTP_URL that cannot be honoured must fail loudly rather than appear to work.
    return {
      name: 'smtp-unimplemented',
      configured: false,
      async send() {
        throw new Error(
          'SMTP_URL is set but the legacy server has no SMTP client installed. Add nodemailer and wire ' +
            'it here, or run apps/api, which has one.',
        );
      },
    };
  }
  return {
    name: 'fail-closed',
    configured: false,
    async send() {
      throw new MailNotConfiguredError();
    },
  };
}

module.exports = { createMailer, MailNotConfiguredError };
