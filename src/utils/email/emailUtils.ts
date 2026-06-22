// sendEmail.ts
import {
  buildOtpEmail,
  buildAlertEmail,
  buildAppointmentEmail,
} from './email_builder';

export async function sendEmail({
  to,
  subject,
  data,
  type,
  isHtml = true,
}: {
  to: string;
  subject: string;
  data?: any;
  type: 'otp' | 'appointment' | 'alert';
  isHtml?: boolean;
}) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const SENDGRID_API_URL: any = process.env.SENDGRID_API_URL;
  const SENDGRID_SENDER_EMAIL = process.env.SENDGRID_SENDER_EMAIL;
  const SENDGRID_SENDER_NAME = process.env.SENDGRID_SENDER_NAME;

  const message = buildEmailContent(data, type);
  const payload = {
    personalizations: [
      {
        to: [{ email: to }],
        subject: subject,
      },
    ],
    from: { email: SENDGRID_SENDER_EMAIL, name: SENDGRID_SENDER_NAME },
    content: [{ type: isHtml ? 'text/html' : 'text/plain', value: message }],
    // Uncomment this to enable sandbox mode
    // mail_settings: { sandbox_mode: { enable: true } },
  };
  try {
    const response = await fetch(SENDGRID_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `SendGrid error: ${JSON.stringify(errorData.errors || errorData)}`,
      );
    }
    console.log(`Email sent to ${to} with status ${response.status}`);
    return { success: true, status: response.status };
  } catch (error: any) {
    console.error('Error sending email:', error.message);
    return { success: false, error: error.message };
  }
}

function buildEmailContent(data: any, type: string) {
  switch (type) {
    case 'otp':
      return buildOtpEmail(data);
    case 'appointment':
      return buildAppointmentEmail(data);
    case 'alert':
      return buildAlertEmail(data);
    default:
      return 'Hello, this is a message from Vital Signs.';
  }
}
