import jwt from 'jsonwebtoken';

// Ohne JWT_SECRET startet der Server nicht (siehe index.mjs)
const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = '7d';

export function signToken(payload, expiresIn = EXPIRES_IN) {
  return jwt.sign(payload, SECRET, { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
