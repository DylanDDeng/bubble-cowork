import * as React from 'react';

import { cn } from '@/ui/lib/utils';

type IconButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'title'
> & {
  label: string;
  tooltip?: string;
  size?: 'sm' | 'md';
  stopPropagation?: boolean;
};

const sizeClasses = {
  sm: 'h-7 w-7 rounded-md',
  md: 'h-8 w-8 rounded-lg',
};

export const iconButtonClassName =
  'no-drag pointer-events-auto inline-flex shrink-0 items-center justify-center border border-transparent text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] active:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]';

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      children,
      className,
      label,
      tooltip,
      type = 'button',
      size = 'md',
      stopPropagation = true,
      onMouseDown,
      onClick,
      ...props
    },
    ref
  ) => {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        title={tooltip ?? label}
        aria-label={label}
        className={cn(iconButtonClassName, sizeClasses[size], className)}
        onMouseDown={(event) => {
          if (stopPropagation) {
            event.preventDefault();
            event.stopPropagation();
          }
          onMouseDown?.(event);
        }}
        onClick={(event) => {
          if (stopPropagation) {
            event.preventDefault();
            event.stopPropagation();
          }
          onClick?.(event);
        }}
      >
        {children}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';
