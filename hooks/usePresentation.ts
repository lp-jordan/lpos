'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { PresentationState } from '@/lib/services/presentation-service';

export interface PresentationControls {
  uploading: boolean;
  uploadError: string | null;
  upload: (file: File) => Promise<void>;
  nextSlide: () => void;
  prevSlide: () => void;
  goToSlide: (index: number) => void;
  clear: () => void;
}

const DEFAULT_STATE: PresentationState = {
  loaded: false,
  name: '',
  currentSlide: 0,
  totalSlides: 0,
};

export function usePresentation(): PresentationState & PresentationControls {
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<PresentationState>(DEFAULT_STATE);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const socket = io('/presentation', { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('presentation:state', (s: PresentationState) => setState(s));

    return () => { socket.disconnect(); };
  }, []);

  function nextSlide() {
    if (!state.loaded || state.currentSlide >= state.totalSlides - 1) return;
    socketRef.current?.emit('presentation:slideChange', { index: state.currentSlide + 1 });
  }

  function prevSlide() {
    if (!state.loaded || state.currentSlide <= 0) return;
    socketRef.current?.emit('presentation:slideChange', { index: state.currentSlide - 1 });
  }

  function goToSlide(index: number) {
    if (!state.loaded || index < 0 || index >= state.totalSlides) return;
    socketRef.current?.emit('presentation:slideChange', { index });
  }

  function clear() {
    socketRef.current?.emit('presentation:clear');
  }

  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/presentation/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return {
    ...state,
    uploading,
    uploadError,
    upload,
    nextSlide,
    prevSlide,
    goToSlide,
    clear,
  };
}
