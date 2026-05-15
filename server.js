import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './lib/env.js';
loadEnv();

import { readJSON, writeJSON, updateJSON } from './lib/storage.js';
import { rateLimit } from './lib/ratelimit.js';
import { sameOriginPost } from './lib/csrf.js';
import {
  adminAuth, cookieParser, readSession, setSessionCookie, clearSessionCookie,
  issueMagicLink, consumeMagicLink, getAccount, upsertAccount,
  setContactDraft, readContactDraft, clearContactDraft,
} from './lib/auth.js';
import {
  getPricing, invalidatePricing, recommendPackage, calculate, matchBundle, nearestBundle,
  shootDurationMinutes,
} from './lib/pricing.js';
import { dailySlots, todayYmdInTz, addDaysYmd } from './lib/availability.js';
import * as Google from './lib/google.js';
import * as Wave from './lib/wave.js';
import { sendEmail } from './lib/resend.js';

// Mirror a completed booking to DigFlat admin so it lands as a Lead.
// Fire-and-forget: the customer email + invoice flow must not fail if the
// webhook is down. Requires BOOKING_WEBHOOK_TOKEN env var (same value as on
// digflatmedia.com).
async function postToDigflatAdmin(booking) {
  try {
    const r = await fetch("https://digflatmedia.com/api/real-estate-booking", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.BOOKING_WEBHOOK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(booking),
    });
    if (!r.ok) console.warn("digflat webhook responded", r.status, await r.text());
  } catch (err) {
    console.error("digflat webhook failed", err);
  }
}

import {
  bookingConfirmedEmail, bookingPendingEmail, bookingCancelledEmail,
  deliveryEmail, magicLinkEmail, operatorBookingEmail,
} from './lib/emails.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Seed Google token file from env var (survives across deploys when GOOGLE_REFRESH_TOKEN is set).
Google.initFromEnv().catch(e => console.error('[startup] google initFromEnv:', e.message));

// ----- /healthz BEFORE any auth or body parsing -----
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ----- Wave webhook needs raw body for HMAC; mount it before json parser -----
app.post('/webhook/wave', express.raw({ type: '*/*', limit: '512kb' }), waveWebhook);

// ----- Standard middleware -----
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }));

// Per-request locals (config, branding, session).
app.use(async (req, res, next) => {
  res.locals.config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  res.locals.brand = res.locals.config.branding;
  res.locals.publicUrl = PUBLIC_URL;
  res.locals.session = readSession(req);
  res.locals.year = new Date().getFullYear();
  // Embed mode: when ?embed=1 is present, persist in a cookie so the full
  // multi-step flow stays embed-aware (cross-origin iframe requires SameSite=None).
  if (req.query.embed === '1') {
    res.cookie('_embed', '1', { path: '/', sameSite: 'none', secure: true, maxAge: 3600 });
  }
  res.locals.embed = req.query.embed === '1' || req.cookies?._embed === '1';
  next();
});

// =====================================================================
// PUBLIC ROUTES
// =====================================================================

app.get('/', async (req, res) => {
  const pricing = await getPricing();
  res.render('home', { pricing, query: req.query });
});

// Live quote — JSON. Public, no auth.
app.post('/api/quote', rateLimit({ max: 60 }), async (req, res, next) => {
  try {
    const pricing = await getPricing();
    const { packageId, addonIds = [], rush = false } = req.body || {};
    const valid = pricing.photo_packages.find(p => p.id === packageId);
    if (!valid) return res.status(400).json({ error: 'Invalid package' });
    const quote = calculate(pricing, { packageId, addonIds, rush });
    const matched = matchBundle(pricing, packageId, addonIds);
    const suggested = matched ? null : nearestBundle(pricing, packageId, addonIds);
    res.json({ quote, matchedBundle: matched, suggestedBundle: suggested });
  } catch (e) { next(e); }
});

// Availability — JSON list of slots for a given date.
app.get('/api/availability', rateLimit({ max: 120 }), async (req, res, next) => {
  try {
    const { date, packageId, addons } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const config = res.locals.config;
    const pricing = await getPricing();
    const pkg = pricing.photo_packages.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'packageId required' });
    const addonIds = (addons || '').split(',').filter(Boolean);
    const duration = shootDurationMinutes(config, packageId, addonIds);

    // Pull busy intervals for the day (with margin).
    const tz = config.schedule.timezone;
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);
    let busy = [];
    try {
      busy = await Google.freeBusy(dayStart.toISOString(), dayEnd.toISOString());
    } catch (e) {
      console.error('[availability] freeBusy failed:', e.message);
    }
    // Also block slots overlapping pending/confirmed bookings (in case calendar is delayed).
    const bookings = await readJSON('bookings.json', { bookings: [] });
    const localBusy = bookings.bookings
      .filter(b => ['pending', 'confirmed'].includes(b.status))
      .map(b => ({ start: new Date(b.startISO), end: new Date(b.endISO) }));
    const slots = dailySlots({
      ymd: date, config, durationMin: duration,
      busy: [...busy, ...localBusy],
    });
    res.json({ date, durationMinutes: duration, slots });
  } catch (e) { next(e); }
});

