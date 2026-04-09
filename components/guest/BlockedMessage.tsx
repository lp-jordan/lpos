'use client';

import { useEffect } from 'react';

export function BlockedMessage() {
  useEffect(() => {
    // Strip ?blocked=1 from the URL after the message has rendered
    const url = new URL(window.location.href);
    url.searchParams.delete('blocked');
    window.history.replaceState({}, '', url.toString());
  }, []);

  return (
    <p style={{
      fontSize: '0.8rem',
      color: 'var(--color-text-muted, #888)',
      margin: '-0.5rem 0 1rem',
      textAlign: 'center',
    }}>
      That area is off limits for guest access.
    </p>
  );
}
