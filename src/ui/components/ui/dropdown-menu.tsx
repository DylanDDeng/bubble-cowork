import * as React from 'react';
import { Menu } from '@base-ui-components/react/menu';
import { cn } from '@/ui/lib/utils';

/**
 * Base UI-backed Dropdown Menu wrapper.
 *
 * Exposes two parallel export surfaces so consumers can use either:
 *   import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/ui/components/ui/dropdown-menu';
 *   import * as DropdownMenu from '@/ui/components/ui/dropdown-menu';  // then DropdownMenu.Root, .Trigger, .Content ...
 *
 * `asChild` is translated to Base UI's `render` prop for Radix compatibility.
 */

type AsChildProp = { asChild?: boolean };


/* ---------- Root ---------- */
const Root = Menu.Root;

/* ---------- Trigger (asChild compat) ---------- */
type TriggerProps = React.ComponentProps<typeof Menu.Trigger> & AsChildProp;
const Trigger = React.forwardRef<HTMLElement, TriggerProps>(
  ({ asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <Menu.Trigger ref={ref} {...props} render={children as any} />;
    }
    return <Menu.Trigger ref={ref} {...props}>{children}</Menu.Trigger>;
  }
);
Trigger.displayName = 'DropdownMenuTrigger';

/* ---------- Portal ---------- */
const Portal = Menu.Portal;

/* ---------- Content (Positioner + Popup, no Portal — consumers wrap in Portal) ---------- */
type ContentProps = React.ComponentProps<typeof Menu.Positioner> &
  React.ComponentProps<typeof Menu.Popup> & AsChildProp;

const Content = React.forwardRef<HTMLDivElement, ContentProps>(
  ({ className, sideOffset, side, align, alignOffset, ...props }, ref) => (
    <Menu.Positioner sideOffset={sideOffset} side={side} align={align} alignOffset={alignOffset}>
      <Menu.Popup
        ref={ref}
        className={cn('popover-surface z-50 min-w-[8rem] overflow-hidden p-1.5', className)}
        {...props}
      />
    </Menu.Positioner>
  )
);
Content.displayName = 'DropdownMenuContent';

/* ---------- Content with Portal (for named-export consumers that don't wrap in Portal) ---------- */
const ContentWithPortal = React.forwardRef<HTMLDivElement, ContentProps>(
  ({ className, sideOffset, side, align, alignOffset, ...props }, ref) => (
    <Menu.Portal>
      <Menu.Positioner sideOffset={sideOffset} side={side} align={align} alignOffset={alignOffset}>
        <Menu.Popup
          ref={ref}
          className={cn('popover-surface z-50 min-w-[8rem] overflow-hidden p-1.5', className)}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  )
);
ContentWithPortal.displayName = 'DropdownMenuContent';

/* ---------- Item ---------- */
type BaseItemProps = Omit<React.ComponentProps<typeof Menu.Item>, 'onSelect'>;
type ItemSelectEvent = React.MouseEvent<HTMLElement> & {
  preventBaseUIHandler?: () => void;
};
type ItemProps = BaseItemProps & {
  inset?: boolean;
  onSelect?: (event: ItemSelectEvent) => void;
};
const Item = React.forwardRef<HTMLDivElement, ItemProps>(
  ({ className, inset, onClick, onSelect, ...props }, ref) => {
    const handleClick = React.useCallback((event: ItemSelectEvent) => {
      onSelect?.(event);
      if (event.defaultPrevented) {
        event.preventBaseUIHandler?.();
      }
      onClick?.(event);
    }, [onClick, onSelect]);

    return (
      <Menu.Item
        ref={ref}
        className={cn(
          'relative flex cursor-default select-none items-center rounded-lg px-3 py-2 text-sm outline-none transition-colors focus:bg-[var(--bg-tertiary)] data-[highlighted]:bg-[var(--bg-tertiary)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
          inset && 'pl-8',
          className
        )}
        onClick={handleClick}
        {...props}
      />
    );
  }
);
Item.displayName = 'DropdownMenuItem';

