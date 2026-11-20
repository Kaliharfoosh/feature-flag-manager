// Unit tests for evaluate() and the API key helpers. No database needed.
const { bucket, evaluate } = require('../evaluate');
const { newKey, hashKey, readBearer } = require('../../../shared/api-keys');

const on = { archived: false, enabled: true, percentage: 100, allow: [], block: [] };
const users = Array.from({ length: 2000 }, (_, i) => `user-${i}`);

describe('bucket()', () => {
  test('is always 0 to 9999', () => {
    for (const u of users) {
      const b = bucket('new-checkout', u);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10000);
    }
  });

  test('the same flag and user always give the same bucket (stable)', () => {
    expect(bucket('new-checkout', 'u-981')).toBe(bucket('new-checkout', 'u-981'));
  });

  test('a different flag key gives a different spread of users', () => {
    const same = users.filter((u) => bucket('flag-a', u) === bucket('flag-b', u));
    expect(same.length).toBeLessThan(10);
  });
});

describe('evaluate()', () => {
  test('0% turns the flag on for nobody, 100% for everybody', () => {
    expect(users.some((u) => evaluate({ ...on, percentage: 0 }, 'f', u).enabled)).toBe(false);
    expect(users.every((u) => evaluate({ ...on, percentage: 100 }, 'f', u).enabled)).toBe(true);
  });

  test('25% turns it on for roughly a quarter of users', () => {
    const count = users.filter((u) => evaluate({ ...on, percentage: 25 }, 'f', u).enabled).length;
    expect(count / users.length).toBeGreaterThan(0.2);
    expect(count / users.length).toBeLessThan(0.3);
  });

  test('raising 25% to 50% keeps everyone who was already in', () => {
    const at25 = users.filter((u) => evaluate({ ...on, percentage: 25 }, 'f', u).enabled);
    const at50 = new Set(users.filter((u) => evaluate({ ...on, percentage: 50 }, 'f', u).enabled));
    expect(at25.every((u) => at50.has(u))).toBe(true);
  });

  test('accepts the percentage as the string pg returns ("25.00")', () => {
    const fromString = users.filter((u) => evaluate({ ...on, percentage: '25.00' }, 'f', u).enabled);
    const fromNumber = users.filter((u) => evaluate({ ...on, percentage: 25 }, 'f', u).enabled);
    expect(fromString).toEqual(fromNumber);
  });

  test('a missing percentage means 0%', () => {
    expect(evaluate({ ...on, percentage: undefined }, 'f', 'u-1')).toMatchObject({ enabled: false, reason: 'out-of-percentage' });
  });

  test('archived beats everything, even the allow list', () => {
    expect(evaluate({ ...on, archived: true, allow: ['u-1'] }, 'f', 'u-1')).toMatchObject({ enabled: false, reason: 'archived' });
  });

  test('an environment that is off is off, even for allow-listed users', () => {
    expect(evaluate({ ...on, enabled: false, allow: ['u-1'] }, 'f', 'u-1')).toMatchObject({ enabled: false, reason: 'disabled' });
  });

  test('block list wins over 100% and over the allow list', () => {
    expect(evaluate({ ...on, block: ['u-1'], allow: ['u-1'] }, 'f', 'u-1')).toMatchObject({ enabled: false, reason: 'blocklisted' });
  });

  test('allow list turns it on even at 0%', () => {
    expect(evaluate({ ...on, percentage: 0, allow: ['u-1'] }, 'f', 'u-1')).toMatchObject({ enabled: true, reason: 'allowlisted' });
  });

  test('returns the bucket so the preview tool can show it', () => {
    expect(evaluate(on, 'new-checkout', 'u-981').bucket).toBe(bucket('new-checkout', 'u-981'));
  });
});

describe('api key helpers', () => {
  test('newKey: the prefix is ffm_<env code>_ + 6 letters/digits and the hash matches', () => {
    for (const [env, code] of [['dev', 'dev'], ['staging', 'stg'], ['prod', 'prd']]) {
      const key = newKey(env);
      expect(key.prefix).toMatch(new RegExp(`^ffm_${code}_[A-Za-z0-9]{6}$`));
      expect(key.raw.startsWith(key.prefix)).toBe(true);
      expect(key.keyHash).toBe(hashKey(key.raw));
      expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('newKey: two keys are never the same', () => {
    expect(newKey('staging').raw).not.toBe(newKey('staging').raw);
  });

  test('newKey: refuses an unknown env', () => {
    expect(() => newKey('qa')).toThrow(TypeError);
  });

  test('readBearer: takes a well-formed key, refuses everything else', () => {
    const { raw } = newKey('staging');
    expect(readBearer(`Bearer ${raw}`)).toBe(raw);
    expect(readBearer(`bearer ${raw}`)).toBe(raw);
    expect(readBearer(undefined)).toBeNull();
    expect(readBearer('')).toBeNull();
    expect(readBearer(raw)).toBeNull(); // no "Bearer"
    expect(readBearer('Bearer not-a-key')).toBeNull();
    expect(readBearer(`Basic ${raw}`)).toBeNull();
  });
});
