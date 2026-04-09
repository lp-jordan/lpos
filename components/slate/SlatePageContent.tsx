'use client';

import { useState, useEffect, useRef } from 'react';
import { useSlate } from '@/hooks/useSlate';
import { AtemPanel } from '@/components/slate/AtemPanel';
import { LightingPanel } from '@/components/slate/LightingPanel';
import { PlaybackPanel } from '@/components/slate/PlaybackPanel';
import { CameraPanel } from '@/components/slate/CameraPanel';
import { PresentationPanel } from '@/components/studio/PresentationPanel';
import { SlateModal, ModalType } from '@/components/slate/SlateModal';
import { NewProjectModal } from '@/components/shared/NewProjectModal';

// ── Local timecode / date hooks (client-only, no socket needed) ────────────

function useTimecode() {
  const [tc, setTc] = useState('00:00:00:00');
  useEffect(() => {
    function tick() {
      const now = new Date();
      const frames = Math.floor(now.getMilliseconds() / 40);
      setTc(`${now.toTimeString().split(' ')[0]}:${String(frames).padStart(2, '0')}`);
    }
    tick();
    const id = setInterval(tick, 40);
    return () => clearInterval(id);
  }, []);
  return tc;
}

function useCurrentDate() {
  const [date, setDate] = useState('');
  useEffect(() => {
    const fmt = () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    setDate(fmt());
    const id = setInterval(() => setDate(fmt()), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  return date;
}

// ── Page ───────────────────────────────────────────────────────────────────

export function SlatePageContent({ isGuest }: { isGuest: boolean }) {
  const timecode = useTimecode();
  const currentDate = useCurrentDate();

  const slate = useSlate();

  // Local UI state
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [logVisible, setLogVisible] = useState(true);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [codeInput, setCodeInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [atemSettingsOpen, setAtemSettingsOpen] = useState(false);
  const [output4Mode, setOutput4Mode] = useState<'multiview' | 'program'>('multiview');
  const [devConsoleOpen, setDevConsoleOpen] = useState(false);
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const [modal, setModal] = useState<{ type: ModalType; message?: string }>({ type: null });
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null);
  const [editNoteCode, setEditNoteCode] = useState('');
  const [editNoteText, setEditNoteText] = useState('');
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectClient, setNewProjectClient] = useState<string | undefined>();
  const VALID_TABS = ['notes', 'atem', 'lighting', 'camera', 'audio', 'playback', 'presentation'] as const;
  type StudioTab = typeof VALID_TABS[number];
  // Guests always land on presentation
  const [studioTab, setStudioTab] = useState<StudioTab>(isGuest ? 'presentation' : 'notes');

  const projectRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Open the correct tab when navigating via a hash deep-link (e.g. /slate#presentation)
  // Guests are locked to presentation regardless of hash
  useEffect(() => {
    if (isGuest) return;
    const hash = window.location.hash.slice(1) as StudioTab;
    if (VALID_TABS.includes(hash)) setStudioTab(hash);
  }, []);

  // Sync code input with broadcast updates from other clients
  useEffect(() => {
    setCodeInput(slate.codeText);
  }, [slate.codeText]);

  useEffect(() => {
    if (studioTab !== 'audio') {
      setAudioSettingsOpen(false);
    }
  }, [studioTab]);

  // ── Derived values ──
  const currentProject = slate.projects.find((p) => p.projectId === slate.currentProjectId);
  const isRecording = slate.atemState?.recording.isRecording ?? false;

  // Group projects by client for the dropdown
  const clientGroups = slate.projects.reduce<Record<string, typeof slate.projects>>((acc, p) => {
    (acc[p.clientName] ??= []).push(p);
    return acc;
  }, {});
  const sortedClients = Object.keys(clientGroups).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // ── Note actions ──
  function submitNote() {
    if (!noteInput.trim()) return;
    slate.addNote(codeInput.trim(), noteInput.trim());
    setNoteInput('');
    noteInputRef.current?.focus();
  }

  function toggleSelectNote(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }

  function deleteSelected() {
    slate.deleteNotes([...selected]);
    setSelected(new Set());
    setBatchMode(false);
  }

  function handleCodeChange(value: string) {
    setCodeInput(value);
    slate.updateCode(value);
  }

  // ── ATEM output4 toggle ──
  function handleOutput4Toggle() {
    const next: 'program' | 'multiview' = output4Mode === 'multiview' ? 'program' : 'multiview';
    setOutput4Mode(next);
    slate.atemSetOutput4Mode(next);
  }

  function handleStudioTabChange(tab: StudioTab) {
    if (isGuest && tab !== 'presentation') return;
    setStudioTab(tab);
    slate.setStudioTab(tab);
  }

  return (
    <div className="sl-page">

      {/* Date header */}
      <div className="sl-date-bar">
        <span className="sl-date">{currentDate}</span>
        {!slate.socketConnected && (
          <span className="sl-socket-status sl-socket-status--offline">● Offline</span>
        )}
      </div>

      {/* ATEM toast */}
      {slate.atemToast && (
        <div className={`sl-toast sl-toast--${slate.atemToast.type}`} onClick={slate.dismissToast}>
          {slate.atemToast.message}
        </div>
      )}

      {/* Hero: timecode + project selector + REC strip */}
      <section className="sl-hero">
        <div className="sl-timecode">{timecode}</div>

        {/* Project selector */}
        <div className="sl-course-row" ref={projectRef}>
          <span className="sl-course-label">Project</span>

          <div className={`sl-select-wrap${projectDropdownOpen ? ' open' : ''}`}>
            <button
              className="sl-select-trigger"
              type="button"
              onClick={() => setProjectDropdownOpen((v) => !v)}
            >
              <span>{currentProject ? `${currentProject.clientName} — ${currentProject.name}` : 'Select a project'}</span>
              <svg className="sl-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {projectDropdownOpen && (
              <div className="sl-dropdown">
                {slate.projects.length === 0 && (
                  <span className="sl-dropdown-empty">No projects — create one below</span>
                )}
                {sortedClients.map((client) => (
                  <div key={client} className="sl-dropdown-group">
                    <span className="sl-dropdown-group-label">{client}</span>
                    {clientGroups[client].map((p) => (
                      <button
                        key={p.projectId}
                        className={`sl-dropdown-option${slate.currentProjectId === p.projectId ? ' active' : ''}`}
                        type="button"
                        onClick={() => { slate.loadProject(p.projectId); setProjectDropdownOpen(false); }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                ))}
                <button
                  className="sl-dropdown-new"
                  type="button"
                  onClick={() => {
                    setNewProjectClient(undefined);
                    setProjectDropdownOpen(false);
                    setShowNewProjectModal(true);
                  }}
                >
                  + New Project
                </button>
              </div>
            )}
          </div>
        </div>

        {/* REC strip */}
        <div className="sl-rec-strip">
          <button
            className={`sl-rec-btn${isRecording ? ' sl-rec-btn--active' : ''}`}
            type="button"
            onClick={() => isRecording ? slate.atemStopRecording() : slate.atemStartRecording()}
            disabled={!slate.currentProjectId}
          >
            REC
          </button>
          <span className="sl-rec-label">Recording</span>
          <span className={`sl-rec-value${isRecording ? ' sl-rec-value--on' : ''}`}>
            {isRecording ? 'On' : 'Off'}
          </span>
          <span className="sl-rec-spacer" />
          <span className={`sl-connected-badge${slate.atemState?.connected ? '' : ' sl-connected-badge--off'}`}>
            {slate.atemState?.connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </section>

      {/* Studio panel — tabbed, circles float left */}
      <div className="sl-studio-wrap">

        {/* Vertical pill tabs */}
        <nav className="sl-pill-nav" aria-label="Studio tabs">
          {([
            { id: 'notes',    label: 'Production Notes', icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
            )},
            { id: 'atem',     label: 'ATEM Controls', icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/>
                <path d="M15.54 8.46a5 5 0 010 7.07M8.46 8.46a5 5 0 000 7.07"/>
              </svg>
            )},
            { id: 'lighting', label: 'Lighting', icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            )},
            { id: 'camera',   label: 'Camera',   icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
              </svg>
            )},
            { id: 'audio',    label: 'Audio',    icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                <path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
            )},
            { id: 'playback', label: 'Playback', icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="7 5 19 12 7 19 7 5"/>
                <rect x="3" y="5" width="2" height="14" rx="1"/>
              </svg>
            )},
            { id: 'presentation', label: 'Presentation', icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            )},
          ] as { id: StudioTab; label: string; icon: React.ReactNode; soon?: boolean }[]).map((tab) => {
            const guestLocked = isGuest && tab.id !== 'presentation';
            return (
              <button
                key={tab.id}
                type="button"
                className={`sl-pill${studioTab === tab.id ? ' sl-pill--active' : ''}${tab.soon ? ' sl-pill--soon' : ''}${guestLocked ? ' sl-pill--locked' : ''}`}
                onClick={() => !tab.soon && !guestLocked && handleStudioTabChange(tab.id as typeof studioTab)}
                aria-label={tab.label}
                title={guestLocked ? 'Not available in guest mode' : tab.label}
                aria-disabled={guestLocked || undefined}
              >
                <span className="sl-pill-icon">{tab.icon}</span>
                <span className="sl-pill-label">
                  {tab.label}
                  {tab.soon && <span className="sl-pill-soon-badge">Soon</span>}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Panel content */}
        <section className="sl-notes-section sl-studio-panel">

          {/* ── Notes tab ── */}
          {studioTab === 'notes' && (<>
            <div className="sl-note-inputs">
              <div className="sl-code-box">
                <span className="sl-code-placeholder">CODE</span>
                <input
                  className="sl-code-input"
                  value={codeInput}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  aria-label="Note code"
                  placeholder=" "
                  disabled={!slate.currentProjectId}
                />
              </div>
              <div className="sl-note-box">
                <textarea
                  ref={noteInputRef}
                  className="sl-note-input"
                  placeholder={slate.currentProjectId ? 'Production Notes' : 'Select a project to take notes'}
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitNote(); } }}
                  disabled={!slate.currentProjectId}
                  rows={1}
                />
                <button className="sl-send-btn" type="button" onClick={submitNote} disabled={!slate.currentProjectId}>
                  Send
                </button>
              </div>
            </div>

            {batchMode && (
              <div className="sl-batch-bar">
                <button className="sl-danger-btn" type="button" onClick={deleteSelected}>
                  Delete Selected ({selected.size})
                </button>
                <button className="sl-btn-ghost" type="button" onClick={() => { setSelected(new Set()); setBatchMode(false); }}>
                  Cancel
                </button>
              </div>
            )}

            <div className="sl-log-controls">
              <button className="sl-btn-ghost" type="button" onClick={() => setLogVisible((v) => !v)}>
                {logVisible ? 'Hide Log' : 'Show Log'}
              </button>
              <button className="sl-btn-ghost" type="button" onClick={() => setBatchMode((v) => !v)}>
                {batchMode ? 'Exit Select' : 'Select'}
              </button>
              <button className="sl-btn-ghost" type="button">Export CSV</button>
            </div>

            {logVisible && (
              <div className="sl-notes-log">
                {slate.notes.length === 0 && (
                  <p className="sl-notes-empty">
                    {slate.currentProjectId ? 'No notes yet.' : 'Select a project to begin.'}
                  </p>
                )}
                {slate.notes.map((n, index) => (
                  <div
                    key={`${n.timestamp}-${index}`}
                    className={`sl-note-row${selected.has(index) ? ' sl-note-row--selected' : ''}`}
                    onClick={() => batchMode && toggleSelectNote(index)}
                  >
                    {batchMode && (
                      <input
                        type="checkbox"
                        className="sl-note-check"
                        checked={selected.has(index)}
                        onChange={() => toggleSelectNote(index)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    {editingNoteIndex === index ? (
                      <div
                        className="sl-note-edit-row"
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                            slate.editNote(index, editNoteCode, editNoteText);
                            setEditingNoteIndex(null);
                          }
                        }}
                      >
                        <input
                          className="sl-note-edit-code"
                          value={editNoteCode}
                          onChange={(e) => setEditNoteCode(e.target.value)}
                          aria-label="Edit note code"
                        />
                        <input
                          className="sl-note-edit-text"
                          value={editNoteText}
                          onChange={(e) => setEditNoteText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              slate.editNote(index, editNoteCode, editNoteText);
                              setEditingNoteIndex(null);
                            } else if (e.key === 'Escape') {
                              setEditingNoteIndex(null);
                            }
                          }}
                          aria-label="Edit note text"
                          autoFocus
                        />
                        <button
                          className="sl-note-edit-save"
                          type="button"
                          onClick={() => { slate.editNote(index, editNoteCode, editNoteText); setEditingNoteIndex(null); }}
                        >
                          Save
                        </button>
                        <button
                          className="sl-note-edit-cancel"
                          type="button"
                          onClick={() => setEditingNoteIndex(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="sl-note-ts">[{n.timestamp}]</span>
                        <span className="sl-note-body">{n.code} - {n.note}</span>
                        {!batchMode && (
                          <>
                            <button
                              className="sl-note-edit-btn"
                              type="button"
                              aria-label="Edit note"
                              onClick={(e) => { e.stopPropagation(); setEditNoteCode(n.code); setEditNoteText(n.note); setEditingNoteIndex(index); }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                              </svg>
                            </button>
                            <button
                              className="sl-note-delete"
                              type="button"
                              aria-label="Delete note"
                              onClick={(e) => { e.stopPropagation(); slate.deleteNote(index); }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                                <path d="M10 11v6M14 11v6"/>
                                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                              </svg>
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>)}

          {/* ── ATEM tab ── */}
          {studioTab === 'atem' && (
            <AtemPanel
              atemState={slate.atemState}
              settingsOpen={atemSettingsOpen}
              onSettingsToggle={() => setAtemSettingsOpen((v) => !v)}
              onConnect={slate.atemConnect}
              onDisconnect={slate.atemDisconnect}
              onSetFilename={slate.atemSetFilename}
              onSetPreview={slate.atemSetPreview}
              onSetProgram={slate.atemSetProgram}
              onCut={slate.atemCut}
              onAuto={slate.atemAuto}
              onStartRecording={slate.atemStartRecording}
              onStopRecording={slate.atemStopRecording}
              onOutput4Toggle={handleOutput4Toggle}
            />
          )}

          {/* ── Lighting tab ── */}
          {studioTab === 'playback' && (
            <PlaybackPanel connection={slate.playbackConnection} />
          )}

          {studioTab === 'lighting' && <LightingPanel />}

          {/* ── Camera / Audio soon ── */}
          {studioTab === 'audio' && (
            <div className="sl-audio-panel">
              <div className="sl-audio-header">
                <span className="sl-playback-title">Studio Audio</span>
                <div className="sl-audio-header-actions">
                  <span
                    className={`sl-audio-status-badge${slate.audioMonitor.phase === 'monitoring'
                      ? ' sl-audio-status-badge--live'
                      : slate.audioMonitor.phase === 'error' || slate.audioMonitor.phase === 'no_source'
                        ? ' sl-audio-status-badge--off'
                        : ''}`}
                  >
                    {slate.audioMonitor.statusLabel}
                  </span>
                  <div className="sl-audio-settings-wrap">
                    <button
                      type="button"
                      className={`sl-gear-btn${audioSettingsOpen ? ' sl-gear-btn--open' : ''}`}
                      onClick={() => setAudioSettingsOpen((value) => !value)}
                      aria-label="Audio input settings"
                      title="Audio input settings"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                    {audioSettingsOpen && (
                      <div className="sl-audio-settings-menu">
                        <span className="sl-manage-label">Host Input</span>
                        {slate.audioMonitor.availableInputs.length === 0 && (
                          <div className="sl-audio-settings-empty">No host audio inputs found.</div>
                        )}
                        {slate.audioMonitor.availableInputs.map((input) => {
                          const active = input.deviceKey === slate.audioMonitor.preferredInput.deviceKey;
                          return (
                            <button
                              key={input.deviceKey}
                              type="button"
                              className={`sl-audio-settings-option${active ? ' sl-audio-settings-option--active' : ''}`}
                              onClick={() => {
                                slate.setAudioMonitorInput(input);
                                setAudioSettingsOpen(false);
                              }}
                            >
                              {input.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="sl-audio-monitor-wrap">
                <button
                  type="button"
                  className={`sl-audio-monitor-pill${!slate.audioMonitor.locallyMuted && slate.audioMonitor.phase !== 'blocked'
                    ? ' sl-audio-monitor-pill--live'
                    : ''}`}
                  onClick={() => slate.setAudioMonitorMuted(!slate.audioMonitor.locallyMuted)}
                  disabled={slate.audioMonitor.phase === 'no_source'}
                >
                  Monitor
                </button>
                <p className="sl-audio-monitor-copy">
                  {slate.audioMonitor.lastError
                    ? slate.audioMonitor.lastError
                    : slate.audioMonitor.preferredInput.label || slate.audioMonitor.preferredInput.deviceKey || 'No preferred input configured'}
                </p>
              </div>
            </div>
          )}

          {studioTab === 'camera' && <CameraPanel />}

          {studioTab === 'presentation' && <PresentationPanel />}

        </section>
      </div>

      {/* Dev console */}
      <div className="sl-dev-wrap">
        <button className="sl-dev-toggle" type="button" onClick={() => setDevConsoleOpen((v) => !v)}>
          Dev Console {slate.socketConnected ? '●' : '○'}
        </button>
        {devConsoleOpen && (
          <div className="sl-dev-console">
            {slate.logs.length === 0 && <div className="sl-dev-line sl-dev-line--muted">No logs yet.</div>}
            {slate.logs.map((line, i) => (
              <div key={i} className="sl-dev-line">{line}</div>
            ))}
          </div>
        )}
      </div>

      <SlateModal type={modal.type} message={modal.message} onClose={() => setModal({ type: null })} />

      {showNewProjectModal && (
        <NewProjectModal
          defaultClientName={newProjectClient}
          onClose={() => setShowNewProjectModal(false)}
          onCreated={(project) => {
            setShowNewProjectModal(false);
            // Auto-load the newly created project into slate
            slate.loadProject(project.projectId);
          }}
        />
      )}
    </div>
  );
}
