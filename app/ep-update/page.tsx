/**
 * /ep-update
 *
 * Download page for EditPanel.
 * editpanel users are sent here to grab the latest Windows build.
 */

import { getEpReleaseService } from '@/lib/services/container';

export default function EpUpdatePage() {
  const svc    = getEpReleaseService();
  const status = svc?.getStatus() ?? null;
  const ready  = !!status?.version && !!status?.installerFilename;

  return (
    <div className="ep-update-page">
      <div className="ep-update-card">
        <p className="ep-update-kicker">EditPanel</p>
        <h1 className="ep-update-title">
          {ready ? `Version ${status!.version} available` : 'No release available'}
        </h1>

        {ready ? (
          <>
            <p className="ep-update-instructions">
              Download the installer and run <strong>{status!.installerFilename}</strong>, then follow
              the prompts. EditPanel needs <strong>Python 3</strong> installed on your machine to run
              its helper processes — install Python before first launch.
            </p>
            <a
              className="ep-update-download-btn"
              href={`/api/ep-updates/${status!.installerFilename}`}
              download
            >
              Download EditPanel {status!.version}
            </a>
            {status!.lastUpdated && (
              <p className="ep-update-meta">
                Released {new Date(status!.lastUpdated).toLocaleDateString()}
              </p>
            )}
          </>
        ) : (
          <p className="ep-update-instructions">
            No EditPanel release has been published to this server yet.
          </p>
        )}
      </div>

      <style>{`
        .ep-update-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0a0e14;
          font-family: system-ui, sans-serif;
        }
        .ep-update-card {
          background: #111720;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          padding: 3rem;
          max-width: 480px;
          width: 100%;
          text-align: center;
        }
        .ep-update-kicker {
          font-size: 0.78rem;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #6b7a99;
          margin: 0 0 0.75rem;
        }
        .ep-update-title {
          font-size: 1.7rem;
          font-weight: 700;
          color: #e8edf5;
          margin: 0 0 1.25rem;
          line-height: 1.2;
        }
        .ep-update-instructions {
          color: #8a94a8;
          font-size: 0.95rem;
          line-height: 1.6;
          margin: 0 0 2rem;
        }
        .ep-update-instructions strong { color: #c4cad6; }
        .ep-update-download-btn {
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
        .ep-update-download-btn:hover { background: #4a7ee8; }
        .ep-update-meta {
          margin: 1.25rem 0 0;
          font-size: 0.8rem;
          color: #4a5368;
        }
      `}</style>
    </div>
  );
}
