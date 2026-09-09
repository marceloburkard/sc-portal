// Sends the daily "new matching tenders" email.
//
// Two transports, chosen by environment variables (see .env.example):
//   Gmail SMTP (preferred when both GMAIL_USER and GMAIL_APP_PASSWORD
//   are set) — uses smtp.gmail.com:465. Needs a Google App Password,
//   not the account's regular password.
//   Resend HTTPS API — fallback when Gmail isn't configured. Needs a
//   verified sending domain; @gmail.com cannot be used as FROM.
//
// Shared:
//   ALERT_EMAIL_TO    - who receives the daily alert
//   ALERT_EMAIL_FROM  - optional display "from" for Resend; Gmail always
//                       sends as GMAIL_USER
//
// If neither transport is fully configured, sending is silently skipped
// — the portal and daily fetch still work fine without email.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isGmailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function isResendConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_FROM);
}

function isEmailConfigured() {
  return Boolean(process.env.ALERT_EMAIL_TO && (isGmailConfigured() || isResendConfigured()));
}

function activeProvider() {
  if (isGmailConfigured()) return 'gmail';
  if (isResendConfigured()) return 'resend';
  return null;
}

function fromAddress() {
  if (isGmailConfigured()) return process.env.GMAIL_USER;
  return process.env.ALERT_EMAIL_FROM || null;
}

// Reports which required env vars are present, without ever exposing
// secrets. Used by the portal's "Send test email" button.
function getEmailConfigStatus() {
  const missing = [];
  if (!process.env.ALERT_EMAIL_TO) missing.push('ALERT_EMAIL_TO');
  if (!isGmailConfigured() && !isResendConfigured()) {
    if (!process.env.GMAIL_USER) missing.push('GMAIL_USER');
    if (!process.env.GMAIL_APP_PASSWORD) missing.push('GMAIL_APP_PASSWORD');
  }
  const provider = activeProvider();
  return {
    configured: isEmailConfigured(),
    missing,
    provider,
    to: process.env.ALERT_EMAIL_TO || null,
    from: fromAddress(),
    vercel: Boolean(process.env.VERCEL),
  };
}

function describeSendError(error) {
  if (!error) return 'Unknown email error';
  if (typeof error === 'string') return error;
  return error.message || error.name || JSON.stringify(error);
}

