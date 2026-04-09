'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function GuestPinPage() {
  const [digits, setDigits]   = useState(['', '', '', '']);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];
  const router = useRouter();

  async function submit(pin: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        router.push('/guest');
      } else {
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Incorrect PIN.');
        setDigits(['', '', '', '']);
        inputs[0].current?.focus();
      }
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);
    setError(null);

    if (digit && index < 3) {
      inputs[index + 1].current?.focus();
    }

    if (digit && index === 3) {
      const pin = [...next.slice(0, 3), digit].join('');
      if (pin.length === 4) submit(pin);
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputs[index - 1].current?.focus();
    }
  }

  return (
    <div className="signin-shell">
      <div className="signin-card">
        <div className="signin-kicker">Guest Access</div>
        <h1 className="signin-title">LPOS</h1>
        <p className="signin-copy">Enter today's access PIN</p>

        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', margin: '1.5rem 0 1rem' }}>
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={inputs[i]}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              autoFocus={i === 0}
              disabled={loading}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              style={{
                width: '3rem',
                height: '3.5rem',
                fontSize: '1.5rem',
                textAlign: 'center',
                borderRadius: '8px',
                border: `1.5px solid ${error ? 'var(--color-error, #e55)' : 'var(--color-border, #444)'}`,
                background: 'var(--color-input-bg, #1a1a1a)',
                color: 'inherit',
                outline: 'none',
                caretColor: 'transparent',
              }}
            />
          ))}
        </div>

        {error && (
          <p style={{ color: 'var(--color-error, #e55)', fontSize: '0.8rem', textAlign: 'center', margin: '0 0 0.75rem' }}>
            {error}
          </p>
        )}

        {loading && (
          <p style={{ color: 'var(--color-text-muted, #888)', fontSize: '0.8rem', textAlign: 'center' }}>
            Verifying…
          </p>
        )}

        <a
          href="/signin"
          style={{ display: 'block', textAlign: 'center', fontSize: '0.8rem', color: 'var(--color-text-muted, #888)', marginTop: '1rem' }}
        >
          ← Back to sign in
        </a>
      </div>
    </div>
  );
}
