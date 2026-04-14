/**
 * /lp-update
 *
 * Download page for LeaderPrompt updates.
 * LP clients are sent here when a new version is available.
 */

import { getLpReleaseService } from '@/lib/services/container';

export default function LpUpdatePage() {
  const svc    = getLpReleaseService();
  const status = svc?.getStatus() ?? null;
  const ready  = !!status?.version && !!status?.dmgFilename;

  return (
    <div className="lp-update-page">
      <div className="lp-update-card">
        <p className="lp-update-kicker">LeaderPrompt</p>
        <h1 className="lp-update-title">
          {ready ? `Version ${status!.version} available` : 'No release available'}
        </h1>

        {ready ? (
          <>
            <p className="lp-update-instructions">
              Download the installer, open the <strong>.dmg</strong>, and drag
              LeaderPrompt to your Applications folder. Then relaunch the app.
            </p>
            <a
              className="lp-update-download-btn"
              href={`/api/lp-updates/${status!.dmgFilename}`}
              download
            >
              Download LeaderPrompt {status!.version}
            </a>
            {status!.lastUpdated && (
              <p className="lp-update-meta">
                Released {new Date(status!.lastUpdated).toLocaleDateString()}
              </p>
            )}
          </>
        ) : (
          <p className="lp-update-instructions">
            No LeaderPrompt release has been published to this server yet.
          </p>
        )}
      </div>

      <style>{`
        .lp-update-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0a0e14;
          font-family: system-ui, sans-serif;
        }
        .lp-update-card {
          background: #111720;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          padding: 3rem;
          max-width: 480px;
          width: 100%;
          text-align: center;
        }
        .lp-update-kicker {
          font-size: 0.78rem;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #6b7a99;
          margin: 0 0 0.75rem;
        }
        .lp-update-title {
          font-size: 1.7rem;
          font-weight: 700;
          color: #e8edf5;
          margin: 0 0 1.25rem;
          line-height: 1.2;
        }
        .lp-update-instructions {
          color: #8a94a8;
          font-size: 0.95rem;
          line-height: 1.6;
          margin: 0 0 2rem;
        }
        .lp-update-instructions strong { color: #c4cad6; }
        .lp-update-download-btn {
          display: inline-block;
          background: #3b6fd4;
          color: #fff;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.85rem 2rem;
          border-radius: 10px;
          text-decoration: none;
          transition: background 0.15s;
        }
        .lp-update-download-btn:hover { background: #4a7ee8; }
        .lp-update-meta {
          margin: 1.25rem 0 0;
          font-size: 0.8rem;
          color: #4a5368;
        }
      `}</style>
    </div>
  );
}
