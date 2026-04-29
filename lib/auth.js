// Two auth flavors:
// 1. Admin: HTTP Basic Auth with constant-time compare
// 2. Customer: signed cookie (HMAC) over magic-link tokens stored in accounts.json
import crypto from 'node:crypto';
import { updateJSON, readJSON } from './storage.js';

// ---- Admin Basic Auth ----
export function adminAuth() {
  return (req, res, next) => {
    const user = process.env.ADMIN_USER || '';
    const pass = process.env.ADMIN_PASS || '';
    if (!user || !pass) return res.status(500).send('Admin auth not configured');
    const header = req.get('authorization') || '';
    if (!header.startsWith('Basic ')) return prompt(res);
    let decoded;
    try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
    catch { return prompt(res); }
    const idx = decoded.indexOf(':');
    if (idx < 0) return prompt(res);
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    const ok = safeEqual(u, user) & safeEqual(p, pass);
    if (!ok) return prompt(res);
    next();
  };
  function prompt(res) {
    res.set('WWW-Authenticate', 'Basic realm="DigFlat Admin"');
    res.status(401).send('Authentication required');
  }
}

function safeEqual(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ab.length !== bb.length) return 0;
  return crypto.timingSafeEqual(ab, bb) ? 1 : 0;
}

// ---- Customer signed cookie ----
const COOKIE_NAME = 'df_sess';
const COOKIE_MAX_AGE_DAYS = 60;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars)');
  return s;
}
function sign(value) {
  const h = crypto.createHmac('sha256', secret()).update(value).digest('base64url');
  return `${value}.${h}`;
}
function verify(signed) {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret()).update(value).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}

export function setSessionCookie(res, email) {
  const value = `${email}|${Date.now()}`;
  res.cookie(COOKIE_NAME, sign(value), {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.PUBLIC_URL || '').startsWith('https://'),
    maxAge: COOKIE_MAX_AGE_DAYS * 24 * 3600 * 1000,
  });
}
export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

export function readSession(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  const v = verify(raw);
  if (!v) return null;
  const [email, tsStr] = v.split('|');
  const ts = Number(tsStr);
  if (!email || !ts) return null;
  if (Date.now() - ts > COOKIE_MAX_AGE_DAYS * 24 * 3600 * 1000) return null;
  return { email };
}

// ---- Cookie parser (no cookie-parser dep) ----
export function cookieParser() {
  return (req, _res, next) => {
    const header = req.headers.cookie || '';
    const out = {};
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (!k) continue;
      out[k] = decodeURIComponent(rest.join('='));
    }
    req.cookies = out;
    next();
  };
}

// ---- Magic link token store ----
// accounts.json shape:
//   { accounts: { "email@x.com": { name, phone, brokerage, createdAt } }, magicLinks: [{ email, token, expiresAt }] }
const ACCOUNTS_FILE = 'accounts.json';
const ACCOUNTS_DEFAULT = { accounts: {}, magicLinks: [] };

export async function issueMagicLink(email) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + 30 * 60 * 1000;
  await updateJSON(ACCOUNTS_FILE, ACCOUNTS_DEFAULT, db => {
    db.magicLinks = (db.magicLinks || []).filter(m => m.expiresAt > Date.now() && m.email !== email.toLowerCase());
    db.magicLinks.push({ email: email.toLowerCase(), token, expiresAt });
    return db;
  });
  return token;
}

export async function consumeMagicLink(token) {
  let email = null;
  await updateJSON(ACCOUNTS_FILE, ACCOUNTS_DEFAULT, db => {
    db.magicLinks = db.magicLinks || [];
    const i = db.magicLinks.findIndex(m => m.token === token && m.expiresAt > Date.now());
    if (i < 0) return db;
    email = db.magicLinks[i].email;
    db.magicLinks.splice(i, 1);
    if (!db.accounts[email]) db.accounts[email] = { createdAt: Date.now() };
    return db;
  });
  return email;
}

export async function getAccount(email) {
  if (!email) return null;
  const db = await readJSON(ACCOUNTS_FILE, ACCOUNTS_DEFAULT);
  return db.accounts[email.toLowerCase()] || null;
}

export async function upsertAccount(email, patch) {
  await updateJSON(ACCOUNTS_FILE, ACCOUNTS_DEFAULT, db => {
    const e = email.toLowerCase();
    db.accounts[e] = { ...(db.accounts[e] || {}), ...patch };
    return db;
  });
}
