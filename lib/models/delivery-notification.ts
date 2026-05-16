/**
 * Delivery Notification model
 *
 * Surfaces trouble reports submitted by delivery-link recipients to the user
 * who created the delivery (or to all admins as a fallback when the creator
 * can't be resolved). Mirrors the shape of TaskNotification/ProspectNotification
 * so NotifBell can render it with the same pattern.
 */

export type DeliveryNotifType = 'trouble_reported';

export interface DeliveryNotification {
  notifId:        string;
  userId:         string;
  type:           DeliveryNotifType;
  deliveryToken:  string;
  projectName:    string;
  clientName:     string | null;
  label:          string | null;
  /** Free-text message from the recipient. May be empty if they submitted with no description. */
  description:    string | null;
  /** Short single-line summary of the recipient's queue state, e.g. "5 of 20 complete, 2 failed". */
  queueSummary:   string | null;
  /** Recipient's user-agent header at the time of report — useful diagnostic. */
  userAgent:      string | null;
  /** Optional dashboard URL for clicking through (e.g. /projects/<id>?delivery=<token>). */
  href:           string | null;
  read:           boolean;
  createdAt:      string;
}
