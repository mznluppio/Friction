import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onOpenChange
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]" />
        <Dialog.Content className="dialog-panel">
          <Dialog.Title className="text-base font-semibold text-friction-text">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-friction-muted">{description}</Dialog.Description>

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-ghost min-h-11 px-4">
                {cancelLabel}
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-danger min-h-11 px-4"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <span>{confirmLabel}</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
