'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

interface SummaryRow { key: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }
interface RecentRow {
  occurredAt: string; feature: string; model: string;
  inputTokens: number; outputTokens: number; costUsd: number;
  projectId: string | null; assetId: string | null;
}
interface Report {
  range: string;
  since: string;
  until: string;
  totals: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  byFeature: SummaryRow[];
  byModel: SummaryRow[];
  recent: RecentRow[];
}

const RANGES: Array<{ id: string; label: string }> = [
  { id: 'mtd', label: 'This month' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

const FEATURE_LABELS: Record<string, string> = {
  spanish_translation: 'Spanish translation',
  cami_search: 'Cami search',
  transcript_search: 'Transcript search',
  daily_catchup: 'Daily Catch-Up',
  pass_prep: 'Pass Prep',
  whats_new: "What's New",
};

function featureLabel(key: string): string {
  return FEATURE_LABELS[key] ?? key;
}

function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00';
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

const cellStyle: CSSProperties = { padding: '4px 10px', textAlign: 'left', whiteSpace: 'nowrap' };
const numCellStyle: CSSProperties = { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export function AiUsageCard() {
  const [range, setRange] = useState('mtd');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (r: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/llm-usage?range=${r}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setReport(await res.json() as Report);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range); }, [range, load]);

  return (
    <div className="storage-settings-card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div className="storage-settings-section-title">AI Usage &amp; Cost</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              style={{
                padding: '3px 10px',
                borderRadius: 6,
                border: '1px solid var(--line, #333)',
                background: range === r.id ? 'var(--accent-2, #b8860b)' : 'transparent',
                color: range === r.id ? '#fff' : 'inherit',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {r.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load(range)}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--line, #333)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
          >
            Refresh
          </button>
        </div>
      </div>

      <p className="storage-settings-muted" style={{ marginTop: 4 }}>
        Exact token usage and cost from every Claude call in LPOS. Token counts come from each API response;
        cost is those tokens × the model&apos;s price at call time.
      </p>

      {loading && <p className="storage-settings-muted">Loading…</p>}
      {error && <p style={{ color: 'var(--danger, #e5484d)' }}>{error}</p>}

      {report && !loading && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '12px 0' }}>
            <Stat label="Total cost" value={fmtCost(report.totals.costUsd)} big />
            <Stat label="Calls" value={fmtInt(report.totals.calls)} />
            <Stat label="Input tokens" value={fmtInt(report.totals.inputTokens)} />
            <Stat label="Output tokens" value={fmtInt(report.totals.outputTokens)} />
          </div>

          <UsageTable title="By feature" rows={report.byFeature} labelFn={featureLabel} />
          <UsageTable title="By model" rows={report.byModel} labelFn={(k) => k} />

          {report.recent.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="storage-settings-section-title" style={{ fontSize: 13 }}>Recent calls</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr style={{ opacity: 0.7 }}>
                      <th style={cellStyle}>When</th>
                      <th style={cellStyle}>Feature</th>
                      <th style={cellStyle}>Model</th>
                      <th style={numCellStyle}>In</th>
                      <th style={numCellStyle}>Out</th>
                      <th style={numCellStyle}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recent.map((row, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--line, #2a2a2a)' }}>
                        <td style={cellStyle}>{new Date(row.occurredAt).toLocaleString()}</td>
                        <td style={cellStyle}>{featureLabel(row.feature)}</td>
                        <td style={cellStyle}>{row.model}</td>
                        <td style={numCellStyle}>{fmtInt(row.inputTokens)}</td>
                        <td style={numCellStyle}>{fmtInt(row.outputTokens)}</td>
                        <td style={numCellStyle}>{fmtCost(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {report.totals.calls === 0 && (
            <p className="storage-settings-muted">No Claude usage recorded in this range yet.</p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className="storage-settings-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function UsageTable({ title, rows, labelFn }: { title: string; rows: SummaryRow[]; labelFn: (k: string) => string }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="storage-settings-section-title" style={{ fontSize: 13 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ opacity: 0.7 }}>
              <th style={cellStyle}>{title.replace('By ', '')}</th>
              <th style={numCellStyle}>Calls</th>
              <th style={numCellStyle}>Input</th>
              <th style={numCellStyle}>Output</th>
              <th style={numCellStyle}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={{ borderTop: '1px solid var(--line, #2a2a2a)' }}>
                <td style={cellStyle}>{labelFn(row.key)}</td>
                <td style={numCellStyle}>{fmtInt(row.calls)}</td>
                <td style={numCellStyle}>{fmtInt(row.inputTokens)}</td>
                <td style={numCellStyle}>{fmtInt(row.outputTokens)}</td>
                <td style={numCellStyle}>{fmtCost(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
