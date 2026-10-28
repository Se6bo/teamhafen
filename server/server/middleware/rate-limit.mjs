import { randomUUID } from 'node:crypto';

const attempts = new Map();

export function rateLimit(maxAttempts = 50, windowMs = 10 * 1000) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = attempts.get(key);

    if (!record || now - record.windowStart > windowMs) {
      attempts.set(key, { windowStart: now, count: 1 });
      return next();
    }

    if (record.count >= maxAttempts) {
      const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: `Too many attempts. Retry after ${retryAfter}s` });
    }

    record.count++;
    next();
  };
}
