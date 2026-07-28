/**
 * Formats a plan usage label showing used vs max checks.
 * e.g. planUsageLabel(3, 5) → "3 / 5 checks"
 */
export function planUsageLabel(used: number, max: number): string {
  return `${used} / ${max} checks`;
}
