/**
 * Where a wish originated:
 *   'dashboard' — submitted from the LPOS shell Wish List (the default).
 *   'editpanel' — submitted by an editor from the EditPanel app via /api/ep/wishes.
 * The dashboard Wish List badges editpanel-sourced rows so the origin is visible.
 */
export type WishSource = 'dashboard' | 'editpanel';

export interface WishItem {
  wishId: string;
  title: string;
  description?: string;
  submittedBy: string;      // userId
  submittedByName: string;  // display name at submission time
  completed: boolean;
  createdAt: string;        // ISO string
  completedAt?: string;     // ISO string
  source: WishSource;       // origin surface — defaults to 'dashboard'
  sourceInstance?: string;  // machine/display name for editpanel submissions
}
