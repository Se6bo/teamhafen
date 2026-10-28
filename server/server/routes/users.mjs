import { Router } from 'express';
import { getDb } from '../db/database.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import { hashPassword } from '../auth/passwords.mjs';
import { hasPrivateVault } from '../auth/private-vault.mjs';

const router = Router();

function canManageUsers(user) {
  return user?.role === 'admin' || user?.role === 'owner';
}

// Konten mit privatem Tresor kann nur ihr Besitzer selbst ändern oder löschen.
// Sonst könnte ein Admin das Passwort zurücksetzen, sich anmelden und den privaten Tresor sehen.
function protectedAccount(req, res, targetId) {
  if (hasPrivateVault(Number(targetId)) && Number(targetId) !== Number(req.user.id)) {
    res.status(403).json({ error: 'Dieses Konto hat einen privaten Tresor und kann nur von seinem Besitzer selbst geändert werden.' });
    return true;
  }
  return false;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getDeleteReplacementUserId(db, targetUserId, actorUserId) {
  const actor = db.prepare('SELECT id FROM users WHERE id = ? AND id != ?').get(actorUserId, targetUserId);
  if (actor) {
    return actor.id;
  }

  const fallback = db.prepare(`
    SELECT id
    FROM users
    WHERE id != ?
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id ASC
    LIMIT 1
  `).get(targetUserId);

  return fallback?.id ?? null;
}

function cleanupUserReferences(db, targetUserId, replacementUserId) {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(targetUserId);
  db.prepare('DELETE FROM meeting_participants WHERE user_id = ?').run(targetUserId);

  db.prepare('UPDATE activities SET user_id = NULL WHERE user_id = ?').run(targetUserId);
  db.prepare('UPDATE backlog_items SET assignee_id = NULL WHERE assignee_id = ?').run(targetUserId);
  db.prepare('UPDATE subtasks SET created_by = NULL WHERE created_by = ?').run(targetUserId);
  db.prepare('UPDATE doc_folders SET created_by = NULL WHERE created_by = ?').run(targetUserId);
  db.prepare('UPDATE documentation SET author_id = NULL WHERE author_id = ?').run(targetUserId);
  db.prepare('UPDATE doc_versions SET created_by = NULL WHERE created_by = ?').run(targetUserId);
  db.prepare('UPDATE meetings SET created_by = NULL WHERE created_by = ?').run(targetUserId);
  db.prepare('UPDATE password_entries SET created_by = NULL WHERE created_by = ?').run(targetUserId);
  db.prepare('UPDATE password_entries SET updated_by = NULL WHERE updated_by = ?').run(targetUserId);

  const hasPasswordFolders = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'password_folders'").get();
  if (hasPasswordFolders) {
    db.prepare('UPDATE password_folders SET created_by = NULL WHERE created_by = ?').run(targetUserId);
  }

  const hasPasswordHistory = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'password_history'").get();
  if (hasPasswordHistory) {
    db.prepare('UPDATE password_history SET changed_by = NULL WHERE changed_by = ?').run(targetUserId);
  }

  // Tresor-Index (Vaultwarden): Verweise auf den Benutzer lösen, Einträge bleiben
  const hasVaultIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vault_entries'").get();
  if (hasVaultIndex) {
    db.prepare('UPDATE vault_entries SET created_by = NULL WHERE created_by = ?').run(targetUserId);
    db.prepare('UPDATE vault_entries SET updated_by = NULL WHERE updated_by = ?').run(targetUserId);
    db.prepare('UPDATE vault_folders SET created_by = NULL WHERE created_by = ?').run(targetUserId);
    db.prepare('UPDATE vault_history_meta SET changed_by = NULL WHERE changed_by = ?').run(targetUserId);
  }

  const hasWebauthnCredentials = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webauthn_credentials'").get();
  if (hasWebauthnCredentials) {
    db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(targetUserId);
  }

  if (replacementUserId) {
    db.prepare('UPDATE backlog_items SET creator_id = ? WHERE creator_id = ?').run(replacementUserId, targetUserId);
    db.prepare('UPDATE comments SET user_id = ? WHERE user_id = ?').run(replacementUserId, targetUserId);
  }
}

// All user routes require auth
router.use(authMiddleware);

// GET /api/users - List all users
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const users = db.prepare('SELECT id, username, email, first_name, last_name, avatar, role, scrum_role, created_at FROM users ORDER BY created_at DESC').all();
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users/:id - Get user by ID
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, username, email, first_name, last_name, avatar, role, scrum_role, created_at FROM users WHERE id = ?').get(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users - Create user (admin/owner only)
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    if (!canManageUsers(req.user)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    
    const { username, email, password, first_name, last_name, role, scrum_role } = req.body;
    
    if (!username || !email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Username, email, password, first_name, and last_name are required' });
    }
    
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    
    const hash = await hashPassword(password);
    const result = db.prepare('INSERT INTO users (username, email, password_hash, first_name, last_name, role, scrum_role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      username, email, hash, first_name, last_name, role || 'member', scrum_role || 'developer'
    );
    
    const user = db.prepare('SELECT id, username, email, first_name, last_name, avatar, role, scrum_role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'create', 'user', result.lastInsertRowid, `Created user ${username}`
    );
    
    res.status(201).json(user);
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/:id - Update user (admin/owner only)
router.put('/:id', async (req, res) => {
  try {
    const db = getDb();
    if (!canManageUsers(req.user)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    
    const existingUser = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(req.params.id);
    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (protectedAccount(req, res, existingUser.id)) return;

    const { username, email, first_name, last_name, role, scrum_role, avatar, password } = req.body;
    const nextUsername = username !== undefined ? String(username).trim() : existingUser.username;
    const nextEmail = email !== undefined ? String(email).trim() : existingUser.email;

    if (username !== undefined && !nextUsername) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (email !== undefined && (!nextEmail || !isValidEmail(nextEmail))) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    if (username !== undefined || email !== undefined) {
      const duplicate = db.prepare('SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?').get(nextUsername, nextEmail, req.params.id);
      if (duplicate) {
        return res.status(400).json({ error: 'Username or email already exists' });
      }
    }

    if (password) {
      const hash = await hashPassword(password);
      db.prepare('UPDATE users SET username = COALESCE(?, username), email = COALESCE(?, email), first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), role = COALESCE(?, role), scrum_role = COALESCE(?, scrum_role), avatar = COALESCE(?, avatar), password_hash = COALESCE(?, password_hash), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        username !== undefined ? nextUsername : null, email !== undefined ? nextEmail : null, first_name, last_name, role, scrum_role, avatar, hash, req.params.id
      );
    } else {
      db.prepare('UPDATE users SET username = COALESCE(?, username), email = COALESCE(?, email), first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), role = COALESCE(?, role), scrum_role = COALESCE(?, scrum_role), avatar = COALESCE(?, avatar), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        username !== undefined ? nextUsername : null, email !== undefined ? nextEmail : null, first_name, last_name, role, scrum_role, avatar, req.params.id
      );
    }
    
    const user = db.prepare('SELECT id, username, email, first_name, last_name, avatar, role, scrum_role, created_at FROM users WHERE id = ?').get(req.params.id);
    
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'update', 'user', req.params.id, `Updated user ${user.username}`
    );
    
    res.json(user);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/users/:id (admin/owner only)
router.delete('/:id', (req, res) => {
  const db = getDb();

  try {
    if (!canManageUsers(req.user)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    const targetUserId = req.params.id;
    if (String(req.user.id) === String(targetUserId)) {
      return res.status(400).json({ error: 'You cannot delete your own user account' });
    }

    const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (protectedAccount(req, res, targetUser.id)) return;

    const actor = db.prepare('SELECT id FROM users WHERE id = ?').get(req.user.id);
    const activityUserId = actor?.id ?? null;
    const replacementUserId = getDeleteReplacementUserId(db, targetUserId, req.user.id);
    const needsReplacement = db.prepare(`
      SELECT 1 AS found FROM backlog_items WHERE creator_id = ?
      UNION ALL
      SELECT 1 AS found FROM comments WHERE user_id = ?
      LIMIT 1
    `).get(targetUserId, targetUserId);

    if (needsReplacement && !replacementUserId) {
      return res.status(409).json({ error: 'Cannot delete user because authored records require another user for reassignment' });
    }

    db.exec('BEGIN');
    try {
      cleanupUserReferences(db, targetUserId, replacementUserId);

      const deleted = db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);
      if (deleted.changes === 0) {
        throw new Error('User delete did not change any rows');
      }

      db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
        activityUserId, 'delete', 'user', targetUserId, `Deleted user ${targetUser.username}`
      );

      db.exec('COMMIT');
    } catch (transactionError) {
      db.exec('ROLLBACK');
      throw transactionError;
    }
    
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
