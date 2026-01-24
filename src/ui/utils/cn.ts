import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 Tailwind CSS 类名
 *
 * 使用 clsx 处理条件类名，使用 tailwind-merge 解决类名冲突
 *
 * @example
 * // 基础用法
 * cn('px-4 py-2', 'bg-blue-500')
 * // => 'px-4 py-2 bg-blue-500'
 *
 * @example
 * // 条件类名
 * cn('px-4', isActive && 'bg-blue-500', isDisabled && 'opacity-50')
 *
 * @example
 * // 解决冲突（后者覆盖前者）
 * cn('px-4', 'px-8')
 * // => 'px-8' (不是 'px-4 px-8')
 *
 * @example
 * // 合并 props.className
 * cn('base-styles', props.className)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
