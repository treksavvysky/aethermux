import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import type { TerminalSink } from './registry';

/** A live terminal handle: a {@link TerminalSink} plus input/lifecycle hooks. */
export interface TerminalHandle extends TerminalSink {
  onData(cb: (data: string) => void): void;
  fit(): void;
  dispose(): void;
}

/** Creates a terminal attached to `container`. Injectable so tests can fake it. */
export type TerminalFactory = (container: HTMLElement) => TerminalHandle;

/** The real xterm.js factory used in the browser. */
export const createXtermTerminal: TerminalFactory = (container) => {
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0b0e14' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  safeFit(fit);
  return {
    write: (data) => term.write(data),
    clear: () => term.clear(),
    onData: (cb) => {
      term.onData(cb);
    },
    fit: () => safeFit(fit),
    dispose: () => term.dispose(),
  };
};

function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    /* no measurable layout (e.g. hidden tab or jsdom) — ignore */
  }
}