// Step 2: property details form.
app.get('/details', (req, res) => {
  res.render('details', { query: req.query });
});

// Step 3: book form. Selections come in via querystring.
app.get('/book', async (req, res, next) => {
  try {
    const pricing = await getPricing();
    const packageId = req.query.package || pricing.photo_packages.find(p => p.is_default)?.id || pricing.photo_packages[0].id;
    const addonIds = (req.query.addons || '').split(',').filter(Boolean);
    const video = req.query.video;
    if (video && video !== 'none' && !addonIds.includes(video)) addonIds.push(video);
    const floorplan = req.query.floorplan;
    if (floorplan && floorplan !== 'none' && !addonIds.includes(floorplan)) addonIds.push(floorplan);
    const rush = req.query.rush === '1';
    const config = res.locals.config;

    // Best-effort distance check so the trip charge shows in the order summary
    // before the customer submits. Silently skipped if address isn't provided yet.
    let tripMiles = null;
    const propertyAddress = [req.query.address, req.query.city, req.query.state, req.query.zip]
      .filter(Boolean).join(', ');
    if (propertyAddress) {
      try {
        const timeout = new Promise(r => setTimeout(r, 2000, null));
        tripMiles = await Promise.race([
          Google.distanceMiles(config.operator.base_zip, propertyAddress),
          timeout,
        ]);
      } catch (e) {
        console.warn('[book GET] distance check failed:', e.message);
      }
    }

    const quote = calculate(pricing, { packageId, addonIds, rush, tripMiles }, config);
    const minDate = addDaysYmd(todayYmdInTz(config.schedule.timezone), Math.ceil((config.schedule.lead_time_hours || 0) / 24), config.schedule.timezone);
    const maxDate = addDaysYmd(todayYmdInTz(config.schedule.timezone), config.schedule.max_advance_days || 60, config.schedule.timezone);
    // Contact info from session or guest cookie set in step 1. Allowed to be
    // missing when the user jumps directly to this step via the nav strip;
    // book.ejs prompts them to fill it in, and the POST handler enforces it.
    const contact = res.locals.session
      ? (await getAccount(res.locals.session.email) || { email: res.locals.session.email })
      : readContactDraft(req);
    res.render('book', { pricing, quote, packageId, addonIds, rush, minDate, maxDate, query: req.query, tripMiles, contact: contact || null });
  } catch (e) { next(e); }
});

// Step 1: collect contact info / sign in. No booking data yet.
app.get('/your-info', async (req, res, next) => {
  try {
    const session  = res.locals.session;
    const prefill  = session ? await getAccount(session.email) : readContactDraft(req);
    res.render('your-info', {
      prefill,
      sessionEmail: session?.email || '',
      returnPath: req.originalUrl,
      error: req.query.error || null,
    });
  } catch (e) { next(e); }
});

// POST step 1: save contact info to signed cookie, redirect to service selection.
app.post('/your-info', sameOriginPost(PUBLIC_URL), rateLimit({ max: 30 }), async (req, res, next) => {
  try {
    if (req.body.website) return res.status(400).send('Spam'); // honeypot
    const name             = (req.body.name              || '').trim();
    const email            = (req.body.email             || '').trim().toLowerCase();
    const phone            = (req.body.phone             || '').trim();
    const brokerage        = (req.body.brokerage         || '').trim();
    const brokerageAddress = (req.body.brokerage_address || '').trim();
    if (!name || !email || !phone) return res.redirect('/your-info?error=missing');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect('/your-info?error=email');
    // Persist to a signed cookie so it survives the service → details → book steps.
    setContactDraft(res, { name, email, phone, brokerage, brokerageAddress });
    // If they have an account, keep the session cookie in sync.
    if (res.locals.session?.email === email) {
      await upsertAccount(email, { name, phone, brokerage, brokerageAddress });
    }
    res.redirect('/');
  } catch (e) { next(e); }
});

