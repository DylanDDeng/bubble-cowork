import { useSyncExternalStore } from 'react';
import { useAppPreferences } from '../store/useAppPreferences';

const media = () => window.matchMedia('(prefers-reduced-motion: reduce)');
const subscribe = (listener: () => void) => {
  const query = media();
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};
export function useAppReducedMotion() {
  const preference = useAppPreferences(s => s.reduceMotion);
  const system = useSyncExternalStore(subscribe, () => media().matches, () => false);
  return preference === 'on' || (preference === 'system' && system);
}
