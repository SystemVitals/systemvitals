import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';

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
  token: string | null,
  query: string,
  variables?: unknown,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { query, variables },
  });
  return JSON.parse(r.body) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
}

interface MeOrgs {
  data: { me: { organizations: Array<{ id: string }> } };
}

const ME_ORGS = `{ me { organizations { id } } }`;

describe('members (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  const owner = 'members+owner@systemvitals.com';
  const invitee = 'members+invitee@systemvitals.com';
  const stranger = 'members+stranger@systemvitals.com';
  const memberProbe = 'members+memberprobe@systemvitals.com';
  const rolesProbe = 'members+rolesprobe@systemvitals.com';
  const invitesProbe = 'members+invitesprobe@systemvitals.com';
  const emails = [
    owner,
    invitee,
    stranger,
    memberProbe,
    rolesProbe,
    invitesProbe,
  ];

  let ownerToken: string;
  let inviteeToken: string;
  let memberProbeToken: string;
  let rolesProbeToken: string;
  let invitesProbeToken: string;
  let orgId: string;

  /**
   * Invite `email` into the shared org and accept it as that user, so a test
   * that needs an existing member can create its own instead of depending on
   * one an earlier test happened to leave behind. Returns the invite token.
   */
  async function inviteAndAccept(
    email: string,
    theirToken: string,
    role: string,
  ): Promise<string> {
    const invited = await gql(
      app,
      ownerToken,
      `mutation($organizationId: ID!, $email: String!, $role: String!) {
        inviteMember(organizationId: $organizationId, email: $email, role: $role) { token }
      }`,
      { organizationId: orgId, email, role },
    );
    if (invited.errors) throw new Error(invited.errors[0].message);
    const token = (invited.data?.inviteMember as { token: string }).token;

    const accepted = await gql(
      app,
      theirToken,
      `mutation($token: String!) { acceptInvite(token: $token) { id } }`,
      { token },
    );
    if (accepted.errors) throw new Error(accepted.errors[0].message);
    return token;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, emails);

    ownerToken = await signup(app, owner);
    inviteeToken = await signup(app, invitee);
    memberProbeToken = await signup(app, memberProbe);
    rolesProbeToken = await signup(app, rolesProbe);
    invitesProbeToken = await signup(app, invitesProbe);

    const me = (await gql(app, ownerToken, ME_ORGS)) as unknown as MeOrgs;
    orgId = me.data.me.organizations[0].id;
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, emails);
    } finally {
      await app.close();
    }
  });

  it('a brand-new SOLO-plan org can invite and accept — membership is not plan-gated', async () => {
    // A fresh signup is on the SOLO plan; assert that explicitly.
    const sub = await gql(app, ownerToken, `{ mySubscription { plan } }`);
    expect((sub.data?.mySubscription as { plan: string }).plan).toBe('SOLO');

    const invited = await gql(
      app,
      ownerToken,
      `mutation($organizationId: ID!, $email: String!, $role: String!) {
        inviteMember(organizationId: $organizationId, email: $email, role: $role) {
          id email role token acceptUrl
        }
      }`,
      { organizationId: orgId, email: invitee, role: 'MEMBER' },
    );

    expect(invited.errors).toBeUndefined();
    const invite = invited.data?.inviteMember as {
      token: string;
      acceptUrl: string;
      email: string;
    };
    expect(invite.email).toBe(invitee);
    expect(invite.acceptUrl).toContain(`/invite/${invite.token}`);

    const accepted = await gql(
      app,
      inviteeToken,
      `mutation($token: String!) { acceptInvite(token: $token) { id email role } }`,
      { token: invite.token },
    );

    expect(accepted.errors).toBeUndefined();
    expect((accepted.data?.acceptInvite as { role: string }).role).toBe(
      'MEMBER',
    );

    const members = await gql(
      app,
      ownerToken,
      `query($organizationId: ID!) {
        organizationMembers(organizationId: $organizationId) { id email role }
      }`,
      { organizationId: orgId },
    );
    const rows = members.data?.organizationMembers as Array<{
      email: string;
      role: string;
    }>;
    // Assert membership, not an exact count: other tests add their own members
    // to this org, and this test must not depend on running before them.
    const byEmail = new Map(rows.map((r) => [r.email, r.role]));
    expect(byEmail.get(owner)).toBe('OWNER');
    expect(byEmail.get(invitee)).toBe('MEMBER');
  });

  it('invitePreview works without authentication and masks the email', async () => {
    const invited = await gql(
      app,
      ownerToken,
      `mutation($organizationId: ID!, $email: String!, $role: String!) {
        inviteMember(organizationId: $organizationId, email: $email, role: $role) { token }
      }`,
      { organizationId: orgId, email: stranger, role: 'MEMBER' },
    );
    const token = (invited.data?.inviteMember as { token: string }).token;

    const preview = await gql(
      app,
      null,
      `query($token: String!) {
        invitePreview(token: $token) { organizationName maskedEmail status }
      }`,
      { token },
    );

    expect(preview.errors).toBeUndefined();
    const p = preview.data?.invitePreview as {
      maskedEmail: string;
      status: string;
    };
    expect(p.status).toBe('PENDING');
    expect(p.maskedEmail).toBe('m***@systemvitals.com');
    expect(p.maskedEmail).not.toContain('members+stranger');
  });

  it('a plain MEMBER cannot invite', async () => {
    // Self-sufficient: create and accept this test's own MEMBER rather than
    // depending on a member left behind by an earlier test.
    const token = await inviteAndAccept(
      memberProbe,
      memberProbeToken,
      'MEMBER',
    );
    expect(token).toBeTruthy();

    const res = await gql(
      app,
      memberProbeToken,
      `mutation($organizationId: ID!, $email: String!, $role: String!) {
        inviteMember(organizationId: $organizationId, email: $email, role: $role) { id }
      }`,
      { organizationId: orgId, email: 'nope@systemvitals.com', role: 'MEMBER' },
    );

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0].message).toMatch(/owner or admin/i);
  });

  it('a plain MEMBER cannot list organization invites', async () => {
    // Self-sufficient: this test creates and accepts its OWN member rather
    // than reusing one an earlier test happened to leave behind. Without
    // this the assertion below would pass for the wrong reason -- a
    // non-member fails requireMembership with 'Not a member', not the
    // 'Requires owner or admin' this test is actually about.
    await inviteAndAccept(invitesProbe, invitesProbeToken, 'MEMBER');

    // organizationInvites is OWNER/ADMIN only — MembersService.listInvites
    // calls requireManager — because Invite.token is a plaintext bearer
    // secret and a plain member has no reason to hold tokens for invites
    // they can neither issue nor revoke.
    const res = await gql(
      app,
      invitesProbeToken,
      `query($organizationId: ID!) {
        organizationInvites(organizationId: $organizationId) { id email token }
      }`,
      { organizationId: orgId },
    );

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0].message).toMatch(/owner or admin/i);
  });

  it('the organization creator cannot leave before transferring creatorship', async () => {
    const res = await gql(
      app,
      ownerToken,
      `mutation($organizationId: ID!) { leaveOrganization(organizationId: $organizationId) }`,
      { organizationId: orgId },
    );

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0].message).toBe(
      'Transfer organization creatorship first',
    );
  });

  it('an owner can promote and remove a member', async () => {
    // Self-sufficient: this test creates the member it acts on.
    await inviteAndAccept(rolesProbe, rolesProbeToken, 'MEMBER');

    const members = await gql(
      app,
      ownerToken,
      `query($organizationId: ID!) {
        organizationMembers(organizationId: $organizationId) { id email role }
      }`,
      { organizationId: orgId },
    );
    const rows = members.data?.organizationMembers as Array<{
      id: string;
      email: string;
    }>;
    const membershipId = rows.find((r) => r.email === rolesProbe)!.id;

    const promoted = await gql(
      app,
      ownerToken,
      `mutation($membershipId: ID!, $role: String!) {
        updateMemberRole(membershipId: $membershipId, role: $role) { id role }
      }`,
      { membershipId, role: 'ADMIN' },
    );
    expect(promoted.errors).toBeUndefined();
    expect((promoted.data?.updateMemberRole as { role: string }).role).toBe(
      'ADMIN',
    );

    const removed = await gql(
      app,
      ownerToken,
      `mutation($membershipId: ID!) { removeMember(membershipId: $membershipId) }`,
      { membershipId },
    );
    expect(removed.errors).toBeUndefined();
    expect(removed.data?.removeMember).toBe(true);
  });
});
