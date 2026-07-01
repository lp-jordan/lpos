'use client';

import { useCallback, useEffect, useState } from 'react';

interface ModelOption {
  value: string;
  label: string;
  installed: boolean;
}

interface TranscriptionConfig {
  model: string;
  workers: number;
  timeoutMinutes: number;
  timeoutLengthAware: boolean;
  modelDir: string;
  options: ModelOption[];
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.45rem 0.6rem',
  borderRadius: 6,
  background: 'var(--color-surface, rgba(0,0,0,0.3))',
  border: '1px solid var(--color-border, rgba(255,255,255,0.12))',
  color: 'var(--color-text, #fff)',
  fontSize: '0.85rem',
};

export function TranscriptionConfigCard() {
  const [config, setConfig] = useState<TranscriptionConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/transcription-config', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load transcription config.');
      const data = await res.json() as { config: TranscriptionConfig };
      setConfig(data.config);
    } catch {
      setError('Could not load transcription config.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function patch<K extends keyof TranscriptionConfig>(key: K, value: TranscriptionConfig[K]) {
    setConfig((prev) => prev ? { ...prev, [key]: value } : prev);
    setSaved(false);
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch('/api/admin/transcription-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          workers: config.workers,
          timeoutMinutes: config.timeoutMinutes,
          timeoutLengthAware: config.timeoutLengthAware,
        }),
      });
      const data = await res.json() as { config?: TranscriptionConfig; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save.');
      if (data.config) setConfig(data.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selectedOption = config?.options.find((o) => o.value === config.model);
  const isBigModel = config ? config.model.startsWith('large') : false;

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Transcription (Whisper)</h2>
        <p className="storage-settings-muted">
          Tune the whisper.cpp model and worker/timeout behavior. Higher-accuracy models
          (large-v3, large-v3-turbo) improve transcript quality for downstream products at
          the cost of runtime. <strong>large-v3-turbo is recommended.</strong>
        </p>
      </div>

      {loading && <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>Loading…</p>}
      {error && (
        <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.75rem', fontSize: '0.85rem' }}>
          {error}
        </p>
      )}

      {!loading && config && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
          {/* Model */}
          <div>
            <label htmlFor="tc-model" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
              Model
            </label>
            <select
              id="tc-model"
              value={config.model}
              onChange={(e) => patch('model', e.target.value)}
              style={inputStyle}
            >
              {config.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}{o.installed ? '' : ' — NOT INSTALLED'}
                </option>
              ))}
            </select>
            {selectedOption && !selectedOption.installed && (
              <p style={{ color: 'var(--color-warning, #e0a800)', marginTop: 6, fontSize: '0.78rem' }}>
                The model file <code>ggml-{config.model}.bin</code> is not present in{' '}
                <code>{config.modelDir}</code>. Download it before selecting this model (see docs/README.md).
              </p>
            )}
          </div>

          {/* Workers */}
          <div>
            <label htmlFor="tc-workers" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
              Concurrent workers
            </label>
            <input
              id="tc-workers"
              type="number"
              min={1}
              max={8}
              value={config.workers}
              onChange={(e) => patch('workers', Number(e.target.value))}
              style={inputStyle}
            />
            {isBigModel && config.workers > 1 && (
              <p style={{ color: 'var(--color-warning, #e0a800)', marginTop: 6, fontSize: '0.78rem' }}>
                For large-v3 / large-v3-turbo, use <strong>1</strong> worker — multiple concurrent
                jobs contend for the single Metal GPU and slow each other down.
              </p>
            )}
          </div>

          {/* Timeout */}
          <div>
            <label htmlFor="tc-timeout" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
              Per-job timeout (minutes)
            </label>
            <input
              id="tc-timeout"
              type="number"
              min={1}
              max={360}
              value={config.timeoutMinutes}
              onChange={(e) => patch('timeoutMinutes', Number(e.target.value))}
              style={inputStyle}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: 8, fontSize: '0.82rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={config.timeoutLengthAware}
                onChange={(e) => patch('timeoutLengthAware', e.target.checked)}
                style={{ accentColor: 'var(--color-primary, #3b82f6)' }}
              />
              Scale timeout with video length (recommended for large models)
            </label>
            <p className="storage-settings-muted" style={{ marginTop: 6, fontSize: '0.78rem' }}>
              When length-aware is on, the value above is a floor and the effective timeout grows
              with the media duration (≈4× real-time + overhead). The old fixed 15-min cap trips
              on 30–45 min+ videos under large-v3.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem' }}>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                padding: '0.4rem 1rem',
                borderRadius: '6px',
                border: '1px solid var(--color-border, #444)',
                background: saved ? 'var(--color-success-bg, #1a3a1a)' : 'var(--color-surface, #333)',
                color: saved ? 'var(--color-success, #4caf50)' : 'var(--color-text, #fff)',
                fontSize: '0.85rem',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.5 : 1,
                fontWeight: 500,
              }}
            >
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted, #888)' }}>
              Applies to newly-enqueued jobs (no restart needed).
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
