export type ProspectStatus = 'prospect' | 'active' | 'inactive';

export const PROSPECT_STATUSES: ProspectStatus[] = ['prospect', 'active', 'inactive'];

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  prospect: 'Prospect',
  active:   'Active',
  inactive: 'Inactive',
};

export const ACCOUNT_MODELS = [
  { value: 'blueprint_only',  label: 'Blueprint Only'       },
  { value: 'platform_only',   label: 'Platform Only'        },
  { value: 'studio_only',     label: 'Studio Only'          },
  { value: 'build_platform',  label: 'Build + Platform'     },
  { value: 'studio_platform', label: 'Studio + Platform'    },
  { value: 'full_ecosystem',  label: 'Full Ecosystem'       },
  { value: 'enterprise_org',  label: 'Enterprise / Org Rollout' },
] as const;

export const REVENUE_TYPES = [
  { value: 'one_time',   label: 'One-Time'  },
  { value: 'recurring',  label: 'Recurring' },
  { value: 'hybrid',     label: 'Hybrid'    },
] as const;

export const EXPANSION_POTENTIALS = [
  { value: 'low',    label: 'Low'    },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High'   },
] as const;

export const BILLING_STATUSES = [
  { value: 'active',   label: 'Active'   },
  { value: 'declined', label: 'Declined' },
] as const;

export const PERSON_SOURCES = [
  { value: 'client',   label: 'Client'   },
  { value: 'referral', label: 'Referral' },
  { value: 'org',      label: 'Org.'     },
  { value: 'other',    label: 'Other'    },
] as const;

export interface Prospect {
  prospectId:  string;
  company:     string;
  website:     string | null;
  industry:    string | null;
  source:      string | null;
  status:      ProspectStatus;
  archived:    boolean;
  createdBy:   string;
  createdAt:   string;
  updatedAt:   string;
  promotedAt:  string | null;
  clientName:  string | null;
  assignedTo:  string[];

  // Pre-close fields
  accountModel:            string | null;
  revenueType:             string | null;
  oneTimeLpRevenue:        number | null;
  monthlyLpRevenue:        number | null;
  monthlyLpTechRevenue:    number | null;
  estimatedFirstYearValue: number | null;
  expectedStartMonth:      string | null;
  expansionPotential:      string | null;

  // Post-close fields
  owner:                  string | null;
  startMonth:             string | null;
  recurringBillingStatus: string | null;
  renewalDate:            string | null;
  firstRecurringBillDate: string | null;
  activeServices:         string | null;
  nextFilmDate:           string | null;
}

export interface ProspectContact {
  contactId:   string;
  prospectId:  string;
  name:        string;
  role:        string | null;
  email:       string | null;
  phone:       string | null;
  linkedin:    string | null;
  createdAt:   string;
}

export interface ProspectUpdate {
  updateId:    string;
  prospectId:  string;
  authorId:    string;
  body:        string;
  createdAt:   string;
  editedAt:    string | null;
}

export interface ProspectStatusHistory {
  historyId:   string;
  prospectId:  string;
  fromStatus:  ProspectStatus | null;
  toStatus:    ProspectStatus;
  changedBy:   string;
  changedAt:   string;
}
