import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { useAppPreferences, subscribeAppPreferences } from '../store/useAppPreferences';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';

export function AppearancePreferences({ children }: { children: ReactNode }) {
  const preferences = useAppPreferences();
  const reducedMotion = useAppReducedMotion();
  useEffect(subscribeAppPreferences, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--ui-font-scale', String(preferences.uiFontSize / 13));
    root.style.setProperty('--code-font-size', `${preferences.codeFontSize}px`);
    root.dataset.reduceMotion = String(reducedMotion);
    root.dataset.fontSmoothing = String(preferences.fontSmoothing);
    root.dataset.pointerCursors = String(preferences.pointerCursors);
    root.dataset.diffMarkers = preferences.diffMarkers;
  }, [preferences.uiFontSize, preferences.codeFontSize, preferences.fontSmoothing, preferences.pointerCursors, preferences.diffMarkers, reducedMotion]);
  return <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'}>{children}</MotionConfig>;
}
