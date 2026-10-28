import { Router } from 'express';
import { rateLimit } from '../middleware/rate-limit.mjs';
import { getDb } from '../db/database.mjs';
import { hashPassword, comparePassword } from '../auth/passwords.mjs';
import { signToken } from '../auth/jwt.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import { hasPrivateVault } from '../auth/private-vault.mjs';

const router = Router();

// Öffentliche Registrierung ist abgeschaltet: Das Portal ist aus dem Internet erreichbar und
// gibt Zugriff auf Tresor und Jira. Neue Konten legt ein Admin auf der Admin-Seite an.
// Nur für lokale Entwicklung mit ALLOW_REGISTRATION=true wieder einschaltbar.
router.post('/register', async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') {
    return res.status(403).json({ error: 'Die Registrierung ist deaktiviert. Bitte einen Admin, dir ein Konto anzulegen.' });
  }
  try {
    const { username, email, password, first_name, last_name } = req.body;

    if (!username || !email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
    }

    const db = getDb();

    // Check if user already exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      return res.status(400).json({ error: 'Benutzername oder E-Mail bereits vergeben' });
    }

    // Hash password
    const hash = await hashPassword(password);

    // Insert new user (new users are members by default)
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash, first_name, last_name, role, scrum_role) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(username, email, hash, first_name, last_name, 'member', 'developer');

    const userId = result.lastInsertRowid;

    // Log activity
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      userId, 'register', 'user', userId, `User registered: ${username}`
    );

    // Generate token
    const token = signToken({ id: userId, username, role: 'member' });

    res.status(201).json({
      token,
      user: {
        id: userId,
        username,
        email,
        first_name,
        last_name,
        role: 'member',
        scrum_role: 'developer'
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Rate limited login (10 attempts per 15 minutes)
router.post('/login', rateLimit(30, 20 * 1000), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Benutzername und Passwort sind erforderlich' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);

    if (!user) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const token = signToken({ id: user.id, username: user.username, role: user.role });

    // Log activity
    db.prepare('INSERT INTO activities (user_id, action, entity_type, details) VALUES (?, ?, ?, ?)').run(
      user.id, 'login', 'user', `User ${user.username} logged in`
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
    console.error('Login error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/logout', authMiddleware, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

router.get('/me', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, username, email, first_name, last_name, avatar, role, scrum_role, created_at FROM users WHERE id = ?').get(req.user.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ ...user, private_vault: hasPrivateVault(user) });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/profile', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const { first_name, last_name, avatar } = req.body;
    
    db.prepare('UPDATE users SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), avatar = COALESCE(?, avatar), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      first_name ?? null, last_name ?? null, avatar ?? null, req.user.id
    );
    
    const user = db.prepare('SELECT id, username, email, first_name, last_name, avatar, role, scrum_role FROM users WHERE id = ?').get(req.user.id);
    res.json(user);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/password', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { current_password, new_password } = req.body;
    
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const valid = await comparePassword(current_password, user.password_hash);
    
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const hash = await hashPassword(new_password);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);
    
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
