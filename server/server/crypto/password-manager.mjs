import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX = process.env.CRYPTO_KEY;

function getKey() {
  if (!KEY_HEX || KEY_HEX.length < 32) {
    throw new Error('CRYPTO_KEY must be at least 32 characters long');
  }
  // Ensure key is 32 bytes (256 bits)
  let key = Buffer.from(KEY_HEX, 'hex');
  if (key.length !== 32) {
    key = Buffer.alloc(32);
    // Fester Salt aus der ersten Version; nicht ändern, sonst lassen sich gespeicherte Werte nicht mehr lesen
    crypto.scryptSync(KEY_HEX, 'nextit-salt', 32, { N: 32768, r: 8, p: 1 }, key);
  }
  return key;
}

export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf-8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted, iv, authTag };
}

export function decrypt(encrypted, iv, authTag) {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf-8');
}
