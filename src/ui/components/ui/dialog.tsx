import * as React from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { cn } from '@/ui/lib/utils';

/**
 * Base UI-backed Dialog wrapper.
 *
 * Exposes two parallel export surfaces:
 *   import { Dialog as DialogRoot, DialogContent, DialogTitle } from '@/ui/components/ui/dialog';
 *   import * as DialogPrimitive from '@/ui/components/ui/dialog';  // then DialogPrimitive.Root, .Content, .Overlay ...
 *
 * `asChild` is translated to Base UI's `render` prop for Radix compatibility.
 * Radix `Overlay` → Base UI `Backdrop`; Radix `Content` → Base UI `Popup`.
 */

type AsChildProp = { asChild?: boolean };


/* ---------- Root ---------- */
const Root = Dialog.Root;

/* ---------- Trigger (asChild compat) ---------- */
type TriggerProps = React.ComponentProps<typeof Dialog.Trigger> & AsChildProp;
const Trigger = React.forwardRef<HTMLElement, TriggerProps>(
  ({ asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <Dialog.Trigger ref={ref} {...props} render={children as any} />;
    }
    return <Dialog.Trigger ref={ref} {...props}>{children}</Dialog.Trigger>;
  }
);
Trigger.displayName = 'DialogTrigger';

/* ---------- Portal ---------- */
const Portal = Dialog.Portal;

/* ---------- Overlay → Backdrop ---------- */
type OverlayProps = React.ComponentProps<typeof Dialog.Backdrop>;
const Overlay = React.forwardRef<HTMLDivElement, OverlayProps>(
  ({ className, ...props }, ref) => (
    <Dialog.Backdrop
      ref={ref}
      className={cn(className)}
      {...props}
    />
  )
);
Overlay.displayName = 'DialogOverlay';

/* ---------- Content → Popup (no Portal/Overlay — consumers compose them) ---------- */
type ContentProps = React.ComponentProps<typeof Dialog.Popup>;
const Content = React.forwardRef<HTMLDivElement, ContentProps>(
  ({ className, ...props }, ref) => (
    <Dialog.Popup
      ref={ref}
      // no-drag: popups portal above the window's -webkit-app-region: drag
      // titlebar strips; without it, clicks near the top edge hit the native
      // drag region instead of the dialog.
      className={cn('no-drag', className)}
      {...props}
    />
  )
);
Content.displayName = 'DialogContent';

/* ---------- Close (asChild compat) ---------- */
type CloseProps = React.ComponentProps<typeof Dialog.Close> & AsChildProp;
const Close = React.forwardRef<HTMLButtonElement, CloseProps>(
  ({ asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <Dialog.Close ref={ref} {...props} render={children as any} />;
    }
    return <Dialog.Close ref={ref} {...props}>{children}</Dialog.Close>;
  }
);
Close.displayName = 'DialogClose';

/* ---------- Title ---------- */
type TitleProps = React.ComponentProps<typeof Dialog.Title>;
const Title = React.forwardRef<HTMLHeadingElement, TitleProps>(
  ({ className, ...props }, ref) => (
    <Dialog.Title
      ref={ref}
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  )
);
Title.displayName = 'DialogTitle';

/* ---------- Description ---------- */
type DescriptionProps = React.ComponentProps<typeof Dialog.Description>;
const Description = React.forwardRef<HTMLParagraphElement, DescriptionProps>(
  ({ className, ...props }, ref) => (
    <Dialog.Description
      ref={ref}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
);
Description.displayName = 'DialogDescription';

/* ---------- Presentational helpers ---------- */
const Header = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);
Header.displayName = 'DialogHeader';

const Footer = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
);
Footer.displayName = 'DialogFooter';

/* ---------- Exports ---------- */
// Prefixed named exports (shadcn-style)
export {
  Root as Dialog,
  Trigger as DialogTrigger,
  Portal as DialogPortal,
  Overlay as DialogOverlay,
  Content as DialogContent,
  Close as DialogClose,
  Title as DialogTitle,
  Description as DialogDescription,
  Header as DialogHeader,
  Footer as DialogFooter,
};

// Unprefixed named exports (for `import * as DialogPrimitive` namespace usage)
export { Root, Trigger, Portal, Overlay, Content, Close, Title, Description, Header, Footer };