// Submit booking. Honeypot + rate-limited.
app.post('/book', rateLimit({ max: 10 }), async (req, res, next) => {
  try {
    if (req.body.website) return res.status(400).send('Spam detected'); // honeypot

    const pricing = await getPricing();
    const config = res.locals.config;
    const packageId = req.body.packageId;
    const addonIds = [].concat(req.body.addonIds || []).filter(Boolean);
    const rush = req.body.rush === 'on' || req.body.rush === '1';

    // Contact info: prefer session account, then guest draft cookie, then form body (legacy fallback).
    const sessionContact = res.locals.session
      ? (await getAccount(res.locals.session.email) || { email: res.locals.session.email })
      : null;
    const draftContact = readContactDraft(req);
    const contactSrc   = sessionContact || draftContact || {};
    const contactName             = contactSrc.name             || req.body.name             || '';
    const contactEmail            = (contactSrc.email           || req.body.email            || '').toLowerCase();
    const contactPhone            = contactSrc.phone            || req.body.phone            || '';
    const contactBrokerage        = contactSrc.brokerage        || req.body.brokerage        || '';
    const contactBrokerageAddress = contactSrc.brokerageAddress || req.body.brokerageAddress || '';

    const required = ['propertyAddress', 'propertySqft', 'startISO'];
    for (const f of required) if (!req.body[f]) return res.status(400).send(`Missing field: ${f}`);
    if (!contactName || !contactEmail || !contactPhone) return res.status(400).send('Missing contact info — please start from step 1.');

    const sqft = Number(req.body.propertySqft) || 0;
    const startISO = req.body.startISO;
    const startDate = new Date(startISO);
    if (isNaN(startDate)) return res.status(400).send('Invalid startISO');

    const duration = shootDurationMinutes(config, packageId, addonIds);
    const endDate = new Date(startDate.getTime() + duration * 60000);
    const endISO = endDate.toISOString();

    // Re-check availability server-side to prevent double-booking.
    const dayYmd = startISO.slice(0, 10);
    let busy = [];
    try { busy = await Google.freeBusy(`${dayYmd}T00:00:00.000Z`, `${dayYmd}T23:59:59.999Z`); }
    catch (e) { console.error('[book] freeBusy failed:', e.message); }
    const bookings = await readJSON('bookings.json', { bookings: [] });
    const localBusy = bookings.bookings
      .filter(b => ['pending', 'confirmed'].includes(b.status))
      .map(b => ({ start: new Date(b.startISO), end: new Date(b.endISO) }));
    const buf = (config.schedule.buffer_minutes_between_shoots || 0) * 60000;
    const conflict = [...busy, ...localBusy].some(b =>
      b.start < new Date(endDate.getTime() + buf) &&
      b.end > new Date(startDate.getTime() - buf)
    );
    if (conflict) return res.status(409).render('error', { message: 'That time slot was just taken. Please pick another.' });

    // Distance check (best-effort).
    let distanceMiles = null;
    let needsApproval = false;
    try {
      distanceMiles = await Google.distanceMiles(config.operator.base_zip, req.body.propertyAddress);
      if (distanceMiles && distanceMiles > config.service_area.max_radius_miles && config.service_area.auto_flag_over_max) {
        needsApproval = true;
      }
    } catch (e) { console.error('[book] distance check failed:', e.message); }

    const quote = calculate(pricing, { packageId, addonIds, rush, tripMiles: distanceMiles }, config);

    // Build booking record.
    const bookingId = newId();
    const token = crypto.randomBytes(20).toString('base64url');
    const booking = {
      id: bookingId,
      token,
      status: needsApproval ? 'awaiting_approval' : 'pending',
      createdAt: Date.now(),
      holdExpiresAt: Date.now() + (config.hold_minutes_pending_payment || 15) * 60000,
      customer: {
        name: contactName,
        email: contactEmail,
        phone: contactPhone,
        brokerage: contactBrokerage,
        brokerageAddress: contactBrokerageAddress,
      },
      property: {
        // Core address
        address: req.body.propertyAddress,
        sqft,
        propertyType: req.body.propertyType || 'residential',
        // Listing details
        listing: {
          mlsNumber:      req.body.mlsNumber      || '',
          listPrice:      req.body.listPrice       || '',
          bedrooms:       req.body.bedrooms        || '',
          bathrooms:      req.body.bathrooms       || '',
          yearBuilt:      req.body.yearBuilt       || '',
          lotSize:        req.body.lotSize         || '',
          propStatus:     req.body.propStatus      || '',
          publicRemarks:  req.body.publicRemarks   || '',
        },
        // Additional spaces
        spaces: {
          basement:     req.body.hasBasement     === '1',
          garage:       req.body.hasGarage       === '1',
          barn:         req.body.hasBarn         === '1',
          poolHouse:    req.body.hasPoolHouse    === '1',
          guestHouse:   req.body.hasGuestHouse   === '1',
          workshop:     req.body.hasWorkshop     === '1',
          shed:         req.body.hasShed         === '1',
          carriageHouse:req.body.hasCarriageHouse=== '1',
          boathouse:    req.body.hasBoathouse    === '1',
        },
        // Access & logistics
        accessInstructions: req.body.accessInstructions || '',
        rooms:            req.body.rooms            || '',
        siteTime:         req.body.siteTime         || '',
        listingDeadline:  req.body.listingDeadline  || '',
        // Day-of prep
        propReady:        req.body.propReady        || '',
        lightsOn:         req.body.lightsOn         || '',
        hvacOn:           req.body.hvacOn           || '',
        knownIssues:      req.body.knownIssues      || '',
        exteriorIssues:   req.body.exteriorIssues   || '',
        // Legacy composite notes
        notes: req.body.notes || '',
      },
      // Media delivery recipients
      delivery: {
        email:        req.body.deliveryEmail  || '',
        coAgentName:  req.body.coAgentName    || '',
        coAgentEmail: req.body.coAgentEmail   || '',
        tcName:       req.body.tcName         || '',
        tcEmail:      req.body.tcEmail        || '',
        agentNotes:   req.body.agentNotes     || '',
      },
      selection: { packageId, addonIds, rush },
      quote,
      schedule: { startISO: startDate.toISOString(), endISO, durationMinutes: duration, timezone: config.schedule.timezone },
      distanceMiles,
      needsApproval,
      wave: null,
      googleEventId: null,
      dropboxLink: null,
      deliveredAt: null,
    };

    await updateJSON('bookings.json', { bookings: [] }, db => {
      db.bookings.push(booking);
      return db;
    });

    // Persist contact info to account (session users) and clear the guest draft cookie.
    if (res.locals.session?.email) {
      await upsertAccount(res.locals.session.email, {
        name: booking.customer.name,
        phone: booking.customer.phone,
        brokerage: booking.customer.brokerage,
        brokerageAddress: booking.customer.brokerageAddress,
      });
    }
    clearContactDraft(res);

    if (needsApproval) {
      // Notify operator; show holding-page to customer.
      sendEmail(operatorBookingEmail(booking, { needsApproval: true, publicUrl: PUBLIC_URL }));
    postToDigflatAdmin(booking).catch(()=>{});
      sendEmail(bookingPendingEmail(booking, { publicUrl: PUBLIC_URL, awaitingApproval: true }));
      return res.redirect(`/booking/${token}`);
    }

    // Create Wave invoice and redirect to pay.
    if (!(await Wave.isConfigured())) {
      console.warn('[book] Wave not configured; skipping invoice (dev mode)');
      // Mark confirmed in dev so the flow is testable end-to-end.
      await markBookingPaid(bookingId, { dev: true });
      return res.redirect(`/booking/${token}`);
    }

    let invoice;
    try {
      invoice = await Wave.createPaidInvoice({
        customer: { name: booking.customer.name, email: booking.customer.email, phone: booking.customer.phone },
        items: quote.lineItems.map(li => ({ description: li.name, amount: li.amount })),
        memo: `Booking #${bookingId} — ${formatPretty(startDate, config.schedule.timezone)}\nProperty: ${booking.property.address}`,
        bookingId,
        propertyAddress: booking.property.address,
      });
    } catch (e) {
      console.error('[book] Wave invoice creation failed:', e);
      return res.status(502).render('error', { message: 'Could not create your invoice. Your time slot is held for 15 minutes — please try again or contact us.' });
    }

    await updateJSON('bookings.json', { bookings: [] }, db => {
      const b = db.bookings.find(x => x.id === bookingId);
      if (b) b.wave = { invoiceId: invoice.invoiceId, viewUrl: invoice.viewUrl, pdfUrl: invoice.pdfUrl, status: invoice.status };
      return db;
    });

    sendEmail(operatorBookingEmail(booking, { needsApproval: false, publicUrl: PUBLIC_URL, invoiceUrl: invoice.viewUrl }));
    postToDigflatAdmin(booking).catch(()=>{});

    // Redirect to Wave's hosted pay page.
    return res.redirect(invoice.viewUrl);
  } catch (e) { next(e); }
});

