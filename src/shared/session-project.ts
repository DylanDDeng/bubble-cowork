export type SessionProjectMoveResult =
  | { status: 'moved' | 'unchanged'; projectCwd: string }
  | {
      status: 'needs-confirmation';
      projectCwd: string;
      missingSources: string[];
      approvalToken: string;
    };
