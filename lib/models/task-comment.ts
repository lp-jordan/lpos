export interface TaskCommentAttachment {
  key:  string;
  name: string;
  mime: string;
  size: number;
}

/**
 * Discriminator for the comment row:
 *   - 'comment'      : ordinary update written by a user (the original kind).
 *   - 'handoff'      : auto-written when someone hits the Handoff button; the
 *                      companion task_handoffs row is the monitor's state.
 *   - 'handoff_ack'  : auto-written when a target assignee acknowledges the
 *                      handoff. Resets the stale clock but does NOT complete
 *                      the handoff — only real activity does.
 *   - 'review_ack'   : auto-written when an assignee acknowledges a Review
 *                      check-in ("still on it"). Resets the check-in clock; the
 *                      task stays in Review. Companion to task_review_checkins.
 */
export type TaskCommentKind = 'comment' | 'handoff' | 'handoff_ack' | 'review_ack';

/** Structured payload on `metadata` when kind='handoff'. */
export interface HandoffCommentMetadata {
  handoffId:           string;
  fromUserId:          string;
  toUserIds:           string[];
  priorAssigneeIds:    string[];
}

/** Structured payload on `metadata` when kind='handoff_ack'. */
export interface HandoffAckCommentMetadata {
  handoffId: string;
}

export interface TaskComment {
  commentId:   string;
  taskId:      string;
  body:        string;
  authorId:    string;
  mentions:    string[];  // userId[] resolved from @firstName tokens
  createdAt:   string;
  editedAt?:   string;
  attachments: TaskCommentAttachment[];
  kind:        TaskCommentKind;
  /** Parsed metadata payload; shape depends on `kind`. */
  metadata?:   HandoffCommentMetadata | HandoffAckCommentMetadata | Record<string, unknown>;
}
