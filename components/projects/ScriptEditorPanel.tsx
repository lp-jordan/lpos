'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ScriptAsset } from '@/lib/models/script-asset';

interface Props {
  projectId: string;
  script: ScriptAsset | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ScriptEditorPanel({ projectId, script, onClose, onSaved }: Readonly<Props>) {
  const [loading,     setLoading]     = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [dirty,       setDirty]       = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  // pendingHtml holds fetched content waiting to be written into the editor
  const [pendingHtml, setPendingHtml] = useState<string | null>(null);
  const editorRef                     = useRef<HTMLDivElement>(null);
  const initialHtmlRef                = useRef<string>('');

  // Load HTML content whenever the selected script changes
  useEffect(() => {
    setPendingHtml(null);
    setDirty(false);
    setError(null);
    // Clear editor immediately so stale content doesn't flash
    if (editorRef.current) editorRef.current.innerHTML = '';

    if (!script) return;

    if (!script.hasExtractedText) {
      setError(
        script.status === 'processing'
          ? 'Extracting content…'
          : 'No content available for this file type.',
      );
      return;
    }

    setLoading(true);

    fetch(`/api/projects/${projectId}/scripts/${script.scriptId}/content`)
      .then((r) => r.json() as Promise<{ html?: string; error?: string }>)
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setPendingHtml(d.html ?? '');
      })
      .catch(() => setError('Failed to load content.'))
      .finally(() => setLoading(false));
  }, [projectId, script]);

  // Write into the editor once the div is mounted and we have content.
  // The editor div is always in the DOM (just hidden), so ref is always valid.
  useEffect(() => {
    if (pendingHtml === null) return;
    if (!editorRef.current) return;
    editorRef.current.innerHTML = pendingHtml;
    initialHtmlRef.current = pendingHtml;
    setPendingHtml(null);
    setDirty(false);
  }, [pendingHtml]);

  const handleInput = useCallback(() => {
    const current = editorRef.current?.innerHTML ?? '';
    setDirty(current !== initialHtmlRef.current);
  }, []);

  async function handleSave() {
    if (!script || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const html = editorRef.current?.innerHTML ?? '';
      const res = await fetch(
        `/api/projects/${projectId}/scripts/${script.scriptId}/content`,
        {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ html }),
        },
      );
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? 'Save failed');
        return;
      }
      initialHtmlRef.current = html;
      setDirty(false);
      onSaved();
    } catch {
      setError('Save failed');
    } finally {
      setSaving(false);
    }
  }

  function execCmd(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editorRef.current?.focus();
    handleInput();
  }

  const open = script !== null;

  return (
    <>
      {open && <div className="sep-backdrop" onClick={onClose} aria-hidden="true" />}

      <div className={`sep${open ? ' sep--open' : ''}`} role="dialog" aria-label="Script editor">
        {script && (
          <>
            <div className="sep-header">
              <div className="sep-header-info">
                <span className="sep-title">{script.name}</span>
                <span className="sep-filename">{script.originalFilename}</span>
              </div>
              <div className="sep-header-actions">
                {dirty && (
                  <button
                    type="button"
                    className="btn-primary sep-save-btn"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
                <button type="button" className="sep-close-btn" onClick={onClose} aria-label="Close">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Formatting toolbar */}
            {!loading && !error && (
              <div className="sep-toolbar" onMouseDown={(e) => e.preventDefault()}>
                <button type="button" className="sep-tb-btn" onClick={() => execCmd('bold')} title="Bold (⌘B)"><strong>B</strong></button>
                <button type="button" className="sep-tb-btn sep-tb-btn--italic" onClick={() => execCmd('italic')} title="Italic (⌘I)"><em>I</em></button>
                <button type="button" className="sep-tb-btn sep-tb-btn--underline" onClick={() => execCmd('underline')} title="Underline (⌘U)"><u>U</u></button>
                <div className="sep-tb-sep" />
                <button type="button" className="sep-tb-btn" onClick={() => execCmd('formatBlock', 'h2')} title="Heading">H</button>
                <button type="button" className="sep-tb-btn" onClick={() => execCmd('formatBlock', 'p')} title="Paragraph">¶</button>
                <div className="sep-tb-sep" />
                <button type="button" className="sep-tb-btn" onClick={() => execCmd('insertUnorderedList')} title="Bullet list">•</button>
                <button type="button" className="sep-tb-btn" onClick={() => execCmd('insertOrderedList')} title="Numbered list">1.</button>
              </div>
            )}

            <div className="sep-body">
              {loading && <p className="sep-status">Loading…</p>}
              {!loading && error && <p className="sep-status sep-status--error">{error}</p>}
              {/* Editor stays mounted at all times so the ref is never null.
                  Hidden while loading or showing an error state. */}
              <div
                ref={editorRef}
                className="sep-editor"
                contentEditable={!loading && !error}
                suppressContentEditableWarning
                onInput={handleInput}
                spellCheck
                aria-label="Script content editor"
                style={{ display: loading || error ? 'none' : undefined }}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
