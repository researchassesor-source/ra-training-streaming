function createRateLimiter({ windowMs, max, key = (req) => req.ip, message = 'Demasiadas solicitudes. Intenta más tarde.' }) {
  const entries = new Map();

  function middleware(req, res, next) {
    const now = Date.now();
    const identifier = String(key(req) || 'unknown');
    const current = entries.get(identifier);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;

    entry.count += 1;
    entries.set(identifier, entry);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: message, code: 'RATE_LIMITED' });
    }

    if (entries.size > 10_000) {
      for (const [entryKey, value] of entries) {
        if (value.resetAt <= now) entries.delete(entryKey);
      }
    }
    next();
  }

  middleware.reset = () => entries.clear();
  return middleware;
}

module.exports = { createRateLimiter };
