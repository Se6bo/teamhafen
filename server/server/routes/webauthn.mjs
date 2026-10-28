import { Router } from 'express';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { getDb } from '../db/database.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import { signToken } from '../auth/jwt.mjs';
import { hasPrivateVault } from '../auth/private-vault.mjs';
import { APP_NAME } from '../config.mjs';

const router = Router();

const REGISTRATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LOGIN_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

// key = userId -> { challenge, createdAt }
const registrationChallenges = new Map();
// key = opId -> { challenge, createdAt }
const loginChallenges = new Map();

function pruneExpired(map, ttlMs) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now - entry.createdAt > ttlMs) {
      map.delete(key);
    }
  }
}

const cleanupTimer = setInterval(() => {
  pruneExpired(registrationChallenges, REGISTRATION_CHALLENGE_TTL_MS);
  pruneExpired(loginChallenges, LOGIN_CHALLENGE_TTL_MS);
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

function getRpConfig(req) {
  const rpID = process.env.WEBAUTHN_RP_ID || req.hostname;
  const origin = process.env.WEBAUTHN_RP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const rpName = process.env.WEBAUTHN_RP_NAME || APP_NAME;
  return { rpID, origin, rpName };
}

function parseTransports(transports) {
  if (!transports) return undefined;
  try {
    return JSON.parse(transports);
  } catch {
    return undefined;
  }
}

// POST /api/webauthn/register/options
router.post('/register/options', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { rpID, rpName } = getRpConfig(req);

    const dbUser = db.prepare('SELECT id, username, webauthn_user_handle FROM users WHERE id = ?').get(req.user.id);
    if (!dbUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let handle = dbUser.webauthn_user_handle;
    if (!handle) {
      handle = crypto.randomBytes(32).toString('base64url');
      db.prepare('UPDATE users SET webauthn_user_handle = ? WHERE id = ?').run(handle, dbUser.id);
    }

    const existingCredentials = db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(dbUser.id);
    const excludeCredentials = existingCredentials.map((cred) => ({
      id: cred.credential_id,
      transports: parseTransports(cred.transports)
    }));

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: dbUser.username,
      userID: Buffer.from(handle, 'base64url'),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
    });

    registrationChallenges.set(dbUser.id, { challenge: options.challenge, createdAt: Date.now() });

    res.json(options);
  } catch (error) {
    console.error('WebAuthn register options error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/webauthn/register/verify
router.post('/register/verify', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { rpID, origin } = getRpConfig(req);
    const { name, response } = req.body;

    if (!response || typeof response !== 'object') {
      return res.status(400).json({ error: 'Ungültige Anfrage' });
    }

    const stored = registrationChallenges.get(req.user.id);
    if (!stored || Date.now() - stored.createdAt > REGISTRATION_CHALLENGE_TTL_MS) {
      registrationChallenges.delete(req.user.id);
      return res.status(400).json({ error: 'Anfrage abgelaufen, bitte erneut versuchen.' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID
      });
    } catch (verifyError) {
      console.error('WebAuthn registration verification error:', verifyError.message);
      return res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
    }

    const { verified, registrationInfo } = verification;
    if (!verified || !registrationInfo) {
      return res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
    const credentialName = String(name || 'Passkey').slice(0, 100);

    const result = db.prepare(
      'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_type, backed_up, transports, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      req.user.id,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      credential.transports ? JSON.stringify(credential.transports) : null,
      credentialName
    );

    registrationChallenges.delete(req.user.id);

    const saved = db.prepare('SELECT id, name, device_type, created_at FROM webauthn_credentials WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json(saved);
  } catch (error) {
    console.error('WebAuthn register verify error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/webauthn/credentials
router.get('/credentials', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const credentials = db.prepare(
      'SELECT id, name, device_type, backed_up, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);
    res.json(credentials);
  } catch (error) {
    console.error('WebAuthn list credentials error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/webauthn/credentials/:id
router.delete('/credentials/:id', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Passkey nicht gefunden.' });
    }
    res.json({ message: 'Passkey entfernt.' });
  } catch (error) {
    console.error('WebAuthn delete credential error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/webauthn/login/options (public, discoverable/usernameless)
router.post('/login/options', async (req, res) => {
  try {
    const { rpID } = getRpConfig(req);

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred'
    });

    const opId = crypto.randomUUID();
    loginChallenges.set(opId, { challenge: options.challenge, createdAt: Date.now() });

    res.json({ opId, options });
  } catch (error) {
    console.error('WebAuthn login options error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/webauthn/login/verify (public)
router.post('/login/verify', async (req, res) => {
  try {
    const db = getDb();
    const { rpID, origin } = getRpConfig(req);
    const { opId, response } = req.body;

    if (!opId || !response || typeof response !== 'object') {
      return res.status(400).json({ error: 'Ungültige Anfrage' });
    }

    const stored = loginChallenges.get(opId);
    if (!stored || Date.now() - stored.createdAt > LOGIN_CHALLENGE_TTL_MS) {
      loginChallenges.delete(opId);
      return res.status(400).json({ error: 'Anfrage abgelaufen, bitte erneut versuchen.' });
    }

    const credentialId = response.id;
    if (!credentialId || typeof credentialId !== 'string') {
      return res.status(400).json({ error: 'Ungültige Anfrage' });
    }

    const row = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(credentialId);
    if (!row) {
      return res.status(400).json({ error: 'Unbekannter Passkey.' });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: row.credential_id,
          publicKey: row.public_key,
          counter: row.counter,
          transports: parseTransports(row.transports)
        }
      });
    } catch (verifyError) {
      console.error('WebAuthn login verification error:', verifyError.message);
      return res.status(400).json({ error: 'Passkey-Anmeldung fehlgeschlagen.' });
    }

    const { verified, authenticationInfo } = verification;
    if (!verified) {
      return res.status(400).json({ error: 'Passkey-Anmeldung fehlgeschlagen.' });
    }

    db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      authenticationInfo.newCounter, row.id
    );
    loginChallenges.delete(opId);

    const user = db.prepare(
      'SELECT id, username, email, first_name, last_name, role, scrum_role, avatar FROM users WHERE id = ?'
    ).get(row.user_id);

    if (!user) {
      return res.status(400).json({ error: 'Passkey-Anmeldung fehlgeschlagen.' });
    }

    const token = signToken({ id: user.id, username: user.username, role: user.role });

    db.prepare('INSERT INTO activities (user_id, action, entity_type, details) VALUES (?, ?, ?, ?)').run(
      user.id, 'login', 'user', 'Passkey login'
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        scrum_role: user.scrum_role,
        avatar: user.avatar,
        private_vault: hasPrivateVault(user)
      }
    });
  } catch (error) {
    console.error('WebAuthn login verify error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
