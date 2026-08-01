import bubbleLogoUrl from '../assets/bubble-logo-auto.svg';

export function BubbleLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <img src={bubbleLogoUrl} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}
