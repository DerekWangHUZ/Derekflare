import { describe, expect, it } from 'vitest';
import { mayView, mayWrite, normalizeName, under, validatePayload } from '../src/policy';
import { AppError, type Actor, type Policy, type Zone } from '../src/types';

const actor = { user: { id: 'friend-1', role: 'friend' } } as Actor;
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
    expect(mayView(actor, policy(mode), 'friend-1')).toBe(ownVisible);
    expect(mayView(actor, policy(mode), 'friend-2')).toBe(otherVisible);
    expect(mayWrite(actor, policy(mode), 'friend-1')).toBe(ownWritable);
    expect(mayWrite(actor, policy(mode), 'friend-2')).toBe(otherWritable);
  });
  it('always lets the administrator view and write', () => {
    expect(mayView(admin, null, 'friend-1')).toBe(true);
    expect(mayWrite(admin, null, 'friend-1')).toBe(true);
  });
  it('fails closed when a friend has no policy', () => {
    expect(mayView(actor, null, 'friend-1')).toBe(false);
    expect(mayWrite(actor, null, 'friend-1')).toBe(false);
  });
});

describe('DNS name and payload guardrails', () => {
  it('uses label boundaries for delegated subdomains', () => {
    expect(under('api.friend.example.com', 'friend.example.com')).toBe(true);
    expect(under('badfriend.example.com', 'friend.example.com')).toBe(false);
  });
  it('rejects names outside the zone and URL syntax tricks', () => {
    expect(() => normalizeName('friend.example.com.evil.test', zone.name)).toThrow(AppError);
    expect(() => normalizeName('user@friend.example.com', zone.name)).toThrow(AppError);
    expect(() => normalizeName('foo..example.com', zone.name)).toThrow(AppError);
  });
  it('accepts a structured record type and drops caller supplied tags', () => {
    const record = validatePayload({ type: 'SRV', name: '_sip._tcp.friend.example.com', data: { priority: 10, weight: 5, port: 5060, target: 'host.test' }, tags: ['dns-panel:admin'] }, zone, policy('self'), actor);
    expect(record.type).toBe('SRV');
    expect(record.tags).toBeUndefined();
  });
  it('denies enabling proxy without the option', () => {
    expect(() => validatePayload({ type: 'A', name: 'friend.example.com', content: '192.0.2.1', proxied: true }, zone, policy('self'), actor)).toThrow(AppError);
  });
});