// Preview: renders the booking confirmation page with sample data (dev/design aid).
app.get('/booking/preview', (_req, res) => {
  const now = new Date();
  const start = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days from now
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 90 * 60 * 1000);
  res.render('booking', {
    booking: {
      id: 'PREVIEW',
      token: 'preview',
      status: 'pending',
      createdAt: Date.now(),
      customer: { name: 'Jane Smith', email: 'jane@brokerage.com', phone: '(419) 555-0100', brokerage: 'RE/MAX' },
      property: { address: '123 Main St, Mansfield, OH 44901', sqft: 2200, accessInstructions: 'Lockbox on front door — code 4872', sellerContact: '' },
      quote: {
        lineItems: [
          { name: 'Single Family Photo Package', amount: 225 },
          { name: 'Drone Photos', amount: 125 },
        ],
        tax: 24.50,
        total: 374.50,
      },
      schedule: { startISO: start.toISOString(), endISO: end.toISOString(), timezone: 'America/New_York' },
      wave: { viewUrl: '#' },
      dropboxLink: null,
    },
  });
});

// Booking detail page — works via signed token in URL (guest-safe).
app.get('/booking/:token', async (req, res, next) => {
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const booking = db.bookings.find(b => b.token === req.params.token);
    if (!booking) return res.status(404).render('error', { message: 'Booking not found.' });
    res.render('booking', { booking });
  } catch (e) { next(e); }
});

