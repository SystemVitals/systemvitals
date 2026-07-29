import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { generateToken } from '../src/tokens/token.util';
import { cleanupTestUsers } from './cleanup-test-users';

jest.setTimeout(60_000);

interface GraphQlResponse<T = Record<string, unknown>> {
  data?: T | null;
  errors?: Array<{
    message: string;
    locations?: unknown;
    path?: unknown;
    extensions?: Record<string, unknown>;
  }>;
}

interface Workspace {
  id: string;
  slug: string;
  projects: Array<{ id: string }>;
}

interface CheckResult {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  projectId: string;
  status: string;
}

const CHECK_FIELDS =
  'id name slug organizationId projectId status type pingSlug';

describe('organization workspace checks (e2e)', () => {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const ownerEmail = `organization-checks-${runId}-owner@example.test`;
  const outsiderEmail = `organization-checks-${runId}-outsider@example.test`;
  const fixtureEmails = [ownerEmail, outsiderEmail];
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let outsiderToken: string;
  let ownerId: string;
  let source: Workspace;
  let destination: Workspace;

  async function gql<T = Record<string, unknown>>(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQlResponse<T>> {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: { query, variables },
    });
    return JSON.parse(response.body) as GraphQlResponse<T>;
  }

  async function signup(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'supersecret1' },
    });
    return (JSON.parse(response.body) as { token: string }).token;
  }

  async function createHeartbeat(
    selector: { organizationId?: string; projectId?: string },
    name: string,
    token = ownerToken,
  ): Promise<GraphQlResponse<{ createCheck: CheckResult }>> {
    return gql(
      token,
      `mutation($organizationId: ID, $projectId: ID, $name: String!) {
        createCheck(
          organizationId: $organizationId
          projectId: $projectId
          name: $name
          graceSeconds: 30
          periodSeconds: 300
        ) { ${CHECK_FIELDS} }
      }`,
      { ...selector, name },
    );
  }

  async function createActive(
    selector: { organizationId?: string; projectId?: string },
    name: string,
    token = ownerToken,
  ): Promise<GraphQlResponse<{ createActiveCheck: CheckResult }>> {
    return gql(
      token,
      `mutation($organizationId: ID, $projectId: ID, $name: String!) {
        createActiveCheck(
          organizationId: $organizationId
          projectId: $projectId
          name: $name
          type: "HTTP"
          target: "https://example.test"
          intervalSeconds: 300
          timeoutMs: 5000
        ) { ${CHECK_FIELDS} }
      }`,
      { ...selector, name },
    );
  }

  async function listChecks(
    selector: { organizationId?: string; projectId?: string },
    token = ownerToken,
  ): Promise<GraphQlResponse<{ checks: CheckResult[] }>> {
    return gql(
      token,
      `query($organizationId: ID, $projectId: ID) {
        checks(organizationId: $organizationId, projectId: $projectId) {
          ${CHECK_FIELDS}
        }
      }`,
      selector,
    );
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, fixtureEmails);

    ownerToken = await signup(ownerEmail);
    outsiderToken = await signup(outsiderEmail);
    const me = await gql<{
      me: { id: string; organizations: Workspace[] };
    }>(ownerToken, `{ me { id organizations { id slug projects { id } } } }`);
    ownerId = me.data!.me.id;
    source = me.data!.me.organizations[0];
    await prisma.subscription.update({
      where: { userId: ownerId },
      data: { plan: 'FLEET', manualOverride: true },
    });

    const created = await gql<{ createOrganization: Workspace }>(
      ownerToken,
      `mutation {
        createOrganization(name: "Destination ${runId}") {
          id
          slug
          projects { id }
        }
      }`,
    );
    destination = created.data!.createOrganization;
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, fixtureEmails);
    } finally {
      await app.close();
    }
  });

  it('keeps canonical and deprecated list/create selectors compatible', async () => {
    const canonical = await createHeartbeat(
      { organizationId: source.id },
      'Canonical heartbeat',
    );
    const legacy = await createHeartbeat(
      { projectId: source.projects[0].id },
      'Legacy heartbeat',
    );
    const canonicalActive = await createActive(
      { organizationId: source.id },
      'Canonical active',
    );
    const legacyActive = await createActive(
      { projectId: source.projects[0].id },
      'Legacy active',
    );

    for (const response of [canonical, legacy, canonicalActive, legacyActive]) {
      expect(response.errors).toBeUndefined();
      const data = response.data;
      const check =
        data && 'createCheck' in data
          ? data.createCheck
          : data?.createActiveCheck;
      expect(check).toMatchObject({
        organizationId: source.id,
        projectId: source.projects[0].id,
      });
    }

    const byOrganization = await listChecks({ organizationId: source.id });
    const byProject = await listChecks({ projectId: source.projects[0].id });

    expect(byOrganization.errors).toBeUndefined();
    expect(byProject.errors).toBeUndefined();
    expect(byOrganization.data?.checks).toEqual(byProject.data?.checks);
    expect(byOrganization.data?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: canonical.data!.createCheck.id,
          organizationId: source.id,
          projectId: source.projects[0].id,
        }),
        expect.objectContaining({
          id: legacy.data!.createCheck.id,
          organizationId: source.id,
          projectId: source.projects[0].id,
        }),
      ]),
    );
  });

  it.each([
    ['both', { organizationId: 'source', projectId: 'source' }],
    ['neither', {}],
  ])(
    'rejects %s selectors for list and both create variants',
    async (_label, rawSelector) => {
      const raw = rawSelector as {
        organizationId?: string;
        projectId?: string;
      };
      const selector = {
        organizationId: raw.organizationId === 'source' ? source.id : undefined,
        projectId:
          raw.projectId === 'source' ? source.projects[0].id : undefined,
      };

      const responses = await Promise.all([
        listChecks(selector),
        createHeartbeat(selector, `Invalid heartbeat ${_label}`),
        createActive(selector, `Invalid active ${_label}`),
      ]);

      for (const response of responses) {
        expect(response.data).toBeNull();
        expect(response.errors?.[0]?.message).toBe(
          'Provide exactly one of organizationId or projectId',
        );
      }
    },
  );

  it('keeps project-bound tokens isolated after organization resolution and enforces capabilities', async () => {
    const readToken = generateToken();
    const writeToken = generateToken();
    await prisma.apiToken.createMany({
      data: [
        {
          name: 'Organization check read',
          prefix: readToken.prefix,
          tokenHash: readToken.hash,
          scopes: ['checks:read'],
          userId: ownerId,
          projectId: source.projects[0].id,
        },
        {
          name: 'Organization check write',
          prefix: writeToken.prefix,
          tokenHash: writeToken.hash,
          scopes: ['checks:write'],
          userId: ownerId,
          projectId: source.projects[0].id,
        },
      ],
    });

    const allowedRead = await listChecks(
      { organizationId: source.id },
      readToken.plaintext,
    );
    expect(allowedRead.errors).toBeUndefined();

    const isolatedRead = await listChecks(
      { organizationId: destination.id },
      readToken.plaintext,
    );
    expect(isolatedRead.errors?.[0]?.message).toBe(
      'Credential is bound to a different project',
    );

    const deniedWrite = await createHeartbeat(
      { organizationId: source.id },
      'Read token cannot write',
      readToken.plaintext,
    );
    expect(deniedWrite.errors?.[0]?.message).toBe(
      'Missing capability: checks:write',
    );

    const allowedWrite = await createHeartbeat(
      { organizationId: source.id },
      'Write token canonical',
      writeToken.plaintext,
    );
    expect(allowedWrite.errors).toBeUndefined();

    const isolatedWrite = await createHeartbeat(
      { organizationId: destination.id },
      'Write token isolated',
      writeToken.plaintext,
    );
    expect(isolatedWrite.errors?.[0]?.message).toBe(
      'Credential is bound to a different project',
    );
  });

  it('returns organizationId from resource-ID check paths', async () => {
    const created = await createHeartbeat(
      { organizationId: source.id },
      'Result mapping',
    );
    const id = created.data!.createCheck.id;

    const byId = await gql<{ check: CheckResult }>(
      ownerToken,
      `query($id: ID!) { check(id: $id) { ${CHECK_FIELDS} } }`,
      { id },
    );
    const paused = await gql<{ pauseCheck: CheckResult }>(
      ownerToken,
      `mutation($id: ID!) { pauseCheck(id: $id) { ${CHECK_FIELDS} } }`,
      { id },
    );
    const resumed = await gql<{ resumeCheck: CheckResult }>(
      ownerToken,
      `mutation($id: ID!) { resumeCheck(id: $id) { ${CHECK_FIELDS} } }`,
      { id },
    );
    const updated = await gql<{ updateCheck: CheckResult }>(
      ownerToken,
      `mutation($id: ID!) {
        updateCheck(id: $id, input: { name: "Mapped result" }) {
          ${CHECK_FIELDS}
        }
      }`,
      { id },
    );

    expect(byId.data?.check.organizationId).toBe(source.id);
    expect(paused.data?.pauseCheck.organizationId).toBe(source.id);
    expect(resumed.data?.resumeCheck.organizationId).toBe(source.id);
    expect(updated.data?.updateCheck.organizationId).toBe(source.id);
  });

  it('moves by canonical organization and retains the deprecated project destination', async () => {
    const canonical = await createHeartbeat(
      { organizationId: source.id },
      'Canonical move',
    );
    const canonicalMove = await gql<{ moveCheck: CheckResult }>(
      ownerToken,
      `mutation($checkId: ID!, $destinationOrganizationId: ID) {
        moveCheck(
          checkId: $checkId
          destinationOrganizationId: $destinationOrganizationId
        ) { ${CHECK_FIELDS} }
      }`,
      {
        checkId: canonical.data!.createCheck.id,
        destinationOrganizationId: destination.id,
      },
    );
    expect(canonicalMove.errors).toBeUndefined();
    expect(canonicalMove.data?.moveCheck).toMatchObject({
      organizationId: destination.id,
      projectId: destination.projects[0].id,
    });

    const sameOrganization = await gql<{ moveCheck: CheckResult }>(
      ownerToken,
      `mutation($checkId: ID!, $destinationOrganizationId: ID) {
        moveCheck(
          checkId: $checkId
          destinationOrganizationId: $destinationOrganizationId
        ) { id organizationId }
      }`,
      {
        checkId: canonical.data!.createCheck.id,
        destinationOrganizationId: destination.id,
      },
    );
    expect(sameOrganization.errors?.[0]?.message).toContain(
      'already in the destination organization',
    );

    const legacy = await createHeartbeat(
      { organizationId: source.id },
      'Legacy move',
    );
    const legacyMove = await gql<{ moveCheck: CheckResult }>(
      ownerToken,
      `mutation($checkId: ID!, $destinationProjectId: ID) {
        moveCheck(
          checkId: $checkId
          destinationProjectId: $destinationProjectId
        ) { ${CHECK_FIELDS} }
      }`,
      {
        checkId: legacy.data!.createCheck.id,
        destinationProjectId: destination.projects[0].id,
      },
    );
    expect(legacyMove.errors).toBeUndefined();
    expect(legacyMove.data?.moveCheck).toMatchObject({
      organizationId: destination.id,
      projectId: destination.projects[0].id,
    });
  });

  it('rejects both and neither move destinations before moving', async () => {
    const created = await createHeartbeat(
      { organizationId: source.id },
      'Invalid moves',
    );
    const mutation = `mutation(
      $checkId: ID!
      $destinationOrganizationId: ID
      $destinationProjectId: ID
    ) {
      moveCheck(
        checkId: $checkId
        destinationOrganizationId: $destinationOrganizationId
        destinationProjectId: $destinationProjectId
      ) { id }
    }`;

    const both = await gql(ownerToken, mutation, {
      checkId: created.data!.createCheck.id,
      destinationOrganizationId: destination.id,
      destinationProjectId: destination.projects[0].id,
    });
    const neither = await gql(ownerToken, mutation, {
      checkId: created.data!.createCheck.id,
    });
    for (const response of [both, neither]) {
      expect(response.errors?.[0]?.message).toBe(
        'Provide exactly one of organizationId or projectId',
      );
    }
    expect(
      await prisma.check.findUniqueOrThrow({
        where: { id: created.data!.createCheck.id },
        select: { projectId: true },
      }),
    ).toEqual({ projectId: source.projects[0].id });
  });

  it('makes canonical slug lookup non-disclosing', async () => {
    const owned = await createHeartbeat(
      { organizationId: source.id },
      'Canonical slug lookup',
    );
    const query = `query($orgSlug: String!, $checkSlug: String!) {
      checkByOrganizationSlug(orgSlug: $orgSlug, checkSlug: $checkSlug) {
        ${CHECK_FIELDS}
      }
    }`;
    const found = await gql<{ checkByOrganizationSlug: CheckResult }>(
      ownerToken,
      query,
      {
        orgSlug: source.slug,
        checkSlug: owned.data!.createCheck.slug,
      },
    );
    expect(found.errors).toBeUndefined();
    expect(found.data?.checkByOrganizationSlug).toMatchObject({
      id: owned.data!.createCheck.id,
      organizationId: source.id,
      projectId: source.projects[0].id,
    });

    const inaccessible = await gql(outsiderToken, query, {
      orgSlug: source.slug,
      checkSlug: owned.data!.createCheck.slug,
    });
    const missing = await gql(outsiderToken, query, {
      orgSlug: 'missing-organization',
      checkSlug: 'missing-check',
    });
    expect(inaccessible.errors).toEqual(missing.errors);
    expect(inaccessible.errors?.[0]?.message).toBe('Check not found');
    expect(inaccessible.errors?.[0]?.extensions?.status).toBe(404);
  });
});
