import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.deployment');
mkdirSync(output, { recursive: true });
const archive = join(output, 'relay-web.tar.gz');
// New assets go first; index.html is replaced last. Existing assets remain usable by open tabs.
const result = spawnSync(
  'tar',
  ['-czf', archive, '-C', root, 'dist/assets', 'dist/favicon.svg', 'dist/index.html'],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('前端更新包压缩失败');
console.log(`前端更新包：${archive} (${statSync(archive).size} bytes)`);
