import express from 'express';
import helmet from 'helmet';
import Busboy from 'busboy';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDatabase } from './db.mjs';
import { hashPassword, verifyPassword, tokenHash, validatePassword } from './auth.mjs';

const TTL = [1, 24, 168, 720];
const GiB = 1024 ** 3;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fail = (status, message) => Object.assign(new Error(message), { status });
const positiveInt = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('容量和数量配置必须为正整数');
  return number;
};

export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const production = env.NODE_ENV === 'production';
  const dataDir = resolve(options.dataDir ?? env.DATA_DIR ?? './data');
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
    roomQuotaBytes: positiveInt(env.ROOM_QUOTA_BYTES, 10 * GiB),
    totalQuotaBytes: positiveInt(env.TOTAL_QUOTA_BYTES, 50 * GiB),
  };
  const sessionMs = positiveInt(env.SESSION_DAYS, 30) * 86400000;
  const db = openDatabase(dataDir);
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY && env.TRUST_PROXY !== '0') app.set('trust proxy', positiveInt(env.TRUST_PROXY, 1));
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    upgradeInsecureRequests: publicOrigin?.startsWith('https:') ? [] : null,
  } }, crossOriginEmbedderPolicy: false }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const expected = publicOrigin ?? `${req.protocol}://${req.get('host')}`;
      if ((req.get('origin') && req.get('origin') !== expected) || req.get('sec-fetch-site') === 'cross-site') {
        return next(fail(403, '请求来源不被允许'));
      }
    }
    next();
  });

  // Single-process accounting: chunks reserve capacity synchronously before disk writes.
  const activeUploads = new Map();
  const pendingRoomBytes = new Map();
  const activeTempPaths = new Set();
  let pendingBytes = 0;
  const rateBuckets = new Map();
  function rateLimit(kind, max, windowMs) {
    return (req, res, next) => {
      const key = `${kind}:${req.ip}`;
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
  function authenticate(req, _res, next) {
    const cookie = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('relay_session='));
    const token = cookie?.slice('relay_session='.length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return next(fail(401, '请先登录'));
    const user = db.prepare(`SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash(token), now());
    if (!user) return next(fail(401, '登录已失效，请重新登录'));
    req.user = user;
    req.sessionHash = tokenHash(token);
    next();
  }
  function startSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash(token), userId, now() + sessionMs);
    res.cookie('relay_session', token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: sessionMs });
  }
  function roomFor(req) {
    const room = db.prepare(`SELECT r.* FROM rooms r JOIN members m ON m.room_id=r.id
      WHERE r.id=? AND m.user_id=?`).get(req.params.roomId, req.user.id);
    if (!room) throw fail(404, '房间不存在或你尚未加入');
    return room;
  }
  const usedBytes = (roomId) => Number(roomId
    ? db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM files WHERE room_id=?').get(roomId).n
    : db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM files').get().n);
  function roomView(room, userId) {
    return {
      id: room.id, name: room.name, adminId: room.admin_id, isAdmin: room.admin_id === userId,
      code: room.code, ttlHours: room.ttl_hours, createdAt: room.created_at,
      memberCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id=?').get(room.id).n,
      usedBytes: usedBytes(room.id), quotaBytes: config.roomQuotaBytes,
      receivedCount: db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE f.room_id=? AND f.expires_at>? AND f.sender_id<>?
        AND (f.audience='all' OR EXISTS(SELECT 1 FROM recipients rp WHERE rp.file_id=f.id AND rp.user_id=?))`).get(room.id, now(), userId, userId).n,
      sentCount: db.prepare('SELECT COUNT(*) AS n FROM files WHERE room_id=? AND sender_id=? AND expires_at>?').get(room.id, userId, now()).n,
    };
  }
  function pairingCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const bytes = randomBytes(8);
      const code = [...bytes].map(x => alphabet[x % alphabet.length]).join('');
      if (!db.prepare('SELECT 1 FROM rooms WHERE code=?').get(code)) return code;
    }
    throw fail(503, '配对码生成失败，请重试');
  }
  function removeDisk(path) {
    try { unlinkSync(path); return true; }
    catch (error) {
      if (error.code === 'ENOENT') return true;
      console.error('文件清理失败，将重试', { path, code: error.code });
      return false;
    }
  }
  function cleanup() {
    for (const row of db.prepare('SELECT id,storage_key FROM files WHERE expires_at<=?').all(now())) {
      if (removeDisk(join(uploadDir, row.storage_key))) db.prepare('DELETE FROM files WHERE id=?').run(row.id);
    }
    const referenced = new Set(db.prepare('SELECT storage_key FROM files').all().map(x => x.storage_key));
    for (const name of readdirSync(uploadDir)) {
      if (!referenced.has(name)) removeDisk(join(uploadDir, name));
    }
    for (const name of readdirSync(tempDir)) {
      const path = join(tempDir, name);
      if (!activeTempPaths.has(path)) removeDisk(path);
    }
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
    for (const [key, bucket] of rateBuckets) if (bucket.reset <= now()) rateBuckets.delete(key);
  }
  cleanup();
  const interval = options.cleanupIntervalMs === 0 ? null : setInterval(cleanup, options.cleanupIntervalMs ?? 60000);
  interval?.unref();

  app.get('/api/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  app.get('/api/config', (_req, res) => res.json(config));
  app.post('/api/auth/register', rateLimit('register', 10, 3600000), async (req, res) => {
    if (!config.registrationEnabled) throw fail(403, '当前服务器已关闭注册');
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !/^[\p{L}\p{N}_-]{2,24}$/u.test(username)) throw fail(400, '用户名需为 2–24 位文字、数字、下划线或短横线');
    validatePassword(password);
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw fail(409, '该用户名已被使用');
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    try { db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, username, passwordHash, now()); }
    catch (error) { if (error.code?.includes('CONSTRAINT') || error.message.includes('UNIQUE')) throw fail(409, '该用户名已被使用'); throw error; }
    startSession(res, id);
    res.status(201).json({ id, username });
  });
  const dummyHash = hashPassword(randomBytes(24).toString('hex'));
  app.post('/api/auth/login', rateLimit('login', 30, 900000), async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.length > 24 || typeof password !== 'string' || password.length > 128) throw fail(400, '请输入有效的用户名和密码');
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const valid = await verifyPassword(password, user?.password_hash ?? await dummyHash);
    if (!user || !valid) throw fail(401, '用户名或密码不正确');
    if (db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)?.password_hash !== user.password_hash) throw fail(401, '密码已更新，请使用新密码登录');
    startSession(res, user.id);
    res.json({ id: user.id, username: user.username });
  });
  app.get('/api/auth/me', authenticate, (req, res) => res.json(req.user));
  app.post('/api/auth/logout', authenticate, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    res.clearCookie('relay_session', { httpOnly: true, sameSite: 'lax', secure, path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/rooms', authenticate, (req, res) => {
    const rows = db.prepare('SELECT r.* FROM rooms r JOIN members m ON r.id=m.room_id WHERE m.user_id=? ORDER BY m.joined_at,r.id').all(req.user.id);
    res.json(rows.map(room => roomView(room, req.user.id)));
  });
  app.post('/api/rooms', authenticate, rateLimit('create', 30, 3600000), (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 40) throw fail(400, '房间名称需为 1–40 个字符');
    const id = randomUUID();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO rooms VALUES (?,?,?,?,?,?)').run(id, name, pairingCode(), req.user.id, 24, now());
      db.prepare('INSERT INTO members VALUES (?,?,?)').run(id, req.user.id, now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json(roomView(db.prepare('SELECT * FROM rooms WHERE id=?').get(id), req.user.id));
  });
  app.post('/api/rooms/join', authenticate, rateLimit('join', 20, 900000), (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/[\s-]/g, '').toUpperCase() : '';
    if (!/^[A-Z2-9]{8}$/.test(code)) throw fail(400, '请输入 8 位配对码');
    const room = db.prepare('SELECT * FROM rooms WHERE code=?').get(code);
    if (!room) throw fail(404, '配对码无效或已重置');
    db.prepare('INSERT OR IGNORE INTO members VALUES (?,?,?)').run(room.id, req.user.id, now());
    res.json(roomView(room, req.user.id));
  });
  app.get('/api/rooms/:roomId', authenticate, (req, res) => res.json(roomView(roomFor(req), req.user.id)));
  app.get('/api/rooms/:roomId/members', authenticate, (req, res) => {
    roomFor(req);
    res.json(db.prepare(`SELECT u.id,u.username,m.joined_at AS joinedAt FROM members m JOIN users u ON m.user_id=u.id
      WHERE m.room_id=? ORDER BY m.joined_at,u.username`).all(req.params.roomId));
  });
  app.patch('/api/rooms/:roomId', authenticate, (req, res) => {
    const room = roomFor(req);
    if (room.admin_id !== req.user.id) throw fail(403, '只有房间管理员可以修改设置');
    if (!TTL.includes(req.body?.ttlHours)) throw fail(400, '有效期须为 1 小时、24 小时、7 天或 30 天');
    db.prepare('UPDATE rooms SET ttl_hours=? WHERE id=?').run(req.body.ttlHours, room.id);
    res.json(roomView(db.prepare('SELECT * FROM rooms WHERE id=?').get(room.id), req.user.id));
  });
  app.post('/api/rooms/:roomId/reset-code', authenticate, (req, res) => {
    const room = roomFor(req);
    if (room.admin_id !== req.user.id) throw fail(403, '只有房间管理员可以重置配对码');
    db.prepare('UPDATE rooms SET code=? WHERE id=?').run(pairingCode(), room.id);
    res.json(roomView(db.prepare('SELECT * FROM rooms WHERE id=?').get(room.id), req.user.id));
  });
  const visible = `(f.sender_id=? OR f.audience='all' OR EXISTS(SELECT 1 FROM recipients rp WHERE rp.file_id=f.id AND rp.user_id=?))`;
  app.get('/api/rooms/:roomId/files', authenticate, (req, res) => {
    roomFor(req);
    const tab = req.query.tab === 'sent' ? 'sent' : 'received';
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';
    const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
    const where = `f.room_id=? AND f.expires_at>? AND ${visible} AND ${tab === 'sent' ? 'f.sender_id=?' : 'f.sender_id<>?'} AND instr(lower(f.name),lower(?))>0`;
    const args = [req.params.roomId, now(), req.user.id, req.user.id, req.user.id, search];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${where}`).get(...args).n;
    const rows = db.prepare(`SELECT f.id,f.name,f.size,f.audience,f.created_at AS createdAt,f.expires_at AS expiresAt,
      f.sender_id AS senderId,u.username AS senderName FROM files f JOIN users u ON f.sender_id=u.id
      WHERE ${where} ORDER BY f.created_at DESC,f.id LIMIT 50 OFFSET ?`).all(...args, (page - 1) * 50);
    for (const row of rows) {
      row.recipients = row.audience === 'selected' ? db.prepare('SELECT u.id,u.username FROM recipients rp JOIN users u ON u.id=rp.user_id WHERE rp.file_id=?').all(row.id) : [];
    }
    res.json({ files: rows, total, page, pageSize: 50 });
  });

  app.post('/api/rooms/:roomId/files', authenticate, async (req, res) => {
    const room = roomFor(req);
    const userId = req.user.id;
    if ((activeUploads.get(userId) ?? 0) >= config.maxConcurrentUploads) throw fail(429, '同时上传的文件过多，请稍后重试');
    const audience = req.query.audience;
    if (audience !== 'all' && audience !== 'selected') throw fail(400, '请选择接收人');
    let recipients = [];
    if (audience === 'selected') {
      if (typeof req.query.recipients !== 'string' || req.query.recipients.length > 10000) throw fail(400, '请选择有效的接收人');
      recipients = [...new Set(req.query.recipients.split(',').filter(Boolean))];
      if (recipients.length === 0 || recipients.some(id => !db.prepare('SELECT 1 FROM members WHERE room_id=? AND user_id=?').get(room.id, id))) throw fail(400, '接收人必须是房间成员');
    }
    let parser;
    try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 0, parts: 2, fileSize: config.maxFileBytes + 1 } }); }
    catch { throw fail(400, '请使用 multipart/form-data 上传文件'); }
    activeUploads.set(userId, (activeUploads.get(userId) ?? 0) + 1);
    const id = randomUUID();
    const tempPath = join(tempDir, id);
    const storageKey = `${id}.bin`;
    activeTempPaths.add(tempPath);
    let bytes = 0, filename, uploadTask, uploadError, moved = false, committed = false;
    const capture = error => { uploadError ??= error; };
    parser.on('filesLimit', () => capture(fail(400, '每个请求只能上传一个文件')));
    parser.on('fieldsLimit', () => capture(fail(400, '不支持额外表单字段')));
    parser.on('partsLimit', () => capture(fail(400, '每个请求只能上传一个文件')));
    parser.on('file', (field, stream, info) => {
      filename = basename(info.filename ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
      if (field !== 'file' || !filename || filename.length > 240) {
        capture(fail(400, '文件名需为 1–240 个字符，表单字段必须为 file'));
        stream.resume();
        return;
      }
      stream.on('limit', () => capture(fail(413, '文件超过大小限制')));
      const counter = new Transform({ transform(chunk, _encoding, callback) {
        if (bytes + chunk.length > config.maxFileBytes) { callback(fail(413, '文件超过大小限制')); return; }
        if (usedBytes(room.id) + (pendingRoomBytes.get(room.id) ?? 0) + chunk.length > config.roomQuotaBytes ||
          usedBytes() + pendingBytes + chunk.length > config.totalQuotaBytes) {
          callback(fail(413, '存储空间不足，请删除文件或联系部署者调整容量'));
          return;
        }
        bytes += chunk.length;
        pendingBytes += chunk.length;
        pendingRoomBytes.set(room.id, (pendingRoomBytes.get(room.id) ?? 0) + chunk.length);
        callback(null, chunk);
      } });
      uploadTask = pipeline(stream, counter, createWriteStream(tempPath, { flags: 'wx' })).catch(error => { capture(error); parser.destroy(error); });
    });
    const aborted = () => parser.destroy(fail(400, '上传已中断'));
    req.once('aborted', aborted);
    try {
      try {
        await new Promise((resolveParser, rejectParser) => {
          parser.once('close', resolveParser);
          parser.once('error', rejectParser);
          req.pipe(parser);
        });
      } catch (error) { throw uploadError ?? (error.status ? error : fail(400, '上传内容不完整，请重新上传')); }
      await uploadTask;
      if (uploadError) throw uploadError;
      if (!uploadTask || !filename || req.aborted) throw fail(400, '请选择文件或重试上传');
      renameSync(tempPath, join(uploadDir, storageKey));
      moved = true;
      const createdAt = now();
      const currentRoom = db.prepare('SELECT ttl_hours FROM rooms WHERE id=?').get(room.id);
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)').run(id, room.id, userId, filename, storageKey, bytes, audience, createdAt, createdAt + currentRoom.ttl_hours * 3600000);
        for (const recipient of recipients) db.prepare('INSERT INTO recipients VALUES (?,?)').run(id, recipient);
        db.exec('COMMIT');
        committed = true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      res.status(201).json({ id, name: filename, size: bytes, createdAt, expiresAt: createdAt + currentRoom.ttl_hours * 3600000 });
    } finally {
      req.removeListener('aborted', aborted);
      if (!parser.destroyed) parser.destroy();
      await uploadTask;
      pendingBytes -= bytes;
      pendingRoomBytes.set(room.id, Math.max(0, (pendingRoomBytes.get(room.id) ?? 0) - bytes));
      activeUploads.set(userId, Math.max(0, (activeUploads.get(userId) ?? 0) - 1));
      activeTempPaths.delete(tempPath);
      if (!committed) removeDisk(moved ? join(uploadDir, storageKey) : tempPath);
    }
  });

  function fileFor(req) {
    const file = db.prepare(`SELECT f.* FROM files f JOIN members m ON m.room_id=f.room_id
      WHERE f.id=? AND m.user_id=? AND f.expires_at>? AND ${visible}`).get(req.params.fileId, req.user.id, now(), req.user.id, req.user.id);
    if (!file) throw fail(404, '文件不存在、已过期或你没有访问权限');
    return file;
  }
  app.get('/api/files/:fileId/download', authenticate, (req, res, next) => {
    const file = fileFor(req);
    res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.download(join(uploadDir, file.storage_key), file.name, { dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) next(fail(error.status === 404 ? 404 : 500, '文件暂时无法下载，请重试'));
    });
  });
  app.delete('/api/files/:fileId', authenticate, (req, res) => {
    const file = fileFor(req);
    if (file.sender_id !== req.user.id) throw fail(403, '只能删除自己发送的文件');
    if (!removeDisk(join(uploadDir, file.storage_key))) throw fail(503, '文件删除失败，请稍后重试');
    db.prepare('DELETE FROM files WHERE id=?').run(file.id);
    res.json({ ok: true });
  });
  app.use('/api', (_req, _res, next) => next(fail(404, '接口不存在')));
  const dist = resolve(options.distDir ?? './dist');
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res, next) => res.sendFile(join(dist, 'index.html'), error => { if (error) next(fail(404, '前端尚未构建，请运行 npm run build')); }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const status = error.status ?? (error.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error('请求失败', error);
    res.status(status).json({ error: status === 500 ? '服务器暂时无法处理请求' : error.message });
  });
  return { app, db, config, cleanup, close() { if (interval) clearInterval(interval); db.close(); } };
}
