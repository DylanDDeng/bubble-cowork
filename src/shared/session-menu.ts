/** Serializable presentation only; actions run in the requesting renderer. */
export type SessionMenuAction = 'pin' | 'copy-link' | 'copy-cwd' | 'fork' | 'new-worktree-thread' | 'move-worktree' | 'apply-worktree' | 'discard-worktree' | 'delete' | 'rename' | 'unread' | 'archive' | 'copy-markdown' | 'project-choose' | 'section-none' | 'section-new' | 'fork-local' | 'fork-worktree' | 'open-window' | 'export' | 'share' | `project:${number}` | `section:${number}` | `editor:${number}`;
export type SessionMenuIcon = 'pin' | 'copy' | 'link' | 'folder' | 'fork' | 'worktree' | 'apply' | 'trash' | 'rename' | 'unread' | 'archive' | 'section' | 'share' | 'window';
export type SessionMenuItem =
  | { type: 'separator' }
  | { label: string; icon: SessionMenuIcon; id?: SessionMenuAction; enabled?: boolean; checked?: boolean; submenu?: SessionMenuItem[] };
export type SessionMenuRequest = { items: SessionMenuItem[]; position?: { x: number; y: number } };
