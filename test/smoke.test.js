import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERSION, PRODUCT } from '../dist/index.js';

test('package exposes a semantic version string', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('product identity is AetherMux', () => {
  assert.equal(PRODUCT, 'AetherMux');
});
