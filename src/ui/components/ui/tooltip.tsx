import * as React from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import { cn } from '@/ui/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof TooltipPrimitive.Popup> & { sideOffset?: number }>(
  ({ className, sideOffset = 4, ...props }, ref) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          ref={ref}
          className={cn(
            'z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
);
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
