// Kleiner Bitwarden-Client für Vaultwarden (nur was das Portal braucht).
// Rechnet wie die offiziellen Apps: PBKDF2-Masterschlüssel, HKDF-Streckung, AES-256-CBC mit
// HMAC-SHA256 ("EncString" Typ 2) und ein RSA-Schlüsselpaar pro Konto. Vaultwarden selbst sieht
// nur verschlüsselte Daten.
import { createCipheriv, createDecipheriv, createHmac, generateKeyPairSync, pbkdf2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);
const KDF_ITERATIONS = 600000;

/* ---------- Krypto ---------- */

function hkdfExpand(prk, info, length = 32) {
  // Bitwarden nutzt nur den Expand-Schritt; 32 Byte = ein Block
  const out = Buffer.alloc(length);
  let previous = Buffer.alloc(0);
  let written = 0;
  for (let i = 1; written < length; i++) {
    previous = createHmac('sha256', prk).update(Buffer.concat([previous, Buffer.from(info), Buffer.from([i])])).digest();
    previous.copy(out, written);
    written += previous.length;
  }
  return out;
}

async function masterKeyFor(password, email, iterations) {
  return pbkdf2Async(Buffer.from(password, 'utf8'), Buffer.from(email.trim().toLowerCase(), 'utf8'), iterations, 32, 'sha256');
}

async function masterPasswordHash(masterKey, password) {
  return (await pbkdf2Async(masterKey, Buffer.from(password, 'utf8'), 1, 32, 'sha256')).toString('base64');
}

function stretch(masterKey) {
  return { enc: hkdfExpand(masterKey, 'enc'), mac: hkdfExpand(masterKey, 'mac') };
}

function splitKey(key64) {
  return { enc: key64.subarray(0, 32), mac: key64.subarray(32, 64) };
}

export function encryptBytes(plain, key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key.enc, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest();
  return `2.${iv.toString('base64')}|${data.toString('base64')}|${mac.toString('base64')}`;
}

export function decryptBytes(encString, key) {
  const match = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(String(encString || ''));
  if (!match) throw new Error('Unbekanntes Format eines verschlüsselten Werts');
  const iv = Buffer.from(match[1], 'base64');
  const data = Buffer.from(match[2], 'base64');
  const mac = Buffer.from(match[3], 'base64');
  const expected = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw new Error('Prüfsumme eines verschlüsselten Werts stimmt nicht');
  const decipher = createDecipheriv('aes-256-cbc', key.enc, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export const encryptText = (text, key) => (text == null || text === '' ? null : encryptBytes(Buffer.from(String(text), 'utf8'), key));
export const decryptText = (enc, key) => (enc == null || enc === '' ? null : decryptBytes(enc, key).toString('utf8'));

// Vaultwarden antwortet je nach Version mit PascalCase oder camelCase: einheitlich camelCase
function camel(value) {
  if (Array.isArray(value)) return value.map(camel);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k.charAt(0).toLowerCase() + k.slice(1)] = camel(v);
    return out;
  }
  return value;
}

/* ---------- Client ---------- */

export class BitwardenClient {
  constructor({ baseUrl, email, password, deviceId, deviceName = 'Teamhafen' }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.email = email.trim().toLowerCase();
    this.password = password;
    this.deviceId = deviceId || randomUUID();
    this.deviceName = deviceName;
    this.session = null; // { accessToken, refreshToken, expiresAt, userKey }
    this.loginPromise = null;
  }

  async http(method, path, { body, form, token, allowStatus = [] } = {}) {
    const headers = { 'Accept': 'application/json', 'Bitwarden-Client-Name': 'cli', 'Bitwarden-Client-Version': '2026.7.0', 'Device-Type': '25' };
    let payload;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(this.baseUrl + path, { method, headers, body: payload });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
    if (!res.ok && !allowStatus.includes(res.status)) {
      const message = data?.message || data?.Message || data?.error_description || data?.errorModel?.message || data?.ErrorModel?.Message || `HTTP ${res.status}`;
      const error = new Error(`Vaultwarden ${method} ${path}: ${message}`);
      error.status = res.status;
      throw error;
    }
    return { status: res.status, data: camel(data) };
  }

  // Konto neu anlegen (nur für die Domain, die Vaultwarden in SIGNUPS_DOMAINS_WHITELIST erlaubt)
  async register(name) {
    const masterKey = await masterKeyFor(this.password, this.email, KDF_ITERATIONS);
    const hash = await masterPasswordHash(masterKey, this.password);
    const userKey = randomBytes(64);
    const key = encryptBytes(userKey, stretch(masterKey));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const keys = { publicKey: publicKey.toString('base64'), encryptedPrivateKey: encryptBytes(privateKey, splitKey(userKey)) };
    const legacy = {
      email: this.email, name, masterPasswordHash: hash, masterPasswordHint: null,
      key, kdf: 0, kdfIterations: KDF_ITERATIONS, keys,
    };
    const res = await this.http('POST', '/identity/accounts/register', { body: legacy, allowStatus: [404] });
    if (res.status === 404) {
      await this.http('POST', '/identity/accounts/register/finish', {
        body: {
          email: this.email, masterPasswordHash: hash, masterPasswordHint: null,
          userSymmetricKey: key, userAsymmetricKeys: keys, kdf: 0, kdfIterations: KDF_ITERATIONS,
        },
      });
    }
  }

  async login() {
    const { data: pre } = await this.http('POST', '/identity/accounts/prelogin', { body: { email: this.email } });
    if (Number(pre.kdf) !== 0) throw new Error('Nur PBKDF2-Konten werden unterstützt');
    const masterKey = await masterKeyFor(this.password, this.email, Number(pre.kdfIterations));
    const hash = await masterPasswordHash(masterKey, this.password);
    const { data } = await this.http('POST', '/identity/connect/token', {
      form: {
        grant_type: 'password', username: this.email, password: hash, scope: 'api offline_access', client_id: 'cli',
        deviceType: '25', deviceIdentifier: this.deviceId, deviceName: this.deviceName,
      },
    });
    const userKey = splitKey(decryptBytes(data.key, stretch(masterKey)));
    this.session = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000, userKey };
    return this.session;
  }

  async token() {
    if (this.session && Date.now() < this.session.expiresAt - 60000) return this.session.accessToken;
    if (this.loginPromise) { await this.loginPromise; return this.session.accessToken; }
    this.loginPromise = (async () => {
      if (this.session?.refreshToken) {
        try {
          const { data } = await this.http('POST', '/identity/connect/token', {
            form: { grant_type: 'refresh_token', client_id: 'cli', refresh_token: this.session.refreshToken },
          });
          Object.assign(this.session, { accessToken: data.access_token, refreshToken: data.refresh_token || this.session.refreshToken, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
          return;
        } catch { /* neu anmelden */ }
      }
      await this.login();
    })().finally(() => { this.loginPromise = null; });
    await this.loginPromise;
    return this.session.accessToken;
  }

  async userKey() {
    await this.token();
    return this.session.userKey;
  }

  async api(method, path, body) {
    const token = await this.token();
    try {
      return (await this.http(method, path, { body, token })).data;
    } catch (error) {
      if (error.status === 401) {
        this.session = null;
        return (await this.http(method, path, { body, token: await this.token() })).data;
      }
      throw error;
    }
  }

  async revisionDate() {
    return this.api('GET', '/api/accounts/revision-date');
  }

  async sync() {
    return this.api('GET', '/api/sync?excludeDomains=true');
  }
}
