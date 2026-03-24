export type ScriptStatus = 'uploaded' | 'processing' | 'ready';
export type ScriptMime =
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/pdf'
  | 'text/plain'
  | 'application/octet-stream';

export interface ScriptAsset {
  scriptId:         string;
  projectId:        string;
  /** Display name — editable */
  name:             string;
  originalFilename: string;
  /** Absolute path to stored file */
  filePath:         string;
  fileSize:         number | null;
  mimeType:         ScriptMime | string;
  status:           ScriptStatus;
  /** True when extracted text has been saved to the .extracted.txt sidecar */
  hasExtractedText: boolean;
  uploadedAt:       string;
  updatedAt:        string;
}
