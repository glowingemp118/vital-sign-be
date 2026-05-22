/**
 * ─────────────────────────────────────────────
 *  MEXIDOC — Unified Email Template Usage Guide
 * ─────────────────────────────────────────────
 *
 * Load the HTML template once, then replace placeholders per email type.
 *
 * PLACEHOLDERS IN TEMPLATE:
 *
 *  {{EMAIL_SUBJECT}}    — browser/tab title & email subject line
 *  {{BADGE_TEXT}}       — top-right badge label  (e.g. "ALERT ACTIVE", "OTP", "REMINDER")
 *  {{BADGE_BG}}         — badge background hex   (without #)
 *  {{BADGE_COLOR}}      — badge text color hex
 *  {{BADGE_BORDER}}     — badge border hex
 *  {{HEADER_TITLE}}     — large red heading       (e.g. "VITAL ALERT", "OTP CODE", "APPOINTMENT")
 *  {{HEADER_SUBTITLE}}  — small caps subtitle beneath heading
 *  {{META_TO}}          — recipient shown in meta row
 *  {{META_TYPE}}        — label in TYPE meta cell (e.g. "URGENT", "VERIFICATION", "REMINDER")
 *  {{META_TYPE_COLOR}}  — hex for TYPE value text (without #)
 *  {{META_TIME}}        — formatted send time string
 *  {{INTRO_TEXT}}       — opening paragraph (supports inline HTML / <strong>)
 *  {{CONTENT}}          — main body HTML block (cards, tables, OTP box, etc.)
 *  {{FOOTER_NOTE}}      — disclaimer / note text at bottom
 */

// email_builder.ts
import * as path from 'path';
import * as fs from 'fs';

const templatePath = path.join(__dirname, 'email_temp.html');

let htmlTemplate = '';
try {
  htmlTemplate = fs.readFileSync(templatePath, 'utf8');
} catch (err) {
  console.error(`Failed to load email template: ${templatePath}`, err);
}

/** Helper: replace all template placeholders in one shot */
function buildEmail(vars: Record<string, string>): string {
  return Object.entries({
    ...vars,
    META_FROM: 'info@vitals-signs.com',
  }).reduce(
    (html, [key, value]) => html.replaceAll(`{{${key}}}`, value ?? ''),
    htmlTemplate,
  );
}

