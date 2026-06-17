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
export function TerminalPane({ tab, visible, registry, socket, factory }: TerminalPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<TerminalHandle | null>(null);

  useEffect(() => {
    if (!container.current) return undefined;
    const term = factory(container.current);
    handle.current = term;
    registry.register(tab.sessionId, tab.agentId, term);
    term.onData((data) => {
      socket.send({ type: 'stdin', sessionId: tab.sessionId, agentId: tab.agentId, data });
    });
    return () => {
      registry.unregister(tab.sessionId, tab.agentId);
      term.dispose();
      handle.current = null;
    };
    // Mount once per tab; deps intentionally empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
