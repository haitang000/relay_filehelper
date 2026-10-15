import { chdir, loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
chdir(fileURLToPath(new URL('.', import.meta.url)));
loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
await import('./server/index.mjs');
