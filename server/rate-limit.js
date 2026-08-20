const redis = require('./redis');

function createRateLimiter({ windowMs, max, key = (req) => req.ip, message = 'Demasiadas solicitudes. Intenta más tarde.' }) {
  const entries = new Map();

  function applyHeaders(res, { count, resetAt, ttlMs }) {
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    if (count > max) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ttlMs / 1000))));
  }

  async function middleware(req, res, next) {
    const now = Date.now();
    const identifier = String(key(req) || 'unknown');
    if (redis.hasRedis()) {
      try {
        const result = await redis.incrementWindow(identifier, windowMs);
        const ttlMs = result?.ttlMs > 0 ? result.ttlMs : windowMs;
        applyHeaders(res, { count: result.count, resetAt: now + ttlMs, ttlMs });
        if (result.count > max) return res.status(429).json({ error: message, code: 'RATE_LIMITED' });
        return next();
      } catch (error) {
        return next(error);
      }
    }

    const current = entries.get(identifier);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;

    entry.count += 1;
    entries.set(identifier, entry);
    applyHeaders(res, { count: entry.count, resetAt: entry.resetAt, ttlMs: entry.resetAt - now });

    if (entry.count > max) {
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
