import { useState } from 'preact/hooks';

import { tokenizeCommand, parseEnv } from '../command';
import type { CreateSessionRequest } from '../protocol';

interface CreateFormProps {
  onSubmit: (req: CreateSessionRequest) => Promise<void>;
  onCancel: () => void;
}

/** A small form to create a session: repoPath, command, env (KEY=value lines). */
export function CreateForm({ onSubmit, onCancel }: CreateFormProps) {
  const [command, setCommand] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [env, setEnv] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    const argv = tokenizeCommand(command);
    if (argv.length === 0) {
      setError('command is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ command: argv, repoPath: repoPath.trim() || null, env: parseEnv(env) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form class="create-form" onSubmit={submit}>
      <label>
        Command
        <input
          name="command"
          placeholder="e.g. sh -c &quot;echo hello; sleep 60&quot;"
          value={command}
          onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
          autofocus
        />
      </label>
      <label>
        Repo path (optional)
        <input
          name="repoPath"
          placeholder="/path/to/repo"
          value={repoPath}
          onInput={(e) => setRepoPath((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        Env (KEY=value per line)
        <textarea
          name="env"
          rows={3}
          value={env}
          onInput={(e) => setEnv((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      {error ? <p class="error">{error}</p> : null}
      <div class="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create session'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
