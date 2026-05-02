export type ProspectNotifType = 'assigned' | 'update_posted' | 'mentioned' | 'status_changed' | 'promoted';

export interface ProspectNotification {
  notifId:     string;
  userId:      string;
  type:        ProspectNotifType;
  prospectId:  string;
  company:     string;
  fromUserId?: string;
  fromName?:   string;
  read:        boolean;
  createdAt:   string;
}