/* ---------- CheckboxItem ---------- */
type CheckboxItemProps = React.ComponentProps<typeof Menu.CheckboxItem>;
const CheckboxItem = React.forwardRef<HTMLDivElement, CheckboxItemProps>(
  ({ className, children, ...props }, ref) => (
    <Menu.CheckboxItem
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2.5 text-[13px] outline-none transition-colors focus:bg-[var(--sidebar-item-hover)] data-[highlighted]:bg-[var(--sidebar-item-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <Menu.CheckboxItemIndicator>
          <span className="h-2 w-2 rounded-sm bg-current" />
        </Menu.CheckboxItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  )
);
CheckboxItem.displayName = 'DropdownMenuCheckboxItem';

/* ---------- RadioGroup ---------- */
const RadioGroup = Menu.RadioGroup;

/* ---------- RadioItem ---------- */
type RadioItemProps = React.ComponentProps<typeof Menu.RadioItem>;
const RadioItem = React.forwardRef<HTMLDivElement, RadioItemProps>(
  ({ className, children, ...props }, ref) => (
    <Menu.RadioItem
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2.5 text-[13px] outline-none transition-colors focus:bg-[var(--sidebar-item-hover)] data-[highlighted]:bg-[var(--sidebar-item-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <Menu.RadioItemIndicator>
          <span className="h-2 w-2 rounded-full bg-current" />
        </Menu.RadioItemIndicator>
      </span>
      {children}
    </Menu.RadioItem>
  )
);
RadioItem.displayName = 'DropdownMenuRadioItem';

/* ---------- Label ---------- */
type LabelProps = React.ComponentProps<typeof Menu.GroupLabel> & { inset?: boolean };
const Label = React.forwardRef<HTMLDivElement, LabelProps>(
  ({ className, inset, ...props }, ref) => (
    <Menu.GroupLabel
      ref={ref}
      className={cn('px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]', inset && 'pl-8', className)}
      {...props}
    />
  )
);
Label.displayName = 'DropdownMenuLabel';

/* ---------- Separator ---------- */
type SeparatorProps = React.ComponentProps<typeof Menu.Separator>;
const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, ...props }, ref) => (
    <Menu.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-[var(--border)]', className)}
      {...props}
    />
  )
);
Separator.displayName = 'DropdownMenuSeparator';

/* ---------- Group ---------- */
const Group = Menu.Group;

/* ---------- Sub (SubmenuRoot) ---------- */
const Sub = Menu.SubmenuRoot;

/* ---------- SubTrigger (asChild compat) ---------- */
type SubTriggerProps = React.ComponentProps<typeof Menu.SubmenuTrigger> & AsChildProp;
const SubTrigger = React.forwardRef<HTMLElement, SubTriggerProps>(
  ({ asChild, children, className, ...props }, ref) => {
    const triggerEl = (
      <Menu.SubmenuTrigger
        ref={ref}
        className={cn(
          'flex cursor-default select-none items-center rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors hover:bg-[var(--sidebar-item-hover)] data-[highlighted]:bg-[var(--sidebar-item-hover)] data-[popup-open]:bg-[var(--sidebar-item-hover)]',
          className
        )}
        {...props}
      >
        {children}
      </Menu.SubmenuTrigger>
    );
    if (asChild && React.isValidElement(children)) {
      return (
        <Menu.SubmenuTrigger
          ref={ref}
          className={cn(
            'flex cursor-default select-none items-center rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors hover:bg-[var(--sidebar-item-hover)] data-[highlighted]:bg-[var(--sidebar-item-hover)] data-[popup-open]:bg-[var(--sidebar-item-hover)]',
            className
          )}
          {...props}
          render={children as any}
        />
      );
    }
    return triggerEl;
  }
);
SubTrigger.displayName = 'DropdownMenuSubTrigger';

/* ---------- SubContent (Portal + Positioner + Popup) ---------- */
type SubContentProps = React.ComponentProps<typeof Menu.Positioner> &
  React.ComponentProps<typeof Menu.Popup>;
const SubContent = React.forwardRef<HTMLDivElement, SubContentProps>(
  ({ className, sideOffset, side, align, alignOffset, ...props }, ref) => (
    <Menu.Portal>
      <Menu.Positioner sideOffset={sideOffset} side={side} align={align} alignOffset={alignOffset}>
        <Menu.Popup
          ref={ref}
          className={cn('popover-surface z-50 min-w-[8rem] overflow-hidden p-1.5', className)}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  )
);
SubContent.displayName = 'DropdownMenuSubContent';

/* ---------- Shortcut (pure presentational) ---------- */
const Shortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('ml-auto text-xs tracking-widest opacity-60', className)} {...props} />
);
Shortcut.displayName = 'DropdownMenuShortcut';

/* ---------- Exports ---------- */
// Prefixed named exports (existing consumers)
export {
  Root as DropdownMenu,
  Trigger as DropdownMenuTrigger,
  ContentWithPortal as DropdownMenuContent,
  Item as DropdownMenuItem,
  CheckboxItem as DropdownMenuCheckboxItem,
  RadioItem as DropdownMenuRadioItem,
  Label as DropdownMenuLabel,
  Separator as DropdownMenuSeparator,
  Shortcut as DropdownMenuShortcut,
  Group as DropdownMenuGroup,
  Portal as DropdownMenuPortal,
  Sub as DropdownMenuSub,
  SubContent as DropdownMenuSubContent,
  SubTrigger as DropdownMenuSubTrigger,
  RadioGroup as DropdownMenuRadioGroup,
};

// Unprefixed named exports (for `import * as DropdownMenu` namespace usage)
export {
  Root,
  Trigger,
  Content,
  Item,
  CheckboxItem,
  RadioItem,
  Label,
  Separator,
  Shortcut,
  Group,
  Portal,
  Sub,
  SubContent,
  SubTrigger,
  RadioGroup,
};
