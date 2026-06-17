import { render } from 'preact';

import '@xterm/xterm/css/xterm.css';
import './styles.css';

import { App } from './ui/App';
import { ApiClient } from './api';
import { TerminalRegistry } from './registry';
import { ConsoleStore } from './store';
import { ReconnectingSocket } from './socket';
import { readConfig } from './config';
import { rehydrate } from './hydrate';

const cfg = readConfig(window.location);
const api = new ApiClient(cfg);
const registry = new TerminalRegistry();
const store = new ConsoleStore();

const socket = new ReconnectingSocket({
  url: cfg.wsUrl,
  onMessage: (msg) => registry.route(msg),
  onOpen: ({ reconnect }) => {
    // After a drop, replay each terminal's persisted history from the DB buffer.
    if (reconnect) void rehydrate(api, registry, store.tabs);
  },
});

const root = document.getElementById('app');
if (root) {
  render(<App store={store} api={api} registry={registry} socket={socket} />, root);
}

void (async () => {
  const sessions = await api.listSessions().catch(() => []);
  store.setSessions(sessions); // one tab per active session/agent
  socket.connect();
})();
