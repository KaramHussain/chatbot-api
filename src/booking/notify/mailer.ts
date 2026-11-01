// Outgoing email. A `Mailer` is a tiny interface so the transport can change (GoDaddy SMTP today,
// Amazon SES when volume grows) without touching templates or the notifier.
//
//   MAIL_TRANSPORT=smtp (default)  → MAIL_SMTP_HOST / PORT / SECURE / USER / PASS
//   MAIL_TRANSPORT=dev             → Mailpit on localhost:1025 (Docker test stack)
//   MAIL_TRANSPORT=log             → print instead of sending
//
// Transactional mail only: no List-Unsubscribe header (it files transactional mail under Promotions).
import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingMail {
  to: string;
  from: { name: string; address: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Calendar invite attached as the `text/calendar` alternative so Gmail/Outlook show RSVP/Add. */
  ical?: { method: 'REQUEST' | 'CANCEL' | 'PUBLISH'; content: string };
  attachments?: Array<{ filename: string; content: string | Buffer; contentType?: string }>;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<{ id: string }>;
}

export function mailFromAddress(): { name: string; address: string } {
  const raw = process.env.MAIL_FROM ?? 'CloudGeniee <hello@cloudgeniee.com>';
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ''), address: m[2] } : { name: 'CloudGeniee', address: raw.trim() };
}

interface SmtpOptions { host: string; port: number; secure: boolean; auth?: { user?: string; pass?: string } }

class SmtpMailer implements Mailer {
  private transport: Transporter;
  constructor(options: SmtpOptions) {
    this.transport = nodemailer.createTransport(options as never);
  }
  async send(mail: OutgoingMail) {
    const info = await this.transport.sendMail({
      from: mail.from,
      to: mail.to,
      replyTo: mail.replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      icalEvent: mail.ical ? { method: mail.ical.method, content: mail.ical.content, filename: 'invite.ics' } : undefined,
      attachments: mail.attachments,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return { id: String(info.messageId ?? '') };
  }
}

class LogMailer implements Mailer {
  async send(mail: OutgoingMail) {
    console.log(JSON.stringify({ evt: 'mail_log', to: mail.to, subject: mail.subject, ical: mail.ical?.method ?? null }));
    return { id: `log-${Date.now()}` };
  }
}

let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (cached) return cached;
  const mode = process.env.MAIL_TRANSPORT ?? 'smtp';
  if (mode === 'dev') {
    cached = new SmtpMailer({ host: process.env.MAIL_DEV_HOST ?? 'localhost', port: Number(process.env.MAIL_DEV_PORT ?? 1025), secure: false });
  } else if (mode === 'log' || !process.env.MAIL_SMTP_HOST) {
    cached = new LogMailer();
  } else {
    cached = new SmtpMailer({
      host: process.env.MAIL_SMTP_HOST,
      port: Number(process.env.MAIL_SMTP_PORT ?? 465),
      secure: (process.env.MAIL_SMTP_SECURE ?? 'true') !== 'false', // 465 = implicit SSL, not STARTTLS
      auth: { user: process.env.MAIL_SMTP_USER, pass: process.env.MAIL_SMTP_PASS },
    });
  }
  return cached;
}

/** Test seam. */
export function setMailer(mailer: Mailer | null) {
  cached = mailer;
}
