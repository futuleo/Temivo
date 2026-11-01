import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2><div>{children}</div></div>;
}

export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'error' | 'success';
}) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={(event) => {
      event.preventDefault();
      onClose();
    }}>
      <header className="section-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button>
      </header>
      {children}
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="dialog-content">{children}</div>
      <div className="actions dialog-actions">
        <button type="button" autoFocus onClick={onClose}>Cancel</button>
        <button type="button" className="danger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function NameDialog({
  title,
  label,
  initialValue = '',
  submitLabel,
  disabled = false,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initialValue?: string;
  submitLabel: string;
  disabled?: boolean;
  error?: string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const data = new FormData(event.currentTarget);
        const value = data.get('name');
        if (typeof value === 'string' && value.trim()) onSubmit(value.trim());
      }}>
        {error && <Notice tone="error">{error}</Notice>}
        <label className="field">{label}<input name="name" defaultValue={initialValue} pattern=".*\S.*" required autoFocus /></label>
        <div className="actions dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={disabled}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
