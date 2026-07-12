import type { SVGProps } from 'react';

/** Compact permission mark with the exclamation fully enclosed by the shield. */
export function FullAccessPermissionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M10 3.05c2.34.76 4.55 1.34 6.5 2.04v3.23c0 3.42-2.36 6.08-6.5 8.03-4.14-1.95-6.5-4.61-6.5-8.03V5.09C5.45 4.39 7.66 3.81 10 3.05Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 6.25v4.15"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
      <circle cx="10" cy="12.85" r="0.85" fill="currentColor" />
    </svg>
  );
}
