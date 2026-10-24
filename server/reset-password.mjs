import { resolve } from 'node:path';
import { openDatabase } from './db.mjs';
import { hashPassword, validatePassword } from './auth.mjs';

const username = process.argv[2];
if (!username || process.stdin.isTTY) {
  console.error(
    '用法：通过标准输入传入新密码，运行 node server/reset-password.mjs <用户名>；请参阅 README 的安全重置命令。',
  );
  process.exit(1);
}
let password = '';
for await (const chunk of process.stdin) {
  password += chunk;
  if (password.length > 1024) throw new Error('输入过长');
}
password = password.replace(/\r?\n$/, '');
validatePassword(password);
const db = openDatabase(resolve(process.env.DATA_DIR ?? './data'));
try {
  const user = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!user) throw new Error('用户不存在');
  const hash = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log('密码已重置，该用户的所有登录会话已失效。');
} finally {
  db.close();
}
