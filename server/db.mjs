import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'relay.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
      admin_id TEXT NOT NULL REFERENCES users(id), ttl_hours INTEGER NOT NULL DEFAULT 24,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES users(id),
      joined_at INTEGER NOT NULL, PRIMARY KEY(room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
      sender_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, audience TEXT NOT NULL CHECK(audience IN ('all','selected')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipients (
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(file_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
    CREATE INDEX IF NOT EXISTS idx_files_room_expiry ON files(room_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    PRAGMA user_version=1;
  `);
  return db;
}
