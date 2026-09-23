import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_TYPES, TYPES, allowedTypesFor, mayView, mayWrite, normalizeName, under, validateAllowedTypes, validatePayload } from '../src/policy';
import { AppError, type Actor, type Policy, type Zone } from '../src/types';

const actor = { user: { id: 'user-1', role: 'user' } } as Actor;
const admin = { user: { id: 'admin', role: 'admin' } } as Actor;
const zone = { id: 'zone', name: 'example.com', enabled: 1 } as Zone;
const policy = (mode: Policy['mode']) => ({ mode, allow_proxy: 0 }) as Policy;

describe('four permission modes', () => {
  it.each([
    ['self', true, false, true, false],
    ['collaborate', true, true, true, false],
    ['delegate', true, true, true, true],
    ['readonly', true, true, false, false],
  ] as const)('%s mode', (mode, ownVisible, otherVisible, ownWritable, otherWritable) => {
    expect(mayView(actor, policy(mode), 'user-1')).toBe(ownVisible);
    expect(mayView(actor, policy(mode), 'user-2')).toBe(otherVisible);
    expect(mayWrite(actor, policy(mode), 'user-1')).toBe(ownWritable);
    expect(mayWrite(actor, policy(mode), 'user-2')).toBe(otherWritable);
  });
  it('always lets the administrator view and write', () => {
    expect(mayView(admin, null, 'user-1')).toBe(true);
    expect(mayWrite(admin, null, 'user-1')).toBe(true);
  });
  it('fails closed when a user has no policy', () => {
    expect(mayView(actor, null, 'user-1')).toBe(false);
    expect(mayWrite(actor, null, 'user-1')).toBe(false);
  });
});

describe('DNS name and payload guardrails', () => {
  it('validates and canonicalizes a per-policy record type allowlist', () => {
    expect(validateAllowedTypes(['TXT', 'A'])).toEqual(['A', 'TXT']);
    expect(validateAllowedTypes([])).toEqual([]);
    expect(() => validateAllowedTypes(['A', 'A'])).toThrow(AppError);
    expect(() => validateAllowedTypes(['UNKNOWN'])).toThrow(AppError);
    expect(() => validateAllowedTypes('A')).toThrow(AppError);
    expect(DEFAULT_ALLOWED_TYPES).toEqual(['A', 'AAAA', 'CNAME', 'TXT']);
    expect(allowedTypesFor({ allowed_types_json: JSON.stringify([...TYPES]) } as Policy)).toEqual([...TYPES]);
    expect(allowedTypesFor({ allowed_types_json: 'invalid' } as Policy)).toEqual([]);
  });
  it('uses label boundaries for delegated subdomains', () => {
    expect(under('api.user.example.com', 'user.example.com')).toBe(true);
    expect(under('baduser.example.com', 'user.example.com')).toBe(false);
  });
  it('rejects names outside the zone and URL syntax tricks', () => {
    expect(() => normalizeName('user.example.com.evil.test', zone.name)).toThrow(AppError);
    expect(() => normalizeName('user@user.example.com', zone.name)).toThrow(AppError);
    expect(() => normalizeName('foo..example.com', zone.name)).toThrow(AppError);
  });
  it('accepts a structured record type and drops caller supplied tags', () => {
    const record = validatePayload({ type: 'SRV', name: '_sip._tcp.user.example.com', data: { priority: 10, weight: 5, port: 5060, target: 'host.test' }, tags: ['dns-panel:admin'] }, zone, policy('self'), actor);
    expect(record.type).toBe('SRV');
    expect(record.tags).toBeUndefined();
  });
  it('denies enabling proxy without the option', () => {
    expect(() => validatePayload({ type: 'A', name: 'user.example.com', content: '192.0.2.1', proxied: true }, zone, policy('self'), actor)).toThrow(AppError);
  });
});
