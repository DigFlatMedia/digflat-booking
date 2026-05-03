// Email template helpers. Returns { to, subject, html, text } objects
// ready to pass to sendEmail().

function base(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px 16px; }
  h2 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #555; font-size: 14px; margin-bottom: 24px; }
  table.line-items { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  table.line-items td { padding: 6px 0; border-bottom: 1px solid #eee; }
  table.line-items td.right { text-align: right; }
  .total-row td { font-weight: bold; font-size: 16px; border-top: 2px solid #1a1a1a; border-bottom: none; }
  .btn { display: inline-block; background: #c9a55a; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 4px; font-size: 15px; margin-top: 16px; }
  .footer { margin-top: 32px; font-size: 12px; color: #888; border-top: 1px solid #eee; padding-top: 16px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
  .badge-confirmed { background: #d4edda; color: #155724; }
  .badge-pending   { background: #fff3cd; color: #856404; }
  .badge-cancelled { background: #f8d7da; color: #721c24; }
</style></head><body>
<p style="font-size:18px; font-weight:bold; letter-spacing:1px;">DIGFLAT MEDIA</p>
<h2>${title}</h2>
${body}
<div class="footer">DigFlat Media · Mansfield, OH · <a href="https://digflatmedia.com">digflatmedia.com</a></div>
</body></html>`;
}

function lineItemsTable(quote) {
  const rows = quote.lineItems.map(li =>
    `<tr><td>${li.name}</td><td class="right">$${li.amount.toFixed(2)}</td></tr>`
  ).join('');
  const taxRow = quote.tax > 0 ? `<tr><td>Ohio Sales Tax (${(quote.taxRate * 100).toFixed(1)}%)</td><td class="right">$${quote.tax.toFixed(2)}</td></tr>` : '';
  return `<table class="line-items">${rows}${taxRow}
    <tr class="total-row"><td>Total Due</td><td class="right">$${quote.total.toFixed(2)}</td></tr>
  </table>`;
}

function detailBlock(booking) {
  const start = new Date(booking.schedule?.startISO || booking.startISO);
  const dateStr = start.toLocaleString('en-US', { timeZone: booking.schedule?.timezone || 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `
    <p><strong>Property:</strong> ${booking.property.address}</p>
    <p><strong>Date &amp; time:</strong> ${dateStr}</p>
    <p><strong>Access:</strong> ${booking.property.accessInstructions || 'See notes'}</p>`;
}

// ── Customer emails ──────────────────────────────────────────────────

export function bookingPendingEmail(booking, { publicUrl, awaitingApproval = false }) {
  const title = awaitingApproval ? 'Booking request received' : 'Complete payment to confirm your booking';
  const body = `
    <p class="sub">Hi ${booking.customer.name},</p>
    ${awaitingApproval
      ? `<p>We've received your booking request and are reviewing it. You'll hear from us shortly to confirm availability and send your payment link.</p>`
      : `<p>Your booking is <strong>not yet confirmed</strong>. Please complete payment to hold your time slot.</p>
         <a class="btn" href="${booking.wave?.viewUrl}">Pay Invoice</a>
         <p style="font-size:13px;color:#888;margin-top:8px;">Your slot is held for 15 minutes. Payment must clear to finalize.</p>`
    }
    ${detailBlock(booking)}
    ${lineItemsTable(booking.quote)}
    <p><a href="${publicUrl}/booking/${booking.token}">View booking details</a></p>`;
  return {
    to: booking.customer.email,
    subject: awaitingApproval ? 'DigFlat Media — booking request received' : 'DigFlat Media — complete payment to confirm',
    html: base(title, body),
  };
}

export function bookingConfirmedEmail(booking, { publicUrl }) {
  const body = `
    <p class="sub">Hi ${booking.customer.name},</p>
    <p>Your booking is <span class="badge badge-confirmed">CONFIRMED</span> — payment received. We'll see you at the shoot!</p>
    ${detailBlock(booking)}
    ${lineItemsTable(booking.quote)}
    <p>Need to make changes? <a href="${publicUrl}/booking/${booking.token}">View booking</a> or reply to this email.</p>`;
  return {
    to: booking.customer.email,
    subject: 'DigFlat Media — booking confirmed ✓',
    html: base('Booking Confirmed', body),
  };
}

export function bookingCancelledEmail(booking, { publicUrl }) {
  const body = `
    <p class="sub">Hi ${booking.customer.name},</p>
    <p>Your booking has been <span class="badge badge-cancelled">CANCELLED</span>.</p>
    ${detailBlock(booking)}
    <p>If you'd like to rebook, visit <a href="${publicUrl}">book.digflatmedia.com</a>.</p>
    <p>Questions? Reply to this email.</p>`;
  return {
    to: booking.customer.email,
    subject: 'DigFlat Media — booking cancelled',
    html: base('Booking Cancelled', body),
  };
}

export function deliveryEmail(booking, { publicUrl }) {
  const body = `
    <p class="sub">Hi ${booking.customer.name},</p>
    <p>Your photos are ready! Download them from Dropbox using the link below.</p>
    <a class="btn" href="${booking.dropboxLink}">Download Photos</a>
    <p style="margin-top:16px;font-size:13px;color:#555;">
      <strong>Property:</strong> ${booking.property.address}<br>
      <a href="${publicUrl}/booking/${booking.token}">View booking details</a>
    </p>
    <p style="font-size:13px;color:#888;">This link was sent to ${booking.customer.email}. If you have trouble accessing it, reply to this email.</p>`;
  return {
    to: booking.customer.email,
    subject: 'Your DigFlat Media photos are ready 📸',
    html: base('Your Photos Are Ready', body),
  };
}

export function magicLinkEmail(email, link, { mode = 'signin' } = {}) {
  const isRegister = mode === 'register';
  const heading = isRegister ? 'Welcome to DigFlat Media!' : 'Sign In Link';
  const intro   = isRegister
    ? `<p>Thanks for creating an account! Click below to activate it — no password needed. This link expires in 30 minutes.</p>`
    : `<p>Click the button below to sign in to your DigFlat Media account. This link expires in 30 minutes.</p>`;
  const btnText = isRegister ? 'Activate my account' : 'Sign in';
  const body = `
    ${intro}
    <a class="btn" href="${link}">${btnText}</a>
    <p style="margin-top:12px;font-size:12px;color:#888;">If you didn't request this, you can safely ignore this email.</p>`;
  return {
    to: email,
    subject: isRegister ? 'Welcome to DigFlat Media — activate your account' : 'Sign in to DigFlat Media',
    html: base(heading, body),
  };
}

// ── Operator emails ──────────────────────────────────────────────────

export function operatorBookingEmail(booking, { needsApproval = false, confirmed = false, publicUrl, invoiceUrl }) {
  const operatorEmail = process.env.OPERATOR_EMAIL || 'bryan@digflat.com';
  const title = needsApproval ? '⚠️ New booking requires approval' : confirmed ? '✅ Booking confirmed — payment received' : '🗓 New booking — invoice sent';
  const body = `
    <p><strong>Booking #${booking.id}</strong></p>
    <p><strong>Client:</strong> ${booking.customer.name} (${booking.customer.email}, ${booking.customer.phone})<br>
    ${booking.customer.brokerage ? `<strong>Brokerage:</strong> ${booking.customer.brokerage}<br>` : ''}
    <strong>Property:</strong> ${booking.property.address} (${booking.property.sqft} sqft)<br>
    ${booking.distanceMiles ? `<strong>Distance:</strong> ~${Math.round(booking.distanceMiles)} miles` : ''}</p>
    ${detailBlock(booking)}
    ${lineItemsTable(booking.quote)}
    ${invoiceUrl ? `<p><a href="${invoiceUrl}">View Wave Invoice</a></p>` : ''}
    <p><a href="${publicUrl}/admin/bookings/${booking.id}">Manage in admin →</a></p>`;
  return {
    to: operatorEmail,
    subject: `DigFlat — ${title}`,
    html: base(title, body),
    replyTo: booking.customer.email,
  };
}
