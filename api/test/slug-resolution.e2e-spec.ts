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
    errors?: Array<{
      message: string;
      locations?: unknown;
      path?: unknown;
      extensions?: Record<string, unknown>;
    }>;
  };
}

interface MeResult {
  me: {
    organizations: Array<{
      id: string;
      slug: string;
      projects: Array<{ id: string; slug: string }>;
    }>;
  };
}

const CHECK_FIELDS = `id name slug type status pingSlug`;

describe('slug resolution and editing (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  let tokenA: string;
  let orgASlug: string;
  let projectASlug: string;
  let projectAId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    tokenA = await signup(app, `slug-res-a+${Date.now()}@example.com`);
    const meA = await gql(
      app,
      tokenA,
      `query { me { organizations { id slug projects { id slug } } } }`,
    );
    const orgA = (meA.data as unknown as MeResult).me.organizations[0];
    orgASlug = orgA.slug;
    projectASlug = orgA.projects[0].slug;
    projectAId = orgA.projects[0].id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function newHeartbeat(
    name: string,
    token = tokenA,
    projectId = projectAId,
  ) {
    const r = await gql(
      app,
      token,
      `mutation ($p: ID!, $n: String!) {
         createCheck(projectId: $p, name: $n, graceSeconds: 60, periodSeconds: 300) { ${CHECK_FIELDS} }
       }`,
      { p: projectId, n: name },
    );
    return (
      r.data as { createCheck: { id: string; name: string; slug: string } }
    ).createCheck;
  }

  it('checkBySlug returns the same check as check(id) for a check the user owns', async () => {
    const check = await newHeartbeat('Owned Check');

    const byId = await gql(
      app,
      tokenA,
      `query ($id: ID!) { check(id: $id) { ${CHECK_FIELDS} } }`,
      { id: check.id },
    );

    const bySlug = await gql(
      app,
      tokenA,
      `query ($o: String!, $p: String!, $c: String!) {
         checkBySlug(orgSlug: $o, projectSlug: $p, checkSlug: $c) { ${CHECK_FIELDS} }
       }`,
      { o: orgASlug, p: projectASlug, c: check.slug },
    );

    expect(bySlug.errors).toBeUndefined();
    expect(bySlug.data?.checkBySlug).toEqual(byId.data?.check);
  });

  it('a triple belonging to another organization is indistinguishable from a nonexistent one', async () => {
    // A slug triple is guessable in a way a cuid is not. If "exists but I'm
    // not a member" produced a response an attacker could tell apart from
    // "does not exist" — a different message, a different GraphQL error
    // code, a different status — that difference becomes an oracle for
    // enumerating other tenants' organizations and checks. So this asserts
    // full structural equality of the two error payloads, not just that
    // neither one happens to say "forbidden".
    const tokenB = await signup(app, `slug-res-b+${Date.now()}@example.com`);
    const meB = await gql(
      app,
      tokenB,
      `query { me { organizations { id slug projects { id slug } } } }`,
    );
    const orgB = (meB.data as unknown as MeResult).me.organizations[0];
    const checkB = await newHeartbeat(
      'Other Org Check',
      tokenB,
      orgB.projects[0].id,
    );

    const query = `query ($o: String!, $p: String!, $c: String!) {
         checkBySlug(orgSlug: $o, projectSlug: $p, checkSlug: $c) { id }
       }`;

    const realOtherOrg = await gql(app, tokenA, query, {
      o: orgB.slug,
      p: orgB.projects[0].slug,
      c: checkB.slug,
    });

    const nonexistent = await gql(app, tokenA, query, {
      o: 'does-not-exist-org',
      p: 'does-not-exist-project',
      c: 'does-not-exist-check',
    });

    expect(realOtherOrg.data?.checkBySlug).toBeUndefined();
    expect(nonexistent.data?.checkBySlug).toBeUndefined();
    expect(realOtherOrg.errors?.length).toBe(1);
    expect(nonexistent.errors?.length).toBe(1);

    // Same query text and same variable shapes were used for both requests,
    // so `locations`/`path` are expected to match too — this is a full
    // structural comparison of everything the caller can observe, not a
    // cherry-picked subset.
    expect(realOtherOrg.errors).toEqual(nonexistent.errors);

    const err = realOtherOrg.errors?.[0];
    expect(err?.message).toBe('Check not found');
    expect(err?.extensions?.code).toBeDefined();
    expect(err?.extensions?.status).toBe(404);
  });

  it('updateCheck(input: { slug }) changes the slug, and the check resolves at the new slug and 404s at the old one', async () => {
    const check = await newHeartbeat('Renameable Check');
    const oldSlug = check.slug;

    const r = await gql(
      app,
      tokenA,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: { slug: "renamed" }) { ${CHECK_FIELDS} }
       }`,
      { id: check.id },
    );
    expect(r.errors).toBeUndefined();
    expect((r.data?.updateCheck as { slug: string }).slug).toBe('renamed');

    const atNewSlug = await gql(
      app,
      tokenA,
      `query ($o: String!, $p: String!, $c: String!) {
         checkBySlug(orgSlug: $o, projectSlug: $p, checkSlug: $c) { id }
       }`,
      { o: orgASlug, p: projectASlug, c: 'renamed' },
    );
    expect(atNewSlug.errors).toBeUndefined();
    expect((atNewSlug.data?.checkBySlug as { id: string }).id).toBe(check.id);

    const atOldSlug = await gql(
      app,
      tokenA,
      `query ($o: String!, $p: String!, $c: String!) {
         checkBySlug(orgSlug: $o, projectSlug: $p, checkSlug: $c) { id }
       }`,
      { o: orgASlug, p: projectASlug, c: oldSlug },
    );
    expect(atOldSlug.data?.checkBySlug).toBeUndefined();
    expect(atOldSlug.errors?.[0]?.message).toBeTruthy();
  });

  it('a user-supplied slug that collides within the project is rejected, naming the conflict', async () => {
    const first = await newHeartbeat('Collision Target');
    const second = await newHeartbeat('Collision Source');

    const r = await gql(
      app,
      tokenA,
      `mutation ($id: ID!, $slug: String!) {
         updateCheck(id: $id, input: { slug: $slug }) { slug }
       }`,
      { id: second.id, slug: first.slug },
    );

    expect(r.data?.updateCheck).toBeUndefined();
    expect(r.errors?.[0]?.message).toMatch(new RegExp(first.slug));

    // Confirm it did NOT silently become "<slug>-2".
    const reread = await prisma.check.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(reread.slug).not.toBe(`${first.slug}-2`);
    expect(reread.slug).not.toBe(first.slug);
  });

  it('an invalid slug ("Not A Slug") is rejected', async () => {
    const check = await newHeartbeat('Invalid Slug Target');
    const r = await gql(
      app,
      tokenA,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: { slug: "Not A Slug" }) { slug }
       }`,
      { id: check.id },
    );
    expect(r.data?.updateCheck).toBeUndefined();
    expect(r.errors?.[0]?.message).toBeTruthy();
  });

  it('updateOrganizationSlug changes the org slug', async () => {
    const token = await signup(app, `slug-res-org+${Date.now()}@example.com`);
    const me = await gql(app, token, `{ me { organizations { id } } }`);
    const orgId = (me.data as { me: { organizations: Array<{ id: string }> } })
      .me.organizations[0].id;
    const newSlug = `renamed-org-${Date.now()}`;

    const r = await gql(
      app,
      token,
      `mutation($organizationId: ID!, $slug: String!) { updateOrganizationSlug(organizationId: $organizationId, slug: $slug) { id slug } }`,
      { organizationId: orgId, slug: newSlug },
    );

    expect(r.errors).toBeUndefined();
    expect((r.data?.updateOrganizationSlug as { slug: string }).slug).toBe(
      newSlug,
    );
  });

  it('updateOrganizationSlug("admin") is rejected as reserved', async () => {
    const token = await signup(
      app,
      `slug-res-reserved+${Date.now()}@example.com`,
    );
    const me = await gql(app, token, `{ me { organizations { id } } }`);
    const orgId = (me.data as { me: { organizations: Array<{ id: string }> } })
      .me.organizations[0].id;

    const r = await gql(
      app,
      token,
      `mutation($organizationId: ID!) { updateOrganizationSlug(organizationId: $organizationId, slug: "admin") { id slug } }`,
      { organizationId: orgId },
    );

    expect(r.data?.updateOrganizationSlug).toBeUndefined();
    expect(r.errors?.[0]?.message).toBeTruthy();
  });

  it('updateOrganizationSlug returns a model where `projects` can be selected', async () => {
    const token = await signup(
      app,
      `slug-res-projects+${Date.now()}@example.com`,
    );
    const me = await gql(app, token, `{ me { organizations { id } } }`);
    const orgId = (me.data as { me: { organizations: Array<{ id: string }> } })
      .me.organizations[0].id;
    const newSlug = `renamed-org-projects-${Date.now()}`;

    const r = await gql(
      app,
      token,
      `mutation($organizationId: ID!, $slug: String!) {
         updateOrganizationSlug(organizationId: $organizationId, slug: $slug) {
           id
           slug
           projects { id name slug pingKey }
         }
       }`,
      { organizationId: orgId, slug: newSlug },
    );

    expect(r.errors).toBeUndefined();
    const org = r.data?.updateOrganizationSlug as {
      slug: string;
      projects: Array<{ id: string; slug: string }>;
    };
    expect(org.slug).toBe(newSlug);
    expect(Array.isArray(org.projects)).toBe(true);
    expect(org.projects.length).toBeGreaterThan(0);
  });

  it('updateOrganizationSlug renames the org the caller specifies even when they belong to more than one organization (no longer ambiguous)', async () => {
    const token = await signup(
      app,
      `slug-res-multiorg+${Date.now()}@example.com`,
    );
    const me = await gql(
      app,
      token,
      `query { me { id organizations { id slug } } }`,
    );
    const meData = me.data as unknown as {
      me: { id: string; organizations: MeResult['me']['organizations'] };
    };
    const userId = meData.me.id;
    const firstOrgId = meData.me.organizations[0].id;
    const firstOrgSlug = meData.me.organizations[0].slug;

    // Teams-on-all-plans (multiple memberships per user) isn't wired up to
    // any mutation yet, so simulate the state directly against the isolated
    // test database: create a second organization and add the same user as
    // a member of it. This is the exact multi-org scenario the old
    // ambiguity check used to reject outright; with an explicit
    // organizationId there is nothing left to disambiguate.
    const secondOrg = await prisma.organization.create({
      data: {
        name: 'Second Org',
        slug: `second-org-${Date.now()}`,
        creatorUserId: userId,
        memberships: {
          create: { userId, role: 'OWNER' },
        },
      },
    });

    const newSlug = `multi-org-rename-${Date.now()}`;
    const r = await gql(
      app,
      token,
      `mutation($organizationId: ID!, $slug: String!) { updateOrganizationSlug(organizationId: $organizationId, slug: $slug) { id slug } }`,
      { organizationId: firstOrgId, slug: newSlug },
    );

    expect(r.errors).toBeUndefined();
    expect((r.data?.updateOrganizationSlug as { slug: string }).slug).toBe(
      newSlug,
    );

    // Confirm only the targeted org was renamed; the second org and its
    // slug are untouched.
    const rereadFirst = await prisma.organization.findUniqueOrThrow({
      where: { id: firstOrgId },
    });
    expect(rereadFirst.slug).toBe(newSlug);
    expect(rereadFirst.slug).not.toBe(firstOrgSlug);

    const rereadSecond = await prisma.organization.findUniqueOrThrow({
      where: { id: secondOrg.id },
    });
    expect(rereadSecond.slug).toBe(secondOrg.slug);
  });
});
