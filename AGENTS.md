# Agents working in this repo

AetherMux is the **execution plane**. Fluxion Core is the **control plane** (the what/why): issues, acceptance criteria, change control. When you act through the Fluxion MCP server, you are one of several agents (Antigravity, Codex, Claude) sharing one audit trail — so every action must be attributable to *you*.

## Attribution (workspace-wide policy — non-negotiable)

Your identity token is **`<AgentName>@<hostname>`** — your product name (`Antigravity`/`Codex`/`Claude`) plus the output of the `hostname` command (run it once per session, reuse it). This distinguishes the same agent on different hosts and different agents on the same host. Examples in use: `Antigravity@codejourney`, `Antigravity@dev-xxl`, `Codex@plannedintent-dev`, `Claude@codejourney`. Use it verbatim in every Fluxion attribution field. Never the default `agent`, never blank, never another identity.

- **`check_criterion`** → pass `attestor: "<your token>"`. `evidence` = the command you ran and the output you saw, first person.
- **`create_change_log`** → `implementedBy: "<your token>"`. Set `approvedBy` to the human (`George Loudon`) **only if they actually approved**; if you acted autonomously, use `approvedBy: "<your token> (autonomous)"` — make autonomy visible, never disguise it as human sign-off.
- **`update_status` / `update_issue` / `create_issue`** (no actor field) → a status move to Done is already covered by your gating `check_criterion` attestations. But a **content edit** to an issue contract or a **new issue you authored** must be trailed by a one-line `create_change_log` (`type: "Annotation"`, `implementedBy: "<your token>"`) saying what you changed and why — that log is the only thing that makes the edit attributable.

Full text: Fluxion durable brief **"Agent Attribution Protocol"** (doc slug `agent-attribution-protocol`); recorded as a workspace-wide Decision in Fluxion Change Control.

## Connecting to Fluxion (MCP)

- Same host (codejourney): `serverUrl: http://localhost:3002/api/mcp`
- From another Tailnet host (e.g. Codex on plannedintent): `serverUrl: http://100.102.188.64:3002/api/mcp` (codejourney's Tailscale IP)
- Auth header: `x-api-key`. Antigravity config key is `serverUrl` (not `url`), with a `headers` object.
