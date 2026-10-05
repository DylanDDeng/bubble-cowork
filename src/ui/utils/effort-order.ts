// Catalogs can return descending tiers. Order known tiers without inventing any.
const tierOrder = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'on',
  'high',
  'xhigh',
  'max',
  'ultra',
];
export function orderedEfforts<T extends string>(options: readonly T[]): T[] {
  const unique = [...new Set(options)];
  return unique.every((option) => tierOrder.includes(option))
    ? unique.sort((a, b) => tierOrder.indexOf(a) - tierOrder.indexOf(b))
    : unique;
}