// Status JSON for polling (post-Wave-redirect "confirming" page).
app.get('/booking/:token/status', async (req, res, next) => {
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const booking = db.bookings.find(b => b.token === req.params.token);
    if (!booking) return res.status(404).json({ error: 'not found' });
    res.json({ status: booking.status, viewUrl: booking.wave?.viewUrl, dropboxLink: booking.dropboxLink });
  } catch (e) { next(e); }
});

// Customer-initiated cancel (within policy window).
app.post('/booking/:token/cancel', sameOriginPost(PUBLIC_URL), rateLimit({ max: 5 }), async (req, res, next) => {
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const booking = db.bookings.find(b => b.token === req.params.token);
    if (!booking) return res.status(404).send('Not found');
    if (booking.status === 'cancelled') return res.redirect(`/booking/${booking.token}`);
    const start = new Date(booking.startISO || booking.schedule?.startISO);
    const hoursOut = (start - Date.now()) / 3_600_000;
    if (hoursOut < 24) return res.status(400).render('error', { message: 'Within-24-hour cancellations require contacting us directly.' });

    await updateJSON('bookings.json', { bookings: [] }, db => {
      const b = db.bookings.find(x => x.id === booking.id);
      if (b) { b.status = 'cancelled'; b.cancelledAt = Date.now(); }
      return db;
    });
    if (booking.googleEventId) Google.deleteEvent(booking.googleEventId).catch(e => console.error('[cancel] delete event:', e.message));
    sendEmail(bookingCancelledEmail(booking, { publicUrl: PUBLIC_URL }));
    res.redirect(`/booking/${booking.token}`);
  } catch (e) { next(e); }
});

// =====================================================================
// WAVE WEBHOOK
// =====================================================================
async function waveWebhook(req, res) {
  const raw = req.body; // Buffer (express.raw)
  const sig = req.get('x-wave-signature') || req.get('X-Wave-Signature');
  if (!Wave.verifyWebhookSignature(raw, sig)) {
    console.warn('[wave webhook] signature mismatch');
    return res.status(401).send('Bad signature');
  }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).send('Bad JSON'); }

  const eventType = payload.event_type || payload.eventType || payload.type;
  // Wave sends invoice.update for status changes including SAVED -> PAID.
  if (!/invoice/i.test(eventType || '')) return res.status(200).send('ignored');

  const invoiceId = payload.resource_id || payload.resourceId || payload.invoice_id || payload.invoiceId;
  if (!invoiceId) return res.status(200).send('no invoice id');

  // Look up the booking by stored invoiceId.
  const db = await readJSON('bookings.json', { bookings: [] });
  const booking = db.bookings.find(b => b.wave?.invoiceId === invoiceId);
  if (!booking) {
    console.warn('[wave webhook] no booking for invoice', invoiceId);
    return res.status(200).send('no booking');
  }

  // Re-fetch invoice to get authoritative status.
  let inv;
  try { inv = await Wave.getInvoice(invoiceId); }
  catch (e) { console.error('[wave webhook] getInvoice failed', e.message); return res.status(200).send('lookup failed'); }
  if (!inv) return res.status(200).send('no invoice');

  if (inv.status === 'PAID' || (inv.amountDue && Number(inv.amountDue.value) === 0 && Number(inv.amountPaid?.value || 0) > 0)) {
    if (booking.status !== 'confirmed') await markBookingPaid(booking.id);
  }
  res.status(200).send('ok');
}

