import { test, expect } from 'vitest';

import { tokenizeCommand, parseEnv } from '../src/command';

test('tokenizeCommand splits on whitespace and honours quotes', () => {
  expect(tokenizeCommand('aider --model gpt')).toEqual(['aider', '--model', 'gpt']);
  expect(tokenizeCommand('sh -c "echo hi; sleep 60"')).toEqual(['sh', '-c', 'echo hi; sleep 60']);
  expect(tokenizeCommand("sh -c 'a b'")).toEqual(['sh', '-c', 'a b']);
  expect(tokenizeCommand('   ')).toEqual([]);
  expect(tokenizeCommand('echo ""')).toEqual(['echo', '']);
});

test('parseEnv reads KEY=value lines and returns undefined when empty', () => {
  expect(parseEnv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  expect(parseEnv('  TOKEN=a=b=c \n\n')).toEqual({ TOKEN: 'a=b=c' });
  expect(parseEnv('')).toBeUndefined();
  expect(parseEnv('not-an-assignment')).toBeUndefined();
});
