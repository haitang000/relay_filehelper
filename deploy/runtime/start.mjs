import { existsSync } from 'node:fs';
import { chdir, loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
chdir(root);
const envPath = fileURLToPath(new URL('.env', import.meta.url));
if (!existsSync(envPath)) {
  console.error('请将 .env.example 复制为 .env 并填写 PUBLIC_ORIGIN');
  process.exit(1);
}
loadEnvFile(envPath);
await import('./server/index.mjs');
