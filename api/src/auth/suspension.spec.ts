import { PrismaClient } from '@systemvitals/database';

const prisma = new PrismaClient();
afterAll(async () => {
  await prisma.$disconnect();
});

describe('suspension data contract', () => {
  it('User has a nullable suspendedAt column', async () => {
    const u = await prisma.user.create({
      data: { email: `susp+${Date.now()}@e.com`, passwordHash: 'x' },
    });
    expect(u.suspendedAt).toBeNull();
    const s = await prisma.user.update({
      where: { id: u.id },
      data: { suspendedAt: new Date() },
    });
    expect(s.suspendedAt).toBeInstanceOf(Date);
    await prisma.user.delete({ where: { id: u.id } });
  });
});