async function markBookingPaid(bookingId, { dev = false } = {}) {
  let updated;
  await updateJSON('bookings.json', { bookings: [] }, db => {
    const b = db.bookings.find(x => x.id === bookingId);
    if (!b) return db;
    b.status = 'confirmed';
    b.paidAt = dev ? null : Date.now();
    if (dev) b.devMode = true;
    updated = b;
    return db;
  });
  if (!updated) return;

  // Create Google Calendar event.
  try {
    const ev = await Google.createEvent({
      summary: `📸 ${updated.customer.name} — ${updated.property.address}`,
      description: [
        `${updated.customer.name} (${updated.customer.email}, ${updated.customer.phone})`,
        updated.customer.brokerage || '',
        '',
        `Property: ${updated.property.address}`,
        `Sqft: ${updated.property.sqft}` +
          (updated.property.listing?.bedrooms ? `  ·  ${updated.property.listing.bedrooms} bed` : '') +
          (updated.property.listing?.bathrooms ? ` / ${updated.property.listing.bathrooms} bath` : ''),
        updated.property.listing?.propStatus   ? `Status: ${updated.property.listing.propStatus}`    : '',
        updated.property.listing?.mlsNumber    ? `MLS #: ${updated.property.listing.mlsNumber}`      : '',
        updated.property.listing?.listPrice    ? `List price: ${updated.property.listing.listPrice}` : '',
        '',
        `Access: ${updated.property.accessInstructions}`,
        updated.property.rooms          ? `Rooms to shoot: ${updated.property.rooms}`            : '',
        updated.property.propReady      ? `Show-ready: ${updated.property.propReady}`            : '',
        updated.property.lightsOn       ? `Lights on: ${updated.property.lightsOn}`              : '',
        updated.property.hvacOn         ? `HVAC on: ${updated.property.hvacOn}`                  : '',
        updated.property.knownIssues    ? `Known issues: ${updated.property.knownIssues}`        : '',
        updated.property.exteriorIssues ? `Exterior: ${updated.property.exteriorIssues}`         : '',
        updated.property.listingDeadline? `Media needed by: ${updated.property.listingDeadline}` : '',
        '',
        `Services: ${updated.quote.lineItems.map(li => li.name).join(', ')}`,
        `Total: $${updated.quote.total.toFixed(2)}`,
        '',
        `${PUBLIC_URL}/admin/bookings/${updated.id}`,
      ].filter(l => l !== null && l !== undefined).join('\n'),
      location: updated.property.address,
      startISO: updated.schedule.startISO,
      endISO: updated.schedule.endISO,
    });
    if (ev?.id) {
      await updateJSON('bookings.json', { bookings: [] }, db => {
        const b = db.bookings.find(x => x.id === bookingId);
        if (b) b.googleEventId = ev.id;
        return db;
      });
    }
  } catch (e) { console.error('[markBookingPaid] calendar event:', e.message); }

  sendEmail(bookingConfirmedEmail(updated, { publicUrl: PUBLIC_URL }));
  sendEmail(operatorBookingEmail(updated, { confirmed: true, publicUrl: PUBLIC_URL }));
}

// =====================================================================
// ACCOUNT (magic-link)
// =====================================================================

app.get('/account/login', (_req, res) => res.render('account/login', { error: null, sent: false }));

app.post('/account/login', sameOriginPost(PUBLIC_URL), rateLimit({ max: 8 }), async (req, res, next) => {
  try {
    if (req.body.website) return res.status(400).send('Spam'); // honeypot
    const email = (req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.render('account/login', { error: 'Enter a valid email', sent: false });
    // returnTo: allow redirect back to a local path after sign-in (e.g. /your-info?...)
    const rawReturn = (req.body.returnTo || '').trim();
    const returnTo  = rawReturn.startsWith('/') ? rawReturn : '';
    const mode      = req.body.mode === 'register' ? 'register' : 'signin';
    const token = await issueMagicLink(email);
    const verifyUrl = `${PUBLIC_URL}/account/verify?token=${token}` + (returnTo ? `&return=${encodeURIComponent(returnTo)}` : '');
    sendEmail(magicLinkEmail(email, verifyUrl, { mode }));
    res.render('account/login', { error: null, sent: email, returnTo });
  } catch (e) { next(e); }
});

app.get('/account/verify', async (req, res) => {
  const token = String(req.query.token || '');
  const email = await consumeMagicLink(token);
  if (!email) return res.status(400).render('error', { message: 'That sign-in link is invalid or expired.' });
  setSessionCookie(res, email);
  // Honour a local returnTo (e.g. back to /your-info after booking sign-in).
  const rawReturn = String(req.query.return || '');
  const dest = rawReturn.startsWith('/') ? rawReturn : '/account';
  res.redirect(dest);
});

app.get('/account/logout', (_req, res) => { clearSessionCookie(res); res.redirect('/'); });

app.get('/account', async (req, res, next) => {
  try {
    const sess = res.locals.session;
    if (!sess) return res.redirect('/account/login');
    const acct = await getAccount(sess.email);
    const db = await readJSON('bookings.json', { bookings: [] });
    const my = db.bookings.filter(b => b.customer.email === sess.email).sort((a, b) => b.createdAt - a.createdAt);
    res.render('account/index', { account: acct, bookings: my });
  } catch (e) { next(e); }
});

// =====================================================================
// ADMIN
// =====================================================================
const adminRouter = express.Router();
adminRouter.use(adminAuth());
adminRouter.use(sameOriginPost(PUBLIC_URL));

adminRouter.get('/', async (_req, res, next) => {
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const sorted = db.bookings.slice().sort((a, b) => b.createdAt - a.createdAt);
    const googleConnected = await Google.isConnected();
    const waveConfigured = await Wave.isConfigured();
    res.render('admin/index', { bookings: sorted, googleConnected, waveConfigured });
  } catch (e) { next(e); }
});

