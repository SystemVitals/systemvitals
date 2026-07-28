import nodemailer from "nodemailer";
import { config } from "./config.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Production mailer built from SMTP_* env vars.
 * Falls back to nodemailer's jsonTransport (logs the message, no network)
 * when SMTP_HOST is not set, so dev works without an SMTP server.
 */
export class NodemailerMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  private readonly from: string;
  private readonly isJsonTransport: boolean;

  constructor() {
    this.from = config.mailFrom;

    const smtpHost = process.env["SMTP_HOST"];
    this.isJsonTransport = !smtpHost;

    if (smtpHost) {
      this.transport = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env["SMTP_PORT"] ?? "587", 10),
        auth: {
          user: process.env["SMTP_USER"],
          pass: process.env["SMTP_PASS"],
        },
      });
    } else {
      // No SMTP configured — log the message but don't fail
      this.transport = nodemailer.createTransport({ jsonTransport: true });
    }
  }

  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
    if (this.isJsonTransport) {
      console.log("[mailer] (no SMTP) message accepted", {
        recipientCount: 1,
      });
    }
  }
}

/**
 * In-memory mailer for tests — pushes each sent message to the `sent` array.
 */
export class CollectingMailer implements Mailer {
  public readonly sent: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}
