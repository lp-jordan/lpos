export interface TranscriptEntry {
  jobId: string;
  filename: string;
  completedAt: string;
  txtSize: number;
  files: { txt: boolean; json: boolean; srt: boolean; vtt: boolean };
}

export interface TranscriptSearchSource {
  jobId: string;
  filename: string;
  excerpt: string;
  isDirectQuote?: boolean;
}

export interface TranscriptSearchScope {
  jobIds: string[];
  transcriptCount: number;
}

export interface TranscriptSearchMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  sources?: TranscriptSearchSource[];
  usage?: {
    selectedChunkCount: number;
    selectedTranscriptCount: number;
  };
  pending?: boolean;
  searchMode?: 'local' | 'ai';
}

export interface TranscriptSearchResponse {
  answer: string;
  sources: TranscriptSearchSource[];
  scope: TranscriptSearchScope;
  threadSummary?: string;
  clarifyQuestion?: string;
  searchMode?: 'local' | 'ai';
  usage?: {
    selectedChunkCount: number;
    selectedTranscriptCount: number;
  };
}

export interface TranscriptChatThread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  scope: {
    mode: 'selected' | 'all';
    jobIds: string[];
  };
  threadSummary: string;
  messages: TranscriptSearchMessage[];
}

export interface TranscriptChatThreadSummary {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  scope: {
    mode: 'selected' | 'all';
    jobIds: string[];
  };
  messageCount: number;
}
