export type ProjectInstructionSource = 'global' | 'project';

export interface ProjectInstructionDocument {
  source: ProjectInstructionSource;
  path: string;
  scopePath: string;
  depth: number;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface ProjectInstructionOmission {
  path: string;
  reason: 'budget' | 'empty' | 'outside_scope' | 'unreadable' | 'binary';
  detail?: string;
}

export interface ProjectInstructionSnapshot {
  documents: ProjectInstructionDocument[];
  omissions: ProjectInstructionOmission[];
  prompt: string;
  truncated: boolean;
}

export interface ProjectInstructionRenderLimits {
  maxFileChars: number;
  maxTotalChars: number;
  maxDocuments: number;
}
