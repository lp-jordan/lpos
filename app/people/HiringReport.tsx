'use client';

import React, { useCallback, useEffect, useState } from 'react';

/**
 * Answer shapes vary per question kind and come from a snapshot taken when the
 * invite was created, so a shape this code does not expect is a live
 * possibility. Without a boundary, one bad question blanks the entire report
 * and hides the other 28 — which is worse than showing one broken row.
 */
class QuestionErrorBoundary extends React.Component<
  { children: React.ReactNode; questionNumber: number },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          marginBottom: '2.25rem', padding: '0.7rem 0.9rem', borderRadius: 6,
          border: '1px solid rgba(229,85,85,0.4)', background: 'rgba(229,85,85,0.06)',
          fontSize: '0.82rem', color: 'var(--color-error,#e55)',
        }}>
          Q{this.props.questionNumber} could not be rendered: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Candidate report — one scrollable page, all questions in section order.
 *
 * Layout choices come from the plan and are deliberate:
 *  - No card container per question; whitespace separates them.
 *  - No rubric prose. Questions the system did not score carry a quiet
 *    "Not auto-scored" marker; you judge against the source document, which you
 *    hold separately.
 *  - Auto-scored questions collapse to a one-line confirmation — eight correct
 *    multiple-choice answers is noise.
 *  - Timing renders inline on each question, not in a separate tab. The number
 *    is only meaningful next to the answer it describes.
 */

interface Report {
  invite: {
    token: string; candidateName: string; roleLabel: string | null;
    status: string; startedAt: string | null; completedAt: string | null;
    archived: boolean; revoked: boolean; finalCheck: unknown;
  };
  questions: Question[];
  sections: Section[];
  answers: Record<string, AnswerRow>;
  auto: Record<string, AutoResult>;
  scoring: Scoring;
  manual: Record<string, ManualRow>;
  criticalConditions: Record<string, { condition: string; detection: string }[]>;
  timing: { totalMs: number; activeMs: number; blurMs: number; introDwellMs: number };
}

interface Section { id: string; number: string; title: string; points: number }
interface Question {
  id: string; number: number; section: string; kind: string;
  prompt: string; typeLabel?: string;
  options?: { key: string; text: string }[];
  fields?: { key: string; label?: string }[];
  itemContext?: { name?: string; original?: string; description?: string }[];
  count?: number;
}
interface AnswerRow {
  value: unknown; answered: boolean;
  dwellMs: number; visits: number; blurMs: number;
}
interface AutoResult {
  autoPoints: number; maxAutoPoints: number; maxPoints: number;
  criticalFailure: boolean;
  detail: Record<string, unknown>;
}
interface ManualRow {
  manualPoints: number | null; state: string | null;
  tally: boolean[] | null; criticalFlag: boolean; note: string | null;
}
interface Scoring {
  total: number; rawTotal: number; pendingManual: number;
  criticalFailures: string[];
  band: { label: string; detail: string };
  perQuestion: Record<string, {
    autoPoints: number; manualPoints: number; total: number;
    maxPoints: number; manualMax: number; judged: boolean;
    mode: string; partialPct: number;
    manualControl: 'judgement' | 'items' | 'none';
    manualLabel: string | null;
  }>;
}

