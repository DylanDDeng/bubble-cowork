// 智能缓冲策略 Hook

import { useState, useEffect, useRef } from 'react';
import { DEFAULT_BUFFER_CONFIG, type BufferConfig } from '../types';

/**
 * 检测内容是否包含结构化元素（代码块/标题/列表）
 */
function hasStructuredContent(content: string): boolean {
  // 代码块
  if (content.includes('```')) return true;
  // 标题
  if (/^#{1,6}\s/m.test(content)) return true;
  // 列表
  if (/^[-*+]\s/m.test(content) || /^\d+\.\s/m.test(content)) return true;
  // 疑问句（通常是完整的开场）
  if (/\?$/.test(content.trim())) return true;

  return false;
}

/**
 * 计算内容的词数
 */
function countWords(content: string): number {
  // 移除代码块内容（不计入词数）
  const withoutCode = content.replace(/```[\s\S]*?```/g, '');
  // 按空白字符分割
  const words = withoutCode.trim().split(/\s+/);
  return words.filter((w) => w.length > 0).length;
}

/**
 * 智能缓冲 Hook
 *
 * 缓冲策略：
 * 1. 最少等 MIN_BUFFER_MS (500ms)
 * 2. 最多等 MAX_BUFFER_MS (2500ms)
 * 3. 检测到结构化内容且 ≥ MIN_WORDS_STRUCTURED (8词) → 提前放开
 * 4. 普通内容 ≥ MIN_WORDS_STANDARD (15词) → 放开
 *
 * @param content - 当前流式内容
 * @param isStreaming - 是否正在流式输出
 * @param config - 缓冲配置
 * @returns isBuffering - 是否仍在缓冲中
 */
export function useSmartBuffer(
  content: string,
  isStreaming: boolean,
  config: BufferConfig = DEFAULT_BUFFER_CONFIG
): boolean {
  const [isBuffering, setIsBuffering] = useState(false);
  const streamStartTimeRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // 清理定时器
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // 不在流式输出，重置状态
    if (!isStreaming) {
      streamStartTimeRef.current = null;
      setIsBuffering(false);
      return;
    }

    // 开始流式输出，记录开始时间
    if (streamStartTimeRef.current === null) {
      streamStartTimeRef.current = Date.now();
      setIsBuffering(true);
    }

    const elapsed = Date.now() - streamStartTimeRef.current;
    const wordCount = countWords(content);
    const isStructured = hasStructuredContent(content);

    // 检查是否应该放开缓冲
    const shouldRelease = () => {
      // 超过最大等待时间，强制放开
      if (elapsed >= config.MAX_BUFFER_MS) {
        return true;
      }

      // 未达到最小等待时间，继续缓冲
      if (elapsed < config.MIN_BUFFER_MS) {
        return false;
      }

      // 结构化内容，较低词数阈值
      if (isStructured && wordCount >= config.MIN_WORDS_STRUCTURED) {
        return true;
      }

      // 普通内容，较高词数阈值
      if (wordCount >= config.MIN_WORDS_STANDARD) {
        return true;
      }

      return false;
    };

    if (shouldRelease()) {
      setIsBuffering(false);
    } else {
      // 设置定时器在最小缓冲时间后重新检查
      const remainingMinTime = Math.max(0, config.MIN_BUFFER_MS - elapsed);
      timerRef.current = window.setTimeout(() => {
        // 在定时器触发时重新评估
        const newElapsed = Date.now() - (streamStartTimeRef.current ?? 0);
        if (newElapsed >= config.MIN_BUFFER_MS) {
          const newWordCount = countWords(content);
          const newIsStructured = hasStructuredContent(content);
          if (
            newElapsed >= config.MAX_BUFFER_MS ||
            (newIsStructured && newWordCount >= config.MIN_WORDS_STRUCTURED) ||
            newWordCount >= config.MIN_WORDS_STANDARD
          ) {
            setIsBuffering(false);
          }
        }
      }, remainingMinTime + 50); // 加一点余量
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [content, isStreaming, config]);

  return isBuffering;
}

export default useSmartBuffer;
