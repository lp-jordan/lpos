'use client';

import { useState } from 'react';

interface DeliveryTokenUsage {
  token:        string;
  bytes:        number;
  objects:      number;
  costUsd:      number;
  projectName?: string | null;
  clientName?:  string | null;
  label?:       string | null;
  projectId?:   string | null;
}

interface DeliveryProjectUsage {
  projectName: string;
  clientName:  string | null;
  projectId:   string | null;
  bytes:       number;
  objects:     number;
  linkCount:   number;
  costUsd:     number;
}

interface DeliveryStorageFootprint {
  totalBytes:      number;
  totalObjects:    number;
  tokenCount:      number;
  tokens:          DeliveryTokenUsage[];
  tokensTruncated: boolean;
  projects:        DeliveryProjectUsage[];
  costUsd:         number;
  costRateUsdPerGbMonth: number;
  enriched:        boolean;
  unmatchedTokens: number;
  unmatchedBytes:  number;
  scannedAt:       string;
}

function bytesToHuman(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function usd(value: number): string {
  if (!value) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Live delivery-link storage footprint. Delivery links copy asset bytes into
 * Cloudflare R2 (`delivery/{token}/...`) and LPOS keeps no local tally, so this
 * asks R2 directly on demand — total usage, estimated monthly cost, the owning
 * project per link (joined from the ingest link list), and the heaviest links.
 */
export function DeliveryStorageSection() {
  const [footprint, setFootprint] = useState<DeliveryStorageFootprint | null>(null);
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res  = await fetch('/api/admin/delivery-storage');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      setFootprint(data.footprint as DeliveryStorageFootprint);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="storage-settings-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="storage-settings-section-title">Delivery link storage</h2>
          <p className="storage-settings-muted" style={{ maxWidth: 620 }}>
            Live footprint of delivery-link media in Cloudflare R2 (<code>delivery/&#123;token&#125;/…</code>).
            Each link freezes a copy of the asset&rsquo;s bytes here until it expires or is revoked.
            LPOS keeps no local tally, so this walks the bucket on demand and joins each link to its
            project via the ingest server.
          </p>
        </div>
        <button
          type="button"
          className="storage-settings-secondary"
          onClick={() => void check()}
          disabled={busy}
          title="Scan every object under the delivery/ prefix (can take a moment with many links)"
        >
          {busy ? 'Scanning…' : footprint ? 'Refresh' : 'Check delivery storage'}
        </button>
      </div>

      {error && (
        <p className="storage-settings-muted" style={{ color: '#ffb4ab', marginTop: 8, fontSize: '0.85em' }}>
          {error}
        </p>
      )}

      {footprint && (
        <div style={{ marginTop: 12 }}>
          <div className="cold-storage-stats" style={{ marginTop: 0 }}>
            <div>
              <span className="cold-storage-stat-label">Total in R2</span>
              <strong>{bytesToHuman(footprint.totalBytes)}</strong>
              <span className="storage-settings-muted">live delivery media</span>
            </div>
            <div>
              <span className="cold-storage-stat-label">Est. cost / month</span>
              <strong>{usd(footprint.costUsd)}</strong>
              <span className="storage-settings-muted">
                @ ${footprint.costRateUsdPerGbMonth}/GB·mo · egress free
              </span>
            </div>
            <div>
              <span className="cold-storage-stat-label">Delivery links</span>
              <strong>{footprint.tokenCount.toLocaleString()}</strong>
              <span className="storage-settings-muted">with bytes in R2</span>
            </div>
            <div>
              <span className="cold-storage-stat-label">Objects</span>
              <strong>{footprint.totalObjects.toLocaleString()}</strong>
              <span className="storage-settings-muted">files (incl. proxies, thumbs, VTT)</span>
            </div>
          </div>

          {!footprint.enriched && (
            <p className="storage-settings-muted" style={{ color: '#ffcf8a', marginTop: 10, fontSize: '0.82em' }}>
              Couldn&rsquo;t reach the ingest server, so links aren&rsquo;t matched to projects this scan.
              Totals and cost above are still accurate. Try Refresh.
            </p>
          )}

          {footprint.enriched && footprint.unmatchedTokens > 0 && (
            <p className="storage-settings-muted" style={{ marginTop: 10, fontSize: '0.82em' }}>
              {footprint.unmatchedTokens.toLocaleString()} link{footprint.unmatchedTokens === 1 ? '' : 's'}
              {' '}({bytesToHuman(footprint.unmatchedBytes)}, {usd(footprint.unmatchedBytes / 1e9 * footprint.costRateUsdPerGbMonth)}/mo)
              {' '}have bytes in R2 but no live ingest record — revoked or orphaned, pending the hourly cleanup sweep.
            </p>
          )}

          {/* By project — the rollup over the full bucket */}
          {footprint.enriched && footprint.projects.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 className="storage-settings-section-title" style={{ fontSize: '1em', marginBottom: 6 }}>
                By project
              </h3>
              <div style={{ overflowX: 'auto' }}>
                <table className="storage-settings-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em' }}>
                  <thead>
                    <tr style={{ textAlign: 'left' }}>
                      <th style={{ padding: '4px 8px' }}>Project</th>
                      <th style={{ padding: '4px 8px' }}>Client</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Links</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Size</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Est. $/mo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {footprint.projects.map((p) => (
                      <tr key={p.projectName} style={{ borderTop: '1px solid var(--border, #333)' }}>
                        <td style={{ padding: '4px 8px' }}>
                          {p.projectId ? (
                            <a href={`/projects/${p.projectId}`} style={{ color: 'var(--accent-strong, #8ab4ff)' }}>
                              {p.projectName}
                            </a>
                          ) : p.projectName}
                        </td>
                        <td style={{ padding: '4px 8px' }} className="storage-settings-muted">{p.clientName ?? '—'}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>{p.linkCount.toLocaleString()}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>{bytesToHuman(p.bytes)}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>{usd(p.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Largest individual links */}
          {footprint.tokens.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 className="storage-settings-section-title" style={{ fontSize: '1em', marginBottom: 6 }}>
                Largest links
                {footprint.tokensTruncated && (
                  <span className="storage-settings-muted" style={{ fontWeight: 400, fontSize: '0.8em' }}>
                    {' '}— top {footprint.tokens.length} of {footprint.tokenCount.toLocaleString()}
                  </span>
                )}
              </h3>
              <div style={{ overflowX: 'auto' }}>
                <table className="storage-settings-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em' }}>
                  <thead>
                    <tr style={{ textAlign: 'left' }}>
                      <th style={{ padding: '4px 8px' }}>Project / link</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Size</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Files</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Est. $/mo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {footprint.tokens.map((t) => (
                      <tr key={t.token} style={{ borderTop: '1px solid var(--border, #333)' }}>
                        <td style={{ padding: '4px 8px' }}>
                          <div>
                            {t.projectId ? (
                              <a href={`/projects/${t.projectId}`} style={{ color: 'var(--accent-strong, #8ab4ff)' }}>
                                {t.projectName}
                              </a>
                            ) : (t.projectName ?? <span className="storage-settings-muted">unmatched</span>)}
                            {t.clientName ? <span className="storage-settings-muted"> · {t.clientName}</span> : null}
                          </div>
                          <div className="storage-settings-muted" style={{ fontSize: '0.85em' }}>
                            {t.label ? `${t.label} · ` : ''}<span style={{ fontFamily: 'monospace' }}>{t.token}</span>
                          </div>
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>{bytesToHuman(t.bytes)}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>{t.objects.toLocaleString()}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>{usd(t.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="storage-settings-muted" style={{ fontSize: '0.82em', marginTop: 10 }}>
            Scanned {relativeTime(footprint.scannedAt)}. Cost is an estimate at Cloudflare&rsquo;s
            ${footprint.costRateUsdPerGbMonth}/GB-month storage rate (R2 egress is free); actual billing may
            differ slightly. Projects are joined from the ingest link list.
          </p>
        </div>
      )}
    </div>
  );
}
