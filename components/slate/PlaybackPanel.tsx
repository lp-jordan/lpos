'use client';

import { useEffect, useState } from 'react';
import type { PlaybackConnectionState } from '@/lib/services/atem-utils';

const PLAYER_MAX_HEIGHT = 420;
const DEFAULT_PLAYER_ASPECT_RATIO = 16 / 9;

interface Props {
  connection: PlaybackConnectionState | null;
}

function formatLastChecked(value: string | null): string {
  if (!value) return 'Waiting for first poll';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Waiting for first poll';
  return `Last checked ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

export function PlaybackPanel({ connection }: Readonly<Props>) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedSessionPath, setSelectedSessionPath] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [activeClipPath, setActiveClipPath] = useState<string | null>(null);
  const [preparedClipPaths, setPreparedClipPaths] = useState<string[]>([]);
  const [loadingClipPath, setLoadingClipPath] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [videoAspectRatio, setVideoAspectRatio] = useState<number>(DEFAULT_PLAYER_ASPECT_RATIO);
  const connected = connection?.connected ?? false;
  const host = connection?.host?.trim() || 'No ATEM IP configured';
  const detail = connected
    ? `FTP reachable at ${host}:${connection?.port ?? 21}`
    : connection?.lastError || 'FTP not connected';
  const sessions = connection?.sessions ?? [];
  const selectedSession = sessions.find((session) => session.path === selectedSessionPath) ?? null;
  const clips = selectedSession?.clips ?? [];
  const playerWrapStyle = {
    aspectRatio: String(videoAspectRatio),
    width: `min(100%, ${Math.round(PLAYER_MAX_HEIGHT * videoAspectRatio)}px)`,
  };

  useEffect(() => {
    if (!selectedSessionPath) return;
    if (sessions.length === 0) return;
    if (sessions.some((session) => session.path === selectedSessionPath)) return;
    setSelectedSessionPath(null);
  }, [selectedSessionPath, sessions]);

  async function handleClipSelect(remotePath: string) {
    if (!connection?.host) return;
    setLoadingClipPath(remotePath);
    setPlaybackError(null);

    try {
      const response = await fetch('/api/slate/playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: connection.host, remotePath }),
      });

      const payload = await response.json() as { error?: string; playbackUrl?: string };
      if (!response.ok || !payload.playbackUrl) {
        throw new Error(payload.error || 'Failed to prepare playback file');
      }

      setPlaybackUrl(payload.playbackUrl);
      setActiveClipPath(remotePath);
      setPreparedClipPaths((current) => (
        current.includes(remotePath) ? current : [...current, remotePath]
      ));
      setVideoAspectRatio((current) => current || DEFAULT_PLAYER_ASPECT_RATIO);
    } catch (err) {
      setPlaybackError((err as Error).message);
    } finally {
      setLoadingClipPath(null);
    }
  }

  return (
    <div className="sl-playback-panel">
      <div className="sl-playback-header">
        <div>
          <span className="sl-playback-title">Playback</span>
        </div>
        <span className={`sl-playback-badge${connected ? '' : ' sl-playback-badge--off'}`}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {(playbackUrl || playbackError || loadingClipPath) && (
        <div className="sl-playback-player-card">
          {loadingClipPath && (
            <div className="sl-playback-player-status">
              Preparing {pathLeaf(loadingClipPath)} for playback...
            </div>
          )}
          {playbackUrl ? (
            <div
              className="sl-playback-player-wrap"
              style={playerWrapStyle}
            >
              <video
                key={playbackUrl}
                className="sl-playback-player"
                controls
                preload="metadata"
                src={playbackUrl}
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  if (video.videoWidth > 0 && video.videoHeight > 0) {
                    setVideoAspectRatio(video.videoWidth / video.videoHeight);
                  }
                }}
              />
            </div>
          ) : playbackError ? (
            <div className="sl-playback-empty">{playbackError}</div>
          ) : (
            <div className="sl-playback-empty">Preparing playback...</div>
          )}
          {activeClipPath && (
            <div className="sl-playback-player-meta">
              {pathLeaf(activeClipPath)}
            </div>
          )}
        </div>
      )}

      <div className="sl-playback-card">
        <div className="sl-playback-list-header">
          <span className="sl-playback-label">
            {selectedSession ? 'Video ISO Files' : 'Session Folders'}
          </span>
          <span className="sl-playback-count">
            {selectedSession
              ? `${clips.length} item${clips.length === 1 ? '' : 's'}`
              : `${sessions.length} item${sessions.length === 1 ? '' : 's'}`}
          </span>
        </div>

        {connected && !selectedSession && sessions.length > 0 ? (
          <div className="sl-playback-list">
            {sessions.map((session) => (
              <button
                key={session.path}
                className="sl-playback-session"
                type="button"
                onClick={() => setSelectedSessionPath(session.path)}
              >
                <span className="sl-playback-session-name">{session.name}</span>
                <span className="sl-playback-session-meta">{session.clips.length} clip{session.clips.length === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        ) : connected && selectedSession ? (
          <div className="sl-playback-list">
            <div className="sl-playback-crumb-row">
              <button
                className="sl-playback-back"
                type="button"
                onClick={() => setSelectedSessionPath(null)}
              >
                Back
              </button>
              <span className="sl-playback-session-name">{selectedSession.name}</span>
            </div>

            {clips.length > 0 ? (
              clips.map((file) => (
                <div
                  key={file.path}
                  className={`sl-playback-file${activeClipPath === file.path ? ' sl-playback-file--active' : ''}`}
                >
                  <button
                    className="sl-playback-file-main"
                    type="button"
                    onClick={() => handleClipSelect(file.path)}
                    disabled={loadingClipPath === file.path}
                  >
                    <div className="sl-playback-file-copy">
                      <span className="sl-playback-file-name">{file.name}</span>
                      {loadingClipPath === file.path && (
                        <span className="sl-playback-file-status">Preparing playback...</span>
                      )}
                    </div>
                  </button>
                  {preparedClipPaths.includes(file.path) && (
                    <button
                      className={`sl-playback-ready${activeClipPath === file.path ? ' sl-playback-ready--active' : ''}`}
                      type="button"
                      onClick={() => handleClipSelect(file.path)}
                      aria-label={`Play ${file.name}`}
                      title="Ready for playback"
                    >
                      <span className="sl-playback-ready-icon" aria-hidden="true">▶</span>
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="sl-playback-empty">
                No matching `CAM 1 XX.mp4` clips were found in this session&apos;s `Video ISO Files` folder.
              </div>
            )}
          </div>
        ) : (
          <div className="sl-playback-empty">
            {connected ? 'Connected, but no session folders with `Video ISO Files` were found yet.' : detail}
          </div>
        )}
      </div>

      <div className="sl-playback-advanced-wrap">
        <button
          className="sl-playback-advanced-toggle"
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          Advanced
        </button>

        {advancedOpen && (
          <div className="sl-playback-advanced">
            <div className="sl-playback-row">
              <span className="sl-playback-label">Host</span>
              <span className="sl-playback-value">{host}</span>
            </div>
            <div className="sl-playback-row">
              <span className="sl-playback-label">FTP Status</span>
              <span className="sl-playback-value">{detail}</span>
            </div>
            <div className="sl-playback-row">
              <span className="sl-playback-label">Poll</span>
              <span className="sl-playback-value">{formatLastChecked(connection?.lastCheckedAt ?? null)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function pathLeaf(value: string): string {
  const parts = value.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}
