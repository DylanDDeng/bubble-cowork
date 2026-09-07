/** Serializable presentation only; actions run in the requesting renderer. */
export type SessionMenuAction = 'pin' | 'copy-link' | 'copy-cwd' | 'fork' | 'new-worktree-thread' | 'move-worktree' | 'apply-worktree' | 'discard-worktree' | 'delete';
export type SessionMenuIcon = 'pin' | 'copy' | 'link' | 'folder' | 'fork' | 'worktree' | 'apply' | 'trash';
export type SessionMenuItem =
  | { type: 'separator' }
  | { label: string; icon: SessionMenuIcon; id?: SessionMenuAction; enabled?: boolean; submenu?: SessionMenuItem[] };
export type SessionMenuRequest = { items: SessionMenuItem[]; position?: { x: number; y: number } };
