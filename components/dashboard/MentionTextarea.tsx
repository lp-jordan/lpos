'use client';

import { useRef, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  users: UserSummary[];
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}

function getMentionQuery(value: string, cursor: number): string | null {
  const before = value.slice(0, cursor);
  const m = before.match(/@(\w*)$/);
  return m ? m[1] : null;
}

function insertMention(value: string, cursor: number, firstName: string): { value: string; cursor: number } {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const replaced = before.replace(/@\w*$/, `@${firstName} `);
  return { value: replaced + after, cursor: replaced.length };
}

export function MentionTextarea({ id, value, onChange, users, placeholder, rows = 3, autoFocus }: Readonly<Props>) {
  const [query, setQuery] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const matches =
    query !== null
      ? users
          .filter((u) => {
            const q = query.toLowerCase();
            return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
          })
          .slice(0, 6)
      : [];

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    const cursor = e.target.selectionStart ?? v.length;
    onChange(v);
    setQuery(getMentionQuery(v, cursor));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab' && query !== null && matches.length > 0) {
      e.preventDefault();
      handleSelect(matches[0]);
    }
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const cursor = e.currentTarget.selectionStart ?? 0;
    setQuery(getMentionQuery(e.currentTarget.value, cursor));
  }

  function handleSelect(user: UserSummary) {
    if (!ref.current) return;
    const cursor = ref.current.selectionStart ?? value.length;
    const firstName = user.name.split(' ')[0];
    const result = insertMention(value, cursor, firstName);
    onChange(result.value);
    setQuery(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(result.cursor, result.cursor);
    });
  }

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        id={id}
        className="modal-input modal-textarea"
        placeholder={placeholder}
        value={value}
        rows={rows}
        autoFocus={autoFocus}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query !== null && matches.length > 0 && (
        <ul className="mention-dropdown">
          {matches.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="mention-option"
                onMouseDown={(e) => { e.preventDefault(); handleSelect(u); }}
              >
                <span className="mention-option-name">{u.name}</span>
                <span className="mention-option-email">{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
