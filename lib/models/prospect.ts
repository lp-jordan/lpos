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
  { value: 'not_started', label: 'Not Started' },
  { value: 'active',      label: 'Active'      },
  { value: 'declined',    label: 'Declined'    },
  { value: 'cancelled',   label: 'Cancelled'   },
] as const;

export const PERSON_SOURCES = [
  { value: 'client',   label: 'Client'   },
  { value: 'referral', label: 'Referral' },
  { value: 'org',      label: 'Org.'     },
  { value: 'other',    label: 'Other'    },
] as const;

/** Prospect-only funnel stages. Free-select (not a strict sequence) — the user
 *  picks whichever stage best describes where the conversation is. Hidden for
 *  active/inactive clients. */
export const PROSPECT_STAGES = [
  { value: 'reached_out',          label: 'Reached Out',                    color: '#94a3b8' },
  { value: 'zoom_meeting_set',     label: 'Zoom Meeting Set',               color: '#5b8dd9' },
  { value: 'post_zoom_email_sent', label: 'Post-Zoom Email Sent',           color: '#7c3aed' },
  { value: 'examples_sent',        label: 'Examples Sent',                  color: '#0ea5e9' },
  { value: 'proposal_sent',        label: 'Proposal Sent',                  color: '#f59e0b' },
  { value: 'blueprint_sow_sent',   label: 'Blueprint SOW & Payment Link Sent', color: '#c9a227' },
  { value: 'contract_sent',        label: 'Contract Sent',                  color: '#10b981' },
] as const;

export type ProspectStage = (typeof PROSPECT_STAGES)[number]['value'];

export const PROSPECT_STAGE_VALUES: readonly string[] = PROSPECT_STAGES.map((s) => s.value);

export const ENTITY_TYPES = [
  { value: 'individual',   label: 'Individual'   },
  { value: 'organization', label: 'Organization' },
] as const;

export type EntityType = 'individual' | 'organization';

export interface Prospect {
  prospectId:  string;
  company:     string;
  website:     string | null;
  industry:    string | null;
  source:      string | null;
  /** Free-text — name of the person who referred this prospect. Editable on
   *  both prospects and active clients. Sits underneath Source in the UI. */
  referredBy:  string | null;
  /** Prospect funnel stage (PROSPECT_STAGES enum value, free-select). Null for
   *  prospects that haven't been classified yet; ignored on active/inactive
   *  clients. */
  prospectStage: string | null;
  entityType:  EntityType;
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

export interface ProspectUpdateAttachment {
  key:  string;
  name: string;
  mime: string;
  size: number;
}

export interface ProspectUpdate {
  updateId:    string;
  prospectId:  string;
  authorId:    string;
  body:        string;
  createdAt:   string;
  editedAt:    string | null;
  attachments: ProspectUpdateAttachment[];
}

export interface ProspectStatusHistory {
  historyId:   string;
  prospectId:  string;
  fromStatus:  ProspectStatus | null;
  toStatus:    ProspectStatus;
  changedBy:   string;
  changedAt:   string;
}
