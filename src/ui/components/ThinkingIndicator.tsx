// Thinking/Preparing/Streaming 指示器组件

import { motion, AnimatePresence } from 'motion/react';
import type { TurnPhase } from '../types';
import { getThinkingText } from '../utils/turn-utils';

interface ThinkingIndicatorProps {
  phase: TurnPhase;
  isBuffering: boolean;
}

/**
 * Spinner 组件 - 3x3 网格动画
 * 复用 index.css 中的 spinner-grid 样式
 */
function Spinner() {
  return (
    <span className="spinner-grid" aria-hidden="true">
      {Array.from({ length: 9 }).map((_, i) => (
        <span key={i} className="spinner-cube" />
      ))}
    </span>
  );
}

/**
 * ThinkingIndicator 组件
 *
 * 显示不同阶段的等待状态：
 * - pending / awaiting → "Thinking..."
 * - streaming + buffering → "Preparing response..."
 */
export function ThinkingIndicator({ phase, isBuffering }: ThinkingIndicatorProps) {
  const text = getThinkingText(phase, isBuffering);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={text}
        className="thinking-indicator my-3 flex items-center gap-2 text-[var(--text-secondary)]"
        role="status"
        aria-live="polite"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
      >
        <Spinner />
        <motion.span
          className="text-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.05 }}
        >
          {text}
        </motion.span>
      </motion.div>
    </AnimatePresence>
  );
}

export default ThinkingIndicator;
