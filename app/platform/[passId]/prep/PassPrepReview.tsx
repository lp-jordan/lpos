'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PassTree } from '@/lib/store/platform-pass-store';

type ReconcileState = 'matched' | 'category_mismatch' | 'no_code_on_asset' | 'code_not_in_sheet' | 'no_asset_linked';

interface PrepRow {
  tileId: string;
  categoryId: string;
  tileCategory: string;
  code: string | null;
  state: ReconcileState;
  transcript: 'ready' | 'missing' | 'no_asset';
  titleBefore: string;
  titleAfter: string;
  titleOutcome: 'sheet' | 'ai' | 'kept' | 'unresolved';
  descriptionOutcome: 'generated' | 'kept' | 'manual' | 'no_transcript' | 'error';
  error: string | null;
}

interface PrepResult {
  ok: boolean;
  sheetConnected: boolean;
  sheetError: string | null;
  aiAvailable: boolean;
  counts: Record<string, number>;
  report: PrepRow[];
}

const STATE_LABEL: Record<ReconcileState, string> = {
  matched: 'Matched',
  category_mismatch: 'Wrong category',
  no_code_on_asset: 'No code on video',
  code_not_in_sheet: 'Code not in sheet',
  no_asset_linked: 'No video linked',
};
const STATE_TONE: Record<ReconcileState, { fg: string; bg: string; bd: string }> = {
  matched: { fg: 'var(--success, #2f855a)', bg: 'var(--accent-soft)', bd: 'var(--accent)' },
  category_mismatch: { fg: 'var(--warning)', bg: 'var(--surface-inset)', bd: 'var(--warning)' },
  no_code_on_asset: { fg: 'var(--muted)', bg: 'var(--surface-inset)', bd: 'var(--line)' },
  code_not_in_sheet: { fg: 'var(--warning)', bg: 'var(--surface-inset)', bd: 'var(--warning)' },
  no_asset_linked: { fg: 'var(--muted-soft)', bg: 'var(--surface-inset)', bd: 'var(--line)' },
};

