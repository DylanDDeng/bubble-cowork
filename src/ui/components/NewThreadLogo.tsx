import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import { useState } from 'react';
import { motion } from 'motion/react';

/** Decorative home mark; geometry comes from assets/cowork-logo.svg. */
export function NewThreadLogo() {
  const reducedMotion = useAppReducedMotion();
  const [rotations, setRotations] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  const [greeting, setGreeting] = useState(false);

  return (
    <motion.div
      className="aegis-new-thread-logo no-drag"
      aria-hidden="true"
      animate={{ rotate: -rotations * 360, scale: enlarged && !reducedMotion ? 1.18 : 1 }}
      transition={reducedMotion ? { duration: 0 } : { type: 'spring', duration: 0.55, bounce: 0.15 }}
      onAnimationComplete={() => setEnlarged(false)}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch' && !reducedMotion) setGreeting(true);
      }}
      onPointerUp={(event) => {
        if (event.button !== 0 || reducedMotion) return;
        setRotations((value) => value + 1);
        setEnlarged(true);
      }}
    >
      <motion.svg
        viewBox="250 250 524 524"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        animate={greeting && !reducedMotion ? { rotate: [0, -8, 6, -3, 0] } : { rotate: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.6, ease: 'easeInOut' }}
        onAnimationComplete={() => setGreeting(false)}
      >
        <rect x="372" y="250" width="88" height="524" rx="4" />
        <rect x="564" y="250" width="88" height="524" rx="4" />
        <rect x="276" y="468" width="472" height="88" rx="4" />
      </motion.svg>
    </motion.div>
  );
}
