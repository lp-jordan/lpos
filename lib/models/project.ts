export type ProjectPhase = 'pre_production' | 'production' | 'post_production';

export type ProjectSubPhase =
  | 'discovery'   // pre_production
  | 'blueprint'   // pre_production
  | 'recording'   // production
  | 'editing'     // post_production
  | 'pass'        // post_production
  | 'workbooks';  // post_production

/** Maps every sub-phase to its parent phase (used for validation). */
export const SUBPHASE_PHASE_MAP: Record<ProjectSubPhase, ProjectPhase> = {
  discovery: 'pre_production',
  blueprint: 'pre_production',
  recording: 'production',
  editing: 'post_production',
  pass: 'post_production',
  workbooks: 'post_production',
};

/** Ordered sequence of sub-phases for sequential advancement. */
export const SUBPHASE_ORDER: ProjectSubPhase[] = [
  'discovery',
  'blueprint',
  'recording',
  'editing',
  'pass',
  'workbooks',
];

export interface CloudflareProjectDefaults {
  /** Frame number to use as the Cloudflare Stream thumbnail (default: 24). */
  thumbnailFrameNumber: number;
}

export interface Project {
  projectId:           string;
  name:                string;
  clientName:          string;
  phase:               ProjectPhase;
  subPhase:            ProjectSubPhase;
  createdAt:           string;
  updatedAt:           string;
  archived?:           boolean;
  assetLinkGroupId?:   string;
  assetMergeLocked?:   boolean;
  cloudflareDefaults?: CloudflareProjectDefaults;
}
