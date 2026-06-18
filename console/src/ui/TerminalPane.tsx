import { useEffect, useRef } from 'preact/hooks';

import type { ReconnectingSocket } from '../socket';
import type { TerminalRegistry } from '../registry';
import type { TerminalFactory, TerminalHandle } from '../terminal';
import type { Tab } from '../store';

interface TerminalPaneProps {
  tab: Tab;
  visible: boolean;
  registry: TerminalRegistry;
  socket: ReconnectingSocket;
  factory: TerminalFactory;
  /** Called once the terminal has mounted and registered its sink, so the caller
   * can replay persisted history into a session that's already parked. */
  onMount?: () => void;
}

/**
 * Mounts one xterm.js terminal for a tab, registers it with the {@link
 * TerminalRegistry} (so multiplexed output routes to it), and forwards typed
 * characters back as stdin for the tab's session+agent. The terminal stays
 * mounted across tab switches (just hidden) so no output is lost.
 *
 * This component is **agent-agnostic** — every tab uses this same component and
 * factory; there is no per-agent rendering branch.
 */
export function TerminalPane({ tab, visible, registry, socket, factory, onMount }: TerminalPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<TerminalHandle | null>(null);

  useEffect(() => {
    if (!container.current) return undefined;
    const term = factory(container.current);
    handle.current = term;
    registry.register(tab.sessionId, tab.agentId, term);

    // The agent exec runs without a PTY (Tty:false) and the I/O pipeline is
    // line-oriented (output is split on '\n'), so emulate cooked-mode line input
    // on the client: there is no remote echo, and the terminal's Enter key emits
    // a carriage return ('\r'), which a line reader like `read` never treats as
    // end-of-line. We echo keystrokes locally, support backspace editing, and
    // send the assembled line terminated by '\n' when Enter is pressed.
    let line = '';
    let lastWasCr = false;
    const sendStdin = (data: string) =>
      socket.send({ type: 'stdin', sessionId: tab.sessionId, agentId: tab.agentId, data });
    term.onData((data) => {
      for (const ch of data) {
        if (ch === '\n' && lastWasCr) {
          lastWasCr = false; // swallow the LF of a CRLF pair so Enter sends once
          continue;
        }
        lastWasCr = ch === '\r';
        if (ch === '\r' || ch === '\n') {
          term.write('\r\n');
          sendStdin(`${line}\n`);
          line = '';
        } else if (ch === '\x7f' || ch === '\b') {
          if (line.length > 0) {
            line = line.slice(0, -1);
            term.write('\b \b'); // erase the last glyph on screen
          }
        } else if (ch === '\u0003') {
          term.write('^C\r\n'); // Ctrl-C: interrupt and reset the line
          sendStdin('\u0003');
          line = '';
        } else if (ch >= ' ') {
          line += ch;
          term.write(ch); // local echo of printable input
        }
      }
    });
    onMount?.(); // sink is now registered → safe to replay persisted history
    return () => {
      registry.unregister(tab.sessionId, tab.agentId);
      term.dispose();
      handle.current = null;
    };
    // Mount once per tab; the tab identity is stable for the component's life,
    // so the empty dependency list is intentional.
  }, []);

  useEffect(() => {
    if (visible) handle.current?.fit();
  }, [visible]);

  return (
    <div
      ref={container}
      class="term-pane"
      style={{ display: visible ? 'block' : 'none' }}
      data-testid={`term-${tab.sessionId}/${tab.agentId}`}
    />
  );
}
