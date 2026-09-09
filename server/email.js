// Sends the daily "new matching tenders" email via Resend
// (https://resend.com). Chosen over raw SMTP because it's a plain HTTPS API
// call — no SMTP ports to worry about on Vercel's serverless functions, and
// no mailbox/app-password to manage.
//
// Configuration lives entirely in environment variables (see .env.example):
//   RESEND_API_KEY    - your Resend API key
//   ALERT_EMAIL_TO    - who receives the daily alert
//   ALERT_EMAIL_FROM  - a "from" address on a domain verified in Resend
//
// If RESEND_API_KEY (or the other two) isn't set, sending is silently
// skipped — the portal and daily fetch still work fine without email
// configured, this is purely an optional add-on.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO && process.env.ALERT_EMAIL_FROM);
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

// Sends the alert email if, and only if, there's at least one new matching
// tender and email is configured. Never throws — a failed email should not
// break the daily fetch/filter run; errors are logged and swallowed.
async function sendDailyMatchEmail(newTenders, meta) {
  if (!newTenders || newTenders.length === 0) return { sent: false, reason: 'no-new-matches' };
  if (!isEmailConfigured()) return { sent: false, reason: 'not-configured' };

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const subject = `Canada Buys Tenders: ${newTenders.length} new match${newTenders.length === 1 ? '' : 'es'} (${meta.runDate})`;

    const { error } = await resend.emails.send({
      from: process.env.ALERT_EMAIL_FROM,
      to: process.env.ALERT_EMAIL_TO,
      subject,
      html: buildEmailHtml(newTenders, meta),
    });

    if (error) {
      console.error('[email] Resend returned an error:', error);
      return { sent: false, reason: 'resend-error', error };
    }

    return { sent: true };
  } catch (err) {
    console.error('[email] Failed to send daily match email:', err);
    return { sent: false, reason: 'exception', error: err.message };
  }
}

module.exports = { sendDailyMatchEmail, buildEmailHtml, isEmailConfigured };
