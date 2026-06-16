import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

import { WebSocket } from 'ws';
import {
  OrchestratorSocket,
  parseClientMessage,
  isAuthorized,
  extractRequestToken,
  WS_PATH,
} from '../dist/index.js';

// --- pure protocol / auth helpers (no server) --------------------------------

test('parseClientMessage accepts valid stdin and rejects everything else', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'stdin', sessionId: 's', agentId: 'a', data: 'x' })), {
    type: 'stdin',
    sessionId: 's',
    agentId: 'a',
    data: 'x',
  });
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'stdin', sessionId: 's' })), null); // missing fields
  assert.equal(parseClientMessage(JSON.stringify({ type: 'stdout', sessionId: 's', agentId: 'a', payload: 'x' })), null);
  assert.equal(parseClientMessage(JSON.stringify(42)), null);
});

test('isAuthorized / extractRequestToken: header, x-api-token, and ?token=', () => {
  const reqWith = (headers, url = '/ws') => ({ headers, url });
  // Fail-closed: no token configured → reject, even if the request presents one.
  assert.equal(isAuthorized(reqWith({}), undefined), false);
  assert.equal(isAuthorized(reqWith({ authorization: 'Bearer secret' }), undefined), false);
  // Token configured → must match.
  assert.equal(isAuthorized(reqWith({ authorization: 'Bearer secret' }), 'secret'), true);
  assert.equal(isAuthorized(reqWith({ authorization: 'secret' }), 'secret'), true);
  assert.equal(isAuthorized(reqWith({ 'x-api-token': 'secret' }), 'secret'), true);
  assert.equal(isAuthorized(reqWith({}, '/ws?token=secret'), 'secret'), true);
  assert.equal(isAuthorized(reqWith({ authorization: 'Bearer wrong' }), 'secret'), false);
  assert.equal(isAuthorized(reqWith({}), 'secret'), false);
  assert.equal(extractRequestToken(reqWith({ authorization: 'Bearer abc' })), 'abc');
  assert.equal(extractRequestToken(reqWith({}, '/ws?token=q')), 'q');
});

const TOKEN = 'test-token';

// --- WS server over a fake engine (no Docker/Postgres) -----------------------

class FakeEngine extends EventEmitter {
  constructor() {
    super();
    this.stdinCalls = [];
    this.failStdin = false;
  }
  async sendStdin(sessionId, agentId, data) {
    this.stdinCalls.push({ sessionId, agentId, data });
    if (this.failStdin) throw new Error(`No live agent ${sessionId}:${agentId}`);
  }
}

async function startServer(engine, opts) {
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  const socket = new OrchestratorSocket(engine, server, opts);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, socket, url: `ws://127.0.0.1:${server.address().port}${WS_PATH}` };
}

function connect(url, options) {
  const ws = new WebSocket(url, options);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected ${res.statusCode}`)));
  });
}

function waitFor(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for message'));
    }, timeoutMs);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMsg);
    };
    ws.on('message', onMsg);
  });
}

test('WS auth is fail-closed: rejects without a token, with a wrong token, and when none is configured', async (t) => {
  // (1) token configured, none/wrong presented → reject; correct → accept.
  const engine = new FakeEngine();
  const { server, socket } = await startServer(engine, { token: TOKEN });
  const url = `ws://127.0.0.1:${server.address().port}${WS_PATH}`;
  t.after(async () => {
    await socket.close();
    server.close();
  });

  await assert.rejects(() => connect(url), /unexpected 401|401/);
  await assert.rejects(() => connect(`${url}?token=wrong`), /unexpected 401|401/);
  assert.equal(socket.clientCount, 0);

  const ws = await connect(`${url}?token=${TOKEN}`); // query param (browser-friendly)
  t.after(() => ws.close());
  assert.equal(ws.readyState, WebSocket.OPEN);

  // (2) no token configured → still rejected (fail-closed, no open relay).
  const open = await startServer(new FakeEngine(), {});
  t.after(async () => {
    await open.socket.close();
    open.server.close();
  });
  await assert.rejects(() => connect(open.url), /unexpected 401|401/);
});

test('pushes stdout/stderr/exit multiplexed by session+agent; relays stdin', async (t) => {
  const engine = new FakeEngine();
  const { server, socket, url } = await startServer(engine, { token: TOKEN });
  t.after(async () => {
    await socket.close();
    server.close();
  });

  const ws = await connect(`${url}?token=${TOKEN}`);
  t.after(() => ws.close());

  // stdout push.
  const outP = waitFor(ws, (m) => m.type === 'stdout' && m.agentId === 'agent-01');
  engine.emit('agentLog', { sessionId: 's1', agentId: 'agent-01', stream: 'stdout', text: 'hello', timestamp: 't' });
  const out = await outP;
  assert.deepEqual(out, { type: 'stdout', sessionId: 's1', agentId: 'agent-01', payload: 'hello' });

  // stderr push for a different agent — demultiplexable by session+agent.
  const errP = waitFor(ws, (m) => m.type === 'stderr' && m.agentId === 'agent-02');
  engine.emit('agentLog', { sessionId: 's1', agentId: 'agent-02', stream: 'stderr', text: 'oops', timestamp: 't' });
  const err = await errP;
  assert.deepEqual(err, { type: 'stderr', sessionId: 's1', agentId: 'agent-02', payload: 'oops' });

  // exit push.
  const exitP = waitFor(ws, (m) => m.type === 'exit');
  engine.emit('agentExit', { sessionId: 's1', agentId: 'agent-01', status: 'exited', exitCode: 0 });
  assert.deepEqual(await exitP, { type: 'exit', sessionId: 's1', agentId: 'agent-01', payload: { status: 'exited', exitCode: 0 } });

  // stdin relay reaches the engine with the right routing.
  ws.send(JSON.stringify({ type: 'stdin', sessionId: 's1', agentId: 'agent-01', data: 'typed\n' }));
  await waitForCondition(() => engine.stdinCalls.length === 1);
  assert.deepEqual(engine.stdinCalls[0], { sessionId: 's1', agentId: 'agent-01', data: 'typed\n' });

  // a malformed frame yields an error message, not a crash.
  const badP = waitFor(ws, (m) => m.type === 'error');
  ws.send('garbage');
  assert.match((await badP).payload, /invalid message/);

  // a stdin for an unknown agent is surfaced as an error to the sender.
  engine.failStdin = true;
  const relayErrP = waitFor(ws, (m) => m.type === 'error' && m.agentId === 'ghost');
  ws.send(JSON.stringify({ type: 'stdin', sessionId: 's1', agentId: 'ghost', data: 'x' }));
  assert.match((await relayErrP).payload, /No live agent/);
});

test('disconnect/reconnect: a new client still receives broadcasts', async (t) => {
  const engine = new FakeEngine();
  const { server, socket, url } = await startServer(engine, { token: TOKEN });
  t.after(async () => {
    await socket.close();
    server.close();
  });

  const a = await connect(`${url}?token=${TOKEN}`);
  assert.equal(socket.clientCount, 1);
  a.close();
  await waitForCondition(() => socket.clientCount === 0);

  const b = await connect(`${url}?token=${TOKEN}`);
  t.after(() => b.close());
  const p = waitFor(b, (m) => m.type === 'stdout');
  engine.emit('agentLog', { sessionId: 's', agentId: 'agent-01', stream: 'stdout', text: 'after-reconnect', timestamp: 't' });
  assert.equal((await p).payload, 'after-reconnect');
});

function waitForCondition(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve(undefined);
      if (Date.now() - start > timeoutMs) return reject(new Error('condition timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}