function buildEmailHtml(newTenders, { rawCount, matchCount, runDate }) {
  const rows = newTenders.map((t) => {
    const sa = (t.matchedSaReferences || []).join(', ');
    const badge = t.matchType === 'both'
      ? 'SA + KEYWORD MATCH'
      : t.matchType === 'sa-reference'
        ? 'SA MATCH'
        : 'KEYWORD MATCH';
    const ca = t.contractingAuthority || {};
    const saDetailsHtml = (t.saDetails || []).map((d) => `
          <div style="font-size:11px;color:#374151;margin-top:6px;padding:6px 8px;background:#f3f4f6;border-radius:4px;">
            <div style="font-weight:600;">${escapeHtml(d.number)}${d.label ? ' — ' + escapeHtml(d.label) : ''}</div>
            ${d.streams ? `<div style="margin-top:2px;">${d.streams.map((s) => escapeHtml(s)).join('<br>')}</div>` : ''}
            ${d.securityLevel ? `<div style="margin-top:2px;color:#6b7280;">Security level: ${escapeHtml(d.securityLevel)}</div>` : ''}
          </div>`).join('');
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
          <div style="font-weight:600;font-size:14px;color:#111827;">
            ${t.url ? `<a href="${escapeHtml(t.url)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(t.title)}</a>` : escapeHtml(t.title)}
          </div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">
            ${escapeHtml(t.solicitationNumber || '(no solicitation #)')} &middot; ${escapeHtml(t.organization || '')}
          </div>
          <div style="font-size:11px;color:#059669;margin-top:4px;font-weight:600;">
            ${escapeHtml(badge)}${sa ? ' &mdash; ' + escapeHtml(sa) : ''}
          </div>
          ${saDetailsHtml}
          ${ca.name ? `<div style="font-size:12px;color:#374151;margin-top:4px;">Contact: ${escapeHtml(ca.name)}${ca.email ? ' &lt;' + escapeHtml(ca.email) + '&gt;' : ''}${ca.phone ? ' &middot; ' + escapeHtml(ca.phone) : ''}</div>` : ''}
          <div style="font-size:12px;color:#6b7280;margin-top:4px;">Closes: ${escapeHtml(t.closingDate || 'unknown')}</div>
        </td>
      </tr>`;
  }).join('');

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;">
    <h2 style="color:#111827;margin-bottom:4px;">Canada Buys Tenders &mdash; ${newTenders.length} new match${newTenders.length === 1 ? '' : 'es'}</h2>
    <p style="color:#6b7280;font-size:13px;margin-top:0;">
      Checked ${escapeHtml(runDate)} &middot; ${rawCount} notices scanned &middot; ${matchCount} total current matches
    </p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      ${rows}
    </table>
    <p style="color:#9ca3af;font-size:11px;margin-top:16px;">
      Sent automatically by your Canada Buys Tenders portal after today's scheduled check.
    </p>
  </div>`;
}

async function sendViaGmail({ to, from, subject, html }) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  const info = await transporter.sendMail({ from, to, subject, html });
  return { sent: true, provider: 'gmail', id: info && info.messageId };
}

async function sendViaResend({ to, from, subject, html }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({ from, to, subject, html });
  if (error) {
    return { sent: false, reason: 'resend-error', provider: 'resend', error: describeSendError(error) };
  }
  return { sent: true, provider: 'resend', id: data && data.id };
}

async function sendMail({ subject, html }) {
  const status = getEmailConfigStatus();
  if (!status.configured) return { sent: false, reason: 'not-configured', ...status };

  const payload = {
    to: status.to,
    from: status.from,
    subject,
    html,
  };

  try {
    if (status.provider === 'gmail') {
      return { ...await sendViaGmail(payload), to: status.to, from: status.from };
    }
    const result = await sendViaResend(payload);
    return { ...result, to: status.to, from: status.from };
  } catch (err) {
    console.error('[email] Failed to send:', err);
    return {
      sent: false,
      reason: 'exception',
      provider: status.provider,
      error: err.message,
      to: status.to,
      from: status.from,
    };
  }
}

// Sends the alert email if, and only if, there's at least one new matching
// tender and email is configured. Never throws — a failed email should not
// break the daily fetch/filter run; errors are logged and swallowed.
async function sendDailyMatchEmail(newTenders, meta) {
  if (!newTenders || newTenders.length === 0) return { sent: false, reason: 'no-new-matches' };
  if (!isEmailConfigured()) return { sent: false, reason: 'not-configured' };

  const subject = `Canada Buys Tenders: ${newTenders.length} new match${newTenders.length === 1 ? '' : 'es'} (${meta.runDate})`;
  const result = await sendMail({ subject, html: buildEmailHtml(newTenders, meta) });
  if (!result.sent) {
    console.error('[email] Daily match email was not sent:', result);
  }
  return result;
}

// Sends a clearly labeled test message using the same transport as the
// daily alert. Unlike sendDailyMatchEmail, this does not require any new
// matching tenders. Never throws.
async function sendTestEmail() {
  const status = getEmailConfigStatus();
  if (!status.configured) {
    return { sent: false, reason: 'not-configured', ...status };
  }

  const sampleTenders = [{
    title: 'Sample notice — this is a test, not a real tender',
    url: 'https://canadabuys.canada.ca',
    solicitationNumber: 'TEST-0001',
    organization: 'Email configuration check',
    matchType: 'keyword',
    matchedSaReferences: [],
    saDetails: [],
    contractingAuthority: { name: 'Test contact', email: status.to, phone: '' },
    closingDate: 'n/a',
  }];

  const runDate = new Date().toISOString();
  const where = status.vercel ? 'Vercel' : 'this server';
  const via = status.provider === 'gmail' ? 'Gmail SMTP' : 'Resend';

  return sendMail({
    subject: `[TEST] Canada Buys Tenders: email is working (${runDate.slice(0, 10)})`,
    html: `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;">
    <p style="background:#fef3c7;border:1px solid #f59e0b;padding:10px 12px;border-radius:6px;font-size:13px;color:#92400e;margin-bottom:16px;">
      This is a test message from the Canada Buys Tenders portal via ${via}. If you received it, email is configured correctly on ${where}.
    </p>
  </div>
  ${buildEmailHtml(sampleTenders, { rawCount: 0, matchCount: 1, runDate })}`,
  });
}

module.exports = {
  sendDailyMatchEmail,
  sendTestEmail,
  buildEmailHtml,
  isEmailConfigured,
  getEmailConfigStatus,
};
