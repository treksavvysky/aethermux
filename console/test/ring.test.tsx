// @vitest-environment jsdom
import { test, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';

import { TabBar } from '../src/ui/TabBar';
import type { Tab } from '../src/store';
import type { AttentionState } from '../src/protocol';

afterEach(() => cleanup());

function tabWith(attentionState: AttentionState): Tab {
  return { sessionId: 's1', agentId: 'agent-01', label: 's1', status: 'active', attentionState };
}

function renderRing(state: AttentionState) {
  const { getByTestId } = render(
    <TabBar tabs={[tabWith(state)]} activeKey={null} onSelect={() => {}} onClose={() => {}} onNew={() => {}} />,
  );
  return getByTestId('tab-s1/agent-01');
}

test('ring colour reflects the attention state enum (blue/green/error/neutral)', () => {
  expect(renderRing('awaiting-input').className).toContain('ring-awaiting-input'); // blue
  cleanup();
  expect(renderRing('exited').className).toContain('ring-exited'); // green
  cleanup();
  expect(renderRing('error').className).toContain('ring-error'); // red
  cleanup();
  expect(renderRing('running').className).toContain('ring-running'); // neutral
});

test('FALSE-GREEN GUARD: an error tab never carries the green (exited) ring class', () => {
  const el = renderRing('error');
  expect(el.getAttribute('data-attention')).toBe('error');
  expect(el.className).toContain('ring-error');
  expect(el.className).not.toContain('ring-exited');
});
