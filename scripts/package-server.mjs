import { cpSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = resolve(root, '.deployment');
const staging = join(outputRoot, `release-${Date.now()}`);
const output = join(staging, 'relay');
mkdirSync(output, { recursive: true });
for (const directory of ['server', 'dist']) cpSync(join(root, directory), join(output, directory), { recursive: true });
cpSync(join(root, 'deploy/runtime/node_modules'), join(output, 'node_modules'), { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'start.mjs']) copyFileSync(join(root, 'deploy/runtime', name), join(output, name));
copyFileSync(join(root, 'deploy/runtime/.env.example'), join(output, '.env'));
const files = {};
function hashDirectory(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) hashDirectory(path);
    else files[relative(output, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
for (const directory of ['server', 'dist']) hashDirectory(join(output, directory));
for (const name of ['package.json', 'package-lock.json', 'start.mjs']) files[name] = createHash('sha256').update(readFileSync(join(output, name))).digest('hex');
writeFileSync(join(output, 'release.json'), JSON.stringify({ version: '1.0.0', builtAt: new Date().toISOString(), files }, null, 2));
const archive = join(outputRoot, 'relay-server.tar.gz');
const result = spawnSync('tar', ['-czf', archive, '-C', staging, 'relay'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('部署包压缩失败');
console.log(`部署包已生成：${archive} (${statSync(archive).size} bytes)`);
