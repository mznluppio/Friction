import { Loader2, Play } from "lucide-react";

interface Phase3ValidateInlineProps {
  repoPath: string;
  baseBranch: string;
  consentedToDataset: boolean;
  running?: boolean;
  error?: string | null;
  onRepoPathChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onDatasetOptInChange: (value: boolean) => void;
  onRun: () => void;
}

export function Phase3ValidateInline({
  repoPath,
  baseBranch,
  consentedToDataset,
  running = false,
  error,
  onRepoPathChange,
  onBaseBranchChange,
  onDatasetOptInChange,
  onRun,
}: Phase3ValidateInlineProps) {
  return (
    <section className="workflow-inline-block">
      <p className="workflow-inline-title">Proof mode</p>
      <p className="workflow-inline-subtitle">
        Stress-test the chosen direction on a real repo only when you need proof.
      </p>

      <div className="chat-config-grid">
        <label className="grid gap-1">
          <span className="panel-label">Repository path</span>
          <input
            value={repoPath}
            onChange={(event) => onRepoPathChange(event.target.value)}
            className="input-base"
            name="repo_path_inline"
            autoComplete="off"
            spellCheck={false}
            placeholder="/absolute/path/to/git/repo"
          />
        </label>
        <label className="grid gap-1">
          <span className="panel-label">Base branch</span>
          <input
            value={baseBranch}
            onChange={(event) => onBaseBranchChange(event.target.value)}
            className="input-base"
            name="base_branch_inline"
            autoComplete="off"
            placeholder="main"
          />
        </label>
        <label className="checkbox-row chat-config-check">
          <input
            type="checkbox"
            checked={consentedToDataset}
            onChange={(event) => onDatasetOptInChange(event.target.checked)}
          />
          <span>Dataset opt-in</span>
        </label>
      </div>

      {error ? (
        <p className="workflow-inline-error" role="alert" aria-live="polite">
          {error}
        </p>
      ) : null}

      <div className="workflow-inline-actions">
        <button
          type="button"
          className="workflow-inline-primary"
          disabled={running}
          onClick={onRun}
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Running…
            </>
          ) : (
            <>
              <Play className="h-4 w-4" aria-hidden="true" />
              Run proof mode
            </>
          )}
        </button>
      </div>
    </section>
  );
}
