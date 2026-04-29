// Origin/Referer check for state-changing requests on protected routes.
// Basic Auth doesn't cover CSRF.
export function sameOriginPost(publicUrl) {
  let allowedHost;
  try { allowedHost = new URL(publicUrl).host; } catch { allowedHost = null; }
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin') || req.get('referer') || '';
    if (!origin) return res.status(403).send('Missing Origin/Referer');
    let host;
    try { host = new URL(origin).host; } catch { return res.status(403).send('Bad Origin'); }
    if (allowedHost && host !== allowedHost && host !== req.get('host')) {
      return res.status(403).send('Cross-origin request denied');
    }
    next();
  };
}
