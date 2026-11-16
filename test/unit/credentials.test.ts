import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { credentialsFromApiKey, isValidApiKey } from '../../src/auth/credentials.ts';

const KEY = 'a'.repeat(20) + '0123456789abcdef0123';

describe('credentials', () => {
  it('accepts 40 hex characters only', () => {
    assert.equal(isValidApiKey(KEY), true);
    assert.equal(isValidApiKey(KEY.toUpperCase()), true);
    assert.equal(isValidApiKey(KEY.slice(1)), false);
    assert.equal(isValidApiKey(`${KEY}0`), false);
    assert.equal(isValidApiKey('g'.repeat(40)), false);
    assert.equal(isValidApiKey(`${KEY.slice(0, 39)}/`), false);
    assert.equal(isValidApiKey(undefined), false);
  });

  it('builds the wger Token authorization header', () => {
    assert.deepEqual(credentialsFromApiKey(KEY), { authorization: `Token ${KEY}` });
    assert.throws(() => credentialsFromApiKey('nope'));
  });
});
