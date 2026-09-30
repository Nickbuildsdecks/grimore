import { describe, it, expect, vi } from 'vitest';
import {
  selectTransport,
  FailClosedTransport,
  ConsoleTransport,
  MemoryTransport,
  MailNotConfiguredError,
  type Transport,
} from './index.js';

describe('transport selection', () => {
  it('fails closed with nothing configured', async () => {
    const t = selectTransport({});
    expect(t.name).toBe('fail-closed');
    // The whole point: a send that cannot happen must not look like one that did.
    await expect(t.send({ to: 'a@b.test', subject: 's', text: 't' })).rejects.toThrow(MailNotConfiguredError);
  });

  it("names what to configure, so the failure is actionable", async () => {
    await expect(new FailClosedTransport().send({ to: 'a@b.test', subject: 's', text: 't' })).rejects.toThrow(
      /SMTP_URL|MAIL_TRANSPORT=console/,
    );
  });

  it('uses SMTP when a url and a from address are given', () => {
    const made: string[] = [];
    const fake: Transport = { name: 'smtp', async send() {} };
    const t = selectTransport(
      { smtpUrl: 'smtps://u:p@smtp.example.test:465', from: 'Grimore <no-reply@example.test>' },
      (url) => {
        made.push(url);
        return fake;
      },
    );
    expect(t).toBe(fake);
    expect(made).toEqual(['smtps://u:p@smtp.example.test:465']);
  });

  it('refuses an SMTP url with no from address rather than inventing one', () => {
    expect(() => selectTransport({ smtpUrl: 'smtps://u:p@h:465' }, () => ({ name: 'x', async send() {} }))).toThrow(
      /MAIL_FROM/,
    );
  });

  it('lets an explicit console transport override live SMTP credentials', () => {
    // A developer with production credentials in their environment must not be able to mail real users
    // by accident, so the explicit development choice wins.
    const t = selectTransport(
      { mailTransport: 'console', smtpUrl: 'smtps://u:p@real.example.test:465', from: 'a@b.test' },
      () => {
        throw new Error('SMTP factory must not be called when console is selected');
      },
    );
    expect(t.name).toBe('console');
  });

  it('ignores an unrecognised transport name instead of guessing', () => {
    expect(selectTransport({ mailTransport: 'sendgrid' }).name).toBe('fail-closed');
  });
});

describe('console transport', () => {
  it('logs the recipient and subject but never the body', async () => {
    const lines: string[] = [];
    const t = new ConsoleTransport((l) => lines.push(l));
    await t.send({
      to: 'player@example.test',
      subject: 'Reset your Grimore password',
      text: 'https://grimore.example/reset?token=SUPER_SECRET_TOKEN_VALUE',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('player@example.test');
    expect(lines[0]).toContain('Reset your Grimore password');
    // Legacy printed the whole recovery link to the log, which put a working takeover credential into
    // every aggregated log and its retention window.
    expect(lines[0]).not.toContain('SUPER_SECRET_TOKEN_VALUE');
    expect(lines[0]).not.toContain('token=');
  });

  it('defaults to console.log without a sink, and does not throw', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new ConsoleTransport().send({ to: 'a@b.test', subject: 's', text: 't' });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('memory transport', () => {
  it('captures messages for assertions, and copies them', async () => {
    const t = new MemoryTransport();
    const msg = { to: 'a@b.test', subject: 's', text: 'body' };
    await t.send(msg);
    msg.text = 'mutated after sending';
    expect(t.sent).toHaveLength(1);
    expect(t.last()?.text).toBe('body');
    t.clear();
    expect(t.sent).toHaveLength(0);
    expect(t.last()).toBeUndefined();
  });
});
