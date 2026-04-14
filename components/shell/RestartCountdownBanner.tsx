'use client';

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export function RestartCountdownBanner() {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const socket = io('/', { transports: ['websocket'] });

    socket.on('server:restart-countdown', ({ secondsLeft: s }: { secondsLeft: number }) => {
      setSecondsLeft(s);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  if (secondsLeft === null) return null;

  return (
    <div className="restart-banner" role="alert" aria-live="assertive">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
        className="restart-banner-icon"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>
        LPOS is restarting in{' '}
        <strong className="restart-banner-countdown">{secondsLeft}s</strong>
        {' '}—{' '}
        <span className="restart-banner-tail-wrap">
          {/* anchor sizing to the longer phrase so the banner width stays stable */}
          <span aria-hidden="true" style={{ visibility: 'hidden' }}>
            please <strong>Refresh</strong> when the countdown reaches 0.
          </span>
          <span className={`restart-banner-tail restart-banner-tail--overlay${secondsLeft <= 5 ? ' restart-banner-tail--hidden' : ''}`}>
            run for your lives!
          </span>
          <span className={`restart-banner-tail restart-banner-tail--overlay${secondsLeft <= 5 ? '' : ' restart-banner-tail--hidden'}`}>
            please <strong>Refresh</strong> when the countdown reaches 0.
          </span>
        </span>
      </span>
    </div>
  );
}
