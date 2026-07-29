import type { JwtUser } from '../auth/jwt.strategy';
import type { PrismaService } from '../prisma/prisma.service';
import { OrganizationsResolver } from './organizations.resolver';
import type { OrganizationsService } from './organizations.service';

describe('OrganizationsResolver.organizationCheckAllowance', () => {
  it('requests the selected organization allowance for the authenticated user', async () => {
    const organizationsService = {
      organizationCheckAllowance: jest.fn().mockResolvedValue({
        used: 3,
        limit: 10,
        remaining: 7,
      }),
    };
    const resolver = new OrganizationsResolver(
      {} as PrismaService,
      organizationsService as unknown as OrganizationsService,
    );

    await expect(
      resolver.organizationCheckAllowance(
        { userId: 'member-1' } as JwtUser,
        'org-1',
      ),
    ).resolves.toEqual({
      used: 3,
      limit: 10,
      remaining: 7,
    });
    expect(
      organizationsService.organizationCheckAllowance,
    ).toHaveBeenCalledWith('member-1', 'org-1');
  });
});
