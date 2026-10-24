import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

const password = 'test-password-123!';
async function setup(t, env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-test-'));
  let clock = Date.now();
  let service, server, base;
  async function start() {
    service = createApp({ dataDir, env, now: () => clock, cleanupIntervalMs: 0 });
    server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    service.cleanup();
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    service.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function req(
    path,
    { cookie, method = 'GET', body, headers = {}, origin, ...options } = {},
  ) {
    const originHeader =
      origin === false
        ? undefined
        : (origin ?? (env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : base));
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(originHeader ? { Origin: originHeader } : {}),
        ...(body !== undefined && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
      ...options,
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
  async function room(user, name = '测试协作空间') {
    const response = await req('/rooms', { method: 'POST', cookie: user.cookie, body: { name } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  async function joinRoom(user, room) {
    const response = await req('/rooms/join', {
      method: 'POST',
      cookie: user.cookie,
      body: { code: room.code },
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  async function upload(
    user,
    room,
    { name = '中文文件.txt', content = '你好，轻传', audience = 'all', recipients = [] } = {},
  ) {
    const form = new FormData();
    form.append('file', new Blob([content]), name);
    return req(
      `/rooms/${room.id}/files?${new URLSearchParams({ audience, recipients: recipients.join(',') })}`,
      { method: 'POST', cookie: user.cookie, body: form },
    );
  }
  return {
    req,
    register,
    room,
    joinRoom,
    upload,
    dataDir,
    get service() {
      return service;
    },
    get base() {
      return base;
    },
    advance(ms) {
      clock += ms;
    },
    async restart() {
      await stop();
      await start();
    },
  };
}

test('账号校验、会话、跨设备身份和退出登录', async (t) => {
  const s = await setup(t);
  assert.equal((await s.req('/auth/me')).status, 401);
  assert.equal(
    (await s.req('/auth/register', { method: 'POST', body: { username: 'x', password } })).status,
    400,
  );
  assert.equal(
    (
      await s.req('/auth/register', {
        method: 'POST',
        body: { username: 'test', password: 'short' },
      })
    ).status,
    400,
  );
  const alice = await s.register('Alice');
  assert.equal(
    (await s.req('/auth/register', { method: 'POST', body: { username: 'alice', password } }))
      .status,
    409,
  );
  const room = await s.room(alice);
  const login = await s.req('/auth/login', {
    method: 'POST',
    body: { username: 'alice', password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.id, alice.id);
  const second = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await s.req('/rooms', { cookie: second })).data[0].isAdmin, true);
  assert.equal((await s.req('/rooms', { cookie: second })).data[0].id, room.id);
  assert.equal(
    (await s.req('/auth/login', { method: 'POST', body: { username: 'Alice', password: 'wrong' } }))
      .status,
    401,
  );
  assert.equal((await s.req('/auth/logout', { method: 'POST', cookie: second })).status, 200);
  assert.equal((await s.req('/auth/me', { cookie: second })).status, 401);
  assert.equal((await s.req('/auth/me', { cookie: alice.cookie })).status, 200);
  const stored = s.service.db
    .prepare('SELECT password_hash FROM users WHERE id=?')
    .get(alice.id).password_hash;
  assert.notEqual(stored, password);
  assert.match(stored, /^[a-f0-9]{32}:[a-f0-9]{128}:131072$/);
});

test('创建者权限、配对码重置、多房间和已有成员不受影响', async (t) => {
  const s = await setup(t);
  const admin = await s.register('管理员');
  const bob = await s.register('成员Bob');
  const room = await s.room(admin);
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{8}$/);
  await s.joinRoom(bob, room);
  assert.equal(
    (
      await s.req(`/rooms/${room.id}`, {
        method: 'PATCH',
        cookie: bob.cookie,
        body: { ttlHours: 1 },
      })
    ).status,
    403,
  );
  assert.equal(
    (await s.req(`/rooms/${room.id}/reset-code`, { method: 'POST', cookie: bob.cookie })).status,
    403,
  );
  assert.equal(
    (
      await s.req(`/rooms/${room.id}`, {
        method: 'PATCH',
        cookie: admin.cookie,
        body: { ttlHours: 2 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await s.req(`/rooms/${room.id}`, {
        method: 'PATCH',
        cookie: admin.cookie,
        body: { ttlHours: 168 },
      })
    ).data.ttlHours,
    168,
  );
  const reset = await s.req(`/rooms/${room.id}/reset-code`, {
    method: 'POST',
    cookie: admin.cookie,
  });
  assert.notEqual(reset.data.code, room.code);
  assert.equal(
    (await s.req('/rooms/join', { method: 'POST', cookie: bob.cookie, body: { code: room.code } }))
      .status,
    404,
  );
  assert.equal((await s.req(`/rooms/${room.id}/members`, { cookie: bob.cookie })).data.length, 2);
  await s.room(bob, '第二房间');
  assert.equal((await s.req('/rooms', { cookie: bob.cookie })).data.length, 2);
});

test('全员历史文件、新成员、定向隐私和管理员无额外读取权', async (t) => {
  const s = await setup(t);
  const admin = await s.register('admin');
  const bob = await s.register('bob');
  const carol = await s.register('carol');
  const later = await s.register('later');
  const outsider = await s.register('outsider');
  const room = await s.room(admin);
  await s.joinRoom(bob, room);
  await s.joinRoom(carol, room);
  const publicFile = await s.upload(bob, room);
  assert.equal(publicFile.status, 201, JSON.stringify(publicFile.data));
  const secret = await s.upload(bob, room, {
    name: '私密设计.txt',
    content: 'private',
    audience: 'selected',
    recipients: [carol.id],
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.data));
  await s.joinRoom(later, room);
  const laterList = await s.req(`/rooms/${room.id}/files`, { cookie: later.cookie });
  assert.deepEqual(
    laterList.data.files.map((file) => file.id),
    [publicFile.data.id],
  );
  assert.equal(
    (await s.req(`/files/${secret.data.id}/download`, { cookie: later.cookie })).status,
    404,
  );
  assert.equal(
    (await s.req(`/files/${secret.data.id}`, { method: 'DELETE', cookie: later.cookie })).status,
    404,
  );
  const adminList = await s.req(`/rooms/${room.id}/files`, { cookie: admin.cookie });
  assert.deepEqual(
    adminList.data.files.map((file) => file.id).sort(),
    [publicFile.data.id, secret.data.id].sort(),
  );
  assert.equal(adminList.data.files.find((file) => file.id === secret.data.id).restricted, true);
  assert.equal(
    (await s.req(`/files/${secret.data.id}/download`, { cookie: admin.cookie })).status,
    404,
  );
  assert.equal((await s.req(`/rooms/${room.id}/files`, { cookie: carol.cookie })).data.total, 2);
  assert.equal(
    (await s.req(`/rooms/${room.id}/files?tab=sent`, { cookie: bob.cookie })).data.total,
    2,
  );
  assert.equal((await s.req(`/rooms/${room.id}/files`, { cookie: bob.cookie })).data.total, 0);
  assert.equal((await s.req(`/rooms/${room.id}/files`, { cookie: outsider.cookie })).status, 404);
  assert.equal(
    (await s.req(`/files/${publicFile.data.id}/download`, { cookie: outsider.cookie })).status,
    404,
  );
  const download = await s.req(`/files/${publicFile.data.id}/download`, { cookie: later.cookie });
  assert.equal(download.status, 200);
  assert.equal(download.data, '你好，轻传');
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await s.req(`/rooms/${room.id}`, { cookie: later.cookie })).data.code, undefined);
  assert.equal(
    (await s.req(`/files/${publicFile.data.id}`, { method: 'DELETE', cookie: admin.cookie }))
      .status,
    200,
  );
  assert.equal((await readdir(join(s.dataDir, 'files'))).length, 1);
  assert.equal(
    (await s.req(`/files/${secret.data.id}`, { method: 'DELETE', cookie: carol.cookie })).status,
    403,
  );
  assert.equal((await s.req(`/rooms/${room.id}`, { cookie: carol.cookie })).data.receivedCount, 1);
  assert.equal(
    (await s.req(`/files/${secret.data.id}`, { method: 'DELETE', cookie: bob.cookie })).status,
    200,
  );
  assert.equal((await readdir(join(s.dataDir, 'files'))).length, 0);
});

test('到期立即禁下载、配置不追溯旧文件、定时清理和重启补清理', async (t) => {
  const s = await setup(t);
  const admin = await s.register('admin');
  const room = await s.room(admin);
  const old = await s.upload(admin, room, { content: 'old' });
  await s.req(`/rooms/${room.id}`, {
    cookie: admin.cookie,
    method: 'PATCH',
    body: { ttlHours: 1 },
  });
  const recent = await s.upload(admin, room, { content: 'new' });
  assert.equal(old.data.expiresAt - old.data.createdAt, 86400000);
  assert.equal(recent.data.expiresAt - recent.data.createdAt, 3600000);
  s.advance(3600000);
  assert.equal(
    (await s.req(`/files/${recent.data.id}/download`, { cookie: admin.cookie })).status,
    404,
  );
  assert.equal(
    (await s.req(`/rooms/${room.id}/files?tab=sent`, { cookie: admin.cookie })).data.total,
    1,
  );
  assert.equal((await readdir(join(s.dataDir, 'files'))).length, 2);
  s.service.cleanup();
  assert.equal((await readdir(join(s.dataDir, 'files'))).length, 1);
  assert.equal(s.service.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
  await writeFile(join(s.dataDir, 'tmp', 'abandoned'), 'orphan');
  await writeFile(join(s.dataDir, 'files', 'orphan.bin'), 'orphan');
  await s.restart();
  assert.equal((await readdir(join(s.dataDir, 'tmp'))).length, 0);
  assert.equal((await readdir(join(s.dataDir, 'files'))).length, 1);
  assert.equal((await s.req('/rooms', { cookie: admin.cookie })).data[0].isAdmin, true);
  assert.equal(
    (await s.req(`/files/${old.data.id}/download`, { cookie: admin.cookie })).data,
    'old',
  );
  s.advance(86400000);
  await s.restart();
  assert.equal((await readdir(join(s.dataDir, 'files'))).length, 0);
  assert.equal(s.service.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
});

test('同名文件、零字节、精确大小上限和非法接收人', async (t) => {
  const s = await setup(t, { MAX_FILE_BYTES: '16' });
  const admin = await s.register('admin');
  const stranger = await s.register('stranger');
  const room = await s.room(admin);
  const a = await s.upload(admin, room, { content: 'a' });
  const b = await s.upload(admin, room, { content: 'b' });
  assert.notEqual(a.data.id, b.data.id);
  assert.equal((await s.upload(admin, room, { content: '' })).status, 201);
  assert.equal((await s.upload(admin, room, { content: 'x'.repeat(16) })).status, 201);
  assert.equal((await s.upload(admin, room, { content: 'x'.repeat(17) })).status, 413);
  assert.equal((await s.upload(admin, room, { audience: 'selected', recipients: [] })).status, 400);
  assert.equal(
    (await s.upload(admin, room, { audience: 'selected', recipients: [stranger.id] })).status,
    400,
  );
  assert.equal((await readdir(join(s.dataDir, 'files'))).length, 4);
  assert.equal((await readdir(join(s.dataDir, 'tmp'))).length, 0);
});

test('房间与全站容量在并发上传时也不能超额，失败释放预留空间', async (t) => {
  const s = await setup(t, { ROOM_QUOTA_BYTES: '100', TOTAL_QUOTA_BYTES: '130' });
  const a = await s.register('alice');
  const b = await s.register('bob');
  const room = await s.room(a);
  await s.joinRoom(b, room);
  const results = await Promise.all([
    s.upload(a, room, { content: 'x'.repeat(70) }),
    s.upload(b, room, { content: 'y'.repeat(70) }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 413]);
  assert.equal(s.service.db.prepare('SELECT SUM(size) AS n FROM files').get().n, 70);
  const second = await s.room(a, '另一个房间');
  assert.equal((await s.upload(a, second, { content: 'x'.repeat(61) })).status, 413);
  assert.equal((await s.upload(a, second, { content: 'x'.repeat(60) })).status, 201);
  assert.equal((await readdir(join(s.dataDir, 'tmp'))).length, 0);
});

test('中断上传清理临时文件、并发数限制、上传名不能成为服务器路径', async (t) => {
  const s = await setup(t, { MAX_CONCURRENT_UPLOADS: '1' });
  const a = await s.register('alice');
  const room = await s.room(a);
  const request = httpRequest(`${s.base}/api/rooms/${room.id}/files?audience=all`, {
    method: 'POST',
    headers: {
      Cookie: a.cookie,
      Origin: s.base,
      'Content-Type': 'multipart/form-data; boundary=relaytest',
    },
  });
  request.on('error', () => {});
  request.write(
    '--relaytest\r\nContent-Disposition: form-data; name="file"; filename="interrupted.bin"\r\nContent-Type: application/octet-stream\r\n\r\n',
  );
  request.write(Buffer.alloc(65536));
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await readdir(join(s.dataDir, 'tmp'))).length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await s.upload(a, room)).status, 429);
  request.destroy();
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await readdir(join(s.dataDir, 'tmp'))).length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await readdir(join(s.dataDir, 'tmp'))).length, 0);
  assert.equal(s.service.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  const file = await s.upload(a, room, { name: '../../escape.txt' });
  assert.equal(file.status, 201);
  assert.equal(file.data.name, 'escape.txt');
  assert.match((await readdir(join(s.dataDir, 'files')))[0], /^[a-f0-9-]+\.bin$/);
  const form = new FormData();
  form.append('file', new Blob(['first']), 'a.txt');
  form.append('file', new Blob(['second']), 'b.txt');
  assert.equal(
    (
      await s.req(`/rooms/${room.id}/files?audience=all`, {
        method: 'POST',
        cookie: a.cookie,
        body: form,
      })
    ).status,
    400,
  );
  assert.equal((await readdir(join(s.dataDir, 'tmp'))).length, 0);
});

test('16 MiB 文件以数据块流式传输，落盘大小和 Range 下载正确', async (t) => {
  const s = await setup(t);
  const a = await s.register('alice');
  const room = await s.room(a);
  const responseTask = new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      `${s.base}/api/rooms/${room.id}/files?audience=all`,
      {
        method: 'POST',
        headers: {
          Cookie: a.cookie,
          Origin: s.base,
          'Content-Type': 'multipart/form-data; boundary=largefile',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolveResponse({
            status: response.statusCode,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    request.on('error', rejectResponse);
    void (async () => {
      request.write(
        '--largefile\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n',
      );
      const chunk = Buffer.alloc(65536, 65);
      for (let i = 0; i < 256; i++) if (!request.write(chunk)) await once(request, 'drain');
      request.end('\r\n--largefile--\r\n');
    })().catch(rejectResponse);
  });
  const response = await responseTask;
  assert.equal(response.status, 201);
  assert.equal(response.data.size, 16 * 1024 * 1024);
  const stored = (await readdir(join(s.dataDir, 'files')))[0];
  assert.equal((await stat(join(s.dataDir, 'files', stored))).size, response.data.size);
  const range = await s.req(`/files/${response.data.id}/download`, {
    cookie: a.cookie,
    headers: { Range: 'bytes=0-15' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.data, 'A'.repeat(16));
  assert.equal(range.headers.get('content-range'), 'bytes 0-15/16777216');
});

test('关闭注册、来源校验、会话过期与配对码限流', async (t) => {
  const closed = await setup(t, { REGISTRATION_ENABLED: 'false' });
  assert.equal(
    (await closed.req('/auth/register', { method: 'POST', body: { username: 'alice', password } }))
      .status,
    403,
  );
  const s = await setup(t);
  const a = await s.register('alice');
  assert.equal(
    (
      await s.req('/rooms', {
        method: 'POST',
        cookie: a.cookie,
        body: { name: 'bad' },
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await s.req('/rooms', {
        method: 'POST',
        cookie: a.cookie,
        body: { name: 'good' },
        headers: { Origin: s.base },
      })
    ).status,
    201,
  );
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await s.req('/rooms/join', { method: 'POST', cookie: a.cookie, body: { code: 'ABCDEFGH' } }))
        .status,
      404,
    );
  const limited = await s.req('/rooms/join', {
    method: 'POST',
    cookie: a.cookie,
    body: { code: 'ABCDEFGH' },
  });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  s.advance(31 * 86400000);
  assert.equal((await s.req('/auth/me', { cookie: a.cookie })).status, 401);
});

test('文件查询分页、搜索与健康检查', async (t) => {
  const s = await setup(t);
  const a = await s.register('alice');
  const room = await s.room(a);
  const file = await s.upload(a, room, { name: '方案设计.PDF' });
  assert.equal(file.status, 201);
  assert.equal(
    (await s.req(`/rooms/${room.id}/files?tab=sent&search=设计`, { cookie: a.cookie })).data.total,
    1,
  );
  assert.equal(
    (await s.req(`/rooms/${room.id}/files?tab=sent&search=pdf`, { cookie: a.cookie })).data.total,
    1,
  );
  assert.equal(
    (await s.req(`/rooms/${room.id}/files?tab=sent&search=xyz`, { cookie: a.cookie })).data.total,
    0,
  );
  assert.equal(
    (await s.req(`/rooms/${room.id}/files?tab=sent&page=2`, { cookie: a.cookie })).data.files
      .length,
    0,
  );
  assert.equal((await s.req('/health')).data.status, 'ok');
  assert.equal((await s.req('/nonexistent')).status, 404);
});

test('服务器密码重置命令更新密码并撤销全部会话', async (t) => {
  const s = await setup(t);
  const a = await s.register('alice');
  const reset = spawnSync(process.execPath, ['server/reset-password.mjs', 'alice'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: s.dataDir },
    input: 'new-password-123!\n',
    encoding: 'utf8',
  });
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal((await s.req('/auth/me', { cookie: a.cookie })).status, 401);
  assert.equal(
    (await s.req('/auth/login', { method: 'POST', body: { username: 'alice', password } })).status,
    401,
  );
  assert.equal(
    (
      await s.req('/auth/login', {
        method: 'POST',
        body: { username: 'alice', password: 'new-password-123!' },
      })
    ).status,
    200,
  );
});

test('公网 HTTP 端口模式不会强制升级资源到 HTTPS，HTTPS 部署保留升级策略', async (t) => {
  const http = await setup(t, {
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'http://files.example.com',
    COOKIE_SECURE: 'false',
  });
  const user = await http.register('alice');
  const response = await http.req('/auth/me', { cookie: user.cookie });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  assert.equal(response.headers.get('strict-transport-security'), null);
  assert.equal(
    (
      await http.req('/rooms', {
        method: 'POST',
        cookie: user.cookie,
        body: { name: '无来源' },
        origin: false,
      })
    ).status,
    403,
  );
  const https = await setup(t, {
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://files.example.com',
  });
  const register = await https.req('/auth/register', {
    method: 'POST',
    body: { username: 'alice', password },
  });
  assert.equal(register.status, 201);
  assert.match(register.headers.get('set-cookie'), /Secure/);
  assert.match(register.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});
