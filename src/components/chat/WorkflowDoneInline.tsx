import { Download, Save } from "lucide-react";

interface WorkflowDoneInlineProps {
  canPersistSession: boolean;
  saveLocalLoading?: boolean;
  datasetLoading?: boolean;
  onSave: () => void;
  onExportSession: () => void;
  onExportDataset: () => void;
  onNewThread: () => void;
}

export function WorkflowDoneInline({
  canPersistSession,
  saveLocalLoading = false,
  datasetLoading = false,
  onSave,
  onExportSession,
  onExportDataset,
  onNewThread,
}: WorkflowDoneInlineProps) {
  return (
    <section className="workflow-inline-block">
      <p className="workflow-inline-title">Workflow done</p>
      <p className="workflow-inline-subtitle">
        Save or export this run, then start a new thread when ready.
      </p>
      <div className="workflow-inline-actions">
        <button
          type="button"
          className="workflow-inline-secondary"
          onClick={onSave}
          disabled={!canPersistSession || saveLocalLoading}
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          {saveLocalLoading ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="workflow-inline-secondary"
          onClick={onExportSession}
          disabled={!canPersistSession}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Export session
        </button>
        <button
          type="button"
          className="workflow-inline-secondary"
          onClick={onExportDataset}
          disabled={datasetLoading}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {datasetLoading ? "Exporting dataset…" : "Export dataset"}
        </button>
        <button
          type="button"
          className="workflow-inline-primary"
          onClick={onNewThread}
        >
          New thread
        </button>
      </div>
    </section>
  );
}

