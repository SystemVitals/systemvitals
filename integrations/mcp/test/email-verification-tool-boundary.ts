export const EMAIL_VERIFICATION_TOOL_ALLOWLIST = [
  "resend_email_channel_verification",
] as const;

// Keep the shared full-catalog tests explicit about the one-release project
// compatibility boundary. In particular, create_project must never return.
export const LEGACY_PROJECT_TOOL_ALLOWLIST = ["list_projects"] as const;

const LIFECYCLE_CONTROL_STEMS = [
  "verif",
  "confirm",
  "approv",
  "activat",
  "enabl",
  "bypass",
  "force",
  "mark",
] as const;

export function isEmailVerificationLifecycleTool(name: string): boolean {
  const tokens = name.toLowerCase().split("_").filter(Boolean);
  return (
    tokens.includes("email") &&
    tokens.some((token) =>
      LIFECYCLE_CONTROL_STEMS.some((stem) => token.startsWith(stem)),
    )
  );
}

export function emailVerificationLifecycleToolNames(
  names: readonly string[],
): string[] {
  return names.filter(isEmailVerificationLifecycleTool);
}

export function legacyProjectToolNames(names: readonly string[]): string[] {
  return names.filter((name) => name.includes("project"));
}