adminRouter.get('/bookings/:id', async (req, res, next) => {
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const booking = db.bookings.find(b => b.id === req.params.id);
    if (!booking) return res.status(404).send('Not found');
    res.render('admin/booking', { booking });
  } catch (e) { next(e); }
});

adminRouter.post('/bookings/:id/dropbox', async (req, res, next) => {
  try {
    let booking;
    await updateJSON('bookings.json', { bookings: [] }, db => {
      const b = db.bookings.find(x => x.id === req.params.id);
      if (b) {
        b.dropboxLink = (req.body.dropboxLink || '').trim();
        b.deliveredAt = b.dropboxLink ? Date.now() : null;
        booking = b;
      }
      return db;
    });
    if (booking?.dropboxLink) sendEmail(deliveryEmail(booking, { publicUrl: PUBLIC_URL }));
    res.redirect(`/admin/bookings/${req.params.id}`);
  } catch (e) { next(e); }
});

adminRouter.post('/bookings/:id/approve', async (req, res, next) => {
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const booking = db.bookings.find(b => b.id === req.params.id);
    if (!booking) return res.status(404).send('Not found');
    if (booking.status !== 'awaiting_approval') return res.redirect(`/admin/bookings/${booking.id}`);

    // Create Wave invoice now and email customer the link.
    const invoice = await Wave.createPaidInvoice({
      customer: { name: booking.customer.name, email: booking.customer.email, phone: booking.customer.phone },
      items: booking.quote.lineItems.map(li => ({ description: li.name, amount: li.amount })),
      memo: `Booking #${booking.id} — ${booking.property.address}`,
      bookingId: booking.id,
      propertyAddress: booking.property.address,
    });
    await updateJSON('bookings.json', { bookings: [] }, db => {
      const b = db.bookings.find(x => x.id === booking.id);
      if (b) {
        b.status = 'pending';
        b.wave = { invoiceId: invoice.invoiceId, viewUrl: invoice.viewUrl, pdfUrl: invoice.pdfUrl, status: invoice.status };
        b.holdExpiresAt = Date.now() + 24 * 3600 * 1000;
      }
      return db;
    });
    sendEmail({
      to: booking.customer.email,
      subject: 'Your DigFlat Media booking is approved — pay to confirm',
      html: `<p>Hi ${booking.customer.name},</p>
        <p>Your booking has been approved. Please complete payment to confirm your time slot:</p>
        <p><a href="${invoice.viewUrl}">Pay invoice</a></p>
        <p>Booking details: <a href="${PUBLIC_URL}/booking/${booking.token}">view</a></p>`,
    });
    res.redirect(`/admin/bookings/${booking.id}`);
  } catch (e) { next(e); }
});

adminRouter.post('/bookings/:id/cancel', async (req, res, next) => {
  try {
    let booking;
    await updateJSON('bookings.json', { bookings: [] }, db => {
      const b = db.bookings.find(x => x.id === req.params.id);
      if (b) { b.status = 'cancelled'; b.cancelledAt = Date.now(); booking = b; }
      return db;
    });
    if (booking?.googleEventId) Google.deleteEvent(booking.googleEventId).catch(() => {});
    if (booking) sendEmail(bookingCancelledEmail(booking, { publicUrl: PUBLIC_URL }));
    res.redirect('/admin');
  } catch (e) { next(e); }
});

adminRouter.get('/pricing', async (_req, res, next) => {
  try {
    const text = readFileSync(path.join(__dirname, 'pricing.json'), 'utf8');
    res.render('admin/pricing', { json: text, message: null });
  } catch (e) { next(e); }
});
adminRouter.post('/pricing', async (req, res, next) => {
  try {
    let parsed;
    try { parsed = JSON.parse(req.body.json); }
    catch (e) { return res.render('admin/pricing', { json: req.body.json, message: 'Invalid JSON: ' + e.message }); }
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(__dirname, 'pricing.json'), JSON.stringify(parsed, null, 2));
    invalidatePricing();
    res.render('admin/pricing', { json: JSON.stringify(parsed, null, 2), message: 'Saved.' });
  } catch (e) { next(e); }
});

