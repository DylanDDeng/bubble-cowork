import qoderLogoUrl from '../assets/qoder.svg';

export function QoderLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <img src={qoderLogoUrl} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}
