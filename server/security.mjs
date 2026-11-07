import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, 64, PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, PARAMS);
  return timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** Human-friendly temporary password, e.g. "Kp7m-Qx2z-Vn4c-Hd8r". */
export function tempPassword() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

export function passwordProblems(password, { email, current } = {}) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 12) problems.push('Use at least 12 characters.');
  if (typeof password === 'string' && password.length > 200) problems.push('Use at most 200 characters.');
  if (email && typeof password === 'string' && password.toLowerCase().includes(email.split('@')[0].toLowerCase()))
    problems.push('Do not include your email name.');
  if (current && password === current) problems.push('Choose a password different from the temporary one.');
  if (typeof password === 'string' && /^(.)\1+$/.test(password)) problems.push('Avoid repeating a single character.');
  return problems;
}
