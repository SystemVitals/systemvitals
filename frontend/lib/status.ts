export function overallStatus(checks: { status: string }[]): "operational" | "degraded" | "down" {
  if (checks.some((c) => c.status === "DOWN")) return "down";
  if (checks.some((c) => c.status === "GRACE")) return "degraded";
  return "operational";
}
