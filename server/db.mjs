import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    admin_id TEXT NOT NULL REFERENCES users(id),
    ttl_hours INTEGER NOT NULL DEFAULT 24,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    sender_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    audience TEXT NOT NULL CHECK(audience IN ('all','selected')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recipients (
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY(file_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    room_id TEXT,
    file_id TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
  CREATE INDEX IF NOT EXISTS idx_files_room_expiry ON files(room_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_room ON audit(room_id, id);
`;

function columnNames(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  );
}

function migrateFromV1(db) {
  if (!columnNames(db, 'users').has('disabled')) {
    db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!columnNames(db, 'sessions').has('created_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      user_id TEXT,
      action TEXT NOT NULL,
      room_id TEXT,
      file_id TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_room ON audit(room_id, id);
  `);
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'relay.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
  `);
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version === 0) {
    db.exec(SCHEMA);
    db.exec('PRAGMA user_version=2');
  } else if (version === 1) {
    migrateFromV1(db);
    db.exec('PRAGMA user_version=2');
  } else if (version !== 2) {
    db.close();
    throw new Error(`数据库版本 ${version} 过新，请升级轻传后再启动`);
  }
  return db;
}
