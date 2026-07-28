import { PrismaService } from '../src/prisma/prisma.service';

export async function cleanupTestUsers(
  prisma: PrismaService,
  emails: string | readonly string[],
): Promise<void> {
  const exactEmails = typeof emails === 'string' ? [emails] : [...emails];
  const users = await prisma.user.findMany({
    where: { email: { in: exactEmails } },
    select: { id: true },
  });
  const userIds = users.map(({ id }) => id);

  if (userIds.length === 0) return;

  await prisma.$transaction([
    prisma.organization.deleteMany({
      where: { creatorUserId: { in: userIds } },
    }),
    prisma.user.deleteMany({ where: { id: { in: userIds } } }),
  ]);

  const [organizationSurvivors, userSurvivors] = await Promise.all([
    prisma.organization.count({
      where: { creatorUserId: { in: userIds } },
    }),
    prisma.user.count({ where: { id: { in: userIds } } }),
  ]);
  if (organizationSurvivors !== 0 || userSurvivors !== 0) {
    throw new Error(
      `Test cleanup left ${organizationSurvivors} organizations and ${userSurvivors} users`,
    );
  }
}
