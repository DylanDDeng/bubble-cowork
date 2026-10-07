import type { CSSProperties } from 'react';
import mimoLogoUrl from '../assets/xiaomimimo.svg';

// The mark is a single-colour glyph; masking it paints it in currentColor so
// it reads on light and dark surfaces alike.
const maskStyle: CSSProperties = {
  WebkitMaskImage: `url("${mimoLogoUrl}")`,
  maskImage: `url("${mimoLogoUrl}")`,
  WebkitMaskSize: 'contain',
  maskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
};

export function MimoLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <span className={`${className} inline-block flex-shrink-0 bg-current`} style={maskStyle} aria-hidden="true" />;
}
