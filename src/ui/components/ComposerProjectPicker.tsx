import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui-components/react/popover';
import { Command } from 'cmdk';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { Check, Folder, Plus, Search } from './icons';

export function ComposerProjectPicker({ cwd, onSelect, disabled = false, variant = 'control', projectName: label }: {
  cwd: string;
  onSelect: (cwd: string) => void;
  disabled?: boolean;
  variant?: 'hero' | 'control';
  projectName?: string;
}) {
  const sessions = useAppStore((state) => state.sessions);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    window.electron.getRecentCwds(50).then((dirs) => {
      if (active) setRecentCwds(dirs);
    }).catch(() => { /* Session projects remain available offline. */ });
    return () => { active = false; };
  }, [open]);

  const projects = useMemo(() => Array.from(new Set([
    cwd,
    ...Object.values(sessions)
      .filter((session) => !session.hiddenFromThreads && session.scope !== 'dm')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => session.projectCwd || session.cwd || ''),
    ...recentCwds,
  ].map((dir) => dir.trim()).filter(Boolean))), [cwd, sessions, recentCwds]);
  const filteredProjects = projects.filter((dir) => dir.toLowerCase().includes(query.trim().toLowerCase()));
  const projectName = label || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

  const selectProject = (dir: string) => {
    setOpen(false);
    if (!disabled && dir !== cwd) onSelect(dir);
  };
  const browse = async () => {
    setOpen(false);
    try {
      const dir = await window.electron.selectDirectory();
      if (dir) selectProject(dir);
    } catch {
      toast.error('Could not open the project folder.');
    }
  };

  return (
    <>
      <Popover.Root open={open && !disabled} onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setQuery('');
      }}>
        <Popover.Trigger
          disabled={disabled}
          aria-label={variant === 'hero' ? `Switch project: ${projectName}` : 'Project folder'}
          title={cwd || 'Choose project'}
          className={variant === 'hero' ? 'aegis-new-thread-project-link' : 'aegis-composer-context-pill aegis-composer-project-control'}
        >
          {variant === 'hero' ? `${projectName}?` : <>
            <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{projectName || 'Choose project'}</span>
          </>}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={8} className="z-[9999]">
            <Popover.Popup initialFocus={searchRef} aria-label="Switch project" className="popover-surface aegis-composer-project-menu w-[320px] max-w-[calc(100vw-32px)] p-1.5 text-left font-normal tracking-normal">
              <Command shouldFilter={false} label="Projects">
                <div className="flex items-center gap-2 px-2 py-2">
                  <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <Command.Input ref={searchRef} value={query} onValueChange={setQuery} aria-label="Search projects" placeholder="Search projects" className="min-w-0 w-full bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]" />
                </div>
                <Command.List className="max-h-[min(280px,50vh)] overflow-y-auto">
                  {filteredProjects.length === 0 && <div className="px-2 py-3 text-[13px] text-[var(--text-muted)]">No projects found</div>}
                  {filteredProjects.map((dir) => (
                    <Command.Item key={dir} value={dir} onSelect={() => selectProject(dir)} title={dir} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-[var(--text-primary)] data-[selected=true]:bg-[var(--bg-tertiary)]">
                      <Folder className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                      <span className="min-w-0 flex-1 truncate">{dir.split(/[\\/]/).filter(Boolean).pop() || dir}</span>
                      {dir === cwd && <Check aria-label="Current project" className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />}
                    </Command.Item>
                  ))}
                  <Command.Separator className="my-1 h-px bg-[var(--border)]" />
                  <Command.Item value="__browse_project__" onSelect={() => { void browse(); }} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-[var(--text-secondary)] data-[selected=true]:bg-[var(--bg-tertiary)]">
                    <Plus className="h-4 w-4 shrink-0" />
                    New project…
                  </Command.Item>
                </Command.List>
              </Command>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
