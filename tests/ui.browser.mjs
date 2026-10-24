import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createApp } from '../server/app.mjs';

const password = 'browser-pass-1';

test('浏览器能注册、看到配对码和存储用量，并完成一次小文件上传', { timeout: 90_000 }, async (t) => {
  assert.ok(
    existsSync(new URL('../dist/index.html', import.meta.url)),
    '请先运行 npm run build，再执行 npm run test:ui',
  );
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-ui-'));
  const service = createApp({
    dataDir,
    cleanupIntervalMs: 0,
    env: {
      NODE_ENV: 'development',
      REGISTRATION_ENABLED: 'true',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: '0',
    },
  });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function register(page, username) {
    await page.goto(base);
    await page.getByRole('button', { name: '注册账号' }).click();
    await page.getByRole('textbox', { name: '用户名' }).fill(username);
    await page.getByRole('textbox', { name: '密码' }).fill(password);
    await page.getByRole('button', { name: '创建账号' }).click();
    await page.getByRole('button', { name: /建立一个新的文件分享空间/ }).waitFor();
  }

  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const admin = await adminContext.newPage();
  await register(admin, '浏览器甲');
  await admin.getByRole('button', { name: /建立一个新的文件分享空间/ }).click();
  await admin.getByLabel('房间名称').fill('浏览器房间');
  await admin.getByRole('dialog').getByRole('button', { name: '创建房间' }).click();
  const pairing = admin.getByRole('button', { name: '复制房间配对码' });
  await pairing.waitFor();
  const code = (await pairing.locator('code').innerText()).replace(/\s+/g, '');
  assert.match(code, /^[A-Z2-9]{8}$/);
  await admin.getByLabel('房间存储使用量').waitFor();

  await admin.setViewportSize({ width: 390, height: 800 });
  const storage = admin.locator('.storage-summary');
  const box = await storage.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, '窄屏应继续显示房间存储');
  assert.notEqual(
    await storage.evaluate((element) => globalThis.getComputedStyle(element).display),
    'none',
  );

  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guest = await guestContext.newPage();
  await register(guest, '浏览器乙');
  await guest.getByRole('button', { name: /输入 8 位配对码/ }).click();
  await guest.getByLabel('8 位配对码').fill(code);
  await guest.getByRole('dialog').getByRole('button', { name: '加入房间' }).click();
  await guest.getByText('配对码仅管理员可见，请向管理员索取').waitFor();
  assert.equal(await guest.getByRole('button', { name: '复制房间配对码' }).count(), 0);

  await admin.setViewportSize({ width: 1280, height: 800 });
  await admin.locator('input[type=file]').setInputFiles({
    name: 'hello.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hi'),
  });
  await admin.getByRole('button', { name: '发送 1 个文件' }).click();
  await admin.getByText('发送成功', { exact: true }).waitFor();
  await admin.getByRole('cell', { name: 'hello.txt 2 B' }).waitFor();
});
