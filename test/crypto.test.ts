import { describe, expect, it } from 'vitest';
import { base32, bytes, decryptTotp, encryptTotp, hashPassword, verifyPassword, verifyTotp, b64 } from '../src/crypto';

describe('credentials', () => {
  it('verifies salted password hashes and rejects the wrong password', async () => {
    const saved = await hashPassword('a-test-password-123');
    expect(saved.iterations).toBeLessThanOrEqual(100_000);
    expect(await verifyPassword('a-test-password-123', saved.salt, saved.hash, saved.iterations)).toBe(true);
    expect(await verifyPassword('wrong-password-123', saved.salt, saved.hash, saved.iterations)).toBe(false);
  });
  it('encrypts the TOTP secret and validates a known RFC vector', async () => {
    const key = b64(bytes(32));
    const secret = base32(new TextEncoder().encode('12345678901234567890'));
    const encrypted = await encryptTotp(secret, key);
    expect(encrypted).not.toContain(secret);
    expect(await decryptTotp(encrypted, key)).toBe(secret);
    expect(await verifyTotp(secret, '287082', 59_000)).toBe(true);
  });
});
