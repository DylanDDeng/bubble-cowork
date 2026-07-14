import * as React from 'react';
import { ContextMenu as ContextMenuPrimitive } from '@base-ui-components/react/context-menu';
import { Menu as MenuPrimitive } from '@base-ui-components/react/menu';
import { cn } from '@/ui/lib/utils';

/**
 * Base UI-backed Context Menu wrapper.
 *
 * Mirrors the visual language of `dropdown-menu.tsx` (same popup surface,
 * item and separator classes) so right-click menus look identical to the
 * app's dropdown menus instead of the native OS menu.
 */

// Same constraint as dropdown-menu.tsx: Base UI positions the Positioner,
// so the z-index must live there or the popup paints under fixed layers.
const POSITIONER_Z_CLASS = 'z-[9999]';

/* ---------- Root / Trigger (asChild via Base UI render prop) ---------- */
const Root = ContextMenuPrimitive.Root;
const Trigger = ContextMenuPrimitive.Trigger;

/* ---------- Content (Portal + Positioner + Popup) ---------- */
type ContentProps = React.ComponentProps<typeof ContextMenuPrimitive.Positioner> &
  React.ComponentProps<typeof ContextMenuPrimitive.Popup>;

const Content = React.forwardRef<HTMLDivElement, ContentProps>(
  ({ className, sideOffset, side, align, alignOffset, ...props }, ref) => (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className={POSITIONER_Z_CLASS}
        sideOffset={sideOffset}
        side={side}
        align={align}
        alignOffset={alignOffset}
      >
        <ContextMenuPrimitive.Popup
          ref={ref}
          className={cn(
            'popover-surface popover-surface--menu z-50 min-w-[8rem] max-w-[320px] overflow-hidden p-1 outline-none',
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
);
Content.displayName = 'ContextMenuContent';

/* ---------- Item ---------- */
type ItemProps = React.ComponentProps<typeof ContextMenuPrimitive.Item> & { inset?: boolean };
const Item = React.forwardRef<HTMLDivElement, ItemProps>(
  ({ className, inset, ...props }, ref) => (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-md px-2.5 py-1 text-[13px] outline-none transition-colors focus:bg-[var(--bg-tertiary)] data-[highlighted]:bg-[var(--bg-tertiary)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        inset && 'pl-8',
        className
      )}
      {...props}
    />
  )
);
Item.displayName = 'ContextMenuItem';

/* ---------- Separator ---------- */
type SeparatorProps = React.ComponentProps<typeof ContextMenuPrimitive.Separator>;
const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, ...props }, ref) => (
    <ContextMenuPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-[var(--border)]', className)}
      {...props}
    />
  )
);
Separator.displayName = 'ContextMenuSeparator';

/* ---------- Point-anchored variant ---------- */
/**
 * Controlled context menu anchored at a screen coordinate, for trees/lists
 * where many rows share ONE menu instance and open it imperatively
 * (`setPoint({ x: event.clientX, y: event.clientY })`). Items/Separators are
 * the same parts as the trigger-based variant, so styling stays identical.
 */
type ContextMenuAtPointProps = {
  point: { x: number; y: number } | null;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
};

const ContextMenuAtPoint = ({ point, onClose, className, children }: ContextMenuAtPointProps) => {
  const anchor = React.useMemo(
    () =>
      point
        ? {
            getBoundingClientRect: () =>
              DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
          }
        : null,
    [point]
  );
  if (!anchor) return null;
  return (
    <MenuPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          className={POSITIONER_Z_CLASS}
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={2}
        >
          <MenuPrimitive.Popup
            className={cn(
              'popover-surface popover-surface--menu z-50 min-w-[8rem] max-w-[320px] overflow-hidden p-1 outline-none',
              className
            )}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
};

export {
  Root as ContextMenu,
  Trigger as ContextMenuTrigger,
  Content as ContextMenuContent,
  Item as ContextMenuItem,
  Separator as ContextMenuSeparator,
  ContextMenuAtPoint,
};
