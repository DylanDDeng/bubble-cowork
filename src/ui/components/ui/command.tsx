import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command as CommandPrimitive } from 'cmdk';
import { cn } from '@/ui/lib/utils';

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] text-[var(--text-primary)]',
      className
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  label?: string;
}

function CommandDialog({ open, onOpenChange, children, className, label }: CommandDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[90] bg-[rgba(15,23,42,0.28)] backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <DialogPrimitive.Content
          aria-label={label ?? 'Search'}
          className={cn(
            'fixed left-1/2 top-[18vh] z-[100] w-[min(640px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_24px_60px_rgba(15,23,42,0.2)] outline-none',
            className
          )}
        >
          <DialogPrimitive.Title className="sr-only">{label ?? 'Search'}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search projects, threads, and actions
          </DialogPrimitive.Description>
          <Command shouldFilter={false}>{children}</Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface CommandInputProps
  extends React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input> {
  startAddon?: React.ReactNode;
  endAddon?: React.ReactNode;
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  CommandInputProps
>(({ className, startAddon, endAddon, ...props }, ref) => (
  <div className="flex h-12 items-center gap-2 border-b border-[var(--border)] px-3">
    {startAddon ? (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]">
        {startAddon}
      </span>
    ) : null}
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-11 w-full bg-transparent text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
    {endAddon}
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-[min(26rem,60vh)] overflow-y-auto overflow-x-hidden', className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className={cn('py-10 text-center text-sm text-[var(--text-muted)]', props.className)}
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden px-1.5 py-1.5 text-[var(--text-primary)] [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-[var(--text-muted)]',
      className
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-0 h-px bg-[var(--border)]', className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors data-[selected=true]:bg-[var(--bg-tertiary)] data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 aria-selected:bg-[var(--bg-tertiary)]',
      className
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'ml-auto inline-flex items-center gap-0.5 text-[11px] font-medium tracking-wide text-[var(--text-muted)]',
        className
      )}
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--bg-tertiary)]/60 px-3 py-2 text-[11px] text-[var(--text-muted)]',
        className
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
  CommandFooter,
};
