'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskComment } from '@/lib/models/task-comment';
import type { UserSummary } from '@/lib/models/user';
import { MentionTextarea } from '@/components/dashboard/MentionTextarea';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderBody(text: string) {
  const parts = text.split(/(@\w+)/g);
  return parts.map((part, i) =>
    part.startsWith('@')
      ? <span key={i} className="task-mention">{part}</span>
      : part,
  );
}

function UserAvatar({ user }: { user: UserSummary }) {
  const initials = user.name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return user.avatarUrl ? (
    <img className="comment-avatar" src={user.avatarUrl} alt={user.name} />
  ) : (
    <span className="comment-avatar comment-avatar--initials">{initials}</span>
  );
}

interface Props {
  taskId: string;
  currentUserId: string;
  users: UserSummary[];
}

export function CommentThread({ taskId, currentUserId, users }: Readonly<Props>) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const userMap = new Map(users.map((u) => [u.id, u]));

  useEffect(() => {
    setLoading(true);
    setComments([]);
    fetch(`/api/tasks/${taskId}/comments`)
      .then((r) => r.json())
      .then((d: { comments: TaskComment[] }) => setComments(d.comments))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [comments.length]);

  const submit = useCallback(async () => {
    if (!body.trim() || posting) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim() }),
      });
      if (res.ok) {
        const data = await res.json() as { comment: TaskComment };
        setComments((prev) => [...prev, data.comment]);
        setBody('');
      }
    } finally {
      setPosting(false);
    }
  }, [body, posting, taskId]);

  const deleteComment = useCallback(async (commentId: string) => {
    const res = await fetch(`/api/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' });
    if (res.ok) {
      setComments((prev) => prev.filter((c) => c.commentId !== commentId));
    }
  }, [taskId]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="comment-thread">
      <div className="comment-thread-label">Updates</div>

      <div className="comment-list">
        {loading && <div className="comment-loading">Loading…</div>}
        {!loading && comments.length === 0 && (
          <div className="comment-empty">No updates yet. Add the first comment.</div>
        )}
        {comments.map((c) => {
          const author = userMap.get(c.authorId);
          return (
            <div key={c.commentId} className="comment-item">
              <div className="comment-author-col">
                {author ? <UserAvatar user={author} /> : <span className="comment-avatar comment-avatar--initials">?</span>}
              </div>
              <div className="comment-body-col">
                <div className="comment-meta">
                  <span className="comment-author-name">{author?.name ?? 'Unknown'}</span>
                  <span className="comment-time">{relativeTime(c.createdAt)}</span>
                  {c.authorId === currentUserId && (
                    <button
                      type="button"
                      className="comment-delete-btn"
                      onClick={() => void deleteComment(c.commentId)}
                      title="Delete comment"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="comment-body">{renderBody(c.body)}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="comment-input-area" onKeyDown={handleKeyDown}>
        <MentionTextarea
          value={body}
          onChange={setBody}
          users={users}
          placeholder="Write an update… @mention a teammate  ·  Ctrl+Enter to post"
          rows={2}
        />
        <button
          type="button"
          className="comment-post-btn"
          onClick={() => void submit()}
          disabled={posting || !body.trim()}
        >
          {posting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
}
