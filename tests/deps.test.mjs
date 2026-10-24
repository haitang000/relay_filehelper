import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function lockedVersion(lockfile, name) {
  const json = JSON.parse(readFileSync(lockfile, 'utf8'));
  const entry = json.packages?.[`node_modules/${name}`];
  assert.ok(entry?.version, `${lockfile} 缺少 ${name}`);
  return entry.version;
}

const names = ['express', 'busboy', 'helmet', 'body-parser'];

test('根目录和运行包锁定同一组服务端依赖，且 body-parser 已修复', () => {
  for (const name of names) {
    assert.equal(
      lockedVersion('package-lock.json', name),
      lockedVersion('deploy/runtime/package-lock.json', name),
      name,
    );
  }
  assert.equal(lockedVersion('package-lock.json', 'body-parser'), '2.4.0');
});
