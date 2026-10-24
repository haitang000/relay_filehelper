import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDatabase } from './db.mjs';
import { hashPassword, validatePassword, validUsername } from './auth.mjs';

const [command, username] = process.argv.slice(2);
const commands = new Set(['create-user', 'disable', 'enable', 'delete-files']);
if (!commands.has(command) || !username || (command === 'create-user' && process.stdin.isTTY)) {
  console.error('用法：node server/admin.mjs <create-user|disable|enable|delete-files> <用户名>');
  console.error('create-user 从标准输入读取密码。停用会立即撤销该用户的全部会话。');
  process.exit(1);
}

async function readPassword() {
  let password = '';
  for await (const chunk of process.stdin) {
    password += chunk;
    if (password.length > 1024) throw new Error('输入过长');
  }
  password = password.replace(/\r?\n$/, '');
  validatePassword(password);
  return password;
}

const dataDir = resolve(process.env.DATA_DIR ?? './data');
const db = openDatabase(dataDir);
try {
  if (command === 'create-user') {
    if (!validUsername(username)) throw new Error('用户名需为 2–24 位文字、数字、下划线或短横线');
    const password = await readPassword();
    db.prepare(
      'INSERT INTO users (id, username, password_hash, created_at, disabled) VALUES (?,?,?,?,0)',
    ).run(randomUUID(), username, await hashPassword(password), Date.now());
    console.log('已创建用户。该用户可直接登录。');
  } else {
    const user = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (!user) throw new Error('用户不存在');
    if (command === 'disable') {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      console.log('已停用账号，该用户的全部登录会话已失效。');
    } else if (command === 'enable') {
      db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(user.id);
      console.log('已恢复账号。');
    } else {
      const files = db.prepare('SELECT id, storage_key FROM files WHERE sender_id=?').all(user.id);
      for (const file of files) {
        db.prepare('DELETE FROM files WHERE id=?').run(file.id);
        rmSync(join(dataDir, 'files', file.storage_key), { force: true });
      }
      console.log(
        `已删除 ${files.length} 个文件。若服务正在运行，用量统计会在下一分钟按数据库校正。`,
      );
    }
  }
} finally {
  db.close();
}
