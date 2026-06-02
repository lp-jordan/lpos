'use client';

/**
 * Handoff modal — opened from the Handoff button on TaskDetailModal.
 *
 * Always available regardless of task status (per design — the user decides
 * when they're done with their part; the button is not gated on terminal
 * status). Requires a non-empty note + ≥1 new assignee. Submitting POSTs to
 * /api/tasks/[taskId]/handoff which atomically drops the current assignees
 * (whole-task semantics), records the kind='handoff' comment, creates the
 * task_handoffs row, and notifies the new assignee(s).
 */

import { useEffect, useMemo, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';
import type { Task } from '@/lib/models/task';
import type { TaskComment } from '@/lib/models/task-comment';
import type { TaskHandoff } from '@/lib/models/task-handoff';

interface Props {
  task:        Task;
  users:       UserSummary[];
  currentUserId: string;
  onDone:      (result: { task: Task; comment: TaskComment; handoff: TaskHandoff }) => void;
  onClose:     () => void;
}

export function HandoffModal({ task, users, currentUserId, onDone, onClose }: Readonly<Props>) {
  const [note, setNote]               = useState('');
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [closing, setClosing]         = useState(false);

  // Sort: self first (probably the most common pick — handing off TO yourself
  // makes no sense, so we suppress it from the list entirely), then alpha.
  const eligible = useMemo(
    () => users
      .filter((u) => u.id !== currentUserId || task.assignedTo.length === 0 || !task.assignedTo.includes(currentUserId))
      // Actually simpler: just exclude the currently-handing-off user. If they
      // want to keep themselves on, they wouldn't be handing off in the first
      // place; the design is "drop all current assignees, pick new ones."
      .filter((u) => u.id !== currentUserId)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [users, currentUserId, task.assignedTo],
  );

  function handleClose() {
    if (submitting) return;
    setClosing(true);
    setTimeout(onClose, 140);
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting]);

  function toggle(uid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  async function submit() {
    setError(null);
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      setError('Add a brief note for the new assignee — what\'s left, what context they need.');
      return;
    }
    if (selected.size === 0) {
      setError('Pick at least one new assignee.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/tasks/${task.taskId}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note:       trimmedNote,
          toUserIds:  [...selected],
        }),
      });
      const data = await res.json() as {
        task?:    Task;
        comment?: TaskComment;
        handoff?: TaskHandoff;
        error?:   string;
      };
      if (!res.ok || !data.task || !data.comment || !data.handoff) {
        setError(data.error ?? 'Handoff failed. Please try again.');
        setSubmitting(false);
        return;
      }
      onDone({ task: data.task, comment: data.comment, handoff: data.handoff });
    } catch (err) {
      setError((err as Error).message || 'Network error.');
      setSubmitting(false);
    }
  }

  const currentNames = users
    .filter((u) => task.assignedTo.includes(u.id))
    .map((u) => u.name.split(' ')[0])
    .join(', ') || 'no one';

  return (
    <div
      className={`modal-overlay handoff-overlay${closing ? ' modal-overlay--closing' : ''}`}
      onClick={handleClose}
    >
      <div className="modal-box handoff-box" onClick={(e) => e.stopPropagation()}>
        <div className="handoff-header">
          <div>
            <div className="handoff-title">Hand off this task</div>
            <div className="handoff-subtitle">
              Currently assigned: <strong>{currentNames}</strong> — they’ll be replaced.
            </div>
          </div>
          <button type="button" className="modal-close" onClick={handleClose} aria-label="Close" disabled={submitting}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="handoff-body">
          <label className="handoff-field">
            <span className="handoff-field-label">
              Note for the new assignee
              <span className="handoff-required"> · required</span>
            </span>
            <textarea
              className="handoff-note-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What's done, what's left, anything they need to know to pick this up cleanly."
              rows={5}
              autoFocus
              disabled={submitting}
            />
          </label>

          <div className="handoff-field">
            <span className="handoff-field-label">
              Hand off to
              <span className="handoff-required"> · pick at least one</span>
            </span>
            <div className="handoff-assignee-list">
              {eligible.length === 0 && (
                <div className="handoff-empty">No other users to hand off to.</div>
              )}
              {eligible.map((u) => (
                <label key={u.id} className={`handoff-assignee-row${selected.has(u.id) ? ' handoff-assignee-row--on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggle(u.id)}
                    disabled={submitting}
                  />
                  <span className="handoff-assignee-name">{u.name}</span>
                </label>
              ))}
            </div>
          </div>

          {error && <div className="handoff-error">{error}</div>}
        </div>

        <div className="handoff-footer">
          <button type="button" className="handoff-cancel-btn" onClick={handleClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="handoff-submit-btn"
            onClick={() => void submit()}
            disabled={submitting || !note.trim() || selected.size === 0}
          >
            {submitting ? 'Handing off…' : 'Hand off'}
          </button>
        </div>
      </div>
    </div>
  );
}
