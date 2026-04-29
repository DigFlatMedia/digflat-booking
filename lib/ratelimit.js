// In-memory IP rate limiter. Sliding 1-hour window.
const buckets = new Map();
const WINDOW_MS = 60 * 60 * 1000;

export function rateLimit({ max = 20, key = req => req.ip } = {}) {
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const arr = (buckets.get(k) || []).filter(ts => now - ts < WINDOW_MS);
    if (arr.length >= max) {
      res.status(429).json({ error: 'Too many requests. Try again later.' });
      return;
    }
    arr.push(now);
    buckets.set(k, arr);
    next();
  };
}

// Garbage collect every 10 min.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets.entries()) {
    const fresh = arr.filter(ts => now - ts < WINDOW_MS);
    if (!fresh.length) buckets.delete(k);
    else buckets.set(k, fresh);
  }
}, 10 * 60 * 1000).unref();
