import express from 'express';
import helmet from 'helmet';
import Busboy from 'busboy';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDatabase } from './db.mjs';
import {
  hashPassword,
  verifyPassword,
  tokenHash,
  validatePassword,
  validUsername,
} from './auth.mjs';
import { acquireDataLock } from './lock.mjs';

const TTL = [1, 24, 168, 720];
const ROOM_COLUMNS = 'id, name, code, admin_id, ttl_hours, created_at';
const ROOM_COLUMNS_R = 'r.id, r.name, r.code, r.admin_id, r.ttl_hours, r.created_at';
const FILE_COLUMNS =
  'f.id, f.room_id, f.sender_id, f.name, f.storage_key, f.size, f.audience, f.created_at, f.expires_at';
function safeFilename(name) {
  let cleaned = '';
  for (const char of name) {
    const code = char.codePointAt(0);
    if (code <= 0x1f || code === 0x7f || /\p{Cf}/u.test(char)) continue;
    cleaned += char;
  }
  return cleaned;
}
const GiB = 1024 ** 3;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLEANUP_BATCH = 100;
const MAX_SESSIONS = 10;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const positiveInt = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('容量和数量配置必须为正整数');
  return number;
};
const localHost = (name) => name === 'localhost' || name === '127.0.0.1' || name === '::1';

export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const production = env.NODE_ENV === 'production';
  const dataDir = resolve(options.dataDir ?? env.DATA_DIR ?? './data');
  const releaseLock = acquireDataLock(dataDir);
  try {
    return buildApp({ env, now, production, dataDir, options, releaseLock });
  } catch (error) {
    releaseLock();
    throw error;
  }
}

