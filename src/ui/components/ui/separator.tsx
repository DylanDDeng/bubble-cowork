import * as React from 'react';
import { Separator as SeparatorPrimitive } from '@base-ui-components/react/separator';
import { cn } from '@/ui/lib/utils';

const Separator = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof SeparatorPrimitive> & {
    orientation?: 'horizontal' | 'vertical';
  }
>(({ className, orientation = 'horizontal', ...props }, ref) => (
  <SeparatorPrimitive
    ref={ref}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-[var(--border)] data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
      className
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';

export { Separator };
