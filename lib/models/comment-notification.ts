// Notifications for activity on media-asset comments.
//   reply          — a reply landed on a comment the recipient authored in LPOS
//                    (see comment-notification-service).
//   share_activity — a client is commenting on a share in LP Share. One rolling
//                    item per review session, updated in place (see
//                    share-notifications.ts); sent to every LPOS user.

export type CommentNotifType = 'reply' | 'share_activity';

export interface CommentNotification {
  notifId:     string;
  userId:      string;   // recipient — the original (LPOS) commenter
  type:        CommentNotifType;
  projectId:   string;
  assetId:     string;
  assetName:   string;   // snapshot for display
  commentId:   string;   // the parent comment that was replied to
  fromUserId?: string;   // who posted the reply
  fromName?:   string;   // reply author's display name
  snippet?:    string;   // short preview of the reply text (share_activity: the latest comment)
  read:        boolean;
  createdAt:   string;   // share_activity: time of the latest comment in the session
  // share_activity only
  shareId?:      string;
  shareToken?:   string;
  shareName?:    string;
  commentCount?: number;
  assetCount?:   number;
}
