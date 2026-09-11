export interface SessionOrganization {
  archived: boolean;
  unread: boolean;
  sectionId: string | null;
}

export interface SessionSection {
  id: string;
  name: string;
}

export interface SessionOrganizationSnapshot {
  sessions: Record<string, SessionOrganization>;
  sections: SessionSection[];
  projectSources: Record<string, string[]>;
}

export type SessionOrganizationChange =
  | { kind: 'archive'; sessionId: string; archived: boolean }
  | { kind: 'unread'; sessionId: string; unread: boolean }
  | { kind: 'section'; sessionId: string; sectionId: string | null }
  | { kind: 'create-section'; sessionId: string; name: string }
  | { kind: 'rename-section'; sectionId: string; name: string }
  | { kind: 'remove-section'; sectionId: string };
