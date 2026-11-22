import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../core/config.js';
import type { Logger } from '../core/logger.js';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Outgoing email (SMTP abstraction; Mailpit locally). */
export interface Mailer {
  send(email: Email): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }

  async send(email: Email): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...email });
  }
}

/**
 * Used when no SMTP server is configured. Logs that an email would have been sent, never its
 * body: bodies carry single-use links that must not end up in logs.
 */
export class LogMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  async send(email: Email): Promise<void> {
    this.logger.warn({ subject: email.subject }, 'SMTP not configured: email dropped');
  }
}

/** Keeps sent emails in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: Email[] = [];

  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }
}

export function createMailer(config: Config, logger: Logger): Mailer {
  return config.mail.smtpUrl
    ? new SmtpMailer(config.mail.smtpUrl, config.mail.from)
    : new LogMailer(logger);
}

/** Escapes text for the HTML version of an email. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
