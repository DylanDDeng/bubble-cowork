import { useMemo } from 'react';
import { getSubagentSprite } from '../utils/subagent-persona';

/**
 * Pixel-art avatar for a subagent — a 5×5 mirrored sprite derived purely from
 * the subagent id, tinted with its persona hue. Purely decorative; the same
 * id always renders the same little creature.
 */
export function SubagentAvatar({
  id,
  hue,
  size = 14,
}: {
  id: string;
  hue: number;
  size?: number;
}) {
  const grid = useMemo(() => getSubagentSprite(id), [id]);
  const base = `hsl(${hue} 60% 48%)`;
  const shade = `hsl(${hue} 65% 34%)`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      shapeRendering="crispEdges"
      aria-hidden
      className="flex-shrink-0"
    >
      {grid.map((cell, i) =>
        cell === 0 ? null : (
          <rect
            key={i}
            x={i % 5}
            y={Math.floor(i / 5)}
            width={1}
            height={1}
            fill={cell === 2 ? shade : base}
          />
        )
      )}
    </svg>
  );
}
