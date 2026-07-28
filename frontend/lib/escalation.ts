export interface EscalationStep {
  channelId: string;
  delaySeconds: number;
}

/**
 * Serialises an ordered list of escalation steps to the JSON string
 * expected by the `createEscalationPolicy` / `updateEscalationPolicy` mutations.
 */
export function buildEscalationStepsJson(steps: EscalationStep[]): string {
  return JSON.stringify(steps);
}
