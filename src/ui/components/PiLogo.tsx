import piLogoUrl from '../assets/pi-logo-auto.svg';

export function PiLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <img src={piLogoUrl} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}