function ms(v: number): string {
  if (!v) return '—';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function HiringReport({ token, onClose }: { token: string; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [saving, setSaving]   = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res  = await fetch(`/api/hiring/invites/${token}/report`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load the report.');
      setReport(data as Report);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  // Merges the server's recomputed totals in place. Reloading the whole report
  // here would remount the page and throw the evaluator back to the top after
  // every single click.
  async function save(questionId: string, patch: Record<string, unknown>) {
    setSaving(questionId);
    try {
      const res = await fetch(`/api/hiring/invites/${token}/scores/${questionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json() as { scoring?: Scoring; manual?: Record<string, ManualRow>; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Save failed.');
      setReport((prev) => (prev && data.scoring
        ? { ...prev, scoring: data.scoring, manual: data.manual ?? prev.manual }
        : prev));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <Shell onClose={onClose}><p style={{ color: 'var(--muted)' }}>Loading report…</p></Shell>;
  if (error || !report) {
    return (
      <Shell onClose={onClose}>
        <p style={{ color: 'var(--color-error,#e55)' }}>{error ?? 'No report.'}</p>
      </Shell>
    );
  }

  const { invite, questions, sections, answers, auto, scoring, manual, timing, criticalConditions } = report;
  const hasCritical = scoring.criticalFailures.length > 0;

  return (
    <Shell onClose={onClose}>
      {/* Summary header */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>{invite.candidateName}</h2>
          <span style={{ color: 'var(--muted-soft)', fontSize: '0.85rem' }}>
            {invite.roleLabel} · {invite.completedAt ? 'Submitted' : 'In progress'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '1.75rem', flexWrap: 'wrap', margin: '1rem 0' }}>
          <Stat label="Total time" value={ms(timing.totalMs)} hint="Begin → submit" />
          <Stat label="Active" value={ms(timing.activeMs)} hint="Summed time on questions" />
          <Stat label="Tab away" value={ms(timing.blurMs)} />
          <Stat label="Intro reading" value={ms(timing.introDwellMs)} hint="Before the clock started" />
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
          padding: '0.8rem 1rem', borderRadius: 8,
          border: `1px solid ${hasCritical ? 'rgba(229,85,85,0.45)' : 'var(--line)'}`,
          background: hasCritical ? 'rgba(229,85,85,0.08)' : 'rgba(255,255,255,0.03)',
        }}>
          {hasCritical ? (
            <strong style={{ color: 'var(--color-error,#e55)' }}>Critical failure</strong>
          ) : (
            <strong style={{ fontSize: '1.05rem' }}>{scoring.total} / 100</strong>
          )}
          <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            {hasCritical
              ? `${scoring.criticalFailures.length} condition${scoring.criticalFailures.length === 1 ? '' : 's'} flagged — the band does not apply`
              : scoring.band.label}
          </span>
          {!hasCritical && scoring.pendingManual > 0 && (
            <span style={{ color: 'var(--muted-soft)', fontSize: '0.8rem' }}>
              · running total — {scoring.pendingManual} points still unjudged
            </span>
          )}
        </div>
      </div>

      {/* Questions, in section order */}
      {sections.map((section) => {
        const qs = questions.filter((q) => q.section === section.id);
        if (!qs.length) return null;
        return (
          <div key={section.id} style={{ marginBottom: '2.5rem' }}>
            <p style={{
              margin: '0 0 1.25rem', fontSize: '0.72rem', letterSpacing: '0.09em',
              textTransform: 'uppercase', color: 'var(--accent)',
              borderBottom: '1px solid var(--line)', paddingBottom: '0.5rem',
            }}>
              Section {section.number} — {section.title} · {section.points} pts
            </p>
            {qs.map((q) => (
              <QuestionErrorBoundary key={q.id} questionNumber={q.number}>
                <QuestionBlock
                  q={q}
                  answer={answers[q.id]}
                  auto={auto[q.id]}
                  manual={manual[q.id]}
                  score={scoring.perQuestion[q.id]}
                  conditions={criticalConditions?.[q.id]}
                  saving={saving === q.id}
                  onSave={(patch) => void save(q.id, patch)}
                />
              </QuestionErrorBoundary>
            ))}
          </div>
        );
      })}
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <button
        type="button"
        onClick={onClose}
        style={{
          alignSelf: 'flex-start', background: 'none', border: 'none',
          color: 'var(--muted)', cursor: 'pointer', fontSize: '0.85rem', padding: 0,
        }}
      >
        ← Back to candidates
      </button>
      {children}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.72rem', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--muted-soft)' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{value}</div>
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--muted-soft)' }}>{hint}</div>}
    </div>
  );
}

function QuestionBlock({ q, answer, auto, manual, score, conditions, saving, onSave }: {
  q: Question;
  answer?: AnswerRow;
  auto?: AutoResult;
  manual?: ManualRow;
  score?: Scoring['perQuestion'][string];
  conditions?: { condition: string; detection: string }[];
  saving: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const fullyAuto = score && score.manualMax === 0;
  const autoCorrect = auto && auto.autoPoints >= auto.maxAutoPoints;

  // Correct auto-scored questions collapse to one line, but the line still has
  // to say WHAT she answered — a row of bare checkmarks tells the reader
  // nothing and makes them open each one to find out.
  if (fullyAuto && autoCorrect && !auto?.criticalFailure) {
    const chosenKeys: string[] = q.kind === 'mc_multi'
      ? ((auto?.detail?.chosen as string[]) ?? [])
      : [auto?.detail?.chosen as string].filter(Boolean);
    const chosenText = chosenKeys
      .map((k) => q.options?.find((o) => o.key === k)?.text ?? '')
      .filter(Boolean)
      .join(' / ');

    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', padding: '0.4rem 0', fontSize: '0.85rem' }}>
        <span style={{ color: '#5ab95a' }}>✓</span>
        <span style={{ color: 'var(--muted-soft)', flexShrink: 0 }}>Q{q.number}</span>
        <strong style={{ color: 'var(--text)', flexShrink: 0 }}>{chosenKeys.join(', ')}</strong>
        <span style={{
          flex: 1, minWidth: 0, color: 'var(--muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={`${q.prompt}\n\n${chosenText}`}>
          {chosenText || q.prompt}
        </span>
        <span style={{ color: 'var(--muted-soft)', flexShrink: 0 }}>{ms(answer?.dwellMs ?? 0)}</span>
        <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{score?.total}/{score?.maxPoints}</span>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: '2.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.8rem', color: 'var(--muted-soft)' }}>Q{q.number}</strong>
        <span style={{ flex: 1, fontSize: '0.95rem' }}>{q.prompt}</span>
        <span style={{ fontSize: '0.78rem', color: 'var(--muted-soft)' }} title="Dwell · visits · tab away">
          {ms(answer?.dwellMs ?? 0)} · {answer?.visits ?? 0} visit{answer?.visits === 1 ? '' : 's'}
          {answer && answer.blurMs > 0 && ` · ${ms(answer.blurMs)} away`}
        </span>
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: score?.judged ? 'var(--text)' : 'var(--muted-soft)' }}>
          {score ? `${score.total}/${score.maxPoints}` : '—'}
        </span>
      </div>

      <AnswerView
        q={q} answer={answer} auto={auto}
        itemMarks={score?.manualControl === 'items' ? (manual?.tally ?? []) : null}
        onToggleItem={(i) => {
          const n = (manual?.tally ?? []).slice();
          while (n.length <= i) n.push(false);
          n[i] = !n[i];
          onSave({ tally: n });
        }}
        saving={saving}
      />

      <ScoreControls
        manual={manual} score={score} conditions={conditions} saving={saving} onSave={onSave}
      />
    </div>
  );
}

function AnswerView({ q, answer, auto, itemMarks, onToggleItem, saving }: {
  q: Question; answer?: AnswerRow; auto?: AutoResult;
  itemMarks?: boolean[] | null;
  onToggleItem?: (i: number) => void;
  saving?: boolean;
}) {
  const box: React.CSSProperties = {
    padding: '0.7rem 0.9rem', borderRadius: 6, background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--line)', fontSize: '0.88rem', lineHeight: 1.65,
    whiteSpace: 'pre-wrap', margin: '0 0 0.6rem',
  };

  if (!answer?.answered) {
    return <p style={{ ...box, color: 'var(--muted-soft)', fontStyle: 'italic' }}>Not answered.</p>;
  }

  const v = answer.value as Record<string, unknown>;

  if (q.kind === 'mc_single' || q.kind === 'mc_multi') {
    const chosen = q.kind === 'mc_single'
      ? [v?.choice as string].filter(Boolean)
      : (v?.choices as string[] ?? []);
    const expected: string[] = q.kind === 'mc_single'
      ? [(auto?.detail?.expected as string)].filter(Boolean)
      : ((auto?.detail?.expected as string[]) ?? []);

    return (
      <div style={{ margin: '0 0 0.6rem' }}>
        {(q.options ?? []).map((opt) => {
          const picked = chosen.includes(opt.key);
          const right  = expected.includes(opt.key);
          if (!picked && !right) return null;
          return (
            <div key={opt.key} style={{
              display: 'flex', gap: '0.5rem', padding: '0.3rem 0', fontSize: '0.86rem',
              color: picked && right ? '#5ab95a' : picked ? 'var(--color-error,#e55)' : 'var(--muted-soft)',
            }}>
              <span style={{ width: 60, flexShrink: 0 }}>
                {picked ? (right ? '✓ chose' : '✗ chose') : 'expected'}
              </span>
              <span><strong>{opt.key}.</strong> {opt.text}</span>
            </div>
          );
        })}
        {/* Q28 has no expected answer — it is recorded, never scored. */}
        {v?.fields != null && <ConditionalFields fields={v.fields as Record<string, string>} />}
      </div>
    );
  }

  if (q.kind === 'text') {
    const fields = (v?.fields ?? {}) as Record<string, string>;
    return (
      <div style={{ margin: '0 0 0.6rem' }}>
        {Object.entries(fields).map(([k, val]) => (
          <div key={k} style={{ marginBottom: '0.5rem' }}>
            {Object.keys(fields).length > 1 && (
              <div style={{ fontSize: '0.72rem', color: 'var(--muted-soft)', marginBottom: '0.2rem' }}>
                {q.fields?.find((f) => f.key === k)?.label ?? k}
              </div>
            )}
            <p style={box}>{val || <em style={{ opacity: 0.5 }}>blank</em>}</p>
          </div>
        ))}
        {/* `reason: 'blank'` also carries matched:false — reporting an unfilled
            quote as a mismatch would point at a critical failure that is not
            there. */}
        {auto?.detail?.matched === false && auto?.detail?.reason !== 'blank' && (
          <p style={{ fontSize: '0.8rem', color: 'var(--color-error,#e55)', margin: '0 0 0.6rem' }}>
            Quote does not match the transcript. Verify before treating this as a critical failure —
            check for a genuine edit rather than a copy artefact.
          </p>
        )}
        {auto?.detail?.reason === 'blank' && (
          <p style={{ fontSize: '0.8rem', color: 'var(--muted-soft)', margin: '0 0 0.6rem' }}>
            No quote given — nothing to check.
          </p>
        )}
        {auto?.detail?.matched === true && (
          <p style={{ fontSize: '0.8rem', color: '#5ab95a', margin: '0 0 0.6rem' }}>
            ✓ Quote matches the transcript exactly.
          </p>
        )}
        {auto?.detail?.reason === 'transcript_unavailable' && (
          <p style={{ fontSize: '0.8rem', color: 'var(--muted-soft)', margin: '0 0 0.6rem' }}>
            Transcript not loaded — quote fidelity could not be checked.
          </p>
        )}
      </div>
    );
  }

  if (q.kind === 'repeat') {
    const items = (v?.items ?? []) as (Record<string, string> | null)[];
    // Two different auto shapes land in `results`: Q21's filename check gives
    // { passed, failed }, Q23's status check gives { correct, accepted }.
    // Reading one shape's fields off the other is how this blanked the page.
    const results = auto?.detail?.results as
      | { passed?: boolean; failed?: string[]; correct?: boolean; accepted?: string[] }[]
      | undefined;
    const ordering = auto?.detail?.expected as string[] | undefined;
    const markable = itemMarks != null && onToggleItem != null;

    // A single-field item is just a sentence — printing "bullet:" in front of
    // it leaks the internal field name. Multi-field items keep a label, but the
    // question's own wording rather than the raw key.
    const singleField = (q.fields?.length ?? 0) <= 1;
    const labelFor = (k: string) => q.fields?.find((f) => f.key === k)?.label ?? k;

    return (
      <div style={{ margin: '0 0 0.6rem' }}>
        {items.map((item, i) => {
          const ctx = q.itemContext?.[i];
          const r = results?.[i];
          const ok = r ? (r.passed ?? r.correct) : undefined;
          const marked = Boolean(itemMarks?.[i]);
          const filled = Object.entries(item ?? {}).filter(([, val]) => String(val ?? '').trim());

          // Only worth a line of its own when it actually says something —
          // "Asset A", a source filename, or an auto-check verdict. A bare
          // ordinal goes inline instead of eating a row.
          const heading = ctx?.name ?? ctx?.original ?? null;
          const hasHeadingRow = Boolean(heading) || ok !== undefined || Boolean(ordering?.[i]);

          return (
            <div key={i} style={{
              display: 'flex', gap: '0.55rem', alignItems: 'flex-start', marginBottom: '0.5rem',
            }}>
              {markable && (
                <input
                  type="checkbox"
                  checked={marked}
                  disabled={saving}
                  onChange={() => onToggleItem(i)}
                  title="Mark this item as meeting the bar"
                  style={{ marginTop: '0.7rem', accentColor: '#5ab95a', flexShrink: 0, cursor: 'pointer' }}
                />
              )}
              <span style={{
                fontSize: '0.72rem', color: 'var(--muted-soft)', marginTop: '0.72rem',
                flexShrink: 0, minWidth: '1.1rem', fontVariantNumeric: 'tabular-nums',
              }}>
                {i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {hasHeadingRow && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--muted-soft)', marginBottom: '0.2rem' }}>
                    {heading}
                    {ok !== undefined && (
                      <span style={{ marginLeft: heading ? '0.5rem' : 0, color: ok ? '#5ab95a' : 'var(--color-error,#e55)' }}>
                        {ok
                          ? '✓'
                          : r?.failed?.length
                            ? `✗ ${r.failed.join(', ')}`
                            : r?.accepted?.length
                              ? `✗ expected ${r.accepted.join(' or ')}`
                              : '✗'}
                      </span>
                    )}
                    {ordering?.[i] && (
                      <span style={{ marginLeft: '0.5rem', color: 'var(--muted-soft)' }}>
                        expected: {ordering[i]}
                      </span>
                    )}
                  </div>
                )}
                <div style={box}>
                  {!filled.length && <em style={{ opacity: 0.5 }}>blank</em>}
                  {singleField
                    ? filled.map(([, val]) => val).join('\n')
                    : filled.map(([k, val]) => (
                        <div key={k} style={{ marginBottom: '0.3rem' }}>
                          <span style={{ color: 'var(--muted-soft)' }}>{labelFor(k)}: </span>
                          {val}
                        </div>
                      ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return <p style={box}>{JSON.stringify(answer.value)}</p>;
}

function ConditionalFields({ fields }: { fields: Record<string, string> }) {
  const entries = Object.entries(fields).filter(([, v]) => String(v ?? '').trim());
  if (!entries.length) return null;
  return (
    <div style={{ marginTop: '0.5rem' }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ marginBottom: '0.35rem' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--muted-soft)' }}>{k}</div>
          <p style={{
            margin: 0, padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: '0.85rem',
            background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)', whiteSpace: 'pre-wrap',
          }}>{v}</p>
        </div>
      ))}
    </div>
  );
}

const BTN: React.CSSProperties = {
  padding: '0.22rem 0.6rem', borderRadius: 5, fontSize: '0.76rem', cursor: 'pointer',
  border: '1px solid var(--color-border,#444)', background: 'var(--color-input-bg,#1a1a1a)',
  color: 'var(--muted)',
};

function ScoreControls({ manual, score, conditions, saving, onSave }: {
  manual?: ManualRow;
  score?: Scoring['perQuestion'][string];
  conditions?: { condition: string; detection: string }[];
  saving: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  if (!score) {
    return <p style={{ fontSize: '0.78rem', color: 'var(--muted-soft)', margin: 0 }}>Not scored.</p>;
  }

  const manualMax = score.manualMax;
  const control   = score.manualControl;

  // Only questions that test a p.26 condition get a flag, and it names the
  // condition. Automatically-detected ones raise themselves.
  const manualConditions = (conditions ?? []).filter((c) => c.detection !== 'automatic');

  const partialPts = Math.round(manualMax * (score.partialPct / 100) * 100) / 100;
  const STATES: { key: string; label: string; pts: number }[] = [
    { key: 'strong',  label: 'Strong',  pts: manualMax },
    { key: 'partial', label: 'Partial', pts: partialPts },
    { key: 'weak',    label: 'Weak',    pts: 0 },
  ];

  const markedCount = (manual?.tally ?? []).filter(Boolean).length;

  return (
    <div style={{ marginTop: '0.5rem' }}>
      {control === 'none' && score.maxPoints === 0 && (
        <span style={{ fontSize: '0.76rem', color: 'var(--muted-soft)' }}>Recorded, not scored.</span>
      )}

      {control === 'judgement' && manualMax > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          {/* On hybrid questions most points are already auto-scored, so say
              what this judgement is actually rating. */}
          {score.manualLabel && (
            <span style={{ fontSize: '0.76rem', color: 'var(--muted)', marginRight: '0.15rem' }}>
              {score.manualLabel}:
            </span>
          )}
          {STATES.map((st) => (
            <button
              key={st.key}
              type="button"
              disabled={saving}
              onClick={() => onSave({ state: st.key })}
              style={{
                ...BTN,
                borderColor: manual?.state === st.key ? 'var(--accent)' : 'var(--color-border,#444)',
                background:  manual?.state === st.key ? 'var(--accent-soft)' : 'var(--color-input-bg,#1a1a1a)',
                color:       manual?.state === st.key ? 'var(--accent-strong)' : 'var(--muted)',
              }}
            >
              {st.label} <span style={{ opacity: 0.7 }}>{st.pts}</span>
            </button>
          ))}
        </div>
      )}

      {control === 'items' && manualMax > 0 && (
        <div style={{ fontSize: '0.76rem', color: 'var(--muted-soft)' }}>
          {score.manualLabel ? `${score.manualLabel} — ` : ''}
          tick each item that meets the bar ·{' '}
          <strong style={{ color: 'var(--muted)' }}>
            {markedCount} marked · {score.manualPoints} of {manualMax} pts
          </strong>
        </div>
      )}

      {manualConditions.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.45rem',
          flexWrap: 'wrap', justifyContent: 'flex-end',
        }}>
          <span style={{ fontSize: '0.74rem', color: 'var(--muted-soft)', marginRight: 'auto' }}>
            {manualConditions.map((c) => c.condition).join(' · ')}
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave({ criticalFlag: !manual?.criticalFlag })}
            style={{
              ...BTN,
              borderColor: manual?.criticalFlag ? 'rgba(229,85,85,0.6)' : 'var(--color-border,#444)',
              background:  manual?.criticalFlag ? 'rgba(229,85,85,0.12)' : 'var(--color-input-bg,#1a1a1a)',
              color:       manual?.criticalFlag ? 'var(--color-error,#e55)' : 'var(--muted-soft)',
            }}
          >
            {manual?.criticalFlag ? '⚑ Flagged' : 'Flag'}
          </button>
        </div>
      )}
    </div>
  );
}
