'use client';

import { useState, useRef, useEffect } from 'react';
import type { Asset } from '@/lib/models/asset';
import type { TranscriptEntry } from '@/app/api/projects/[projectId]/transcripts/route';

// ── Local types ───────────────────────────────────────────────────────────────

type PPSettings = {
  audience: string;
  tone: string;
  additionalGuidance: string;
};

type PPVideo = {
  videoId: string;
  sourceCode: string;
  generatedTitle: string;
  generatedDescription: string;
};

type PPCategory = {
  id: string;
  title: string;
  videos: PPVideo[];
};

type PPPass = {
  id: string;
  title: string;
  categories: PPCategory[];
};

type WorkbookSection = {
  videoId: string;
  categoryTitle: string;
  title: string;
  content: string;
};

type Phase = 'preflight' | 'passPlan' | 'workbook' | 'admin';

const PHASE_ORDER: Phase[] = ['preflight', 'passPlan', 'workbook', 'admin'];

const PHASES: { id: Phase; label: string; num: number }[] = [
  { id: 'preflight', label: 'Pre-Flight',  num: 1 },
  { id: 'passPlan',  label: 'Pass Plan',   num: 2 },
  { id: 'workbook',  label: 'Workbook',    num: 3 },
  { id: 'admin',     label: 'Admin',       num: 4 },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  workbooks: Asset[];
  projectId: string;
  queuedJobIds: string[];
}

// ── Main component ────────────────────────────────────────────────────────────

