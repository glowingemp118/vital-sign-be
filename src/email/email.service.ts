// email.service.ts
import { Injectable } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { env } from 'src/config/env';

@Injectable()
export class EmailService {
  constructor() {
    sgMail.setApiKey(env.SENDGRID_API_KEY); // Replace with your SendGrid API key
  }
  async send({
    to,
    subject,
    text,
    html,
  }: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }) {
    const msg: any = {
      to,
      from: env.SG_EMAIL, // Replace with your verified sender email
      subject,
      content: [
        {
          type: text ? 'text/plain' : 'text/html',
          value: text || html || '',
        },
      ],
    };

    try {
      await sgMail.send(msg);
      return { success: true };
    } catch (error: any) {
      console.error('Email error:', error.response?.body || error.message);
      return { success: false, error };
    }
  }
}
