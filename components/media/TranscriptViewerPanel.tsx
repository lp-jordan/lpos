'use client';

import { CSSProperties, Fragment, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type FileType = 'txt' | 'json' | 'srt' | 'vtt';

interface Props {
  projectId: string;
  jobId: string | null;
  filename: string;
  onClose: () => void;
  standalone?: boolean;
}

function formatTranscriptLabel(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

export function TranscriptViewerPanel({ projectId, jobId, filename, onClose, standalone = false }: Readonly<Props>) {
  const [mounted, setMounted] = useState(false);
  const [availableFiles, setAvailableFiles] = useState<Record<FileType, boolean>>({
    txt: false,
    json: false,
    srt: false,
    vtt: false,
  });
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState(0);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!jobId) {
      setAvailableFiles({ txt: false, json: false, srt: false, vtt: false });
      setContent('');
      setError(null);
      setWordCount(0);
      return;
    }

    setError(null);

    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/transcripts`);
        if (!res.ok) return;
        const data = await res.json() as {
          transcripts: Array<{ jobId: string; files: Record<FileType, boolean> }>;
        };
        const entry = data.transcripts.find((t) => t.jobId === jobId);
        if (entry) setAvailableFiles(entry.files);
      } catch {
        // ignore
      }
    })();
  }, [jobId, projectId]);

  useEffect(() => {
    if (!jobId) return;

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/transcripts?download=${jobId}&type=txt`);
        if (!res.ok) {
          setError('Could not load TXT transcript.');
          setContent('');
          setWordCount(0);
          return;
        }

        const text = await res.text();
        setContent(text);
        setWordCount(text.trim().split(/\s+/).filter(Boolean).length);
      } catch {
        setError('Failed to fetch transcript.');
        setContent('');
        setWordCount(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [jobId, projectId]);

  const isOpen = jobId !== null;
  const panelClass = [
    'txv-panel',
    standalone ? 'txv-panel--standalone' : '',
    isOpen ? 'txv-panel--open' : '',
  ].filter(Boolean).join(' ');

  const standalonePanelStyle: CSSProperties | undefined = standalone ? {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: '480px',
    maxWidth: 'calc(100vw - 48px)',
    background: 'var(--surface-2)',
    borderLeft: '1px solid var(--line)',
    boxShadow: '-20px 0 60px rgba(0, 0, 0, 0.38)',
    zIndex: 1001,
    transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 220ms ease',
    pointerEvents: isOpen ? 'auto' : 'none',
    display: 'flex',
    flexDirection: 'column',
  } : undefined;

  function getDownloadUrl(type: FileType): string {
    return `/api/projects/${projectId}/transcripts?download=${jobId}&type=${type}`;
  }

  const panel = (
    <Fragment>
      {standalone && isOpen && <div className="txv-backdrop" onClick={onClose} aria-hidden="true" />}
      <div className={panelClass} aria-hidden={!isOpen} style={standalonePanelStyle}>
        <div className="txv-header">
          <button type="button" className="txv-back-btn" onClick={onClose} aria-label="Close transcript viewer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back to transcripts
          </button>
          <div className="txv-header-info">
            <span className="txv-filename" title={formatTranscriptLabel(filename)}>{formatTranscriptLabel(filename)}</span>
            {wordCount > 0 && <span className="txv-wordcount">{wordCount.toLocaleString()} words</span>}
          </div>
        </div>

        <div className="txv-tabs">
          {(['txt', 'json', 'srt', 'vtt'] as FileType[]).map((type) => (
            availableFiles[type] ? (
              <a
                key={type}
                href={getDownloadUrl(type)}
                download
                className={`txv-tab${type === 'txt' ? ' txv-tab--active' : ''}`}
                title={`Download .${type}`}
              >
                {type.toUpperCase()}
              </a>
            ) : null
          ))}
        </div>

        <div className="txv-body">
          {loading && <p className="txv-loading">Loading...</p>}
          {error && <p className="txv-error">{error}</p>}
          {!loading && !error && content && (
            <pre className="txv-text">{content}</pre>
          )}
          {!loading && !error && !content && isOpen && (
            <p className="txv-loading">No TXT transcript available.</p>
          )}
        </div>
      </div>
    </Fragment>
  );

  if (standalone) {
    if (!mounted) return null;
    return createPortal(panel, document.body);
  }

  return panel;
}
