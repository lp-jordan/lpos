export interface WishItem {
  wishId: string;
  title: string;
  description?: string;
  submittedBy: string;      // userId
  submittedByName: string;  // display name at submission time
  completed: boolean;
  createdAt: string;        // ISO string
  completedAt?: string;     // ISO string
}