export function PassPrepReview({ passIdOrSlug }: { passIdOrSlug: string }) {
  const router = useRouter();
  const [tree, setTree] = useState<PassTree | null>(null);
  const [running, setRunning] = useState(false);
  const [regenDesc, setRegenDesc] = useState(false);
  const [result, setResult] = useState<PrepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyTile, setBusyTile] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/platform/passes/${passIdOrSlug}`);
    if (res.ok) setTree((await res.json()).pass);
  }, [passIdOrSlug]);
  useEffect(() => { load(); }, [load]);

  async function run() {
    if (!tree || running) return;
    setRunning(true); setError(null);
    try {
      const res = await fetch(`/api/platform/passes/${tree.id}/prep`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerateDescriptions: regenDesc }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Prep failed'); return; }
      setResult(data);
    } catch (e) { setError((e as Error).message); } finally { setRunning(false); }
  }

  async function tileAction(tileId: string, body: Record<string, unknown>, patch: (row: PrepRow, title: string) => void) {
    setBusyTile(tileId);
    try {
      const res = await fetch(`/api/platform/tiles/${tileId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.tile) {
        setResult((prev) => prev && { ...prev, report: prev.report.map((r) => r.tileId === tileId ? (patch(r, data.tile.title), { ...r }) : r) });
      } else if (!res.ok) {
        setResult((prev) => prev && { ...prev, report: prev.report.map((r) => r.tileId === tileId ? { ...r, error: data.error ?? 'Action failed' } : r) });
      }
    } finally { setBusyTile(null); }
  }

  const genTitle = (row: PrepRow) => tileAction(row.tileId, { generateTitle: true }, (r, title) => { r.titleAfter = title; r.titleOutcome = 'ai'; r.error = null; });
  const genDesc = (row: PrepRow) => tileAction(row.tileId, { generateDescription: true }, (r) => { r.descriptionOutcome = 'generated'; r.error = null; });

  const slug = tree?.slug ?? passIdOrSlug;

  // Group report rows by category (preserve order).
  const groups: Array<{ category: string; rows: PrepRow[] }> = [];
  for (const row of result?.report ?? []) {
    const g = groups.find((x) => x.category === row.tileCategory);
    if (g) g.rows.push(row); else groups.push({ category: row.tileCategory, rows: [row] });
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 24px 80px' }}>
      <button onClick={() => router.push(`/platform/${slug}`)} style={breadcrumb}>‹ Back to board</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-strong)', margin: 0 }}>
          Pass Prep{tree ? ` — ${tree.title}` : ''}
        </h1>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--muted)' }}>
          <input type="checkbox" checked={regenDesc} onChange={(e) => setRegenDesc(e.target.checked)} /> Regenerate all descriptions
        </label>
        <button onClick={run} disabled={running || !tree} style={{ ...runBtn, opacity: running || !tree ? 0.6 : 1 }}>
          {running ? 'Running…' : 'Run Pass Prep ▸'}
        </button>
      </div>

      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 10 }}>
        {tree?.sheetId
          ? <>Pass map connected: <strong>{tree.sheetTabTitle}</strong>. Titles come from the sheet by code; descriptions are written from each video&apos;s transcript.</>
          : <>No pass map connected — titles will be AI-generated from transcripts. Connect a sheet on the board to use sheet titles.</>}
      </p>

      {error && <div style={banner('var(--warning)')}>{error}</div>}
      {result?.sheetError && <div style={banner('var(--warning)')}>Pass map read failed: {result.sheetError}</div>}
      {result && !result.aiAvailable && <div style={banner('var(--line)')}>No AI provider configured — sheet titles applied, but descriptions/AI titles were skipped.</div>}

      {result && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0 6px' }}>
            <Stat label="Sheet titles" value={result.counts.titlesFromSheet ?? 0} />
            <Stat label="AI titles" value={result.counts.titlesFromAi ?? 0} />
            <Stat label="Descriptions" value={result.counts.descriptionsGenerated ?? 0} />
            <Stat label="No transcript" value={result.counts.noTranscript ?? 0} tone="warn" />
            <Stat label="Wrong category" value={result.counts.category_mismatch ?? 0} tone="warn" />
            <Stat label="No code" value={result.counts.no_code_on_asset ?? 0} />
            <Stat label="Not in sheet" value={result.counts.code_not_in_sheet ?? 0} />
          </div>

          {groups.map((g) => (
            <div key={g.category} style={{ marginTop: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-soft)', marginBottom: 6 }}>{g.category}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {g.rows.map((row) => {
                  const tone = STATE_TONE[row.state];
                  return (
                    <div key={row.tileId} style={rowCard}>
                      <span style={{ ...codePill, opacity: row.code ? 1 : 0.4 }}>{row.code ?? '—'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.titleAfter || <em style={{ color: 'var(--muted-soft)' }}>untitled</em>}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ ...badge, color: tone.fg, borderColor: tone.bd, background: tone.bg }}>{STATE_LABEL[row.state]}</span>
                          <span style={miniTag}>title: {row.titleOutcome}</span>
                          <span style={miniTag}>desc: {row.descriptionOutcome === 'no_transcript' ? 'no transcript' : row.descriptionOutcome}</span>
                          {row.transcript === 'missing' && <span style={{ ...miniTag, color: 'var(--warning)' }}>transcript not ready</span>}
                          {row.error && <span style={{ ...miniTag, color: 'var(--warning)' }}>⚠ {row.error}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button onClick={() => genTitle(row)} disabled={busyTile === row.tileId || row.transcript !== 'ready'} style={smallBtn} title={row.transcript !== 'ready' ? 'Needs a ready transcript' : 'Generate an AI title from the transcript'}>Title AI</button>
                        <button onClick={() => genDesc(row)} disabled={busyTile === row.tileId || row.transcript !== 'ready'} style={smallBtn} title={row.transcript !== 'ready' ? 'Needs a ready transcript' : 'Regenerate the description'}>Desc AI</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--surface-inset)', minWidth: 76 }}>
      <span style={{ fontSize: 19, fontWeight: 700, color: tone === 'warn' && value > 0 ? 'var(--warning)' : 'var(--text-strong)' }}>{value}</span>
      <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted-soft)', fontWeight: 600 }}>{label}</span>
    </div>
  );
}

const banner = (color: string): React.CSSProperties => ({ fontSize: 12.5, color: color === 'var(--warning)' ? 'var(--warning)' : 'var(--muted)', background: 'var(--surface-inset)', border: `1px solid ${color}`, borderRadius: 8, padding: 10, marginTop: 12, lineHeight: 1.45 });
const breadcrumb: React.CSSProperties = { background: 'transparent', border: 0, color: 'var(--muted-soft)', fontSize: 12, fontWeight: 600, padding: '2px 4px', cursor: 'pointer' };
const runBtn: React.CSSProperties = { background: 'var(--accent)', color: '#16130c', border: 0, borderRadius: 9, fontSize: 13.5, fontWeight: 700, padding: '10px 16px', cursor: 'pointer' };
const rowCard: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)' };
const codePill: React.CSSProperties = { flexShrink: 0, width: 40, textAlign: 'center', fontSize: 11.5, fontWeight: 700, fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--accent-strong)', background: 'var(--accent-soft)', border: '1px solid var(--accent-soft)', padding: '3px 4px', borderRadius: 6 };
const badge: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 5, border: '1px solid' };
const miniTag: React.CSSProperties = { fontSize: 10.5, color: 'var(--muted-soft)', fontFamily: 'ui-monospace, Menlo, monospace' };
const smallBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--text)', fontSize: 11.5, fontWeight: 600, padding: '6px 9px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' };
