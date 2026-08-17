'use client';

/**
 * TranscriptEditor
 *
 * Per-asset caption editing. Edits are text-only — every cue's timing is fixed
 * and shown read-only, because the whole design rests on the segment timings
 * never moving (see lib/transcripts/edit-store.ts). Saving writes the transcript
 * files and replaces that language's Cloudflare caption track in one action, so
 * the operator sees a real result instead of a background attempt.
 *
 * English and Spanish are index-aligned by construction, so they render as one
 * row per cue. Editing an English row flags its Spanish twin rather than
 * retranslating it — hand-corrected Spanish is never silently overwritten.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineVideoPlayer } from '@/components/media/InlineVideoPlayer';
import type { TranscriptCue } from '@/lib/transcripts/edit-store';
import type { TranscriptEditorPayload } from '@/lib/transcripts/editor-payload';

type Lang = 'en' | 'es';

type LangDoc = NonNullable<TranscriptEditorPayload['en']>;

interface Props {
  projectId: string;
  initial: TranscriptEditorPayload;
}

interface PushResult {
  status: 'pushed' | 'skipped' | 'failed';
  error?: string;
}

function displayTimecode(raw: string): string {
  return raw.replace(',', '.');
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TranscriptEditor({ projectId, initial }: Readonly<Props>) {
  const [docs, setDocs] = useState<{ en: LangDoc | null; es: LangDoc | null }>({ en: initial.en, es: initial.es });
  const [flags, setFlags] = useState<Set<number>>(new Set(initial.englishChangedIndices));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [resetToken, setResetToken] = useState(0);

  const [busy, setBusy] = useState<null | 'saving' | 'translating' | 'resyncing'>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad' | 'plain'; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);

  const [currentTime, setCurrentTime] = useState(0);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [overlayTrack, setOverlayTrack] = useState<Lang>('en');

  const rowsRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const streamSrc = `/api/projects/${projectId}/media/${initial.assetId}/frameio-stream`;

  const hasEs = docs.es !== null;
  const rowCount = docs.en?.cues.length ?? docs.es?.cues.length ?? 0;

  // ── Draft bookkeeping ──────────────────────────────────────────────────────

  const draftKey = (lang: Lang, index: number) => `${lang}:${index}`;

  const baselineText = useCallback((lang: Lang, index: number): string => {
    return docs[lang]?.cues[index]?.text ?? '';
  }, [docs]);

  const isDirty = useCallback((lang: Lang, index: number): boolean => {
    const key = draftKey(lang, index);
    return key in drafts && drafts[key] !== baselineText(lang, index);
  }, [drafts, baselineText]);

  const dirtyEdits = useCallback((lang: Lang) => {
    const out: Array<{ index: number; text: string }> = [];
    for (const [key, text] of Object.entries(drafts)) {
      const [keyLang, rawIndex] = key.split(':');
      if (keyLang !== lang) continue;
      const index = Number(rawIndex);
      if (text !== baselineText(lang, index)) out.push({ index, text });
    }
    return out;
  }, [drafts, baselineText]);

  const dirtyCount = useMemo(
    () => dirtyEdits('en').length + dirtyEdits('es').length,
    [dirtyEdits],
  );

  function handleCellInput(lang: Lang, index: number, text: string) {
    setDrafts((prev) => ({ ...prev, [draftKey(lang, index)]: text }));
    setMessage(null);
  }

  /** English edits put the Spanish twin in question — flag, never overwrite. */
  const effectiveFlags = useMemo(() => {
    const next = new Set(flags);
    for (const edit of dirtyEdits('en')) next.add(edit.index);
    return next;
  }, [flags, dirtyEdits]);

  // ── Playback ───────────────────────────────────────────────────────────────

  const activeIndex = useMemo(() => {
    const cues = docs.en?.cues ?? docs.es?.cues ?? [];
    const ms = currentTime * 1000;
    return cues.findIndex((cue) => ms >= cue.fromMs && ms < cue.toMs);
  }, [currentTime, docs]);

  // Keep the playing cue in view, but never yank the page while someone types.
  useEffect(() => {
    if (activeIndex < 0 || !followRef.current) return;
    rowsRef.current?.querySelector(`[data-row="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex]);

  const seekTo = useCallback((seconds: number) => {
    setSeekTarget(Math.max(0, seconds));
  }, []);

  const overlayText = useMemo(() => {
    if (activeIndex < 0) return '';
    const key = draftKey(overlayTrack, activeIndex);
    if (key in drafts) return drafts[key];
    return baselineText(overlayTrack, activeIndex);
  }, [activeIndex, overlayTrack, drafts, baselineText]);

  // ── Saving ─────────────────────────────────────────────────────────────────

  const applyResponse = useCallback((lang: Lang, data: {
    revision: number;
    cues: TranscriptCue[];
    englishChangedIndices?: number[];
  }) => {
    setDocs((prev) => {
      const doc = prev[lang];
      if (!doc) return prev;
      return { ...prev, [lang]: { ...doc, revision: data.revision, cues: data.cues } };
    });
    if (Array.isArray(data.englishChangedIndices)) setFlags(new Set(data.englishChangedIndices));
    setDrafts((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) if (key.startsWith(`${lang}:`)) delete next[key];
      return next;
    });
    setResetToken((n) => n + 1);
  }, []);

  function describePush(lang: Lang, push: PushResult, note: string | null): { tone: 'ok' | 'bad' | 'plain'; text: string } {
    const label = lang === 'en' ? 'English' : 'Español';
    if (push.status === 'pushed') return { tone: 'ok', text: `${label} saved · caption track replaced on Cloudflare` };
    if (push.status === 'failed') return { tone: 'bad', text: `${label} saved to disk, but Cloudflare rejected the captions: ${push.error ?? 'unknown error'}` };
    return { tone: 'plain', text: `${label} saved. ${note ?? 'Captions stay on disk for now.'}` };
  }

  const save = useCallback(async () => {
    if (busy) return;
    const langs: Lang[] = (['en', 'es'] as Lang[]).filter((lang) => dirtyEdits(lang).length > 0);
    if (langs.length === 0) return;

    setBusy('saving');
    setConflict(false);
    setMessage({ tone: 'plain', text: 'Saving transcript and pushing captions to Cloudflare…' });

    const outcomes: Array<{ tone: 'ok' | 'bad' | 'plain'; text: string }> = [];

    for (const lang of langs) {
      const doc = docs[lang];
      if (!doc) continue;
      try {
        const res = await fetch(`/api/projects/${projectId}/media/${initial.assetId}/transcript`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang, edits: dirtyEdits(lang), baseRevision: doc.revision }),
        });
        const data = await res.json();

        if (res.status === 409) {
          setConflict(true);
          outcomes.push({ tone: 'bad', text: data.error ?? 'Someone else saved this transcript while you were editing.' });
          continue;
        }
        if (!res.ok) {
          outcomes.push({ tone: 'bad', text: data.error ?? `Save failed (${res.status})` });
          continue;
        }

        applyResponse(lang, data);
        outcomes.push(describePush(lang, data.cloudflare as PushResult, data.cloudflareMessage));
      } catch {
        outcomes.push({ tone: 'bad', text: `Network error while saving ${lang === 'en' ? 'English' : 'Español'}` });
      }
    }

    setBusy(null);
    const worst = outcomes.find((o) => o.tone === 'bad') ?? outcomes.find((o) => o.tone === 'plain') ?? outcomes[0];
    setMessage(worst ? { tone: worst.tone, text: outcomes.map((o) => o.text).join(' · ') } : null);
  }, [busy, dirtyEdits, docs, projectId, initial.assetId, applyResponse]);

  function discard() {
    setDrafts({});
    setResetToken((n) => n + 1);
    setMessage({ tone: 'plain', text: 'Edits discarded' });
  }

  // ── Re-translate the flagged Spanish rows ──────────────────────────────────

  const retranslate = useCallback(async () => {
    if (busy || flags.size === 0) return;
    if (dirtyEdits('en').length > 0) {
      setMessage({ tone: 'bad', text: 'Save your English edits first — re-translation reads the saved English text.' });
      return;
    }

    setBusy('translating');
    setMessage({ tone: 'plain', text: `Re-translating ${flags.size} Spanish ${flags.size === 1 ? 'line' : 'lines'}…` });

    try {
      const res = await fetch(`/api/projects/${projectId}/media/${initial.assetId}/transcript/retranslate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indices: [...flags] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ tone: 'bad', text: data.error ?? `Re-translation failed (${res.status})` });
      } else {
        applyResponse('es', data);
        const push = data.cloudflare as PushResult;
        setMessage(describePush('es', push, data.cloudflareMessage));
      }
    } catch {
      setMessage({ tone: 'bad', text: 'Network error during re-translation' });
    }
    setBusy(null);
  }, [busy, flags, dirtyEdits, projectId, initial.assetId, applyResponse]);

  // ── Retry a failed caption push ────────────────────────────────────────────

  const resync = useCallback(async (lang: Lang) => {
    if (busy) return;
    setBusy('resyncing');
    setMessage({ tone: 'plain', text: 'Re-sending captions to Cloudflare…' });
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${initial.assetId}/transcript/resync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang }),
      });
      const data = await res.json();
      setMessage(res.ok
        ? describePush(lang, data.cloudflare as PushResult, data.cloudflareMessage)
        : { tone: 'bad', text: data.error ?? `Re-sync failed (${res.status})` });
      if (res.ok && data.cloudflare?.status === 'pushed') {
        setDocs((prev) => {
          const doc = prev[lang];
          if (!doc) return prev;
          return { ...prev, [lang]: { ...doc, captions: { ...doc.captions, syncedAt: data.cloudflare.syncedAt, error: null } } };
        });
      }
    } catch {
      setMessage({ tone: 'bad', text: 'Network error during re-sync' });
    }
    setBusy(null);
  }, [busy, projectId, initial.assetId]);

  // ── ⌘S ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [save]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const cfReady = initial.cloudflare.status === 'ready' && Boolean(initial.cloudflare.uid);
  const pushError = docs.en?.captions.error ?? docs.es?.captions.error ?? null;
  const lastSynced = docs.en?.captions.syncedAt ?? docs.es?.captions.syncedAt ?? null;

  return (
    <div className="te-page">

      <header className="te-topbar">
        <div>
          {/* No breadcrumb here — AppShell already renders one from the URL
              (Projects → Client → Project → Transcripts). */}
          <h1 className="te-title">Edit transcript</h1>
          <p className="te-subtitle">{initial.assetName}</p>
        </div>

        <div className="te-status-stack">
          <span className="te-chip">
            <i className={`te-dot ${cfReady ? 'te-dot--ok' : 'te-dot--idle'}`} />
            {cfReady ? 'Cloudflare · ready' : 'Not on Cloudflare'}
          </span>
          <span className="te-chip">
            <i className={`te-dot ${dirtyCount > 0 || pushError ? 'te-dot--warn' : 'te-dot--ok'}`} />
            {dirtyCount > 0
              ? 'Captions out of date on Cloudflare'
              : pushError
                ? 'Last caption push failed'
                : `Captions synced · ${relativeTime(lastSynced)}`}
          </span>
          {pushError && (
            <button type="button" className="te-btn te-btn--ghost te-btn--tiny" onClick={() => void resync('en')} disabled={busy !== null}>
              Retry caption push
            </button>
          )}
        </div>
      </header>

      <div className="te-stage">
        <section className="te-player" aria-label="Player">
          {/* The same player the rest of LPOS uses — keeps AUTO/HD, mute and the
              scrub behaviour consistent instead of inventing a second transport. */}
          <InlineVideoPlayer
            src={streamSrc}
            assetId={initial.assetId}
            seekTarget={seekTarget}
            onSeekHandled={() => setSeekTarget(null)}
            onTimeUpdate={setCurrentTime}
            autoPlayOnSeek={false}
            overlay={overlayText ? (
              <div className="te-caption-layer"><span>{overlayText}</span></div>
            ) : null}
          />

          {hasEs && (
            <div className="te-track-toggle">
              <span className="te-track-label">Caption preview</span>
              <div className="te-seg" role="group" aria-label="Caption track shown on the player">
                {(['en', 'es'] as Lang[]).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    aria-pressed={overlayTrack === lang}
                    onClick={() => setOverlayTrack(lang)}
                  >
                    {lang === 'en' ? 'English' : 'Español'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      <div className={`te-grid-head ${hasEs ? '' : 'te-grid-head--solo'}`}>
        <div>Timecode</div>
        <div>English</div>
        {hasEs && (
          <div className="te-col-es">
            <span>Español</span>
            {effectiveFlags.size > 0 && (
              <button
                type="button"
                className="te-retranslate"
                onClick={() => void retranslate()}
                disabled={busy !== null}
              >
                Re-translate {effectiveFlags.size} flagged
              </button>
            )}
          </div>
        )}
      </div>

      <div className={`te-rows ${hasEs ? '' : 'te-rows--solo'}`} ref={rowsRef}>
        {Array.from({ length: rowCount }, (_, index) => {
          const enCue = docs.en?.cues[index];
          const esCue = docs.es?.cues[index];
          const timing = enCue ?? esCue;
          if (!timing) return null;

          return (
            <div
              key={index}
              data-row={index}
              className={`te-row ${index === activeIndex ? 'is-active' : ''}`}
            >
              <button
                type="button"
                className="te-tc"
                onClick={() => seekTo(timing.fromMs / 1000)}
                aria-label={`Jump to ${displayTimecode(timing.from)}`}
              >
                {displayTimecode(timing.from)}
              </button>

              <Cell
                key={`en-${index}-${resetToken}`}
                lang="en"
                index={index}
                text={baselineText('en', index)}
                present={Boolean(enCue)}
                dirty={isDirty('en', index)}
                flagged={false}
                timecode={displayTimecode(timing.from)}
                onInput={handleCellInput}
                onFocus={() => { followRef.current = false; seekTo(timing.fromMs / 1000); }}
                onBlur={() => { followRef.current = true; }}
              />

              {hasEs && (
                <Cell
                  key={`es-${index}-${resetToken}`}
                  lang="es"
                  index={index}
                  text={baselineText('es', index)}
                  present={Boolean(esCue)}
                  dirty={isDirty('es', index)}
                  flagged={effectiveFlags.has(index) && !isDirty('es', index)}
                  timecode={displayTimecode(timing.from)}
                  onInput={handleCellInput}
                  onFocus={() => { followRef.current = false; seekTo(timing.fromMs / 1000); }}
                  onBlur={() => { followRef.current = true; }}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="te-savebar" role="status">
        <span className={`te-savebar-msg te-tone-${message?.tone ?? 'plain'}`}>
          {message?.text ?? (dirtyCount > 0
            ? `${dirtyCount} unsaved ${dirtyCount === 1 ? 'edit' : 'edits'}`
            : 'No unsaved edits')}
        </span>

        {conflict && (
          <button type="button" className="te-btn te-btn--ghost" onClick={() => window.location.reload()}>
            Reload
          </button>
        )}
        <button type="button" className="te-btn te-btn--ghost" onClick={discard} disabled={dirtyCount === 0 || busy !== null}>
          Discard
        </button>
        <button type="button" className="te-btn te-btn--primary" onClick={() => void save()} disabled={dirtyCount === 0 || busy !== null}>
          {busy === 'saving' ? 'Saving…' : 'Save & push captions'}
          <span className="te-kbd">⌘S</span>
        </button>
      </div>
    </div>
  );
}

// ── Editable cue cell ─────────────────────────────────────────────────────────

interface CellProps {
  lang: Lang;
  index: number;
  text: string;
  present: boolean;
  dirty: boolean;
  flagged: boolean;
  timecode: string;
  onInput: (lang: Lang, index: number, text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * Uncontrolled on purpose: React must not re-render the text of a contentEditable
 * the user is typing into (it collapses the caret). The parent forces a reset by
 * changing the cell's `key` after a save or re-translation.
 */
function Cell({ lang, index, text, present, dirty, flagged, timecode, onInput, onFocus, onBlur }: Readonly<CellProps>) {
  if (!present) return <div className="te-cell te-cell--absent" aria-hidden="true" />;

  return (
    <div className={`te-cell ${dirty ? 'is-dirty' : ''} ${flagged ? 'is-flagged' : ''}`}>
      <div
        className="te-cell-text"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={`${lang === 'en' ? 'English' : 'Spanish'} caption at ${timecode}`}
        onInput={(event) => onInput(lang, index, event.currentTarget.textContent ?? '')}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {text}
      </div>
      {dirty && <span className="te-marker te-marker--dirty"><i />Edited</span>}
      {flagged && !dirty && <span className="te-marker te-marker--flag"><i />English changed</span>}
    </div>
  );
}
