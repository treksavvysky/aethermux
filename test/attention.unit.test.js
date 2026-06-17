import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentStateMachine } from '../dist/index.js';

test('starts running; a real stdout prompt → awaiting-input; stdin → running', () => {
  const sm = new AgentStateMachine();
  assert.equal(sm.state, 'running');
  assert.equal(sm.onOutput('stdout', 'Continue? [y/N]'), true);
  assert.equal(sm.state, 'awaiting-input');
  // More output while awaiting does not change state.
  assert.equal(sm.onOutput('stdout', 'still here'), false);
  // The operator answers → resume running.
  assert.equal(sm.onStdin(), true);
  assert.equal(sm.state, 'running');
});

test('stderr is not matched for prompts; non-prompt stdout stays running', () => {
  const sm = new AgentStateMachine();
  assert.equal(sm.onOutput('stderr', 'error? '), false); // stderr never triggers a prompt
  assert.equal(sm.onOutput('stdout', 'building project'), false);
  assert.equal(sm.state, 'running');
});

test('FALSE-GREEN GUARD: exit 0 → exited (green); any non-zero exit → error', () => {
  const ok = new AgentStateMachine();
  assert.equal(ok.onExit('exited', 0), true);
  assert.equal(ok.state, 'exited');

  const nonzero = new AgentStateMachine();
  assert.equal(nonzero.onExit('exited', 3), true);
  assert.equal(nonzero.state, 'error'); // a non-zero exit must NEVER be green

  const errored = new AgentStateMachine();
  errored.onExit('error', null);
  assert.equal(errored.state, 'error');

  // green is unreachable without a real exit-code-0 exit (no output/prompt path to it).
  const sm = new AgentStateMachine();
  sm.onOutput('stdout', 'done? ');
  sm.onStdin();
  assert.notEqual(sm.state, 'exited');
});

test('terminal states are sticky — no resurrection from later output or stdin', () => {
  const sm = new AgentStateMachine();
  sm.onExit('exited', 0);
  assert.equal(sm.onOutput('stdout', 'late prompt? '), false);
  assert.equal(sm.onStdin(), false);
  assert.equal(sm.state, 'exited');
});

test('prompt patterns are configurable; defaults cover common CLI prompts', () => {
  const custom = new AgentStateMachine([/READY>$/]);
  assert.equal(custom.onOutput('stdout', 'anything? '), false); // default generic not active
  assert.equal(custom.onOutput('stdout', 'READY>'), true);

  for (const line of ['Proceed?', 'name > ', '(y/n)', '[y/N]', 'Press ENTER to continue', 'Do you want to proceed']) {
    assert.equal(new AgentStateMachine().matchesPrompt(line), true, `should match: ${line}`);
  }
  for (const line of ['building project', 'Result: 42', 'plain output']) {
    assert.equal(new AgentStateMachine().matchesPrompt(line), false, `should NOT match: ${line}`);
  }
});