function buildApp({ env, now, production, dataDir, options, releaseLock }) {
  const uploadDir = join(dataDir, 'files');
  const tempDir = join(dataDir, 'tmp');
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : undefined;
  if (production && !publicOrigin) throw new Error('生产环境必须设置 PUBLIC_ORIGIN');
  const secure = env.COOKIE_SECURE === undefined ? production : env.COOKIE_SECURE === 'true';
  const config = {
    registrationEnabled: env.REGISTRATION_ENABLED !== 'false',
    maxFileBytes: positiveInt(env.MAX_FILE_BYTES, GiB),
    maxBatchFiles: positiveInt(env.MAX_BATCH_FILES, 20),
    maxConcurrentUploads: positiveInt(env.MAX_CONCURRENT_UPLOADS, 2),
    maxConcurrentDownloads: positiveInt(env.MAX_CONCURRENT_DOWNLOADS, 2),
    roomQuotaBytes: positiveInt(env.ROOM_QUOTA_BYTES, 10 * GiB),
    totalQuotaBytes: positiveInt(env.TOTAL_QUOTA_BYTES, 50 * GiB),
  };
  const sessionMs = positiveInt(env.SESSION_DAYS, 30) * 86400000;
  const db = openDatabase(dataDir);
  const usage = { total: 0, rooms: new Map() };
  function reloadUsage() {
    const rooms = new Map();
    let total = 0;
    for (const row of db
      .prepare('SELECT room_id AS roomId, COALESCE(SUM(size),0) AS n FROM files GROUP BY room_id')
      .all()) {
      const size = Number(row.n);
      rooms.set(row.roomId, size);
      total += size;
    }
    usage.rooms = rooms;
    usage.total = total;
  }
  function usedBytes(roomId) {
    return roomId ? (usage.rooms.get(roomId) ?? 0) : usage.total;
  }
  function adjustUsage(roomId, delta) {
    usage.total += delta;
    usage.rooms.set(roomId, (usage.rooms.get(roomId) ?? 0) + delta);
  }
  reloadUsage();

  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY && env.TRUST_PROXY !== '0')
    app.set('trust proxy', positiveInt(env.TRUST_PROXY, 1));
  app.use(
    helmet({
      hsts: publicOrigin?.startsWith('https:') ? undefined : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: publicOrigin?.startsWith('https:') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(req))
      return next(fail(403, '请求来源不被允许'));
    next();
  });

  function originAllowed(req) {
    if (req.get('sec-fetch-site') === 'cross-site') return false;
    const origin = req.get('origin');
    if (!origin) return false;
    if (publicOrigin) return origin === publicOrigin;
    const host = req.get('host') ?? '';
    if (origin === `${req.protocol}://${host}`) return true;
    try {
      const url = new URL(origin);
      return localHost(url.hostname) && localHost(host.replace(/:\d+$/, ''));
    } catch {
      return false;
    }
  }

  const activeUploads = new Map();
  const activeDownloads = new Map();
  const pendingRoomBytes = new Map();
  const activeTempPaths = new Set();
  const pendingStorage = new Set();
  let pendingBytes = 0;
  const rateBuckets = new Map();
  function rateLimit(kind, max, windowMs, keyFn = (req) => req.ip || 'unknown') {
    return (req, res, next) => {
      const key = `${kind}:${keyFn(req)}`;
      let bucket = rateBuckets.get(key);
      if (!bucket || bucket.reset <= now()) {
        bucket = { count: 0, reset: now() + windowMs };
        rateBuckets.set(key, bucket);
      }
      if (++bucket.count > max) {
        res.set('Retry-After', String(Math.ceil((bucket.reset - now()) / 1000)));
        return next(fail(429, '尝试过于频繁，请稍后重试'));
      }
      next();
    };
  }
  const usernameKey = (req) => {
    const name =
      typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    return name || req.ip || 'unknown';
  };
  function authenticate(req, _res, next) {
    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('relay_session='));
    const token = cookie?.slice('relay_session='.length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return next(fail(401, '请先登录'));
    const user = db
      .prepare(
        `SELECT u.id, u.username, u.disabled FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?`,
      )
      .get(tokenHash(token), now());
    if (!user || user.disabled) return next(fail(401, '登录已失效，请重新登录'));
    req.user = { id: user.id, username: user.username };
    req.sessionHash = tokenHash(token);
    next();
  }
  function audit(userId, action, fields = {}) {
    db.prepare(
      'INSERT INTO audit (created_at, user_id, action, room_id, file_id, meta) VALUES (?,?,?,?,?,?)',
    ).run(
      now(),
      userId ?? null,
      action,
      fields.roomId ?? null,
      fields.fileId ?? null,
      fields.meta ? JSON.stringify(fields.meta) : null,
    );
  }
  function startSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    const hash = tokenHash(token);
    const createdAt = now();
    db.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)',
    ).run(hash, userId, createdAt + sessionMs, createdAt);
    const extra = db
      .prepare(
        'SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC, token_hash DESC',
      )
      .all(userId);
    for (const row of extra.slice(MAX_SESSIONS))
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
    res.cookie('relay_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: sessionMs,
    });
    return hash;
  }
  function clearSessionCookie(res) {
    res.clearCookie('relay_session', { httpOnly: true, sameSite: 'lax', secure, path: '/' });
  }
  function roomFor(req) {
    const room = db
      .prepare(
        `SELECT ${ROOM_COLUMNS_R} FROM rooms r JOIN members m ON m.room_id=r.id
      WHERE r.id=? AND m.user_id=?`,
      )
      .get(req.params.roomId, req.user.id);
    if (!room) throw fail(404, '房间不存在或你尚未加入');
    return room;
  }
  function roomView(room, userId) {
    const isAdmin = room.admin_id === userId;
    return {
      id: room.id,
      name: room.name,
      adminId: room.admin_id,
      isAdmin,
      ...(isAdmin ? { code: room.code } : {}),
      ttlHours: room.ttl_hours,
      createdAt: room.created_at,
      memberCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id=?').get(room.id).n,
      usedBytes: usedBytes(room.id),
      quotaBytes: config.roomQuotaBytes,
      receivedCount: isAdmin
        ? db
            .prepare(
              'SELECT COUNT(*) AS n FROM files WHERE room_id=? AND expires_at>? AND sender_id<>?',
            )
            .get(room.id, now(), userId).n
        : db
            .prepare(
              `SELECT COUNT(*) AS n FROM files f WHERE f.room_id=? AND f.expires_at>? AND f.sender_id<>?
            AND (f.audience='all' OR EXISTS(SELECT 1 FROM recipients rp WHERE rp.file_id=f.id AND rp.user_id=?))`,
            )
            .get(room.id, now(), userId, userId).n,
      sentCount: db
        .prepare('SELECT COUNT(*) AS n FROM files WHERE room_id=? AND sender_id=? AND expires_at>?')
        .get(room.id, userId, now()).n,
    };
  }
  function pairingCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const bytes = randomBytes(8);
      const code = [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
      if (!db.prepare('SELECT 1 FROM rooms WHERE code=?').get(code)) return code;
    }
    throw fail(503, '配对码生成失败，请重试');
  }
  function removeDisk(path) {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      console.error('文件清理失败，将重试', { path, code: error.code });
      return false;
    }
  }
  function cleanup() {
    const expired = db
      .prepare('SELECT id, storage_key FROM files WHERE expires_at<=? LIMIT ?')
      .all(now(), CLEANUP_BATCH);
    for (const row of expired) {
      if (removeDisk(join(uploadDir, row.storage_key)))
        db.prepare('DELETE FROM files WHERE id=?').run(row.id);
    }
    reloadUsage();
    const referenced = new Set(
      db
        .prepare('SELECT storage_key FROM files')
        .all()
        .map((row) => row.storage_key),
    );
    let removed = 0;
    for (const name of readdirSync(uploadDir)) {
      if (referenced.has(name) || pendingStorage.has(name)) continue;
      if (removed >= CLEANUP_BATCH) break;
      if (removeDisk(join(uploadDir, name))) removed += 1;
    }
    removed = 0;
    for (const name of readdirSync(tempDir)) {
      const path = join(tempDir, name);
      if (activeTempPaths.has(path)) continue;
      if (removed >= CLEANUP_BATCH) break;
      if (removeDisk(path)) removed += 1;
    }
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
    for (const [key, bucket] of rateBuckets) if (bucket.reset <= now()) rateBuckets.delete(key);
  }
  const interval =
    options.cleanupIntervalMs === 0
      ? null
      : setInterval(cleanup, options.cleanupIntervalMs ?? 60000);
  interval?.unref();

  app.get('/api/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });
  app.get('/api/config', (_req, res) => res.json(config));
  app.post(
    '/api/auth/register',
    rateLimit('register-ip', 10, 3600000),
    rateLimit('register-name', 10, 3600000, usernameKey),
    async (req, res) => {
      if (!config.registrationEnabled) throw fail(403, '当前服务器已关闭注册');
      const { username, password } = req.body ?? {};
      if (!validUsername(username)) throw fail(400, '用户名需为 2–24 位文字、数字、下划线或短横线');
      validatePassword(password);
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username))
        throw fail(409, '该用户名已被使用');
      const passwordHash = await hashPassword(password);
      const id = randomUUID();
      try {
        db.prepare(
          'INSERT INTO users (id, username, password_hash, created_at, disabled) VALUES (?,?,?,?,0)',
        ).run(id, username, passwordHash, now());
      } catch (error) {
        if (error.code?.includes('CONSTRAINT') || error.message.includes('UNIQUE'))
          throw fail(409, '该用户名已被使用');
        throw error;
      }
      startSession(res, id);
      audit(id, 'register');
      res.status(201).json({ id, username });
    },
  );
  const dummyHash = hashPassword(randomBytes(24).toString('hex'));
  app.post(
    '/api/auth/login',
    rateLimit('login-ip', 60, 900000),
    rateLimit('login-user', 30, 900000, usernameKey),
    async (req, res) => {
      const { username, password } = req.body ?? {};
      if (
        typeof username !== 'string' ||
        username.length > 24 ||
        typeof password !== 'string' ||
        password.length > 128
      ) {
        throw fail(400, '请输入有效的用户名和密码');
      }
      const user = db
        .prepare(
          'SELECT id, username, password_hash, created_at, disabled FROM users WHERE username=?',
        )
        .get(username);
      const valid = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
      if (!user || !valid) throw fail(401, '用户名或密码不正确');
      if (user.disabled) throw fail(403, '该账号已停用');
      if (
        db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)?.password_hash !==
        user.password_hash
      ) {
        throw fail(401, '密码已更新，请使用新密码登录');
      }
      startSession(res, user.id);
      audit(user.id, 'login');
      res.json({ id: user.id, username: user.username });
    },
  );
  app.get('/api/auth/me', authenticate, (req, res) => res.json(req.user));
  app.get('/api/auth/sessions', authenticate, (req, res) => {
    const rows = db
      .prepare(
        'SELECT token_hash AS id, created_at AS createdAt, expires_at AS expiresAt FROM sessions WHERE user_id=? ORDER BY created_at DESC, token_hash DESC',
      )
      .all(req.user.id);
    res.json(rows.map((row) => ({ ...row, current: row.id === req.sessionHash })));
  });
  app.delete('/api/auth/sessions/:sessionId', authenticate, (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.sessionId)) throw fail(404, '会话不存在');
    const result = db
      .prepare('DELETE FROM sessions WHERE token_hash=? AND user_id=?')
      .run(req.params.sessionId, req.user.id);
    if (!result.changes) throw fail(404, '会话不存在');
    if (req.params.sessionId === req.sessionHash) clearSessionCookie(res);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    validatePassword(newPassword);
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
    if (!(await verifyPassword(currentPassword, user.password_hash)))
      throw fail(400, '当前密码不正确');
    const passwordHash = await hashPassword(newPassword);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(
        req.user.id,
        req.sessionHash,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    audit(req.user.id, 'password-change');
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', authenticate, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  app.get('/api/rooms', authenticate, (req, res) => {
    const rows = db
      .prepare(
        `SELECT ${ROOM_COLUMNS_R} FROM rooms r JOIN members m ON r.id=m.room_id WHERE m.user_id=? ORDER BY m.joined_at,r.id`,
      )
      .all(req.user.id);
    res.json(rows.map((room) => roomView(room, req.user.id)));
  });
  app.post(
    '/api/rooms',
    authenticate,
    rateLimit('create', 30, 3600000, (req) => req.user.id),
    (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name || name.length > 40) throw fail(400, '房间名称需为 1–40 个字符');
      const id = randomUUID();
      db.exec('BEGIN');
      try {
        db.prepare(
          'INSERT INTO rooms (id, name, code, admin_id, ttl_hours, created_at) VALUES (?,?,?,?,?,?)',
        ).run(id, name, pairingCode(), req.user.id, 24, now());
        db.prepare('INSERT INTO members (room_id, user_id, joined_at) VALUES (?,?,?)').run(
          id,
          req.user.id,
          now(),
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      audit(req.user.id, 'create-room', { roomId: id, meta: { name } });
      res
        .status(201)
        .json(
          roomView(db.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id=?`).get(id), req.user.id),
        );
    },
  );
  app.post(
    '/api/rooms/join',
    authenticate,
    rateLimit('join', 20, 900000, (req) => req.user.id),
    (req, res) => {
      const code =
        typeof req.body?.code === 'string' ? req.body.code.replace(/[\s-]/g, '').toUpperCase() : '';
      if (!/^[A-Z2-9]{8}$/.test(code)) throw fail(400, '请输入 8 位配对码');
      const room = db.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE code=?`).get(code);
      if (!room) throw fail(404, '配对码无效或已重置');
      const inserted = db
        .prepare('INSERT OR IGNORE INTO members (room_id, user_id, joined_at) VALUES (?,?,?)')
        .run(room.id, req.user.id, now());
      if (inserted.changes) audit(req.user.id, 'join', { roomId: room.id });
      res.json(roomView(room, req.user.id));
    },
  );
  app.get('/api/rooms/:roomId', authenticate, (req, res) =>
    res.json(roomView(roomFor(req), req.user.id)),
  );
  app.get('/api/rooms/:roomId/members', authenticate, (req, res) => {
    roomFor(req);
    res.json(
      db
        .prepare(
          `SELECT u.id, u.username, m.joined_at AS joinedAt FROM members m JOIN users u ON m.user_id=u.id
      WHERE m.room_id=? ORDER BY m.joined_at, u.username`,
        )
        .all(req.params.roomId),
    );
  });
  app.delete('/api/rooms/:roomId/members/:userId', authenticate, (req, res) => {
    const room = roomFor(req);
    if (room.admin_id !== req.user.id) throw fail(403, '只有房间管理员可以移出成员');
    if (req.params.userId === room.admin_id) throw fail(400, '不能移出房间管理员');
    const member = db
      .prepare(
        'SELECT u.username FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? AND m.user_id=?',
      )
      .get(room.id, req.params.userId);
    if (!member) throw fail(404, '成员不存在');
    db.prepare('DELETE FROM members WHERE room_id=? AND user_id=?').run(room.id, req.params.userId);
    audit(req.user.id, 'remove-member', { roomId: room.id, meta: { username: member.username } });
    res.json({ ok: true });
  });
  app.post('/api/rooms/:roomId/leave', authenticate, (req, res) => {
    const room = roomFor(req);
    if (room.admin_id === req.user.id) throw fail(400, '管理员不能离开房间');
    db.prepare('DELETE FROM members WHERE room_id=? AND user_id=?').run(room.id, req.user.id);
    audit(req.user.id, 'leave', { roomId: room.id });
    res.json({ ok: true });
  });
  app.patch('/api/rooms/:roomId', authenticate, (req, res) => {
    const room = roomFor(req);
    if (room.admin_id !== req.user.id) throw fail(403, '只有房间管理员可以修改设置');
    if (!TTL.includes(req.body?.ttlHours))
      throw fail(400, '有效期须为 1 小时、24 小时、7 天或 30 天');
    db.prepare('UPDATE rooms SET ttl_hours=? WHERE id=?').run(req.body.ttlHours, room.id);
    res.json(
      roomView(
        db.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id=?`).get(room.id),
        req.user.id,
      ),
    );
  });
  app.post('/api/rooms/:roomId/reset-code', authenticate, (req, res) => {
    const room = roomFor(req);
    if (room.admin_id !== req.user.id) throw fail(403, '只有房间管理员可以重置配对码');
    db.prepare('UPDATE rooms SET code=? WHERE id=?').run(pairingCode(), room.id);
    audit(req.user.id, 'reset-code', { roomId: room.id });
    res.json(
      roomView(
        db.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id=?`).get(room.id),
        req.user.id,
      ),
    );
  });
  app.get('/api/rooms/:roomId/audit', authenticate, (req, res) => {
    const room = roomFor(req);
    if (room.admin_id !== req.user.id) throw fail(403, '只有房间管理员可以查看记录');
    const rows = db
      .prepare(
        `SELECT a.id, a.created_at AS createdAt, a.action, a.file_id AS fileId, a.meta, u.username
      FROM audit a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.room_id=? ORDER BY a.id DESC LIMIT 50`,
      )
      .all(room.id);
    res.json(rows.map((row) => ({ ...row, meta: row.meta ? JSON.parse(row.meta) : null })));
  });
  const visible = `(f.sender_id=? OR f.audience='all' OR EXISTS(SELECT 1 FROM recipients rp WHERE rp.file_id=f.id AND rp.user_id=?))`;
  app.get('/api/rooms/:roomId/files', authenticate, (req, res) => {
    const room = roomFor(req);
    const isAdmin = room.admin_id === req.user.id;
    const tab = req.query.tab === 'sent' ? 'sent' : 'received';
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';
    const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
    const visibility = isAdmin ? '1=1' : visible;
    const where = `f.room_id=? AND f.expires_at>? AND ${visibility} AND ${tab === 'sent' ? 'f.sender_id=?' : 'f.sender_id<>?'} AND instr(lower(f.name),lower(?))>0`;
    const args = isAdmin
      ? [req.params.roomId, now(), req.user.id, search]
      : [req.params.roomId, now(), req.user.id, req.user.id, req.user.id, search];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${where}`).get(...args).n;
    const rows = db
      .prepare(
        `SELECT f.id, f.name, f.size, f.audience, f.created_at AS createdAt, f.expires_at AS expiresAt,
      f.sender_id AS senderId, u.username AS senderName FROM files f JOIN users u ON f.sender_id=u.id
      WHERE ${where} ORDER BY f.created_at DESC, f.id LIMIT 50 OFFSET ?`,
      )
      .all(...args, (page - 1) * 50);
    for (const row of rows) {
      const recipients =
        row.audience === 'selected'
          ? db
              .prepare(
                'SELECT u.id, u.username FROM recipients rp JOIN users u ON u.id=rp.user_id WHERE rp.file_id=?',
              )
              .all(row.id)
          : [];
      const allowed =
        row.senderId === req.user.id ||
        row.audience === 'all' ||
        recipients.some((recipient) => recipient.id === req.user.id);
      row.restricted = !allowed;
      row.recipients = allowed ? recipients : [];
    }
    res.json({ files: rows, total, page, pageSize: 50 });
  });

  app.post('/api/rooms/:roomId/files', authenticate, async (req, res) => {
    const room = roomFor(req);
    const userId = req.user.id;
    if ((activeUploads.get(userId) ?? 0) >= config.maxConcurrentUploads)
      throw fail(429, '同时上传的文件过多，请稍后重试');
    const audience = req.query.audience;
    if (audience !== 'all' && audience !== 'selected') throw fail(400, '请选择接收人');
    let recipients = [];
    if (audience === 'selected') {
      if (typeof req.query.recipients !== 'string' || req.query.recipients.length > 10000)
        throw fail(400, '请选择有效的接收人');
      recipients = [...new Set(req.query.recipients.split(',').filter(Boolean))];
      if (
        recipients.length === 0 ||
        recipients.some(
          (id) =>
            !db.prepare('SELECT 1 FROM members WHERE room_id=? AND user_id=?').get(room.id, id),
        )
      ) {
        throw fail(400, '接收人必须是房间成员');
      }
    }
    req.socket?.setTimeout(UPLOAD_TIMEOUT_MS);
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 1, fields: 0, parts: 2, fileSize: config.maxFileBytes + 1 },
      });
    } catch {
      throw fail(400, '请使用 multipart/form-data 上传文件');
    }
    activeUploads.set(userId, (activeUploads.get(userId) ?? 0) + 1);
    const id = randomUUID();
    const tempPath = join(tempDir, id);
    const storageKey = `${id}.bin`;
    activeTempPaths.add(tempPath);
    let bytes = 0;
    let filename;
    let uploadTask;
    let uploadError;
    let moved = false;
    let committed = false;
    const capture = (error) => {
      uploadError ??= error;
    };
    parser.on('filesLimit', () => capture(fail(400, '每个请求只能上传一个文件')));
    parser.on('fieldsLimit', () => capture(fail(400, '不支持额外表单字段')));
    parser.on('partsLimit', () => capture(fail(400, '每个请求只能上传一个文件')));
    parser.on('file', (field, stream, info) => {
      filename = safeFilename(basename(info.filename ?? '')).trim();
      if (field !== 'file' || !filename || filename.length > 240) {
        capture(fail(400, '文件名需为 1–240 个字符，表单字段必须为 file'));
        stream.resume();
        return;
      }
      stream.on('limit', () => capture(fail(413, '文件超过大小限制')));
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          if (bytes + chunk.length > config.maxFileBytes) {
            callback(fail(413, '文件超过大小限制'));
            return;
          }
          const roomPending = pendingRoomBytes.get(room.id) ?? 0;
          if (
            usedBytes(room.id) + roomPending + chunk.length > config.roomQuotaBytes ||
            usedBytes() + pendingBytes + chunk.length > config.totalQuotaBytes
          ) {
            callback(fail(413, '存储空间不足，请删除文件或联系部署者调整容量'));
            return;
          }
          bytes += chunk.length;
          pendingBytes += chunk.length;
          pendingRoomBytes.set(room.id, roomPending + chunk.length);
          callback(null, chunk);
        },
      });
      uploadTask = pipeline(stream, counter, createWriteStream(tempPath, { flags: 'wx' })).catch(
        (error) => {
          capture(error);
          parser.destroy(error);
        },
      );
    });
    const aborted = () => parser.destroy(fail(400, '上传已中断'));
    req.once('aborted', aborted);
    req.once('close', () => {
      if (!req.complete) aborted();
    });
    try {
      try {
        await new Promise((resolveParser, rejectParser) => {
          parser.once('close', resolveParser);
          parser.once('error', rejectParser);
          req.pipe(parser);
        });
      } catch (error) {
        throw uploadError ?? (error.status ? error : fail(400, '上传内容不完整，请重新上传'));
      }
      await uploadTask;
      if (uploadError) throw uploadError;
      if (!uploadTask || !filename || req.aborted) throw fail(400, '请选择文件或重试上传');
      pendingStorage.add(storageKey);
      renameSync(tempPath, join(uploadDir, storageKey));
      moved = true;
      const createdAt = now();
      const currentRoom = db.prepare('SELECT ttl_hours FROM rooms WHERE id=?').get(room.id);
      db.exec('BEGIN');
      try {
        db.prepare(
          'INSERT INTO files (id, room_id, sender_id, name, storage_key, size, audience, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          room.id,
          userId,
          filename,
          storageKey,
          bytes,
          audience,
          createdAt,
          createdAt + currentRoom.ttl_hours * 3600000,
        );
        for (const recipient of recipients)
          db.prepare('INSERT INTO recipients (file_id, user_id) VALUES (?,?)').run(id, recipient);
        db.exec('COMMIT');
        committed = true;
        adjustUsage(room.id, bytes);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      audit(userId, 'upload', {
        roomId: room.id,
        fileId: id,
        meta: { name: filename, size: bytes, audience },
      });
      res.status(201).json({
        id,
        name: filename,
        size: bytes,
        createdAt,
        expiresAt: createdAt + currentRoom.ttl_hours * 3600000,
      });
    } finally {
      req.removeListener('aborted', aborted);
      if (!parser.destroyed) parser.destroy();
      await uploadTask;
      pendingBytes -= bytes;
      pendingRoomBytes.set(room.id, Math.max(0, (pendingRoomBytes.get(room.id) ?? 0) - bytes));
      activeUploads.set(userId, Math.max(0, (activeUploads.get(userId) ?? 0) - 1));
      activeTempPaths.delete(tempPath);
      pendingStorage.delete(storageKey);
      if (!committed) removeDisk(moved ? join(uploadDir, storageKey) : tempPath);
    }
  });

  const visibleFile = `SELECT ${FILE_COLUMNS} FROM files f JOIN members m ON m.room_id=f.room_id
    WHERE f.id=? AND m.user_id=? AND f.expires_at>? AND ${visible}`;
  function fileFor(req) {
    const file = db
      .prepare(visibleFile)
      .get(req.params.fileId, req.user.id, now(), req.user.id, req.user.id);
    if (!file) throw fail(404, '文件不存在、已过期或你没有访问权限');
    return file;
  }
  function releaseDownload(userId, released) {
    if (released.done) return;
    released.done = true;
    activeDownloads.set(userId, Math.max(0, (activeDownloads.get(userId) ?? 1) - 1));
  }
  app.get('/api/files/:fileId/download', authenticate, (req, res, next) => {
    const file = fileFor(req);
    const current = activeDownloads.get(req.user.id) ?? 0;
    if (current >= config.maxConcurrentDownloads)
      return next(fail(429, '同时下载的文件过多，请稍后重试'));
    activeDownloads.set(req.user.id, current + 1);
    const released = { done: false };
    res.on('close', () => releaseDownload(req.user.id, released));
    audit(req.user.id, 'download', {
      roomId: file.room_id,
      fileId: file.id,
      meta: { name: file.name, size: file.size },
    });
    res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.download(join(uploadDir, file.storage_key), file.name, { dotfiles: 'deny' }, (error) => {
      releaseDownload(req.user.id, released);
      if (error && !res.headersSent)
        next(fail(error.status === 404 ? 404 : 500, '文件暂时无法下载，请重试'));
    });
  });
  app.delete('/api/files/:fileId', authenticate, (req, res) => {
    const file = db
      .prepare(
        `SELECT ${FILE_COLUMNS} FROM files f JOIN members m ON m.room_id=f.room_id
      WHERE f.id=? AND m.user_id=? AND f.expires_at>?`,
      )
      .get(req.params.fileId, req.user.id, now());
    if (!file) throw fail(404, '文件不存在、已过期或你没有访问权限');
    const room = db.prepare('SELECT admin_id FROM rooms WHERE id=?').get(file.room_id);
    const isAdmin = room.admin_id === req.user.id;
    if (file.sender_id !== req.user.id && !isAdmin) {
      const visibleRow = db
        .prepare(visibleFile)
        .get(req.params.fileId, req.user.id, now(), req.user.id, req.user.id);
      if (!visibleRow) throw fail(404, '文件不存在、已过期或你没有访问权限');
      throw fail(403, '只能删除自己发送的文件');
    }
    db.prepare('DELETE FROM files WHERE id=?').run(file.id);
    adjustUsage(file.room_id, -Number(file.size));
    removeDisk(join(uploadDir, file.storage_key));
    audit(req.user.id, 'delete', {
      roomId: file.room_id,
      fileId: file.id,
      meta: { name: file.name, size: file.size },
    });
    res.json({ ok: true });
  });
  app.use('/api', (_req, _res, next) => next(fail(404, '接口不存在')));
  const dist = resolve(options.distDir ?? './dist');
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res, next) => {
    res.sendFile(join(dist, 'index.html'), (error) => {
      if (error) next(fail(404, '前端尚未构建，请运行 npm run build'));
    });
  });
  app.use((error, req, res, _next) => {
    if (res.headersSent) {
      if (!req.complete) req.destroy();
      return res.end();
    }
    const status = error.status ?? (error.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error('请求失败', error);
    res.status(status).json({ error: status === 500 ? '服务器暂时无法处理请求' : error.message });
    if (!req.complete) res.on('close', () => req.destroy());
  });
  let closed = false;
  return {
    app,
    db,
    config,
    cleanup,
    close() {
      if (closed) return;
      closed = true;
      if (interval) clearInterval(interval);
      db.close();
      releaseLock();
    },
  };
}