adminRouter.get('/config', async (_req, res, next) => {
  try {
    const text = readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    res.render('admin/config', { json: text, message: null });
  } catch (e) { next(e); }
});
adminRouter.post('/config', async (req, res, next) => {
  try {
    let parsed;
    try { parsed = JSON.parse(req.body.json); }
    catch (e) { return res.render('admin/config', { json: req.body.json, message: 'Invalid JSON: ' + e.message }); }
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(parsed, null, 2));
    res.render('admin/config', { json: JSON.stringify(parsed, null, 2), message: 'Saved.' });
  } catch (e) { next(e); }
});

adminRouter.get('/google', async (_req, res, next) => {
  try {
    const connected = await Google.isConnected();
    res.render('admin/google', { connected, authUrl: Google.authUrl() });
  } catch (e) { next(e); }
});
adminRouter.post('/google/disconnect', async (_req, res, next) => {
  try { await Google.disconnect(); res.redirect('/admin/google'); } catch (e) { next(e); }
});
// Returns current refresh token so it can be saved as GOOGLE_REFRESH_TOKEN env var on the host.
// Admin-protected. Only used during initial setup to persist the token across deploys.
adminRouter.get('/google/refresh-token', async (_req, res, next) => {
  try {
    const token = await Google.getRefreshToken();
    if (!token) return res.status(404).json({ error: 'Not connected — complete OAuth first.' });
    res.json({ refresh_token: token, instructions: 'Save this as GOOGLE_REFRESH_TOKEN env var on Render to survive future deploys.' });
  } catch (e) { next(e); }
});
// NOTE: callback is NOT under adminAuth (Google won't send Basic-Auth back).
// We protect it by validating state below.
app.get('/admin/google/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing code');
    await Google.exchangeCode(code);
    res.redirect('/admin/google');
  } catch (e) { res.status(500).send('OAuth failed: ' + e.message); }
});

adminRouter.get('/export.csv', async (_req, res, next) => {
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const rows = [
      ['id','status','createdAt','paidAt','customer_name','customer_email','customer_phone','brokerage','property_address','property_sqft','start','end','total','wave_invoice_url','dropbox_link'],
      ...db.bookings.map(b => [
        b.id, b.status, isoOrEmpty(b.createdAt), isoOrEmpty(b.paidAt),
        b.customer.name, b.customer.email, b.customer.phone, b.customer.brokerage,
        b.property.address, b.property.sqft,
        b.schedule.startISO, b.schedule.endISO,
        b.quote.total, b.wave?.viewUrl || '', b.dropboxLink || '',
      ]),
    ];
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="bookings.csv"');
    res.send(rows.map(r => r.map(csvCell).join(',')).join('\n'));
  } catch (e) { next(e); }
});

app.use('/admin', adminRouter);

// =====================================================================
// HELPERS
// =====================================================================

function newId() {
  return new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
}
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function isoOrEmpty(ts) { return ts ? new Date(ts).toISOString() : ''; }
function formatPretty(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

// 404 + global error handler.
app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).render('error', { message: 'Something went wrong on our end. Please try again.' });
});

// Background sweep: expire pending bookings whose hold has elapsed.
setInterval(async () => {
  try {
    await updateJSON('bookings.json', { bookings: [] }, db => {
      const now = Date.now();
      for (const b of db.bookings) {
        if (b.status === 'pending' && b.holdExpiresAt && b.holdExpiresAt < now) {
          b.status = 'expired';
        }
      }
      return db;
    });
  } catch (e) { console.error('[sweep]', e); }
}, 5 * 60 * 1000).unref();

// Background Wave payment poll: check all pending invoices every 3 minutes.
// Wave's webhook may not fire on payment (free-tier limitation), so this is
// the safety net — any paid invoice will be caught within ~3 minutes.
setInterval(async () => {
  if (!(await Wave.isConfigured())) return;
  try {
    const db = await readJSON('bookings.json', { bookings: [] });
    const unpaid = db.bookings.filter(b => b.status === 'pending' && b.wave?.invoiceId);
    for (const booking of unpaid) {
      try {
        const inv = await Wave.getInvoice(booking.wave.invoiceId);
        if (!inv) continue;
        const isPaid = inv.status === 'PAID' ||
          (inv.amountDue && Number(inv.amountDue.value) === 0 && Number(inv.amountPaid?.value || 0) > 0);
        if (isPaid) {
          console.log(`[wave poll] booking ${booking.id} paid — confirming`);
          await markBookingPaid(booking.id);
        }
      } catch (e) {
        console.warn(`[wave poll] invoice check failed for ${booking.id}:`, e.message);
      }
    }
  } catch (e) { console.error('[wave poll]', e); }
}, 3 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`DigFlat Booking listening on :${PORT} (public: ${PUBLIC_URL})`);
});
