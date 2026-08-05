'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PassTree } from '@/lib/store/platform-pass-store';

export function HandoffDoc({ passIdOrSlug }: { passIdOrSlug: string }) {
  const router = useRouter();
  const [tree, setTree] = useState<PassTree | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/platform/passes/${passIdOrSlug}`);
    if (res.ok) setTree((await res.json()).pass);
  }, [passIdOrSlug]);
  useEffect(() => { load(); }, [load]);

  const flash = (key: string) => { setCopied(key); window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200); };
  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); flash(key); }
    catch { /* clipboard blocked — selection fallback below */ }
  }

  if (!tree) return <div style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>;

  const plainDoc = buildPlainDoc(tree);
  const totalTiles = tree.categories.reduce((n, c) => n + c.tiles.length, 0);

  function download() {
    const blob = new Blob([plainDoc], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${tree!.slug || 'pass'}-handoff.md`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '18px 24px 90px' }}>
      <button onClick={() => router.push(`/platform/${tree.slug}`)} style={breadcrumb}>‹ Back to board</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-strong)', margin: 0 }}>{tree.title} — handoff</h1>
        <div style={{ flex: 1 }} />
        <button onClick={() => copy(plainDoc, '__all__')} style={primaryBtn}>{copied === '__all__' ? 'Copied ✓' : 'Copy all'}</button>
        <button onClick={download} style={ghostBtn}>Download .md</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
        {totalTiles} tiles across {tree.categories.length} categories. Copy each field into the matching field in LeaderPass admin — or copy the whole document.
      </p>

      {tree.categories.map((cat) => (
        <section key={cat.id} style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-strong)', margin: '0 0 10px', paddingBottom: 6, borderBottom: '1px solid var(--line)' }}>{cat.title}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {cat.tiles.map((t) => (
              <div key={t.id} style={card}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  {t.sourceCode && <span style={codePill}>{t.sourceCode}</span>}
                  <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: 'var(--text-strong)', lineHeight: 1.25 }}>{t.title || <em style={{ color: 'var(--muted-soft)' }}>untitled</em>}</div>
                  <button onClick={() => copy(t.title, `t-${t.id}`)} style={copyBtn}>{copied === `t-${t.id}` ? 'Copied ✓' : 'Copy title'}</button>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start' }}>
                  <p style={{ flex: 1, margin: 0, fontSize: 13.5, color: t.description ? 'var(--text)' : 'var(--muted-soft)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                    {t.description || <em>no description yet</em>}
                  </p>
                  {t.description && <button onClick={() => copy(t.description, `d-${t.id}`)} style={copyBtn}>{copied === `d-${t.id}` ? 'Copied ✓' : 'Copy desc'}</button>}
                </div>
              </div>
            ))}
            {cat.tiles.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted-soft)', margin: 0 }}>No tiles.</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function buildPlainDoc(tree: PassTree): string {
  const lines: string[] = [`# ${tree.title}`, ''];
  for (const cat of tree.categories) {
    lines.push(`## ${cat.title}`, '');
    for (const t of cat.tiles) {
      lines.push(t.sourceCode ? `[${t.sourceCode}] ${t.title}` : t.title);
      if (t.description) lines.push(t.description);
      lines.push('');
    }
  }
  return lines.join('\n').trim() + '\n';
}

const breadcrumb: React.CSSProperties = { background: 'transparent', border: 0, color: 'var(--muted-soft)', fontSize: 12, fontWeight: 600, padding: '2px 4px', cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { background: 'var(--accent)', color: '#16130c', border: 0, borderRadius: 8, fontSize: 13, fontWeight: 700, padding: '8px 14px', cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-raised)', color: 'var(--text)', fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 8, cursor: 'pointer' };
const card: React.CSSProperties = { padding: '12px 14px', borderRadius: 11, border: '1px solid var(--line)', background: 'var(--surface)' };
const codePill: React.CSSProperties = { flexShrink: 0, fontSize: 11, fontWeight: 700, fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--accent-strong)', background: 'var(--accent-soft)', border: '1px solid var(--accent-soft)', padding: '1px 6px', borderRadius: 5 };
const copyBtn: React.CSSProperties = { flexShrink: 0, border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--muted)', fontSize: 11, fontWeight: 600, padding: '4px 9px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' };
