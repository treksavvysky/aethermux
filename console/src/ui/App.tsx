import { useState } from 'preact/hooks';

import { tabKey } from '../store';
import type { ConsoleStore } from '../store';
import type { ApiClient } from '../api';
import type { TerminalRegistry } from '../registry';
import type { ReconnectingSocket } from '../socket';
import type { CreateSessionRequest } from '../protocol';
import { createXtermTerminal, type TerminalFactory } from '../terminal';
import { hydrateTab } from '../hydrate';
import { useStore } from './useStore';
import { TabBar } from './TabBar';
import { TerminalPane } from './TerminalPane';
import { CreateForm } from './CreateForm';

interface AppProps {
  store: ConsoleStore;
  api: ApiClient;
  registry: TerminalRegistry;
  socket: ReconnectingSocket;
  /** Terminal factory (injected in tests so xterm.js isn't needed in jsdom). */
  factory?: TerminalFactory;
}

/** The dashboard: a tab bar over a stack of (hidden-unless-active) terminals. */
export function App({ store, api, registry, socket, factory = createXtermTerminal }: AppProps) {
  useStore(store);
  const [creating, setCreating] = useState(false);

  const onSubmit = async (req: CreateSessionRequest) => {
    const summary = await api.createSession(req);
    store.addSession(summary); // new tab appears with no page reload
    setCreating(false);
  };

  const onClose = async (sessionId: string) => {
    store.removeSession(sessionId); // tab closes immediately, no reload
    await api.terminateSession(sessionId).catch(() => undefined);
  };

  return (
    <div class="console">
      <header class="topbar">
        <span class="brand">AetherMux</span>
        <TabBar
          tabs={store.tabs}
          activeKey={store.activeKey}
          onSelect={(k) => store.setActive(k)}
          onClose={onClose}
          onNew={() => setCreating(true)}
        />
      </header>

      {creating ? (
        <div class="overlay" data-testid="create-overlay">
          <CreateForm onSubmit={onSubmit} onCancel={() => setCreating(false)} />
        </div>
      ) : null}

      <main class="terminals">
        {store.tabs.length === 0 ? (
          <p class="empty">No active sessions — click ＋ New to start one.</p>
        ) : (
          store.tabs.map((tab) => (
            <TerminalPane
              key={tabKey(tab)}
              tab={tab}
              visible={tabKey(tab) === store.activeKey}
              registry={registry}
              socket={socket}
              factory={factory}
              onMount={() => void hydrateTab(api, registry, tab)}
            />
          ))
        )}
      </main>
    </div>
  );
}
