import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 2 ** 17;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: SCRYPT_N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
  return `${salt}:${key.toString('hex')}:${SCRYPT_N}`;
}

export async function verifyPassword(password, hash) {
  const [salt, stored, cost] = hash.split(':');
  const N = cost ? Number(cost) : 16384;
  const key = await scrypt(password, salt, 64, { N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
  const expected = Buffer.from(stored, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw Object.assign(new Error('密码需为 10–128 个字符'), { status: 400 });
  }
}

export function validUsername(username) {
  return typeof username === 'string' && /^[\p{L}\p{N}_-]{2,24}$/u.test(username);
}
