// Hand-rolled Google OAuth + Calendar (freeBusy + events.insert).
// One-time consent stores a refresh token to disk. Access tokens are
// derived per request and cached briefly in memory.
import { readJSON, writeJSON } from './storage.js';

const TOKEN_FILE = 'google-token.json';
let cachedAccess = null; // { token, expiresAt }

export function authUrl(state) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', requireEnv('GOOGLE_CLIENT_ID'));
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('scope', [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ].join(' '));
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

function redirectUri() {
  const base = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  return base.replace(/\/$/, '') + '/admin/google/callback';
}
function requireEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

export async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google token exchange failed: ' + JSON.stringify(data));
  if (!data.refresh_token) {
    throw new Error('No refresh_token returned. Re-consent with prompt=consent (revoke at myaccount.google.com first).');
  }
  await writeJSON(TOKEN_FILE, {
    refresh_token: data.refresh_token,
    scope: data.scope,
    obtained_at: Date.now(),
  });
  cachedAccess = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return true;
}

async function getAccessToken() {
  if (cachedAccess && cachedAccess.expiresAt > Date.now()) return cachedAccess.token;
  const stored = await readJSON(TOKEN_FILE, null);
  if (!stored?.refresh_token) throw new Error('Google Calendar not connected. Visit /admin/google to authorize.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refresh_token: stored.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google token refresh failed: ' + JSON.stringify(data));
  cachedAccess = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

export async function isConnected() {
  const stored = await readJSON(TOKEN_FILE, null);
  return !!stored?.refresh_token;
}

export async function disconnect() {
  await writeJSON(TOKEN_FILE, {});
  cachedAccess = null;
}

// Get busy intervals between two ISO timestamps for the configured calendar.
// If Google isn't connected, returns [] so dev/preview still works.
export async function freeBusy(timeMinISO, timeMaxISO) {
  if (!(await isConnected())) return [];
  const token = await getAccessToken();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      timeMin: timeMinISO, timeMax: timeMaxISO,
      items: [{ id: calendarId }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('freeBusy failed: ' + JSON.stringify(data));
  const cal = data.calendars?.[calendarId] || {};
  return (cal.busy || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export async function createEvent({ summary, description, location, startISO, endISO, attendees = [] }) {
  if (!(await isConnected())) return null;
  const token = await getAccessToken();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary, description, location,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: attendees.map(email => ({ email })),
      reminders: { useDefault: true },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('events.insert failed: ' + JSON.stringify(data));
  return { id: data.id, htmlLink: data.htmlLink };
}

export async function deleteEvent(eventId) {
  if (!eventId || !(await isConnected())) return;
  const token = await getAccessToken();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'DELETE',
    headers: { 'authorization': `Bearer ${token}` },
  });
}

// One-shot distance check via Distance Matrix API. Returns miles or null.
export async function distanceMiles(originZip, destinationAddress) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const u = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  u.searchParams.set('origins', originZip);
  u.searchParams.set('destinations', destinationAddress);
  u.searchParams.set('units', 'imperial');
  u.searchParams.set('key', key);
  const res = await fetch(u);
  const data = await res.json();
  const el = data.rows?.[0]?.elements?.[0];
  if (!el || el.status !== 'OK') return null;
  return el.distance.value / 1609.344;
}
