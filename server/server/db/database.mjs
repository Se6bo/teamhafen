import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (!db) {
    const dbPath = process.env.DB_PATH || join(process.cwd(), 'data.db');
    const expanded = dbPath.replace(/^~/, process.env.HOME || homedir());
    mkdirSync(dirname(expanded), { recursive: true });
    const rawDb = new Database(expanded);
    rawDb.pragma('foreign_keys = ON');
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('synchronous = NORMAL');
    
    // Wrap better-sqlite3 to match DatabaseSync API (.prepare().all() / .run() / .get() / .exec())
    db = {
      exec(sql) {
        return rawDb.exec(sql);
      },
      prepare(sql) {
        const stmt = rawDb.prepare(sql);
        return {
          all(...params) { return stmt.all(...params); },
          get(...params) { return stmt.get(...params); },
          run(...params) { return stmt.run(...params); }
        };
      }
    };
  }
  return db;
}

export function initDatabase() {
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  const db = getDb();
  const safeSchema = schema.replace(/CREATE TABLE/g, 'CREATE TABLE IF NOT EXISTS');
  db.exec(safeSchema);
  migrate(db);
  migrateMcpKeys(db);
  migratePrivateVault(db);
  migrateVaultBackend(db);
  console.log('[DB] Schema initialized.');
  return db;
}

// Privater Tresor: Einträge und Ordner mit private_owner_id sieht nur dieser Benutzer.
// NULL = gemeinsamer Tresor (wie bisher). Bestehende Einträge bleiben unverändert.
function migratePrivateVault(db) {
  try {
    for (const table of ['password_entries', 'password_folders']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (columns.length && !columns.some(c => c.name === 'private_owner_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN private_owner_id INTEGER`);
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_password_entries_private ON password_entries(private_owner_id)');
  } catch (e) {
    console.log('[Migration warning] private vault:', e.message);
  }
}

// Tresor-Speicher in Vaultwarden: Hier liegt nur ein Index ohne Geheimnisse (Nummern, Ordnerbaum,
// Tresor, wer was geändert hat). Namen, Benutzernamen, Passwörter, TOTP, Adressen und Notizen liegen
// verschlüsselt in Vaultwarden. Die alten Tabellen password_entries/password_folders/password_history
// bleiben unverändert als Sicherung stehen.
function migrateVaultBackend(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_accounts (
        account TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        password_encrypted BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        device_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS vault_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        vw_id TEXT NOT NULL,
        parent_id INTEGER,
        private_owner_id INTEGER,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS vault_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        vw_id TEXT NOT NULL,
        folder_id INTEGER,
        private_owner_id INTEGER,
        created_by INTEGER,
        updated_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS vault_history_meta (
        entry_id INTEGER NOT NULL,
        changed_at TEXT NOT NULL,
        changed_by INTEGER
      );
      CREATE TABLE IF NOT EXISTS vault_state (
        name TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_entries_vw ON vault_entries(account, vw_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_folders_vw ON vault_folders(account, vw_id);
      CREATE INDEX IF NOT EXISTS idx_vault_history_entry ON vault_history_meta(entry_id);
    `);
  } catch (e) {
    console.log('[Migration warning] vault backend:', e.message);
  }
}

// Schlüssel, mit denen sich die KI eines Benutzers über MCP anmeldet (nur der Hash wird gespeichert)
function migrateMcpKeys(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
        key_prefix TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_keys_user ON mcp_keys(user_id);
    `);
  } catch (e) {
    console.log('[Migration warning] mcp_keys:', e.message);
  }
}

function migrate(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);
    const docFolderColumns = db.prepare("PRAGMA table_info(doc_folders)").all();
    if (!docFolderColumns.some(c => c.name === 'parent_id')) {
      db.exec('ALTER TABLE doc_folders ADD COLUMN parent_id INTEGER REFERENCES doc_folders(id)');
    }
    // Anhänge: wer hochgeladen hat (für das Löschrecht); alte Einträge aus dem Aktivitätsprotokoll nachtragen
    const fileColumns = db.prepare("PRAGMA table_info(doc_files)").all();
    if (fileColumns.length && !fileColumns.some(c => c.name === 'uploaded_by')) {
      db.exec('ALTER TABLE doc_files ADD COLUMN uploaded_by INTEGER REFERENCES users(id)');
      db.exec(`
        UPDATE doc_files SET uploaded_by = (
          SELECT a.user_id FROM activities a
          WHERE a.action = 'upload' AND a.entity_type = 'doc_file' AND a.entity_id = doc_files.id
          ORDER BY a.id LIMIT 1
        ) WHERE uploaded_by IS NULL
      `);
    }

    // Eigenständige Dateien (PDF, Word, Excel …) direkt in Doku-Ordnern
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_folder_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id INTEGER REFERENCES doc_folders(id),
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mimetype TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_by INTEGER REFERENCES users(id),
        updated_by INTEGER REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const docColumns = db.prepare("PRAGMA table_info(documentation)").all();
    if (!docColumns.some(c => c.name === 'folder_id')) {
      db.exec('ALTER TABLE documentation ADD COLUMN folder_id INTEGER REFERENCES doc_folders(id)');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS password_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);
    const pwColumns = db.prepare("PRAGMA table_info(password_entries)").all();
    if (!pwColumns.some(c => c.name === 'folder_id')) {
      db.exec('ALTER TABLE password_entries ADD COLUMN folder_id INTEGER REFERENCES password_folders(id)');
    }

    const folderColumns = db.prepare("PRAGMA table_info(password_folders)").all();
    if (!folderColumns.some(c => c.name === 'parent_id')) {
      db.exec('ALTER TABLE password_folders ADD COLUMN parent_id INTEGER REFERENCES password_folders(id)');
    }

    const pwColumns2 = db.prepare("PRAGMA table_info(password_entries)").all();
    if (!pwColumns2.some(c => c.name === 'totp_secret_encrypted')) {
      db.exec('ALTER TABLE password_entries ADD COLUMN totp_secret_encrypted BLOB');
      db.exec('ALTER TABLE password_entries ADD COLUMN totp_iv BLOB');
      db.exec('ALTER TABLE password_entries ADD COLUMN totp_auth_tag BLOB');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS password_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL,
        password_encrypted BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        changed_by INTEGER,
        changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entry_id) REFERENCES password_entries(id) ON DELETE CASCADE,
        FOREIGN KEY (changed_by) REFERENCES users(id)
      )
    `);

    const userColumns = db.prepare("PRAGMA table_info(users)").all();
    if (!userColumns.some(c => c.name === 'webauthn_user_handle')) {
      db.exec('ALTER TABLE users ADD COLUMN webauthn_user_handle TEXT');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        credential_id TEXT UNIQUE NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        device_type TEXT,
        backed_up INTEGER DEFAULT 0,
        transports TEXT,
        name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (e) {
    console.log('[Migration warning]', e.message);
  }
}
