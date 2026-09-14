import nodemailer from "nodemailer";
import type { SmtpConfig } from "../config";

export type Mailer = {
  send(to: string, subject: string, text: string): Promise<void>;
};

export function createMailer(smtp: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.port === 587 && !smtp.secure
      ? { requireTLS: true }
      : {}),
    auth: { user: smtp.user, pass: smtp.password },
  });
  return {
    async send(to: string, subject: string, text: string) {
      await transport.sendMail({ from: smtp.from, to, subject, text });
    },
  };
}
