import { useAppStore } from '../store/useAppStore';
import { resolveThemeMode } from '../theme/themes';
import opencodeDarkLogo from '../assets/opencode-dark.png';
import opencodeLightLogo from '../assets/opencode-light.png';

export function OpenCodeLogo({ className = 'h-4 w-4 flex-shrink-0' }: { className?: string }) {
  const theme = useAppStore((state) => state.theme);
  const resolvedMode = resolveThemeMode(theme);
  const logo = resolvedMode === 'dark' ? opencodeDarkLogo : opencodeLightLogo;

  return <img src={logo} alt="" className={className} aria-hidden="true" />;
}