/** Format a JS Date for the meta TIME cell */
function formatTime(date = new Date()) {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  1.  OTP EMAIL
// ════════════════════════════════════════════════════════════════════════════
export function buildOtpEmail({
  user,
  otp,
  expiresInMinutes = 10,
}: {
  user: { name: string; email: string };
  otp: string;
  expiresInMinutes?: number;
}) {
  const content = `
    <!-- OTP CODE BOX -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
      <tr>
        <td style="color:#3a4459;font-size:9px;font-weight:bold;letter-spacing:2px;padding-bottom:10px;">
          YOUR VERIFICATION CODE
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:30px 0;">
          <table cellpadding="0" cellspacing="0" border="0" role="presentation" align="center">
            <tr>
              <td align="center"
                style="background-color:#0b1018;border:1px solid #1a2236;border-radius:8px;padding:24px 48px;">
                <div style="color:#4e5668;font-size:10px;letter-spacing:2px;padding-bottom:10px;font-weight:bold;">
                  ONE-TIME PASSWORD
                </div>
                <div style="color:#e8183a;font-size:48px;font-weight:bold;letter-spacing:10px;">
                  ${otp}
                </div>
                <div style="color:#4e5668;font-size:10px;letter-spacing:1px;padding-top:10px;">
                  Valid for ${expiresInMinutes} minutes
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="color:#9aa0b4;font-size:13px;line-height:22px;padding-top:6px;">
          Enter this code in the app to verify your identity. Do not share it with anyone.
        </td>
      </tr>
    </table>`;

  return buildEmail({
    EMAIL_SUBJECT: 'Your OTP Code – MEXIDOC',
    BADGE_TEXT: 'OTP',
    BADGE_BG: '0c1a2e',
    BADGE_COLOR: '7bb3ff',
    BADGE_BORDER: '1a3456',
    HEADER_TITLE: 'OTP CODE',
    HEADER_SUBTITLE:
      'AUTOMATED HEALTH MONITORING SYSTEM \u00b7 IDENTITY VERIFICATION',
    META_TO: user.email,
    META_TYPE: 'VERIFICATION',
    META_TYPE_COLOR: '7bb3ff',
    META_TIME: formatTime(),
    INTRO_TEXT: `Dear <strong style="color:#ffffff;">${user.name}</strong> &mdash; 
      a one-time password has been generated for your <strong style="color:#ffffff;">MEXIDOC</strong> account.
      Use the code below to complete your verification.`,
    CONTENT: content,
    FOOTER_NOTE:
      'If you did not request this code, please ignore this email. This OTP will expire automatically.',
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  2.  APPOINTMENT REMINDER EMAIL
// ════════════════════════════════════════════════════════════════════════════
export function buildAppointmentEmail({
  patient,
  doctor,
  appointment,
}: {
  patient: { name: string; email: string };
  doctor: { name: string; speciality?: string };
  appointment: {
    date: string;
    time: string;
    location?: string;
    type?: string;
    notes?: string;
  };
}) {
  const content = `
    <!-- APPOINTMENT CARD -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
      <tr>
        <td style="color:#3a4459;font-size:9px;font-weight:bold;letter-spacing:2px;padding-bottom:10px;">
          APPOINTMENT DETAILS
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
      style="background-color:#08101e;border:1px solid #121e34;border-radius:8px;">

      <!-- Date row -->
      <tr>
        <td width="50%" style="padding:16px 20px;border-right:1px solid #121e34;border-bottom:1px solid #121e34;">
          <div style="color:#3a4459;font-size:9px;letter-spacing:1px;padding-bottom:4px;font-weight:bold;">DATE</div>
          <div style="color:#ffffff;font-size:16px;font-weight:bold;">${appointment.date}</div>
        </td>
        <td width="50%" style="padding:16px 20px;border-bottom:1px solid #121e34;">
          <div style="color:#3a4459;font-size:9px;letter-spacing:1px;padding-bottom:4px;font-weight:bold;">TIME</div>
          <div style="color:#ffffff;font-size:16px;font-weight:bold;">${appointment.time}</div>
        </td>
      </tr>

      <!-- Doctor row -->
      <tr>
        <td width="50%" style="padding:16px 20px;border-right:1px solid #121e34;border-bottom:1px solid #121e34;">
          <div style="color:#3a4459;font-size:9px;letter-spacing:1px;padding-bottom:4px;font-weight:bold;">DOCTOR</div>
          <div style="color:#c5cade;font-size:13px;font-weight:bold;">Dr. ${doctor.name}</div>
          <div style="color:#5e6a82;font-size:11px;">${doctor.speciality ?? ''}</div>
        </td>
        <td width="50%" style="padding:16px 20px;border-bottom:1px solid #121e34;">
          <div style="color:#3a4459;font-size:9px;letter-spacing:1px;padding-bottom:4px;font-weight:bold;">LOCATION</div>
          <div style="color:#c5cade;font-size:13px;">${appointment.location ?? 'TBD'}</div>
        </td>
      </tr>

      <!-- Type / status row -->
      <tr>
        <td colspan="2" style="padding:16px 20px;">
          <div style="color:#3a4459;font-size:9px;letter-spacing:1px;padding-bottom:4px;font-weight:bold;">APPOINTMENT TYPE</div>
          <div style="color:#c5cade;font-size:13px;">${appointment.type ?? 'General Consultation'}</div>
        </td>
      </tr>

    </table>

    ${
      appointment.notes
        ? `
    <!-- NOTES BOX -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:16px;">
      <tr>
        <td style="color:#f0c030;font-size:10px;font-weight:bold;letter-spacing:1px;padding-bottom:8px;">
          &#9888; NOTES
        </td>
      </tr>
      <tr>
        <td style="background-color:#0b1018;border-radius:0 6px 6px 0;padding:13px 16px;color:#9aa0b4;font-size:13px;line-height:22px;">
          ${appointment.notes}
        </td>
      </tr>
    </table>`
        : ''
    }`;

  return buildEmail({
    EMAIL_SUBJECT: 'Appointment Reminder – MEXIDOC',
    BADGE_TEXT: 'REMINDER',
    BADGE_BG: '0c1a10',
    BADGE_COLOR: '1cff84',
    BADGE_BORDER: '0e4022',
    HEADER_TITLE: 'APPOINTMENT',
    HEADER_SUBTITLE:
      'AUTOMATED HEALTH MONITORING SYSTEM \u00b7 APPOINTMENT NOTIFICATION',
    META_TO: patient.email,
    META_TYPE: 'REMINDER',
    META_TYPE_COLOR: '1cff84',
    META_TIME: formatTime(),
    INTRO_TEXT: `Dear <strong style="color:#ffffff;">${patient.name}</strong> &mdash; this is a reminder from
      <strong style="color:#ffffff;">MEXIDOC</strong> about your upcoming appointment.
      Please review the details below and arrive on time.`,
    CONTENT: content,
    FOOTER_NOTE:
      'Please arrive 10 minutes before your scheduled time. To reschedule, contact your clinic directly.',
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  3.  VITAL ALERT EMAIL
// ════════════════════════════════════════════════════════════════════════════
export function buildAlertEmail({
  patient,
  doctor,
  hospital,
  alerts,
  comment,
}: {
  patient: { name: string; email: string; age?: number };
  doctor: { name: string; email?: string };
  hospital?: any;
  alerts: Array<{
    name: string;
    value: string;
    recorded_at: string;
    status?: string;
  }>;
  comment?: string;
}) {
  // Build vital cards (first 3 alerts shown as cards, rest in table)
  const MAX_CARDS = 4;
  const cardAlerts = alerts.slice(0, MAX_CARDS);
  const tableAlerts = alerts.slice(MAX_CARDS);

  const statusStyle = (status = '') => {
    const s = status.toUpperCase();

    if (s === 'CRITICAL')
      return {
        bg: '1a0505',
        color: 'ff6000',
        border: '6b1a00',
        icon: '&#9888;', // ⚠ warning triangle
      };
    if (s === 'HIGH')
      return {
        bg: '260c16',
        color: 'ff3c63',
        border: '501028',
        icon: '&#9650;', // ▲ up arrow
      };
    if (s === 'LOW')
      return {
        bg: '091828',
        color: '3c9fff',
        border: '104060',
        icon: '&#9660;', // ▼ down arrow
      };
    // NORMAL
    return {
      bg: '081a10',
      color: '1cff84',
      border: '0e4022',
      icon: '&#10003;', // ✓ checkmark
    };
  };

  const vitalCards = cardAlerts
    .map((a) => {
      const st = statusStyle(a.status);
      return `
      <td class="stack card" width="${Math.floor(100 / cardAlerts.length)}%" valign="top" style="padding:6px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
          style="background-color:#130810;border:1px solid #2e1020;border-radius:8px;">
          <tr>
            <td align="center" style="padding:18px 8px;border-radius:8px;">
              <div style="color:#c45070;font-size:9px;letter-spacing:1px;font-weight:bold;padding-top:8px;">
                ${a.name.toUpperCase()}
              </div>
              <div style="color:#e8183a;font-size:30px;font-weight:bold;padding-top:6px;letter-spacing:-0.5px;">
                ${a.value}
              </div>
              <div style="color:#7a4055;font-size:9px;letter-spacing:1px;padding-bottom:9px;">
                ${new Date(a.recorded_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </div>
              <table cellpadding="0" cellspacing="0" border="0" role="presentation" align="center" style="margin:0 auto;">
                <tr>
                  <td align="center"
                    style="background-color:#${st.bg};color:#${st.color};padding:5px 14px;font-size:9px;font-weight:bold;border-radius:4px;border:1px solid #${st.border};letter-spacing:0.5px;white-space:nowrap;">
                    ${st.icon} ${(a.status || 'NORMAL').toUpperCase()}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>`;
    })
    .join('');

  const vitalTable = tableAlerts.length
    ? `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
      style="margin-top:12px;border:1px solid #141f32;border-radius:8px;overflow:hidden;">
      <tr style="background-color:#08101c;">
        <th style="padding:10px 12px;color:#3a4459;font-size:9px;letter-spacing:1px;text-align:left;font-weight:bold;">VITAL</th>
        <th style="padding:10px 12px;color:#3a4459;font-size:9px;letter-spacing:1px;text-align:left;font-weight:bold;">VALUE</th>
        <th style="padding:10px 12px;color:#3a4459;font-size:9px;letter-spacing:1px;text-align:left;font-weight:bold;">RECORDED AT</th>
        <th style="padding:10px 12px;color:#3a4459;font-size:9px;letter-spacing:1px;text-align:left;font-weight:bold;">STATUS</th>
      </tr>
      ${tableAlerts
        .map((a) => {
          const st = statusStyle(a.status);
          return `<tr style="border-top:1px solid #141f32;">
          <td style="padding:10px 12px;color:#c5cade;font-size:12px;">${a.name}</td>
          <td style="padding:10px 12px;color:#ffffff;font-size:12px;font-weight:bold;">${a.value}</td>
          <td style="padding:10px 12px;color:#8a90a4;font-size:11px;">${new Date(a.recorded_at).toLocaleString()}</td>
          <td style="padding:10px 12px;">
            <span style="color:#${st.color};font-size:10px;font-weight:bold;">${st.icon} ${(a.status || 'NORMAL').toUpperCase()}</span>
          </td>
        </tr>`;
        })
        .join('')}
    </table>`
    : '';

  const content = `
    <!-- PATIENT DETAILS -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
      <tr>
        <td style="color:#3a4459;font-size:9px;font-weight:bold;letter-spacing:2px;padding-bottom:10px;">
          PATIENT DETAILS
        </td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="padding-top:10px;">
      <tr>
        <td class="stack" width="50%" valign="bottom" style="padding-bottom:3px;">
          <div style="color:#3a4459;font-size:9px;letter-spacing:1px;padding-bottom:3px;font-weight:bold;">FULL NAME</div>
          <div style="color:#ffffff;font-size:24px;font-weight:bold;">${patient.name}</div>
        </td>
        <td class="stack" width="50%" align="right" valign="bottom" style="padding-bottom:3px;">
        <div style="color:#3a4459;font-size:9px;letter-spacing:1px;padding-bottom:3px;font-weight:bold;text-align:right;">EMAIL</div>
          <div style="color:#c8ccda;font-size:14px;font-weight:bold;text-align:right;">${patient?.email ?? 'N/A'}</div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:20px 0 0 0;">
      <tr>
        <td style="height:1px;background-color:#1a2236;font-size:0;line-height:0;">&nbsp;</td>
      </tr>
    </table>

    <!-- VITAL SIGNS RECORDED label -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="padding-top:20px;">
      <tr>
        <td style="color:#3a4459;font-size:9px;font-weight:bold;letter-spacing:2px;padding:20px 0 10px 0;">
          VITAL SIGNS RECORDED
        </td>
      </tr>
    </table>

    <!-- VITAL CARDS -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
      style="margin:0 -6px;width:calc(100% + 12px);">
      <tr>${vitalCards}</tr>
    </table>

    ${vitalTable}

    <!-- TRIGGER REASON -->
    ${
      comment
        ? `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:20px;">
      <tr>
        <td style="height:1px;background-color:#1a2236;font-size:0;line-height:0;">&nbsp;</td>
      </tr>
    </table>
    <div style="color:#f0c030;font-size:10px;font-weight:bold;letter-spacing:1px;padding:16px 0 8px 0;">
      &#9889; TRIGGER REASON
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
      style="background-color:#0b1018;border-radius:0 6px 6px 0;">
      <tr>
        <td style="padding:13px 16px;color:#9aa0b4;font-size:13px;line-height:22px;">${comment}</td>
      </tr>
    </table>`
        : ''
    }

    <!-- RECOMMENDED FACILITY -->
    ${
      hospital
        ? `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:20px;">
      <tr>
        <td style="height:1px;background-color:#1a2236;font-size:0;line-height:0;">&nbsp;</td>
      </tr>
    </table>
    <div style="color:#3a4459;font-size:9px;letter-spacing:2px;font-weight:bold;padding:16px 0 10px 0;">
      RECOMMENDED FACILITY
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
      style="background-color:#08101e;border:1px solid #121e34;border-radius:8px;">
      <tr>
        <td width="52" valign="middle" style="padding:14px 6px 14px 14px;">
          <table cellpadding="0" cellspacing="0" border="0" role="presentation">
            <tr>
              <td align="center" valign="middle"
                style="width:36px;height:36px;background-color:#0e1e38;border-radius:50%;font-size:17px;text-align:center;line-height:36px;">
                &#127973;
              </td>
            </tr>
          </table>
        </td>
        <td valign="middle" style="padding:14px 8px;color:#ffffff;font-size:14px;font-weight:bold;">
          ${hospital.name}
          <div style="font-size:11px;color:#5e6a82;font-weight:normal;padding-top:3px;">${hospital.location ?? ''}</div>
        </td>
        ${
          hospital.areaLevel
            ? `
        <td align="right" valign="middle" style="padding:14px;white-space:nowrap;">
          <a href="${hospital.mapsUrl || '#'}"
            style="display:inline-block;background-color:#0d2d63;color:#7bb3ff;text-decoration:none;padding:8px 15px;font-size:11px;font-weight:bold;border-radius:5px;">
            &#128205; Maps
          </a>
        </td>`
            : ''
        }
      </tr>
    </table>`
        : ''
    }`;

  return buildEmail({
    EMAIL_SUBJECT: 'Patient Alert Notification – MEXIDOC',
    BADGE_TEXT: 'ALERT ACTIVE',
    BADGE_BG: '2a0c16',
    BADGE_COLOR: 'ff3c63',
    BADGE_BORDER: '5a1424',
    HEADER_TITLE: 'VITAL ALERT',
    HEADER_SUBTITLE:
      'AUTOMATED HEALTH MONITORING SYSTEM \u00b7 CRITICAL NOTIFICATION',
    META_TO: doctor?.email ?? 'N/A',
    META_TYPE: 'URGENT',
    META_TYPE_COLOR: 'ff2f63',
    META_TIME: formatTime(),
    INTRO_TEXT: `Dear <strong style="color:#ffffff;">Dr. ${doctor?.name ?? 'N/A'}</strong> &mdash; this is an automated alert
      from <strong style="color:#ffffff;">MEXIDOC</strong>.
      The following patient has shown an abnormal vital sign pattern that may require your immediate attention.`,
    CONTENT: content,
    FOOTER_NOTE:
      'This is an automated recommendation and does not constitute a medical diagnosis. No response is required.',
  });
}
