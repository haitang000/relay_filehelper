import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { scryptSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';

const password = 'test-password-123!';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-gov-'));
  const service = createApp({ dataDir, cleanupIntervalMs: 0 });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function req(path, { cookie, method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data, headers: response.headers };
  }
  async function register(username) {
    const response = await req('/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return { ...response.data, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  return { req, register, dataDir, base, service, server };
}

test('移出成员、离开房间和配对码只给管理员', async (t) => {
  const s = await setup(t);
  const admin = await s.register('管理员');
  const bob = await s.register('成员Bob');
  const room = (
    await s.req('/rooms', { method: 'POST', cookie: admin.cookie, body: { name: '治理房间' } })
  ).data;
  await s.req('/rooms/join', { method: 'POST', cookie: bob.cookie, body: { code: room.code } });
  assert.equal((await s.req(`/rooms/${room.id}`, { cookie: bob.cookie })).data.code, undefined);
  assert.equal(
    (await s.req(`/rooms/${room.id}/members/${bob.id}`, { method: 'DELETE', cookie: bob.cookie }))
      .status,
    403,
  );
  assert.equal(
    (
      await s.req(`/rooms/${room.id}/members/${admin.id}`, {
        method: 'DELETE',
        cookie: admin.cookie,
      })
    ).status,
    400,
  );
  assert.equal(
    (await s.req(`/rooms/${room.id}/leave`, { method: 'POST', cookie: admin.cookie })).status,
    400,
  );
  assert.equal(
    (await s.req(`/rooms/${room.id}/members/${bob.id}`, { method: 'DELETE', cookie: admin.cookie }))
      .status,
    200,
  );
  assert.equal((await s.req(`/rooms/${room.id}`, { cookie: bob.cookie })).status, 404);
  const carol = await s.register('carol');
  await s.req('/rooms/join', { method: 'POST', cookie: carol.cookie, body: { code: room.code } });
  assert.equal(
    (await s.req(`/rooms/${room.id}/leave`, { method: 'POST', cookie: carol.cookie })).status,
    200,
  );
  assert.equal((await s.req('/rooms', { cookie: carol.cookie })).data.length, 0);
  const audit = await s.req(`/rooms/${room.id}/audit`, { cookie: admin.cookie });
  assert.equal(audit.status, 200);
  assert.ok(audit.data.some((event) => event.action === 'remove-member'));
  assert.equal((await s.req(`/rooms/${room.id}/audit`, { cookie: bob.cookie })).status, 404);
});

test('改密保留当前会话并撤销其他会话，旧版 scrypt 哈希仍能登录', async (t) => {
  const s = await setup(t);
  const alice = await s.register('alice');
  const second = await s.req('/auth/login', {
    method: 'POST',
    body: { username: 'alice', password },
  });
  const secondCookie = second.headers.get('set-cookie').split(';')[0];
  const sessions = await s.req('/auth/sessions', { cookie: alice.cookie });
  assert.equal(sessions.data.length, 2);
  assert.equal(sessions.data.filter((session) => session.current).length, 1);
  const changed = await s.req('/auth/password', {
    method: 'POST',
    cookie: alice.cookie,
    body: { currentPassword: password, newPassword: 'updated-password-1' },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await s.req('/auth/me', { cookie: alice.cookie })).status, 200);
  assert.equal((await s.req('/auth/me', { cookie: secondCookie })).status, 401);
  assert.equal(
    (await s.req('/auth/login', { method: 'POST', body: { username: 'alice', password } })).status,
    401,
  );
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync('legacy-password-1', salt, 64).toString('hex');
  s.service.db
    .prepare('UPDATE users SET password_hash=? WHERE id=?')
    .run(`${salt}:${key}`, alice.id);
  assert.equal(
    (
      await s.req('/auth/login', {
        method: 'POST',
        body: { username: 'alice', password: 'legacy-password-1' },
      })
    ).status,
    200,
  );
});

test('停用账号、命令行建号，以及未读完的拒绝请求会断开', async (t) => {
  const s = await setup(t);
  const alice = await s.register('alice');
  const created = spawnSync(process.execPath, ['server/admin.mjs', 'create-user', 'bob'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: s.dataDir },
    input: 'created-password-1\n',
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(
    (
      await s.req('/auth/login', {
        method: 'POST',
        body: { username: 'bob', password: 'created-password-1' },
      })
    ).status,
    200,
  );
  const disabled = spawnSync(process.execPath, ['server/admin.mjs', 'disable', 'alice'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: s.dataDir },
    encoding: 'utf8',
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal((await s.req('/auth/me', { cookie: alice.cookie })).status, 401);
  assert.equal(
    (await s.req('/auth/login', { method: 'POST', body: { username: 'alice', password } })).status,
    403,
  );
  const room = (
    await s.req('/rooms', {
      method: 'POST',
      cookie: (
        await s.req('/auth/login', {
          method: 'POST',
          body: { username: 'bob', password: 'created-password-1' },
        })
      ).headers
        .get('set-cookie')
        .split(';')[0],
      body: { name: 'bob 的房间' },
    })
  ).data;
  const form = new FormData();
  form.append('file', new Blob(['secret']), 'report\u202Etxt.exe');
  const bob = await s.req('/auth/login', {
    method: 'POST',
    body: { username: 'bob', password: 'created-password-1' },
  });
  const uploaded = await s.req(`/rooms/${room.id}/files?audience=all`, {
    method: 'POST',
    cookie: bob.headers.get('set-cookie').split(';')[0],
    body: form,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.name.includes('\u202E'), false);
  assert.match(uploaded.data.name, /reporttxt\.exe/);
  const before = await new Promise((resolve) =>
    s.server.getConnections((_error, count) => resolve(count)),
  );
  const after = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: s.server.address().port,
        path: `/api/rooms/${room.id}/files?audience=all`,
        method: 'POST',
        headers: {
          Origin: s.base,
          'Content-Type': 'multipart/form-data; boundary=slow',
          'Content-Length': '2000000',
        },
      },
      (response) => {
        assert.equal(response.statusCode, 401);
        response.resume();
      },
    );
    request.on('error', () => {});
    request.on('close', () => {
      setTimeout(() => s.server.getConnections((_error, count) => resolve(count)), 30);
    });
    request.setTimeout(2000, () => reject(new Error('拒绝后的连接没有关闭')));
    request.end('x');
  });
  assert.ok(after <= before, `连接没有在拒绝后释放：${before} -> ${after}`);
});

test('第二个进程不能打开同一数据目录', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-lock-'));
  const first = createApp({ dataDir, cleanupIntervalMs: 0 });
  t.after(async () => {
    first.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.throws(() => createApp({ dataDir, cleanupIntervalMs: 0 }), /已有轻传进程/);
  first.close();
  const second = createApp({ dataDir, cleanupIntervalMs: 0 });
  second.close();
});

test('v1 数据库会迁移到 v2 且不会把版本写回 1', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-migrate-'));
  try {
    const created = new DatabaseSync(join(dataDir, 'relay.sqlite'));
    created.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO users VALUES ('user-1', 'alice', 'hash', 1);
      INSERT INTO sessions VALUES ('abc', 'user-1', 2);
      PRAGMA user_version=1;
    `);
    created.close();
    const opened = openDatabase(dataDir);
    const version = Number(opened.prepare('PRAGMA user_version').get().user_version);
    const userColumns = opened
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((column) => column.name);
    const session = opened.prepare('SELECT created_at FROM sessions WHERE token_hash=?').get('abc');
    opened.close();
    assert.equal(version, 2);
    assert.ok(userColumns.includes('disabled'));
    assert.equal(session.created_at, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
