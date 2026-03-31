'use client';

import { useRef, useState, useEffect, type DragEvent, type ChangeEvent } from 'react';
import { usePresentation } from '@/hooks/usePresentation';

export function PresentationPanel() {
  const presentation = usePresentation();
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext !== 'pptx' && ext !== 'pdf') return;
    void presentation.upload(file);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    handleFiles(e.target.files);
    e.target.value = '';
  }

  function toggleFullscreen() {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current.requestFullscreen();
    }
  }

  // ── Upload / converting state ─────────────────────────────────────────────

  if (presentation.uploading) {
    return (
      <div className="pres-panel">
        <div className="pres-converting">
          <svg className="pres-converting-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
          </svg>
          <span className="pres-converting-label">Converting slides…</span>
          <span className="pres-converting-sub">This may take a few seconds</span>
        </div>
      </div>
    );
  }

  if (!presentation.loaded) {
    return (
      <div className="pres-panel">
        <div
          className={`pres-dropzone${isDragging ? ' pres-dropzone--over' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setIsDragging(false)}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".45">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span className="pres-dropzone-title">Drop a .pptx or .pdf file here</span>
          <span className="pres-dropzone-sub">or click to browse — PDF gives best quality</span>
          {presentation.uploadError && (
            <span className="pres-upload-error">{presentation.uploadError}</span>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pptx,.pdf"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>
    );
  }

  // ── Loaded: slide preview + controls ─────────────────────────────────────

  const atFirst = presentation.currentSlide === 0;
  const atLast = presentation.currentSlide >= presentation.totalSlides - 1;

  const prevBtn = (size: number) => (
    <button
      type="button"
      className="pres-ctrl-btn"
      onClick={presentation.prevSlide}
      disabled={atFirst}
      aria-label="Previous slide"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    </button>
  );

  const nextBtn = (size: number) => (
    <button
      type="button"
      className="pres-ctrl-btn"
      onClick={presentation.nextSlide}
      disabled={atLast}
      aria-label="Next slide"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );

  return (
    <div className="pres-panel">
      {/* Slide preview — this is the fullscreen target */}
      <div className="pres-preview-wrap" ref={containerRef}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={presentation.currentSlide}
          className="pres-slide-img"
          src={`/api/presentation/slides/${presentation.currentSlide}`}
          alt={`Slide ${presentation.currentSlide + 1} of ${presentation.totalSlides}`}
        />

        {/* Overlay controls visible only in fullscreen (auto-hide via CSS hover) */}
        {isFullscreen && (
          <div className="pres-fullscreen-overlay">
            <div className="pres-fullscreen-controls">
              {prevBtn(22)}
              <span className="pres-counter">
                {presentation.currentSlide + 1} / {presentation.totalSlides}
              </span>
              {nextBtn(22)}
              <button
                type="button"
                className="pres-ctrl-btn pres-ctrl-btn--fs"
                onClick={toggleFullscreen}
                aria-label="Exit fullscreen"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16v3a2 2 0 002 2h3"/>
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Below-preview controls — hidden when fullscreen via CSS */}
      {!isFullscreen && (
        <div className="pres-controls">
          {prevBtn(15)}
          <span className="pres-counter">
            {presentation.currentSlide + 1} / {presentation.totalSlides}
          </span>
          {nextBtn(15)}

          <span className="pres-ctrl-name" title={presentation.name}>
            {presentation.name}
          </span>

          <button
            type="button"
            className="pres-ctrl-btn pres-ctrl-btn--fs"
            onClick={toggleFullscreen}
            aria-label="Fullscreen"
            title="Fullscreen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
            </svg>
          </button>

          <button
            type="button"
            className="pres-ctrl-btn pres-ctrl-btn--clear"
            onClick={presentation.clear}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
