'use client';

import ReactMarkdown from 'react-markdown';
import React, { CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  TranscriptChatThread,
  TranscriptChatThreadSummary,
  TranscriptSearchMessage,
  TranscriptSearchSource,
} from '@/lib/transcripts/types';
type FileType = 'txt' | 'json' | 'srt' | 'vtt';
type PanelMode = 'viewer' | 'search';
type ViewMode = 'plain' | 'timecoded';
type SearchView = 'browser' | 'thread';

interface SearchScopeEntry {
  jobId: string;
  filename: string;
}

interface Props {
  projectId: string;
  projectName: string;
  mode: PanelMode;
  jobId: string | null;
  filename: string;
  onClose: () => void;
  standalone?: boolean;
  searchScope: SearchScopeEntry[];
  searchScopeMode: 'selected' | 'all';
  searchSessionKey: number;
  canUseSelectedScope?: boolean;
  onUseSelectedScope?: () => void;
  onNewChat?: () => void;
  onApplyThreadScope?: (scope: { mode: 'selected' | 'all'; jobIds: string[] }) => void;
  onOpenTranscript?: (jobId: string, filename: string) => void;
  onStartSearchFromTranscript?: () => void;
}

function formatTranscriptLabel(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

function makeMessageId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function groupSourcesByAsset(sources: TranscriptSearchSource[]): Array<{
  jobId: string;
  filename: string;
  isDirectQuote: boolean;
  excerpts: TranscriptSearchSource[];
}> {
  const groups = new Map<string, {
    jobId: string;
    filename: string;
    isDirectQuote: boolean;
    excerpts: TranscriptSearchSource[];
  }>();

  for (const source of sources) {
    const existing = groups.get(source.jobId);
    if (existing) {
      existing.isDirectQuote = existing.isDirectQuote || Boolean(source.isDirectQuote);
      existing.excerpts.push(source);
      continue;
    }

    groups.set(source.jobId, {
      jobId: source.jobId,
      filename: source.filename,
      isDirectQuote: Boolean(source.isDirectQuote),
      excerpts: [source],
    });
  }

  return [...groups.values()];
}

function buildScopeLabel(searchScopeMode: 'selected' | 'all', entries: SearchScopeEntry[]): string {
  if (searchScopeMode === 'all') return 'all transcripts';
  if (entries.length === 1) return formatTranscriptLabel(entries[0]!.filename);
  return `${entries.length} selected transcripts`;
}

function renderMessageContent(content: string) {
  return (
    <div
      className="txv-message-copy txv-message-markdown"
      onCopy={(e) => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', selection.toString());
      }}
    >
      <ReactMarkdown
        components={{
          table: ({ children }) => <>{children}</>,
          thead: () => null,
          tbody: () => null,
          tr: () => null,
          td: () => null,
          th: () => null,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function TranscriptViewerPanel({
  projectId,
  projectName,
  mode,
  jobId,
  filename,
  onClose,
  standalone = false,
  searchScope,
  searchScopeMode,
  searchSessionKey,
  canUseSelectedScope = false,
  onUseSelectedScope,
  onNewChat,
  onApplyThreadScope,
  onOpenTranscript,
  onStartSearchFromTranscript,
}: Readonly<Props>) {
  const [mounted, setMounted] = useState(false);
  const [availableFiles, setAvailableFiles] = useState<Record<FileType, boolean>>({
    txt: false,
    json: false,
    srt: false,
    vtt: false,
  });
  const [viewMode, setViewMode] = useState<ViewMode>('plain');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [messages, setMessages] = useState<TranscriptSearchMessage[]>([]);
  const [input, setInput] = useState('');
  const [threadSummary, setThreadSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [threadList, setThreadList] = useState<TranscriptChatThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [searchView, setSearchView] = useState<SearchView>('browser');
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToBottomRef = useRef(true);

  const isOpen = mode === 'search' || jobId !== null;
  const scopeLabel = useMemo(() => buildScopeLabel(searchScopeMode, searchScope), [searchScopeMode, searchScope]);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    setMessages([]);
    setInput('');
    setThreadSummary('');
    setIsSubmitting(false);
    setError(null);
    setExpandedSources({});
    setIsPinnedToBottom(true);
    setActiveThreadId(null);
    setSearchView('browser');
    shouldScrollToBottomRef.current = true;
  }, [searchSessionKey]);

  useEffect(() => {
    if (mode !== 'search' || searchView !== 'thread') return;
    if (!shouldScrollToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const node = chatBodyRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, mode, searchView]);

  useEffect(() => {
    if (mode !== 'search') return;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/transcripts/chat-threads`);
        if (!res.ok) return;
        const data = await res.json() as { threads: TranscriptChatThreadSummary[] };
        setThreadList(data.threads);
      } catch {
        // Ignore thread list failures.
      }
    })();
  }, [mode, projectId, searchSessionKey]);

  useEffect(() => {
    if (mode !== 'viewer' || !jobId) {
      setAvailableFiles({ txt: false, json: false, srt: false, vtt: false });
      setContent('');
      setWordCount(0);
      if (mode === 'viewer') setError(null);
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
        const entry = data.transcripts.find((item) => item.jobId === jobId);
        if (entry) setAvailableFiles(entry.files);
      } catch {
        // Ignore best-effort file metadata loading.
      }
    })();
  }, [jobId, mode, projectId]);

  useEffect(() => {
    setViewMode('plain');
  }, [jobId]);

  useEffect(() => {
    if (mode !== 'viewer' || !jobId) return;

    setLoading(true);
    setError(null);

    const fetchType = viewMode === 'timecoded' ? 'timecoded-txt' : 'txt';
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/transcripts?download=${jobId}&type=${fetchType}`);
        if (!res.ok) {
          setError(viewMode === 'timecoded' ? 'Could not load timecoded transcript.' : 'Could not load TXT transcript.');
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
  }, [jobId, mode, projectId, viewMode]);

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

  function appendMessage(message: TranscriptSearchMessage) {
    setMessages((current) => [...current, message]);
  }

  function updatePendingMessage(id: string, patch: Partial<TranscriptSearchMessage>) {
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, ...patch, pending: false } : message
    )));
  }

  function resetToBrowser() {
    setSearchView('browser');
    setMessages([]);
    setInput('');
    setThreadSummary('');
    setExpandedSources({});
    setActiveThreadId(null);
    onNewChat?.();
  }

  async function submitSearch(question: string) {
    const trimmed = question.trim();
    if (!trimmed || isSubmitting) return;
    if (!searchScope.length) {
      appendMessage({
        id: makeMessageId('error'),
        role: 'error',
        content: 'No transcripts are available yet.',
      });
      setSearchView('thread');
      return;
    }

    const conversation = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
    const pendingId = makeMessageId('assistant');

    shouldScrollToBottomRef.current = true;
    setSearchView('thread');
    appendMessage({ id: makeMessageId('user'), role: 'user', content: trimmed });
    appendMessage({ id: pendingId, role: 'assistant', content: 'Cami is thinking...', pending: true });
    setInput('');
    setIsSubmitting(true);

    let answer = '';
    let sources: TranscriptSearchSource[] = [];
    let newThreadSummary = '';

    try {
      const res = await fetch(`/api/projects/${projectId}/cami/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          conversation: [...conversation, { role: 'user', content: trimmed }],
          jobIds: searchScope.map((entry) => entry.jobId),
          scopeMode: searchScopeMode,
          threadSummary,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: 'Cami chat failed.' })) as { error?: string };
        throw new Error(err.error ?? 'Cami chat failed.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          let event: { type: string; text?: string; answer?: string; sources?: TranscriptSearchSource[]; threadSummary?: string };
          try { event = JSON.parse(data) as typeof event; } catch { continue; }

          if (event.type === 'status' && event.text) {
            updatePendingMessage(pendingId, { content: event.text });
          } else if (event.type === 'done') {
            answer = event.answer ?? '';
            sources = event.sources ?? [];
            newThreadSummary = event.threadSummary ?? '';
          } else if (event.type === 'error' && event.text) {
            throw new Error(event.text);
          }
        }
      }

      if (!answer) throw new Error('Cami did not return a response.');

      const nextMessages: TranscriptSearchMessage[] = [
        ...messages,
        { id: makeMessageId('user-persisted'), role: 'user', content: trimmed },
        { id: pendingId, role: 'assistant', content: answer, sources },
      ];

      setThreadSummary(newThreadSummary);
      updatePendingMessage(pendingId, { content: answer, sources });

      const persistedThread = await persistThread({
        threadId: activeThreadId,
        messages: nextMessages,
        threadSummary: newThreadSummary,
      });

      if (persistedThread) {
        setActiveThreadId(persistedThread.threadId);
        setThreadList((current) => {
          const nextSummary: TranscriptChatThreadSummary = {
            threadId: persistedThread.threadId,
            title: persistedThread.title,
            createdAt: persistedThread.createdAt,
            updatedAt: persistedThread.updatedAt,
            scope: persistedThread.scope,
            messageCount: persistedThread.messages.length,
          };
          return [nextSummary, ...current.filter((thread) => thread.threadId !== persistedThread.threadId)]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        });
      }
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Cami chat failed.';
      updatePendingMessage(pendingId, { role: 'error', content: message, sources: [] });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function persistThread(input: {
    threadId: string | null;
    messages: TranscriptSearchMessage[];
    threadSummary: string;
  }): Promise<TranscriptChatThread | null> {
    try {
      const threadId = input.threadId ?? activeThreadId;
      const endpoint = threadId
        ? `/api/projects/${projectId}/transcripts/chat-threads/${threadId}`
        : `/api/projects/${projectId}/transcripts/chat-threads`;

      if (!threadId) {
        const created = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: {
              mode: searchScopeMode,
              jobIds: searchScope.map((entry) => entry.jobId),
            },
          }),
        });
        if (!created.ok) return null;

        const createdPayload = await created.json() as { thread: TranscriptChatThread };
        const saved = await fetch(`/api/projects/${projectId}/transcripts/chat-threads/${createdPayload.thread.threadId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: createdPayload.thread.scope,
            threadSummary: input.threadSummary,
            messages: input.messages,
          }),
        });
        if (!saved.ok) return createdPayload.thread;
        return (await saved.json() as { thread: TranscriptChatThread }).thread;
      }

      const saved = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: {
            mode: searchScopeMode,
            jobIds: searchScope.map((entry) => entry.jobId),
          },
          threadSummary: input.threadSummary,
          messages: input.messages,
        }),
      });
      if (!saved.ok) return null;
      return (await saved.json() as { thread: TranscriptChatThread }).thread;
    } catch {
      return null;
    }
  }

  async function loadThread(threadId: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/transcripts/chat-threads/${threadId}`);
      if (!res.ok) return;
      const data = await res.json() as { thread: TranscriptChatThread };
      setActiveThreadId(data.thread.threadId);
      setMessages(data.thread.messages);
      setThreadSummary(data.thread.threadSummary);
      setExpandedSources({});
      setIsPinnedToBottom(true);
      setSearchView('thread');
      shouldScrollToBottomRef.current = true;
      onApplyThreadScope?.(data.thread.scope);
    } catch {
      // Ignore failed thread loads.
    }
  }

  async function deleteThread(threadId: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/transcripts/chat-threads/${threadId}`, { method: 'DELETE' });
      if (!res.ok) return;
      setThreadList((current) => current.filter((thread) => thread.threadId !== threadId));
      if (activeThreadId === threadId) {
        resetToBrowser();
      }
    } catch {
      // Ignore delete failures.
    }
  }

  const panelClass = [
    'txv-panel',
    standalone ? 'txv-panel--standalone' : '',
    isOpen ? 'txv-panel--open' : '',
    mode === 'search' ? 'txv-panel--search' : '',
  ].filter(Boolean).join(' ');

  const panel = (
    <Fragment>
      {standalone && isOpen && <div className="txv-backdrop" onClick={onClose} aria-hidden="true" />}
      <div className={panelClass} aria-hidden={!isOpen} style={standalonePanelStyle}>
        <div className="txv-header">
          <button
            type="button"
            className="txv-back-btn"
            onClick={() => {
              if (mode === 'search' && searchView === 'thread') {
                setSearchView('browser');
              } else {
                onClose();
              }
            }}
            aria-label={mode === 'search' && searchView === 'thread' ? 'Back to thread browser' : 'Close transcript panel'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {mode === 'search' && searchView === 'thread' ? 'Back to search' : 'Back to transcripts'}
          </button>

          {mode === 'viewer' ? (
            <>
              <div className="txv-header-info">
                <span className="txv-filename" title={formatTranscriptLabel(filename)}>{formatTranscriptLabel(filename)}</span>
                {wordCount > 0 && <span className="txv-wordcount">{wordCount.toLocaleString()} words</span>}
              </div>
              <div className="txv-toolbar">
                {availableFiles.json ? (
                  <div className="txv-view-toggle">
                    <button
                      type="button"
                      className={`txv-view-btn${viewMode === 'plain' ? ' txv-view-btn--active' : ''}`}
                      onClick={() => setViewMode('plain')}
                    >
                      Plain
                    </button>
                    <button
                      type="button"
                      className={`txv-view-btn${viewMode === 'timecoded' ? ' txv-view-btn--active' : ''}`}
                      onClick={() => setViewMode('timecoded')}
                    >
                      Timecoded
                    </button>
                  </div>
                ) : (
                  <span className="txv-toolbar-note">Read transcript and exports</span>
                )}
                {onStartSearchFromTranscript && (
                  <button type="button" className="txv-action-btn" onClick={onStartSearchFromTranscript}>
                    Ask About Transcript
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="txv-header-info txv-header-info--stack">
                <span className="txv-panel-title">Cami</span>
              </div>
              <div className="txv-toolbar txv-toolbar--search">
                <div className="txv-toolbar-actions">
                  {searchView === 'thread' && canUseSelectedScope && onUseSelectedScope && (
                    <button type="button" className="txv-action-btn" onClick={onUseSelectedScope}>
                      Use Selected Transcripts
                    </button>
                  )}
                </div>
                <span className="txv-using-label" title={`Using: ${scopeLabel}`}>
                  Using: {scopeLabel}
                </span>
              </div>
            </>
          )}
        </div>

        {mode === 'viewer' ? (
          <>
            <div className="txv-tabs">
              {(['txt', 'json', 'srt', 'vtt'] as FileType[]).map((type) => (
                availableFiles[type] ? (
                  <a
                    key={type}
                    href={getDownloadUrl(type)}
                    download
                    className={`txv-tab${type === 'txt' && viewMode === 'plain' ? ' txv-tab--active' : ''}`}
                    title={`Download .${type}`}
                  >
                    {type.toUpperCase()}
                  </a>
                ) : null
              ))}
              {availableFiles.json && (
                <a
                  href={`/api/projects/${projectId}/transcripts?download=${jobId}&type=timecoded-txt`}
                  download
                  className={`txv-tab${viewMode === 'timecoded' ? ' txv-tab--active' : ''}`}
                  title="Download timecoded TXT"
                >
                  TIMECODED
                </a>
              )}
            </div>

            <div className="txv-body">
              {!loading && !error && content && (
                <CopyButton text={content} />
              )}
              {loading && <p className="txv-loading">Loading...</p>}
              {error && <p className="txv-error">{error}</p>}
              {!loading && !error && content && (
                <pre
                  className="txv-text"
                  onCopy={(e) => {
                    const selection = window.getSelection();
                    if (!selection || selection.isCollapsed) return;
                    e.preventDefault();
                    e.clipboardData.setData('text/plain', selection.toString());
                  }}
                >
                  {content}
                </pre>
              )}
              {!loading && !error && !content && isOpen && <p className="txv-loading">No TXT transcript available.</p>}
            </div>
          </>
        ) : searchView === 'browser' ? (
          <>
            <div className="txv-browser-body">
              {threadList.length > 0 ? (
                <div className="txv-thread-browser">
                  <div className="txv-thread-list">
                    {threadList.map((thread) => (
                      <div
                        key={thread.threadId}
                        className={`txv-thread-chip${activeThreadId === thread.threadId ? ' txv-thread-chip--active' : ''}`}
                      >
                        <button type="button" className="txv-thread-chip-btn" onClick={() => void loadThread(thread.threadId)}>
                          <span className="txv-thread-chip-title">{thread.title}</span>
                          <span className="txv-thread-chip-meta">{thread.messageCount} msgs</span>
                        </button>
                        <button
                          type="button"
                          className="txv-thread-chip-delete"
                          onClick={() => void deleteThread(thread.threadId)}
                          aria-label={`Delete ${thread.title}`}
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="txv-browser-empty">
                  <div className="txv-empty-prompt-wrap">
                    <div className="txv-empty-prompt">
                      Ask me a question about {projectName}.
                    </div>
                  </div>
                </div>
              )}
            </div>

            <form
              className="txv-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submitSearch(input);
              }}
            >
              <input
                type="text"
                className="txv-composer-input"
                placeholder="Ask Cami anything about this project..."
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={isSubmitting}
              />
              <button type="submit" className="txv-composer-send" disabled={isSubmitting || !input.trim()}>
                Send
              </button>
            </form>
          </>
        ) : (
          <>
            <div
              ref={chatBodyRef}
              className="txv-chat-body"
              onScroll={(event) => {
                const node = event.currentTarget;
                const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
                const nextPinnedState = distanceFromBottom < 40;
                setIsPinnedToBottom(nextPinnedState);
                shouldScrollToBottomRef.current = nextPinnedState;
              }}
            >
              {messages.map((message) => (
                <div key={message.id} className={`txv-message txv-message--${message.role}`}>
                  <div className="txv-message-bubble">
                    <span className="txv-message-role">
                      {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Cami' : 'Notice'}
                    </span>
                    {renderMessageContent(message.content)}
                  </div>

                  {message.sources && message.sources.length > 0 && (
                    <div className="txv-source-list">
                      <span className="txv-sources-label">Sources</span>
                      {groupSourcesByAsset(message.sources).map((sourceGroup) => (
                        <SourceCard
                          key={`${message.id}-${sourceGroup.jobId}`}
                          sourceGroup={sourceGroup}
                          expanded={Boolean(expandedSources[`${message.id}-${sourceGroup.jobId}`])}
                          onToggle={() => setExpandedSources((current) => ({
                            ...current,
                            [`${message.id}-${sourceGroup.jobId}`]: !current[`${message.id}-${sourceGroup.jobId}`],
                          }))}
                          onOpenTranscript={onOpenTranscript}
                        />
                      ))}
                    </div>
                  )}

                  {message.usage && (
                    <p className="txv-usage-note">
                      {message.searchMode === 'local'
                        ? `${message.usage.selectedChunkCount} match${message.usage.selectedChunkCount === 1 ? '' : 'es'} found`
                        : `Used ${message.usage.selectedChunkCount} excerpt${message.usage.selectedChunkCount === 1 ? '' : 's'} from ${message.usage.selectedTranscriptCount} transcript${message.usage.selectedTranscriptCount === 1 ? '' : 's'}.`
                      }
                    </p>
                  )}
                </div>
              ))}
            </div>

            {!isPinnedToBottom && (
              <button
                type="button"
                className="txv-jump-bottom"
                onClick={() => {
                  const node = chatBodyRef.current;
                  if (!node) return;
                  node.scrollTop = node.scrollHeight;
                  setIsPinnedToBottom(true);
                  shouldScrollToBottomRef.current = true;
                }}
                aria-label="Jump to latest message"
              >
                &darr;
              </button>
            )}

            <form
              className="txv-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submitSearch(input);
              }}
            >
              <input
                type="text"
                className="txv-composer-input"
                placeholder="Ask Cami anything about this project..."
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={isSubmitting}
              />
              <button type="submit" className="txv-composer-send" disabled={isSubmitting || !input.trim()}>
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </Fragment>
  );

  if (standalone) {
    if (!mounted) return null;
    return createPortal(panel, document.body);
  }

  return panel;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      type="button"
      className="txv-copy-btn"
      onClick={handleCopy}
      aria-label="Copy transcript to clipboard"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function renderExcerptContent(excerpt: string, matchText: string | undefined): React.ReactNode {
  // AI mode — truncate to a few lines
  if (!matchText) {
    const clean = excerpt.replace(/^\.*\s*/, '').trim();
    const truncated = clean.length > 220 ? `${clean.slice(0, 220).trimEnd()}…` : clean;
    return truncated;
  }

  // Local find mode — trim to ~12 words each side and highlight the match
  const WINDOW = 80;
  const lower = excerpt.toLowerCase();
  const matchLower = matchText.toLowerCase();
  const idx = lower.indexOf(matchLower);

  if (idx === -1) {
    // Match not found in excerpt (token fallback case) — show first 180 chars
    return excerpt.replace(/^\.*\s*/, '').trim().slice(0, 180);
  }

  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(excerpt.length, idx + matchText.length + WINDOW);
  const before = (start > 0 ? '…' : '') + excerpt.slice(start, idx);
  const match = excerpt.slice(idx, idx + matchText.length);
  const after = excerpt.slice(idx + matchText.length, end) + (end < excerpt.length ? '…' : '');

  return (
    <>
      {before}
      <mark className="txv-match-highlight">{match}</mark>
      {after}
    </>
  );
}

function SourceCard({
  sourceGroup,
  expanded,
  onToggle,
  onOpenTranscript,
}: Readonly<{
  sourceGroup: {
    jobId: string;
    filename: string;
    isDirectQuote: boolean;
    excerpts: TranscriptSearchSource[];
  };
  expanded: boolean;
  onToggle: () => void;
  onOpenTranscript?: (jobId: string, filename: string) => void;
}>) {
  const sectionCount = sourceGroup.excerpts.length;

  return (
    <div className={`txv-source-card${expanded ? ' txv-source-card--expanded' : ''}`}>
      <div className="txv-source-row">
        <button type="button" className="txv-source-toggle" onClick={onToggle} aria-expanded={expanded}>
          <span className="txv-source-name" title={formatTranscriptLabel(sourceGroup.filename)}>
            {formatTranscriptLabel(sourceGroup.filename)}
          </span>
          <span className="txv-source-count">
            {sectionCount} section{sectionCount === 1 ? '' : 's'}
          </span>
          <span className={`txv-source-caret${expanded ? ' txv-source-caret--open' : ''}`} aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </button>
        {onOpenTranscript && (
          <button
            type="button"
            className="txv-source-go-btn"
            onClick={() => onOpenTranscript(sourceGroup.jobId, sourceGroup.filename)}
          >
            Go to video
          </button>
        )}
      </div>
      {expanded && (
        <div className="txv-source-excerpts">
          {sourceGroup.excerpts.map((source, index) => (
            <p key={`${sourceGroup.jobId}-${index}`} className="txv-source-excerpt">
              {renderExcerptContent(source.excerpt, source.matchText)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
