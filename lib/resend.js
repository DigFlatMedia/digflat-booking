// Resend email integration. Single fetch, no SDK.
// Fire-and-forget by default — failures are logged, not thrown to caller.
export async function sendEmail({ to, subject, html, text, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  if (!apiKey) {
    console.warn('[resend] RESEND_API_KEY not set; skipping email to', to);
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `DigFlat Media <${from}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        reply_to: replyTo,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[resend] failed', res.status, data);
      return { ok: false, error: data };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    console.error('[resend] threw', e);
    return { ok: false, error: e.message };
  }
}
