# Deployment

How to run the AetherMux orchestrator (Phase 1) locally and on a cloud VM.

Phase 1 is a **single-process, socket-driven orchestrator**: one Node process
exposes an HTTP API, talks to PostgreSQL for session state, and drives the host
Docker daemon to provision sandbox containers. It is **not** Kubernetes and
**not** Docker-in-Docker — it creates *sibling* containers on the host daemon
via the mounted Docker socket.

---

## Prerequisites

- **Linux host** (or any Docker host). The deployment targets Linux VMs.
- **Docker** 24+ (Engine + the `docker compose` plugin). The orchestrator needs
  access to the Docker socket (`/var/run/docker.sock`).
- **PostgreSQL** 14+ — either the bundled Compose service (local dev) or a
  pre-installed/managed instance (production).
- **Node.js 20+** — only if you run the orchestrator outside a container.

---

## Configuration (environment variables)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | HTTP API port the orchestrator listens on. |
| `DATABASE_URL` | yes | — | PostgreSQL connection string (`postgres://user:pass@host:5432/db`). Migrations run automatically on startup. |
| `AETHERMUX_API_TOKEN` | **yes** | — | Shared token for the HTTP API **and** the WebSocket (`/ws`), validated **fail-closed**. Every request except `/healthz` must present it; the orchestrator **refuses to start** without it. See [`WEBSOCKET.md`](./WEBSOCKET.md). |
| `AETHERMUX_WORKSPACE_ROOT` | no | `os.tmpdir()/aethermux/workspaces` | Host directory under which per-session workspaces are created and bind-mounted into sandboxes. Must exist on the Docker **host**. |
| `AETHERMUX_SANDBOX_IMAGE` | no | `alpine:3.20` | Base image for sandbox containers. |

> The orchestrator also honours `AETHERMUX_TEST_DATABASE_URL` as a fallback for
> `DATABASE_URL`, used by the test suite.

### Port configuration

The HTTP API **and** the WebSocket transport (`/ws`) share `PORT` (default
`8080`) on one server. Behind a reverse proxy or load balancer, forward that port
(and ensure the proxy passes WebSocket `Upgrade` headers). Only this one port
needs to be exposed; sandbox containers are reached by the orchestrator over the
Docker socket, not the network. See [`WEBSOCKET.md`](./WEBSOCKET.md) for the
real-time streaming protocol.

---

## Local development (Docker Compose)

The fastest path. Brings up PostgreSQL and the orchestrator together:

```bash
docker compose up --build
```

This:
1. Starts `postgres:16-alpine` with a persistent `pgdata` volume and a health check.
2. Builds the orchestrator image from `deploy/Dockerfile`.
3. Starts the orchestrator once Postgres is healthy, mounting the Docker socket
   and a shared workspace directory.

Verify it's up:

```bash
curl localhost:8080/healthz
# {"status":"ok"}

# Create a session (provisions a sandbox, spawns the agent, persists state):
curl -X POST localhost:8080/sessions \
  -H 'content-type: application/json' \
  -d '{"command":["sh","-c","echo hello; sleep 30"]}'
# {"sessionID":"s-..."}

# Inspect the session graph (session + sandboxes + agents + buffers):
curl localhost:8080/sessions/<sessionID>

# Tear it down (removes the sandbox and rows):
curl -X DELETE localhost:8080/sessions/<sessionID>
```

The OpenAPI description is served at `GET /openapi.json`.

Stop the stack (keep data):

```bash
docker compose down
# add -v to also drop the Postgres volume
```

### Running without Compose (Node directly)

```bash
npm ci
npm run build
DATABASE_URL=postgres://postgres:postgres@localhost:5432/aethermux \
  PORT=8080 npm start
```

---

## Cloud VM setup

Phase 1 deploys as a single VM running Docker. Below are AWS and GCP starting
points; both assume an Ubuntu/Debian VM.

### Common bootstrap (Docker)

```bash
# Install Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # re-login to take effect

# Clone and launch
git clone https://github.com/treksavvysky/aethermux.git
cd aethermux
docker compose up --build -d
```

Point a reverse proxy (Caddy/Nginx) or the cloud load balancer at port `8080`,
and terminate TLS there. AetherMux is built for a **single operator** — there is
no built-in auth — so do **not** expose port `8080` to the public internet
without putting authentication (proxy basic-auth, an SSH tunnel, or a private
network) in front of it.

### AWS (EC2)

1. Launch an EC2 instance (e.g. `t3.small`+, Ubuntu 22.04, 20 GB disk).
2. Security group: allow SSH (22) from your IP; expose `8080` only to your IP or
   a load balancer, never `0.0.0.0/0` unauthenticated.
3. SSH in and run the **Common bootstrap** above.
4. For managed Postgres, provision **RDS for PostgreSQL** and set `DATABASE_URL`
   in a `.env` (or the Compose `orchestrator.environment`) instead of the
   bundled `postgres` service; then remove/disable that service.

### GCP (Compute Engine)

1. Create a VM (e.g. `e2-small`, Ubuntu 22.04).
2. Firewall: allow `tcp:22` from your IP and `tcp:8080` only from your IP or an
   HTTPS load balancer.
3. SSH in and run the **Common bootstrap** above.
4. For managed Postgres, use **Cloud SQL for PostgreSQL** (connect via the Cloud
   SQL Auth Proxy or private IP) and set `DATABASE_URL` accordingly.

---

## Operations notes

- **State & recovery.** Session state lives in PostgreSQL. On `SIGINT`/`SIGTERM`
  the orchestrator marks sessions `paused` and exits cleanly, leaving sandbox
  containers running; on restart it reconnects to sandboxes still alive and marks
  the rest `orphaned`. Back up the database, not the containers.
- **Git is the source of truth.** The database stores only ephemeral coordination
  state — never files. A workspace can always be rebuilt from Git plus a fresh
  sandbox.
- **Docker socket = root-equivalent.** Mounting `/var/run/docker.sock` grants the
  orchestrator full control of the host daemon. Run it on a dedicated VM and keep
  the port access-controlled.
- **Workspace path consistency.** Because sandboxes run on the host daemon, the
  `AETHERMUX_WORKSPACE_ROOT` path must resolve to the same location on the host
  and inside the orchestrator container (the Compose file mounts it identically).
