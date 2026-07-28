import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';

async function signup(app: NestFastifyApplication, email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(r.body) as { token: string }).token;
}

async function gql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(r.body) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
}

const ME_ORGS = `{ me { organizations { id name slug role plan creatorUserId creatorLabel } } }`;
interface MeOrgs {
  data: {
    me: {
      organizations: Array<{
        id: string;
        name: string;
        slug: string;
        plan: string;
        creatorUserId: string;
        creatorLabel: string;
      }>;
    };
  };
}

describe('organizations (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = 'org-mgmt+owner@systemvitals.com';
  async function deleteAccount(accountEmail: string) {
    const user = await prisma.user.findUnique({
      where: { email: accountEmail },
      select: { id: true },
    });
    if (!user) return;
    await prisma.$transaction([
      prisma.organization.deleteMany({ where: { creatorUserId: user.id } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await deleteAccount(email);
  });

  afterAll(async () => {
    await deleteAccount(email);
    await app.close();
  });

  it('creates, renames, re-slugs, and deletes an organization', async () => {
    const token = await signup(app, email);

    // start with the signup org
    const before = (await gql(app, token, ME_ORGS)) as unknown as MeOrgs;
    expect(before.data.me.organizations).toHaveLength(1);

    // create a second org
    const created = await gql(
      app,
      token,
      `mutation($name: String!) {
        createOrganization(name: $name) {
          id name slug role plan creatorUserId creatorLabel
        }
      }`,
      { name: 'Second Team' },
    );
    expect(created.errors).toBeUndefined();
    const org = created.data?.createOrganization as {
      id: string;
      slug: string;
      role: string;
      plan: string;
      creatorUserId: string;
      creatorLabel: string;
    };
    expect(org.role).toBe('OWNER');
    expect(org.plan).toBe('SOLO');
    const creator = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(org.creatorUserId).toBe(creator.id);
    expect(org.creatorLabel).toBe(email);
    expect(org.slug).toBe('second-team');

    // me now shows two orgs
    const after = (await gql(app, token, ME_ORGS)) as unknown as MeOrgs;
    expect(after.data.me.organizations).toHaveLength(2);

    await prisma.subscription.update({
      where: { userId: creator.id },
      data: { plan: 'SIGNAL' },
    });
    const upgraded = (await gql(app, token, ME_ORGS)) as unknown as MeOrgs;
    expect(upgraded.data.me.organizations.map((item) => item.plan)).toEqual([
      'SIGNAL',
      'SIGNAL',
    ]);

    // rename its name
    const renamed = await gql(
      app,
      token,
      `mutation($organizationId: ID!, $name: String!) {
        updateOrganization(organizationId: $organizationId, name: $name) {
          id name slug role plan creatorUserId creatorLabel
          projects { id name slug pingKey organizationId }
        }
      }`,
      { organizationId: org.id, name: 'Renamed Team' },
    );
    expect(renamed.errors).toBeUndefined();
    expect(renamed.data?.updateOrganization).toMatchObject({
      id: org.id,
      name: 'Renamed Team',
      slug: 'second-team',
      role: 'OWNER',
      plan: 'SIGNAL',
      creatorUserId: creator.id,
      creatorLabel: email,
      projects: [
        {
          name: 'Default',
          slug: 'default',
          organizationId: org.id,
        },
      ],
    });

    // re-slug it (multi-org user naming an explicit org — no "ambiguous" error)
    const reslugged = await gql(
      app,
      token,
      `mutation($organizationId: ID!, $slug: String!) {
        updateOrganizationSlug(organizationId: $organizationId, slug: $slug) {
          id name slug role plan creatorUserId creatorLabel
          projects { id name slug pingKey organizationId }
        }
      }`,
      { organizationId: org.id, slug: 'renamed-team' },
    );
    expect(reslugged.errors).toBeUndefined();
    expect(reslugged.data?.updateOrganizationSlug).toMatchObject({
      id: org.id,
      name: 'Renamed Team',
      slug: 'renamed-team',
      role: 'OWNER',
      plan: 'SIGNAL',
      creatorUserId: creator.id,
      creatorLabel: email,
      projects: [
        {
          name: 'Default',
          slug: 'default',
          organizationId: org.id,
        },
      ],
    });

    const accountBillingBeforeDelete =
      await prisma.subscription.findUniqueOrThrow({
        where: { userId: creator.id },
        select: {
          id: true,
          plan: true,
          status: true,
          stripeSubscriptionId: true,
        },
      });
    const legacy = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        plan: 'SIGNAL',
        status: 'active',
        stripeSubscriptionId: `sub_legacy_${creator.id}`,
      },
    });

    const blockedDelete = await gql(
      app,
      token,
      `mutation($organizationId: ID!) { deleteOrganization(organizationId: $organizationId) }`,
      { organizationId: org.id },
    );
    expect(blockedDelete.errors?.[0].message).toBe(
      'Complete account subscription reconciliation before transferring/deleting this organization.',
    );
    await expect(
      prisma.organization.findUnique({ where: { id: org.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.subscription.findUnique({ where: { id: legacy.id } }),
    ).resolves.toMatchObject({
      organizationId: org.id,
      status: 'active',
    });

    await prisma.subscription.update({
      where: { id: legacy.id },
      data: { status: 'canceled' },
    });

    // A reconciled legacy row permits deletion.
    const deleted = await gql(
      app,
      token,
      `mutation($organizationId: ID!) { deleteOrganization(organizationId: $organizationId) }`,
      { organizationId: org.id },
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data?.deleteOrganization).toBe(true);
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: legacy.id },
        select: { organizationId: true, status: true },
      }),
    ).resolves.toEqual({ organizationId: null, status: 'canceled' });
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { userId: creator.id },
        select: {
          id: true,
          plan: true,
          status: true,
          stripeSubscriptionId: true,
        },
      }),
    ).resolves.toEqual(accountBillingBeforeDelete);

    // back to one org
    const end = (await gql(app, token, ME_ORGS)) as unknown as MeOrgs;
    expect(end.data.me.organizations).toHaveLength(1);
  });

  it('refuses to delete the last organization', async () => {
    const soloEmail = 'org-mgmt+solo@systemvitals.com';
    await deleteAccount(soloEmail);
    const token = await signup(app, soloEmail);
    const me = (await gql(app, token, ME_ORGS)) as unknown as MeOrgs;
    const onlyOrg = me.data.me.organizations[0].id;

    const res = await gql(
      app,
      token,
      `mutation($organizationId: ID!) { deleteOrganization(organizationId: $organizationId) }`,
      { organizationId: onlyOrg },
    );
    expect(res.errors).toBeDefined();
    expect(res.errors?.[0].message).toMatch(/at least one organization/i);

    await deleteAccount(soloEmail);
  });

  it('transfers creatorship to an existing OWNER and rolls back an over-cap transfer', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const transferOwnerEmail = `org-transfer-owner-${suffix}@systemvitals.com`;
    const transferRecipientEmail = `org-transfer-recipient-${suffix}@systemvitals.com`;
    const createdUserIds: string[] = [];

    try {
      const ownerToken = await signup(app, transferOwnerEmail);
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: transferOwnerEmail },
      });
      createdUserIds.push(owner.id);
      const recipientToken = await signup(app, transferRecipientEmail);
      const recipient = await prisma.user.findUniqueOrThrow({
        where: { email: transferRecipientEmail },
      });
      createdUserIds.push(recipient.id);
      await prisma.subscription.update({
        where: { userId: recipient.id },
        data: { plan: 'SIGNAL' },
      });

      const created = await gql(
        app,
        ownerToken,
        `mutation {
        createOrganization(name: "Transfer Success") {
          id
        }
      }`,
      );
      const successOrgId = (created.data?.createOrganization as { id: string })
        .id;

      async function promoteRecipient(organizationId: string) {
        const invited = await gql(
          app,
          ownerToken,
          `mutation($organizationId: ID!, $email: String!, $role: String!) {
          inviteMember(organizationId: $organizationId, email: $email, role: $role) { token }
        }`,
          {
            organizationId,
            email: transferRecipientEmail,
            role: 'MEMBER',
          },
        );
        const inviteToken = (invited.data?.inviteMember as { token: string })
          .token;
        const accepted = await gql(
          app,
          recipientToken,
          `mutation($token: String!) {
          acceptInvite(token: $token) { id }
        }`,
          { token: inviteToken },
        );
        const membershipId = (accepted.data?.acceptInvite as { id: string }).id;
        const promoted = await gql(
          app,
          ownerToken,
          `mutation($membershipId: ID!, $role: String!) {
          updateMemberRole(membershipId: $membershipId, role: $role) { role }
        }`,
          { membershipId, role: 'OWNER' },
        );
        expect(promoted.errors).toBeUndefined();
      }

      await promoteRecipient(successOrgId);
      const transferred = await gql(
        app,
        ownerToken,
        `mutation($organizationId: ID!, $newCreatorUserId: ID!) {
        transferOrganizationCreatorship(
          organizationId: $organizationId
          newCreatorUserId: $newCreatorUserId
        ) {
          id name slug role plan creatorUserId creatorLabel
          projects { id name slug pingKey organizationId }
        }
      }`,
        { organizationId: successOrgId, newCreatorUserId: recipient.id },
      );
      expect(transferred.errors).toBeUndefined();
      expect(transferred.data?.transferOrganizationCreatorship).toMatchObject({
        id: successOrgId,
        role: 'OWNER',
        plan: 'SIGNAL',
        creatorUserId: recipient.id,
        creatorLabel: transferRecipientEmail,
        projects: [{ organizationId: successOrgId }],
      });
      const successfulMemberships = await prisma.membership.findMany({
        where: { organizationId: successOrgId },
        orderBy: { userId: 'asc' },
        select: { userId: true, role: true },
      });
      expect(successfulMemberships).toEqual(
        [
          { userId: owner.id, role: 'OWNER' },
          { userId: recipient.id, role: 'OWNER' },
        ].sort((a, b) => a.userId.localeCompare(b.userId)),
      );

      const overCapCreated = await gql(
        app,
        ownerToken,
        `mutation {
        createOrganization(name: "Transfer Over Cap") {
          id projects { id }
        }
      }`,
      );
      const overCapOrg = overCapCreated.data?.createOrganization as {
        id: string;
        projects: Array<{ id: string }>;
      };
      await promoteRecipient(overCapOrg.id);
      await prisma.check.createMany({
        data: [
          {
            name: 'One',
            slug: 'one',
            type: 'HEARTBEAT',
            projectId: overCapOrg.projects[0].id,
          },
          {
            name: 'Two',
            slug: 'two',
            type: 'HEARTBEAT',
            projectId: overCapOrg.projects[0].id,
          },
        ],
      });
      await prisma.subscription.update({
        where: { userId: recipient.id },
        data: {
          limits: { maxChecks: 1, minIntervalSeconds: 300 },
        },
      });

      const rejected = await gql(
        app,
        ownerToken,
        `mutation($organizationId: ID!, $newCreatorUserId: ID!) {
        transferOrganizationCreatorship(
          organizationId: $organizationId
          newCreatorUserId: $newCreatorUserId
        ) { creatorUserId }
      }`,
        { organizationId: overCapOrg.id, newCreatorUserId: recipient.id },
      );
      expect(rejected.errors?.[0].message).toMatch(/check limit/i);
      const unchanged = await prisma.organization.findUniqueOrThrow({
        where: { id: overCapOrg.id },
        select: { creatorUserId: true },
      });
      expect(unchanged.creatorUserId).toBe(owner.id);
    } finally {
      if (createdUserIds.length > 0) {
        await prisma.organization.deleteMany({
          where: { creatorUserId: { in: createdUserIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: createdUserIds } },
        });
      }
    }
  });
});
