import { test, expect } from 'vitest';

import { readConfig } from '../src/config';

test('readConfig defaults to the page origin and derives the ws URL with the token', () => {
  const cfg = readConfig({ origin: 'http://localhost:8080', search: '?token=abc' });
  expect(cfg.baseUrl).toBe('http://localhost:8080');
  expect(cfg.token).toBe('abc');
  expect(cfg.wsUrl).toBe('ws://localhost:8080/ws?token=abc');
});

test('readConfig honours an ?api= override and https→wss', () => {
  const cfg = readConfig({ origin: 'http://console.local', search: '?api=https://orch.example.com/&token=t%20k' });
  expect(cfg.baseUrl).toBe('https://orch.example.com');
  expect(cfg.wsUrl).toBe('wss://orch.example.com/ws?token=t%20k');
});

test('readConfig with no token still produces a ws URL (server will reject — fail-closed)', () => {
  const cfg = readConfig({ origin: 'http://localhost:8080', search: '' });
  expect(cfg.token).toBe('');
  expect(cfg.wsUrl).toBe('ws://localhost:8080/ws');
});
