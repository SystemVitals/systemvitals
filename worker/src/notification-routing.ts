import type { PrismaClient } from "@systemvitals/database";

type NotificationRoutingClient = Pick<
  PrismaClient,
  "notificationChannel"
>;

export async function snapshotSelectedChannelIds(
  prisma: NotificationRoutingClient,
  check: { id: string; projectId: string },
): Promise<string[]> {
  const channels = await prisma.notificationChannel.findMany({
    where: {
      projectId: check.projectId,
      enabled: true,
      checkExclusions: { none: { checkId: check.id } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  return channels.map((channel) => channel.id);
}
