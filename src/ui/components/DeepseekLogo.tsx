import deepseekLogoUrl from '../assets/deepseek-color.svg';

export function DeepseekLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <img src={deepseekLogoUrl} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}
