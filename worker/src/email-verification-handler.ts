import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@systemvitals/database";
import type { Mailer } from "./mailer.js";

export interface EmailVerificationJob {
  channelId: string;
  rawToken: string;
}

export interface EmailVerificationDeps {
  mailer: Mailer;
  appUrl: string;
}

const channelInclude = {
  project: { select: { name: true } },
} satisfies Prisma.NotificationChannelInclude;

type ChannelWithProject = Prisma.NotificationChannelGetPayload<{
  include: typeof channelInclude;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function handleEmailVerification(
  prisma: Pick<PrismaClient, "notificationChannel">,
  deps: EmailVerificationDeps,
  job: EmailVerificationJob,
): Promise<boolean> {
  const channel: ChannelWithProject | null =
    await prisma.notificationChannel.findUnique({
      where: { id: job.channelId },
      include: channelInclude,
    });

  const tokenHash = createHash("sha256")
    .update(job.rawToken, "utf8")
    .digest("hex");

  if (
    !channel ||
    channel.type !== "EMAIL" ||
    channel.enabled ||
    channel.verifiedAt ||
    !channel.verificationTokenHash ||
    channel.verificationTokenHash !== tokenHash ||
    !channel.verificationExpiresAt ||
    channel.verificationExpiresAt.getTime() <= Date.now()
  ) {
    return false;
  }

  const email = isRecord(channel.config) ? channel.config["email"] : undefined;
  if (typeof email !== "string" || !email) return false;

  const verificationUrl = new URL("/verify-email", deps.appUrl);
  verificationUrl.searchParams.set("token", job.rawToken);

  await deps.mailer.send({
    to: email,
    subject: `Verify ${email} for ${channel.project.name} on SystemVitals`,
    text: [
      "SystemVitals email notification verification",
      "",
      `Verify ${email} for ${channel.project.name}.`,
      "This link expires in 24 hours.",
      "",
      "Verify email:",
      verificationUrl.toString(),
      "",
      "If you weren't expecting this, you can ignore this email.",
    ].join("\n"),
  });

  return true;
}
