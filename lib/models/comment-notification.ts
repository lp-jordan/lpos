// Notifications for activity on media-asset (Frame.io) comments.
// Currently the only event is a reply landing on a comment the recipient
// authored from within LPOS. External Frame.io reviewers have no LPOS user
// to target, so they never receive these (see comment-notification-service).

export type CommentNotifType = 'reply';

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
  snippet?:    string;   // short preview of the reply text
  read:        boolean;
  createdAt:   string;
}
