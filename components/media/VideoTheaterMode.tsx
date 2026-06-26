'use client';

import { useRef, useState } from 'react';
import type { FrameIOComment, FrameIOCommentReply } from '@/lib/services/frameio';
import { MediaPlayer } from './MediaPlayer';

interface Props {
  src:                  string;
  assetId:              string;
  projectId:            string;
  frameioAssetId:       string | null;
  comments:             FrameIOComment[];
  seekTarget?:          number | null;
  onClose:              (currentTime: number) => void;
  onCommentPosted:      (comment: FrameIOComment) => void;
  onCommentCompleted?:  (commentId: string, completed: boolean) => void;
  onReplyPosted?:       (reply: FrameIOCommentReply, parentId: string) => void;
  onSeekHandled?:       () => void;
}

export function VideoTheaterMode({
  src, assetId, projectId, frameioAssetId, comments,
  seekTarget, onClose, onCommentPosted, onCommentCompleted, onReplyPosted, onSeekHandled,
}: Readonly<Props>) {
  const [panelContainer, setPanelContainer] = useState<HTMLDivElement | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const currentTimeRef = useRef(0);

  return (
    <div
      className="vt-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(currentTimeRef.current); }}
    >
      <div className={`vt-layout${panelOpen ? ' vt-layout--panel-open' : ''}`}>
        <MediaPlayer
          variant="theater"
          src={src}
          assetId={assetId}
          projectId={projectId}
          frameioAssetId={frameioAssetId}
          comments={comments}
          seekTarget={seekTarget}
          onSeekHandled={onSeekHandled}
          onClose={onClose}
          onCommentPosted={onCommentPosted}
          onCommentCompleted={onCommentCompleted}
          onReplyPosted={onReplyPosted}
          panelContainer={panelContainer}
          onPanelOpenChange={setPanelOpen}
          onCurrentTimeChange={t => { currentTimeRef.current = t; }}
        />
        {/* Panel slot — lives OUTSIDE mp-root so it doesn't overlay the video */}
        <div
          ref={setPanelContainer}
          className={`vt-panel-slot${panelOpen ? ' vt-panel-slot--open' : ''}`}
        />
      </div>
    </div>
  );
}
