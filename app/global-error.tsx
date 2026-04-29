'use client';

import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    if (error?.message?.includes('ChunkLoadError') || error?.name === 'ChunkLoadError') {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
        <h2>Something went wrong</h2>
        <p>An unexpected error occurred. Please refresh the page.</p>
      </body>
    </html>
  );
}
