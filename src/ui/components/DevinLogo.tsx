import devinLogoUrl from '../assets/devin-color.svg';

export function DevinLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <img src={devinLogoUrl} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}
