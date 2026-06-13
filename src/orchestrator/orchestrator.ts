import readline from 'node:readline';
import { PassThrough, type Duplex } from 'node:stream';

import Docker from 'dockerode';

import { AgentHandle } from './agent-handle.js';
import {
  SpawnError,
  formatAgentId,
  toEnvArray,
  validateSpawnContract,
  type SpawnContract,
  type StreamKind,
} from './types.js';

/**
 * The orchestrator: spawns CLI agents inside sandboxes through one generic
 * contract and multiplexes their output into per-agent streams.
 *
 * Each {@link spawn} runs the command as a fresh `docker exec` in the target
 * sandbox container (no shell-out to the `docker` CLI, no process pooling). The
 * exec's multiplexed stdout/stderr are demuxed, split into lines, tagged, and
 * pushed into the agent's own buffer — so two agents in the same sandbox never
 * corrupt each other's streams.
 */
export class Orchestrator {
  private readonly docker: Docker;
  private readonly agents = new Map<string, AgentHandle>();
  private counter = 0;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  /**
   * Spawns an agent for `contract` and returns its handle. Throws
   * {@link SpawnError} if the contract is invalid or the process cannot start.
   */
  async spawn(contract: SpawnContract): Promise<AgentHandle> {
    validateSpawnContract(contract);
    const id = formatAgentId(this.counter + 1);

    let stream: Duplex;
    let exec: Docker.Exec;
    try {
      const container = this.docker.getContainer(contract.containerID);
      exec = await container.exec({
        Cmd: contract.command,
        Env: toEnvArray(contract.env),
        WorkingDir: contract.workspaceDir,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
    } catch (err) {
      throw new SpawnError(`Failed to spawn agent for session ${contract.sessionID}`, err);
    }

    this.counter += 1;
    const handle = new AgentHandle({
      id,
      sessionID: contract.sessionID,
      containerID: contract.containerID,
      stdin: stream,
    });
    this.agents.set(id, handle);

    // Per-agent stream pipeline: demux the multiplexed exec stream into separate
    // stdout/stderr channels, then split each into tagged, timestamped lines.
    const stdoutChannel = new PassThrough();
    const stderrChannel = new PassThrough();
    const stdoutDone = this.pipeLines(handle, 'stdout', stdoutChannel);
    const stderrDone = this.pipeLines(handle, 'stderr', stderrChannel);
    this.docker.modem.demuxStream(stream, stdoutChannel, stderrChannel);

    let finalized = false;
    const finalize = async (): Promise<void> => {
      if (finalized) return;
      finalized = true;
      // The source stream has ended; flush the line readers, then record exit.
      stdoutChannel.end();
      stderrChannel.end();
      await Promise.all([stdoutDone, stderrDone]);
      try {
        const info = await exec.inspect();
        handle._finalize('exited', typeof info.ExitCode === 'number' ? info.ExitCode : null);
      } catch {
        handle._finalize('error', null);
      }
    };

    stream.on('end', () => void finalize());
    stream.on('error', (err) => {
      handle.emit('error', err);
      void finalize();
    });

    return handle;
  }

  /** Returns the handle for `agentId`, if known. */
  get(agentId: string): AgentHandle | undefined {
    return this.agents.get(agentId);
  }

  /** All agent handles spawned by this orchestrator (running or terminated). */
  list(): AgentHandle[] {
    return [...this.agents.values()];
  }

  /** Splits a channel into lines and feeds them to the handle; resolves on EOF. */
  private pipeLines(handle: AgentHandle, stream: StreamKind, source: PassThrough): Promise<void> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: source, crlfDelay: Infinity });
      rl.on('line', (line) => handle._ingest(stream, line));
      rl.on('close', () => resolve());
    });
  }
}
