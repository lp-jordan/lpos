'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CatchupPayload, CatchupRow, CatchupSectionKey } from '@/lib/models/catchup';

// Per-user "already read today" marker. Stores the local calendar date the user
// last opened the catch-up; when it matches today, the launcher collapses to a
// thin glowing line. Naturally resets at local midnight (new date → no match →
// full pill returns for the new day's recap).
const READ_KEY = 'lpos-catchup-read';

function todayKey(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function CatchupRowItem({ row, onNavigate }: { row: CatchupRow; onNavigate: (href: string) => void }) {
  return (
    <button
      type="button"
      className={`catchup-row${row.href ? ' catchup-row--clickable' : ''}`}
      onClick={() => row.href && onNavigate(row.href)}
      disabled={!row.href}
    >
      <span className="catchup-row-main">
        <span className="catchup-row-title">{row.title}</span>
        {row.project && <span className="catchup-row-project">{row.project}</span>}
      </span>
      <span className="catchup-row-meta">
        <span className={`catchup-badge catchup-badge--${row.badge.tone}`}>{row.badge.label}</span>
        <span className="catchup-row-time">{formatTime(row.time)}</span>
      </span>
    </button>
  );
}

export function CatchupLauncher() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CatchupPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [collapsed, setCollapsed] = useState<Partial<Record<CatchupSectionKey, boolean>>>({});
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [read, setRead] = useState(false); // true once opened today → collapse to a thin line
  const router = useRouter();

  useEffect(() => {
    try {
      setRead(localStorage.getItem(READ_KEY) === todayKey());
    } catch {
      // localStorage unavailable — stay expanded.
    }
  }, []);

  function markRead() {
    try {
      localStorage.setItem(READ_KEY, todayKey());
    } catch {
      // ignore
    }
    setRead(true);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/catchup');
      if (!res.ok) throw new Error('bad status');
      setData((await res.json()) as CatchupPayload);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  function openDrawer() {
    setOpen(true);
    markRead();
    if (!data && !loading) load();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function navigate(href: string) {
    router.push(href);
    setOpen(false);
  }

  const sections = data?.sections ?? [];
  const visibleSections = failuresOnly
    ? sections
        .map((s) => ({ ...s, items: s.items.filter((r) => r.badge.tone === 'failed') }))
        .filter((s) => s.items.length > 0)
    : sections;

  return (
    <>
      {read ? (
        <button
          type="button"
          className="catchup-line"
          onClick={openDrawer}
          aria-label="Open Daily Catch-Up"
          title="Daily Catch-Up"
        />
      ) : (
        <button type="button" className="catchup-pill" onClick={openDrawer}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>Daily Catch-Up</span>
          <svg className="catchup-pill-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {open && (
        <div className="catchup-overlay" onClick={() => setOpen(false)}>
          <aside
            className="catchup-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Daily Catch-Up"
          >
            <div className="catchup-head">
              <div className="catchup-head-top">
                <span className="catchup-head-title">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  Daily Catch-Up
                </span>
                <button type="button" className="catchup-close" onClick={() => setOpen(false)} aria-label="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {data && <div className="catchup-date">{data.label}</div>}
              {data?.headline && <p className="catchup-headline">{data.headline}</p>}

              {data && (
                <div className="catchup-totals">
                  <button
                    type="button"
                    className={`catchup-total catchup-total--fail${failuresOnly ? ' catchup-total--active' : ''}`}
                    onClick={() => setFailuresOnly((v) => !v)}
                    aria-pressed={failuresOnly}
                    disabled={data.totals.failures === 0}
                  >
                    {data.totals.failures} failures
                  </button>
                  <span className="catchup-total-sep">·</span>
                  <span className="catchup-total catchup-total--comment">{data.totals.comments} comments</span>
                  <span className="catchup-total-sep">·</span>
                  <span className="catchup-total">{data.totals.updates} updates</span>
                </div>
              )}
            </div>

            <div className="catchup-body">
              {loading && <div className="catchup-state">Loading yesterday…</div>}
              {error && !loading && (
                <div className="catchup-state">
                  Couldn&rsquo;t load the catch-up.{' '}
                  <button type="button" className="catchup-retry" onClick={load}>Retry</button>
                </div>
              )}
              {!loading && !error && data && visibleSections.length === 0 && (
                <div className="catchup-state">
                  {failuresOnly ? 'No failures yesterday.' : 'Nothing moved yesterday — you’re all caught up.'}
                </div>
              )}

              {!loading && !error && visibleSections.map((section) => {
                const isCollapsed = collapsed[section.key] ?? false;
                return (
                  <div key={section.key} className="catchup-section">
                    <button
                      type="button"
                      className="catchup-section-head"
                      onClick={() => setCollapsed((c) => ({ ...c, [section.key]: !isCollapsed }))}
                      aria-expanded={!isCollapsed}
                    >
                      <span className="catchup-section-label">{section.label}</span>
                      <span className="catchup-section-count">{section.count}</span>
                      <svg
                        className={`catchup-section-chevron${isCollapsed ? '' : ' catchup-section-chevron--open'}`}
                        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    {!isCollapsed && (
                      <div className="catchup-section-list">
                        {section.items.map((row) => (
                          <CatchupRowItem key={row.id} row={row} onNavigate={navigate} />
                        ))}
                        {section.hasMore && !failuresOnly && (
                          <div className="catchup-section-more">
                            +{section.count - section.items.length} more
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="catchup-foot">
              <button
                type="button"
                className="catchup-viewall"
                onClick={() => {
                  router.push('/dashboard');
                  setOpen(false);
                }}
              >
                View all activity
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
