export type ProspectNotifType = 'assigned' | 'update_posted' | 'mentioned' | 'status_changed' | 'promoted' | 'reacted';

export interface ProspectNotification {
  notifId:     string;
  userId:      string;
  type:        ProspectNotifType;
  prospectId:  string;
  company:     string;
  fromUserId?: string;
  fromName?:   string;
  /** Set only when type='reacted' — the emoji that was added. */
  emoji?:      string;
  read:        boolean;
  createdAt:   string;
}
