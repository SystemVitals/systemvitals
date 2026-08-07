interface TelegramAlertInput {
  appUrl: string;
  organizationSlug: string;
  project: { name: string };
  check: {
    name: string;
    slug: string;
    type: string;
    periodSeconds: number | null;
    intervalSeconds: number | null;
  };
  totalPings: number;
  lastSuccessAt: Date | null;
  otherChecksNotUp: number;
  now: Date;
}

interface TelegramRecoveryAlertInput extends TelegramAlertInput {
  downtimeStartedAt: Date | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function unit(value: number, name: string): string {
  return `${value} ${name}${value === 1 ? "" : "s"}`;
}

function formatDuration(seconds: number): string {
  const units = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ] as const;
  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];

  for (const [size, name] of units) {
    const value = Math.floor(remaining / size);
    if (value > 0) {
      parts.push(unit(value, name));
      remaining %= size;
    }
    if (parts.length === 2) break;
  }

  return parts.join(", ") || "0 seconds";
}

function checkPeriod(input: TelegramAlertInput["check"]): string {
  const seconds =
    input.type === "HEARTBEAT"
      ? input.periodSeconds
      : input.intervalSeconds;
  return seconds == null ? "Not configured" : formatDuration(seconds);
}

function lastPing(input: TelegramAlertInput): string {
  if (input.lastSuccessAt == null) return "Never";
  const elapsedSeconds = Math.max(
    0,
    Math.floor((input.now.getTime() - input.lastSuccessAt.getTime()) / 1_000),
  );
  return elapsedSeconds < 5
    ? "Success, now"
    : `Success, ${formatDuration(elapsedSeconds)} ago`;
}

function siblingSummary(otherChecksNotUp: number): string {
  if (otherChecksNotUp === 0) return "All the other checks are up.";
  return `${unit(otherChecksNotUp, "other check")} ${
    otherChecksNotUp === 1 ? "is" : "are"
  } not up.`;
}

export function buildTelegramDownAlertMessage(
  input: TelegramAlertInput,
): string {
  const checkUrl = `${input.appUrl}/${encodeURIComponent(
    input.organizationSlug,
  )}/${encodeURIComponent(input.check.slug)}`;
  const reason =
    input.check.type === "HEARTBEAT"
      ? "success signal did not arrive on time, grace time passed"
      : "the latest probe failed";

  return [
    `🔴 The check <a href="${escapeHtml(checkUrl)}">${escapeHtml(
      input.check.name,
    )}</a> is <b>DOWN</b> (${reason}).`,
    "",
    `<b>Project:</b> ${escapeHtml(input.project.name)}`,
    `<b>Period:</b> ${checkPeriod(input.check)}`,
    `<b>Total Pings:</b> ${input.totalPings}`,
    `<b>Last Ping:</b> ${lastPing(input)}`,
    "",
    siblingSummary(input.otherChecksNotUp),
  ].join("\n");
}

function formatDowntime(start: Date | null, end: Date | null): string {
  if (start == null || end == null) return "an unknown amount of time";
  const totalMinutes = Math.max(
    0,
    Math.floor((end.getTime() - start.getTime()) / 60_000),
  );
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(unit(days, "day"));
  if (hours > 0 || days > 0) parts.push(unit(hours, "hour"));
  parts.push(unit(minutes, "minute"));
  return parts.join(", ");
}

export function buildTelegramRecoveryAlertMessage(
  input: TelegramRecoveryAlertInput,
): string {
  const checkUrl = `${input.appUrl}/${encodeURIComponent(
    input.organizationSlug,
  )}/${encodeURIComponent(input.check.slug)}`;

  return [
    `🟢 The check <a href="${escapeHtml(checkUrl)}">${escapeHtml(
      input.check.name,
    )}</a> is now <b>UP</b>.`,
    `The downtime lasted ${formatDowntime(
      input.downtimeStartedAt,
      input.lastSuccessAt,
    )}.`,
    "",
    `<b>Project:</b> ${escapeHtml(input.project.name)}`,
    `<b>Period:</b> ${checkPeriod(input.check)}`,
    `<b>Total Pings:</b> ${input.totalPings}`,
    `<b>Last Ping:</b> ${lastPing(input)}`,
    "",
    siblingSummary(input.otherChecksNotUp),
  ].join("\n");
}
