import { PrismaClient } from '@systemvitals/database';
import { promoteAdmins } from './admin-bootstrap.service';

const prisma = new PrismaClient();
afterAll(async () => {
  await prisma.$disconnect();
});

describe('promoteAdmins', () => {
  it('promotes existing users whose email is listed', async () => {
    const email = `boot+${Date.now()}@e.com`;
    const u = await prisma.user.create({ data: { email, passwordHash: 'x' } });
    await promoteAdmins(prisma, `${email}, other@nope.com`);
    const after = await prisma.user.findUnique({ where: { id: u.id } });
    expect(after?.isAdmin).toBe(true);
    await prisma.user.delete({ where: { id: u.id } });
  });
  it('no-ops on empty config', async () => {
    await expect(promoteAdmins(prisma, undefined)).resolves.toBeUndefined();
  });
});