export function PassPrepTab({ projectId, queuedJobIds }: Props) {

  // Screen state
  const [connected,        setConnected]       = useState(false);
  const [activePhase,      setActivePhase]     = useState<Phase>('preflight');
  const [collapsedPhases,  setCollapsedPhases] = useState<Set<Phase>>(new Set());
  const [transcripts,      setTranscripts]     = useState<TranscriptEntry[]>([]);

  // Pre-Flight
  const [settings,          setSettings]         = useState<PPSettings>({ audience: '', tone: '', additionalGuidance: '' });
  const [generatingPlan,    setGeneratingPlan]    = useState(false);
  const [planError,         setPlanError]         = useState<string | null>(null);
  const [warnDismissed,     setWarnDismissed]     = useState(false);

  // Pass Plan
  const [passes, setPasses] = useState<PPPass[]>([]);

  // Workbook
  const [workbookSections,  setWorkbookSections]  = useState<WorkbookSection[]>([]);
  const [generatingWorkbook, setGeneratingWorkbook] = useState(false);
  const [workbookError,     setWorkbookError]      = useState<string | null>(null);

  // Drag state
  const dragInfo = useRef<{ passIdx: number; catIdx: number; vidIdx: number } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null); // "p-c-v" key

  // Load transcripts
  useEffect(() => {
    fetch(`/api/projects/${projectId}/transcripts`)
      .then((r) => r.json() as Promise<{ transcripts: TranscriptEntry[] }>)
      .then((d) => setTranscripts(d.transcripts))
      .catch(() => {});
  }, [projectId]);

  const queuedTranscripts = transcripts.filter((t) => queuedJobIds.includes(t.jobId));

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function phaseStatus(phase: Phase): 'active' | 'done' | 'future' {
    const activeIdx = PHASE_ORDER.indexOf(activePhase);
    const phaseIdx  = PHASE_ORDER.indexOf(phase);
    if (phaseIdx < activeIdx)  return 'done';
    if (phaseIdx === activeIdx) return 'active';
    return 'future';
  }

  function toggleCollapse(phase: Phase) {
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) next.delete(phase); else next.add(phase);
      return next;
    });
  }

  function advanceTo(phase: Phase) {
    setActivePhase(phase);
    // collapse everything before
    const idx = PHASE_ORDER.indexOf(phase);
    setCollapsedPhases(new Set(PHASE_ORDER.slice(0, idx)));
  }

  // ── Plan generation ──────────────────────────────────────────────────────────

  async function handleGeneratePlan() {
    setGeneratingPlan(true);
    setPlanError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/passPrep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds: queuedJobIds, settings }),
      });
      const data = await res.json() as { passes?: PPPass[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? 'Plan generation failed');
      setPasses(data.passes ?? []);
      advanceTo('passPlan');
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingPlan(false);
    }
  }

  // ── Workbook generation ───────────────────────────────────────────────────────

  async function handleGenerateWorkbook() {
    setGeneratingWorkbook(true);
    setWorkbookError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/passPrep`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passes, settings, jobIds: queuedJobIds }),
      });
      const data = await res.json() as { sections?: WorkbookSection[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? 'Workbook generation failed');
      setWorkbookSections(data.sections ?? []);
      advanceTo('workbook');
    } catch (err) {
      setWorkbookError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingWorkbook(false);
    }
  }

  // ── Export workbook ───────────────────────────────────────────────────────────

  function handleExport() {
    const content = workbookSections
      .map((s) => `# ${s.title}\n_Category: ${s.categoryTitle}_\n\n${s.content}`)
      .join('\n\n---\n\n');
    const blob = new Blob([content], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'workbook.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────────

  function handleDragStart(passIdx: number, catIdx: number, vidIdx: number) {
    dragInfo.current = { passIdx, catIdx, vidIdx };
  }

  function handleDrop(passIdx: number, catIdx: number, vidIdx: number) {
    setDragOver(null);
    if (!dragInfo.current) return;
    const { passIdx: fp, catIdx: fc, vidIdx: fv } = dragInfo.current;
    if (fp === passIdx && fc === catIdx && fv === vidIdx) { dragInfo.current = null; return; }

    setPasses((prev) => {
      const next: PPPass[] = JSON.parse(JSON.stringify(prev));
      const [video] = next[fp].categories[fc].videos.splice(fv, 1);
      // Remove now-empty categories
      next[fp].categories = next[fp].categories.filter((c) => c.videos.length > 0);
      // Recalculate target indices after possible removal
      const tPass = next[passIdx];
      const tCat  = tPass?.categories[catIdx];
      if (tCat) {
        const insertAt = (fp === passIdx && fc === catIdx && fv < vidIdx) ? vidIdx - 1 : vidIdx;
        tCat.videos.splice(Math.max(0, insertAt), 0, video);
      }
      return next;
    });
    dragInfo.current = null;
  }

  // ── Connect screen ────────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <div className="pp-connect">
        <div className="pp-connect-card">
          <div className="pp-connect-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
              <rect x="9" y="3" width="6" height="4" rx="1"/>
              <path d="M9 12h6M9 16h4"/>
            </svg>
          </div>
          <h2 className="pp-connect-title">Pass Prep</h2>
          <p className="pp-connect-sub">
            Organize transcripts into a structured course pass plan and generate workbook content with AI.
          </p>
          {queuedJobIds.length > 0 && (
            <div className="pp-connect-queued">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              {queuedJobIds.length} transcript{queuedJobIds.length !== 1 ? 's' : ''} queued
            </div>
          )}
          <div className="pp-connect-actions">
            <button
              type="button"
              className="pp-connect-btn pp-connect-btn--secondary"
              onClick={() => {/* TODO: load existing pass map */}}
              title="Connect to an existing pass map file"
            >
              Connect to Pass Map
            </button>
            <button
              type="button"
              className="pp-connect-btn pp-connect-btn--primary"
              onClick={() => setConnected(true)}
            >
              Start Fresh
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Active workspace ──────────────────────────────────────────────────────────

  const activeIdx = PHASE_ORDER.indexOf(activePhase);

  return (
    <div className="pp-workspace proj-tab-content page-stack">

      {/* ── Phase tracker ── */}
      <div className="pp-tracker">
        {PHASES.map((phase, i) => {
          const st = phaseStatus(phase.id);
          return (
            <div key={phase.id} className="pp-tracker-item">
              <div className={`pp-tracker-dot pp-tracker-dot--${st}`}>
                {st === 'done'
                  ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                  : <span>{phase.num}</span>
                }
              </div>
              <span className={`pp-tracker-label pp-tracker-label--${st}`}>{phase.label}</span>
              {i < PHASES.length - 1 && (
                <div className={`pp-tracker-line pp-tracker-line--${activeIdx > i ? 'done' : 'future'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* ── Phase 1: Pre-Flight ── */}
      <PhaseSection
        num={1} label="Pre-Flight"
        status={phaseStatus('preflight')}
        collapsed={collapsedPhases.has('preflight')}
        onToggle={() => toggleCollapse('preflight')}
      >
        <div className="pp-preflight">
          {queuedJobIds.length === 0 && !warnDismissed && (
            <button
              type="button"
              className="pp-warn pp-warn--clickable"
              onClick={() => setWarnDismissed(true)}
              title="Click to proceed with demo data"
            >
              <span>No transcripts queued — go to the Transcripts tab and send some to Pass Prep first.</span>
              <span className="pp-warn-bypass">Proceed with demo data →</span>
            </button>
          )}
          {queuedJobIds.length > 0 && (
            <div className="pp-queued-files">
              {queuedTranscripts.map((t) => (
                <div key={t.jobId} className="pp-queued-file">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                  {t.filename}
                </div>
              ))}
            </div>
          )}
          <div className="pp-fields">
            <div className="pp-field">
              <label className="pp-field-label">Audience</label>
              <input
                type="text"
                className="pp-field-input"
                placeholder="e.g. Mid-level professionals in financial services"
                value={settings.audience}
                onChange={(e) => setSettings((s) => ({ ...s, audience: e.target.value }))}
              />
            </div>
            <div className="pp-field">
              <label className="pp-field-label">Tone</label>
              <input
                type="text"
                className="pp-field-input"
                placeholder="e.g. Direct, practical, no fluff"
                value={settings.tone}
                onChange={(e) => setSettings((s) => ({ ...s, tone: e.target.value }))}
              />
            </div>
            <div className="pp-field">
              <label className="pp-field-label">Additional Guidance</label>
              <textarea
                className="pp-field-textarea"
                placeholder="Any special instructions for content generation…"
                rows={3}
                value={settings.additionalGuidance}
                onChange={(e) => setSettings((s) => ({ ...s, additionalGuidance: e.target.value }))}
              />
            </div>
          </div>
          {planError && <p className="pp-error">{planError}</p>}
          <div className="pp-phase-actions">
            <button
              type="button"
              className="pp-btn pp-btn--primary"
              onClick={() => void handleGeneratePlan()}
              disabled={generatingPlan || (queuedJobIds.length === 0 && !warnDismissed)}
            >
              {generatingPlan
                ? <><span className="pp-spinner" /> Generating Pass Plan…</>
                : 'Generate Pass Plan'
              }
            </button>
          </div>
        </div>
      </PhaseSection>

      {/* ── Phase 2: Pass Plan ── */}
      {activeIdx >= 1 && (
        <PhaseSection
          num={2} label="Pass Plan"
          status={phaseStatus('passPlan')}
          collapsed={collapsedPhases.has('passPlan')}
          onToggle={() => toggleCollapse('passPlan')}
        >
          <div className="pp-passplan">
            {passes.map((pass, passIdx) => (
              <div key={pass.id} className="pp-pass">
                <div className="pp-pass-header">
                  <h3 className="pp-pass-title">{pass.title}</h3>
                  <span className="pp-pass-meta">
                    {pass.categories.reduce((n, c) => n + c.videos.length, 0)} videos · {pass.categories.length} categories
                  </span>
                </div>
                <div className="pp-categories">
                  {pass.categories.map((cat, catIdx) => (
                    <div key={cat.id} className="pp-category">
                      <div className="pp-category-header">
                        <span className="pp-category-num">{catIdx + 1}</span>
                        <h4 className="pp-category-title">{cat.title}</h4>
                        <span className="pp-category-count">{cat.videos.length} video{cat.videos.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="pp-video-list">
                        {cat.videos.map((video, vidIdx) => {
                          const key = `${passIdx}-${catIdx}-${vidIdx}`;
                          return (
                            <div
                              key={video.videoId}
                              className={`pp-video-card${dragOver === key ? ' pp-video-card--dragover' : ''}`}
                              draggable
                              onDragStart={() => handleDragStart(passIdx, catIdx, vidIdx)}
                              onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
                              onDragLeave={() => setDragOver(null)}
                              onDrop={() => handleDrop(passIdx, catIdx, vidIdx)}
                            >
                              <div className="pp-video-handle" title="Drag to reorder">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                  <circle cx="9"  cy="6"  r="1.5"/>
                                  <circle cx="9"  cy="12" r="1.5"/>
                                  <circle cx="9"  cy="18" r="1.5"/>
                                  <circle cx="15" cy="6"  r="1.5"/>
                                  <circle cx="15" cy="12" r="1.5"/>
                                  <circle cx="15" cy="18" r="1.5"/>
                                </svg>
                              </div>
                              <div className="pp-video-body">
                                <div className="pp-video-top">
                                  <span className="pp-video-code">{video.sourceCode}</span>
                                  <span className="pp-video-title">{video.generatedTitle}</span>
                                </div>
                                <p className="pp-video-desc">{video.generatedDescription}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {workbookError && <p className="pp-error">{workbookError}</p>}
            <div className="pp-phase-actions">
              <button
                type="button"
                className="pp-btn pp-btn--primary"
                onClick={() => void handleGenerateWorkbook()}
                disabled={generatingWorkbook || passes.length === 0}
              >
                {generatingWorkbook
                  ? <><span className="pp-spinner" /> Generating Workbook…</>
                  : 'Generate Workbook'
                }
              </button>
            </div>
          </div>
        </PhaseSection>
      )}

      {/* ── Phase 3: Workbook ── */}
      {activeIdx >= 2 && (
        <PhaseSection
          num={3} label="Workbook"
          status={phaseStatus('workbook')}
          collapsed={collapsedPhases.has('workbook')}
          onToggle={() => toggleCollapse('workbook')}
        >
          <div className="pp-workbook">
            {workbookSections.map((section, idx) => (
              <div key={section.videoId} className="pp-wb-section">
                <div className="pp-wb-section-hd">
                  <span className="pp-wb-cat-badge">{section.categoryTitle}</span>
                  <h4 className="pp-wb-title">{section.title}</h4>
                </div>
                <textarea
                  className="pp-wb-editor"
                  rows={14}
                  value={section.content}
                  onChange={(e) => {
                    const val = e.target.value;
                    setWorkbookSections((prev) => prev.map((s, i) => i === idx ? { ...s, content: val } : s));
                  }}
                />
              </div>
            ))}
            {workbookSections.length === 0 && (
              <p className="pp-empty">No workbook sections generated yet.</p>
            )}
            <div className="pp-phase-actions">
              <button
                type="button"
                className="pp-btn pp-btn--secondary"
                onClick={handleExport}
                disabled={workbookSections.length === 0}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export Workbook
              </button>
              <button
                type="button"
                className="pp-btn pp-btn--ghost"
                onClick={() => advanceTo('admin')}
              >
                Continue to Admin →
              </button>
            </div>
          </div>
        </PhaseSection>
      )}

      {/* ── Phase 4: Admin ── */}
      {activeIdx >= 3 && (
        <PhaseSection
          num={4} label="Admin"
          status={phaseStatus('admin')}
          collapsed={collapsedPhases.has('admin')}
          onToggle={() => toggleCollapse('admin')}
        >
          <div className="pp-admin">
            <div className="pp-admin-grid">
              <div className="pp-admin-card">
                <h4 className="pp-admin-card-title">Delivery Package</h4>
                <p className="pp-admin-card-desc">Bundle workbook + pass plan into a deliverable package for the client.</p>
                <button type="button" className="pp-btn pp-btn--secondary" disabled>Prepare Package</button>
              </div>
              <div className="pp-admin-card">
                <h4 className="pp-admin-card-title">Upload to Delivery</h4>
                <p className="pp-admin-card-desc">Push the finalized workbook to the project delivery folder.</p>
                <button type="button" className="pp-btn pp-btn--secondary" disabled>Push to Delivery</button>
              </div>
              <div className="pp-admin-card">
                <h4 className="pp-admin-card-title">Archive Pass Prep</h4>
                <p className="pp-admin-card-desc">Mark this pass prep as complete and archive all artifacts.</p>
                <button type="button" className="pp-btn pp-btn--danger" disabled>Archive</button>
              </div>
            </div>
          </div>
        </PhaseSection>
      )}

    </div>
  );
}

// ── PhaseSection sub-component ───────────────────────────────────────────────

function PhaseSection({
  num, label, status, collapsed, onToggle, children,
}: {
  num: number;
  label: string;
  status: 'active' | 'done' | 'future';
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`pp-section pp-section--${status}`}>
      <button type="button" className="pp-section-hd" onClick={onToggle}>
        <div className={`pp-section-num pp-section-num--${status}`}>{num}</div>
        <span className="pp-section-label">{label}</span>
        {status === 'done' && <span className="pp-section-done">Done</span>}
        <svg
          className={`pp-section-chevron${collapsed ? ' pp-section-chevron--up' : ''}`}
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {!collapsed && <div className="pp-section-body">{children}</div>}
    </div>
  );
}
