'use client';

export type ModalType = 'rename' | 'confirm' | 'edit-note' | 'alert' | null;

interface Props {
  type: ModalType;
  message?: string;
  onClose: () => void;
  onConfirm?: () => void;
}

export function SlateModal({ type, message, onClose, onConfirm }: Readonly<Props>) {
  if (!type) return null;

  return (
    <div className="sl-modal-overlay" onClick={onClose}>
      <div className="sl-modal" onClick={(e) => e.stopPropagation()}>
        {type === 'rename' && (
          <>
            <h3 className="sl-modal-title">Rename Course</h3>
            <input className="sl-input" defaultValue="ACM" />
            <div className="sl-modal-actions">
              <button className="sl-btn-sm" type="button" onClick={onClose}>Cancel</button>
              <button className="sl-btn" type="button" onClick={onClose}>Save</button>
            </div>
          </>
        )}
        {type === 'confirm' && (
          <>
            <p className="sl-modal-message">{message ?? 'Are you sure?'}</p>
            <div className="sl-modal-actions">
              <button className="sl-btn-sm" type="button" onClick={onClose}>Cancel</button>
              <button className="sl-danger-btn" type="button" onClick={() => { onConfirm?.(); onClose(); }}>OK</button>
            </div>
          </>
        )}
        {type === 'edit-note' && (
          <>
            <h3 className="sl-modal-title">Edit Note</h3>
            <input className="sl-input" placeholder="Code" defaultValue="ATEM" />
            <input className="sl-input" placeholder="Note" defaultValue="Recording started (Test_03-17-26)" />
            <div className="sl-modal-actions">
              <button className="sl-btn-sm" type="button" onClick={onClose}>Cancel</button>
              <button className="sl-btn" type="button" onClick={onClose}>Save</button>
            </div>
          </>
        )}
        {type === 'alert' && (
          <>
            <p className="sl-modal-message">{message ?? 'An error occurred.'}</p>
            <div className="sl-modal-actions">
              <button className="sl-btn" type="button" onClick={onClose}>OK</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
