import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';
import { generateToken, hashToken } from '../src/tokens/token.util';

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    path?: Array<string | number>;
    extensions?: { status?: number; [key: string]: unknown };
  }>;
}

interface CreateApiTokenResult {
  id: string;
  name: string;
  prefix: string;
  plaintext: string;
  scopes: string[];
  projectId: string | null;
  projectName: string | null;
  organizationName: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface ApiCredentialResult {
  authKind: string;
  credentialMode: 'SESSION' | 'LEGACY_BROAD' | 'PROJECT_SCOPED';
  capabilities: string[];
  projectId: string | null;
  projectName: string | null;
}

const TOKEN_FIELDS = `
  id name prefix scopes projectId projectName organizationName
  expiresAt lastUsedAt revokedAt createdAt
`;

async function signup(app: NestFastifyApplication, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(res.body) as { token: string }).token;
}

async function gql<T>(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
  url = '/graphql',
): Promise<GqlResponse<T>> {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(res.body) as GqlResponse<T>;
}

describe('api tokens (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = 'tokens@systemvitals.com';
  const email2 = email.replace('@', '+2@');

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, [email, email2]);
  });

  afterEach(async () => {
    await cleanupTestUsers(prisma, [email, email2]);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [email, email2]);
    } finally {
      await app.close();
    }
  });

  async function signupWithProject(targetEmail = email) {
    const jwt = await signup(app, targetEmail);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: targetEmail },
      include: {
        memberships: {
          include: { organization: { include: { projects: true } } },
        },
      },
    });
    const organization = user.memberships[0].organization;
    return { jwt, user, organization, project: organization.projects[0] };
  }

  async function createScoped(
    jwt: string,
    input: {
      name: string;
      capabilities: string[];
      projectId: string;
      expirationDays?: number;
    },
  ) {
    return gql<{ createScopedApiToken: CreateApiTokenResult }>(
      app,
      jwt,
      `mutation($input:CreateApiTokenInput!){
        createScopedApiToken(input:$input){ ${TOKEN_FIELDS} plaintext }
      }`,
      { input },
    );
  }

  async function createTokenRecord(
    userId: string,
    scopes: string[],
    projectId: string | null,
  ): Promise<string> {
    const { plaintext, prefix, hash } = generateToken();
    await prisma.apiToken.create({
      data: {
        name: scopes.join(','),
        prefix,
        tokenHash: hash,
        scopes,
        userId,
        projectId,
      },
    });
    return plaintext;
  }

  it('preserves legacy broad-token creation and authentication', async () => {
    const { jwt } = await signupWithProject();
    const created = await gql<{ createApiToken: CreateApiTokenResult }>(
      app,
      jwt,
      `mutation($n:String!,$s:[String!]!){
        createApiToken(name:$n, scopes:$s){ prefix plaintext scopes }
      }`,
      { n: 'ci', s: ['read', 'write'] },
    );
    const plaintext = created.data!.createApiToken.plaintext;
    expect(plaintext).toMatch(/^svt_[0-9a-f]{40}$/);

    const health = await gql<{ health: string }>(app, plaintext, `{ health }`);
    expect(health.data!.health).toBe('ok');
  });

  it('describes session, scoped, and legacy credentials without exposing secrets', async () => {
    const { jwt, user, project } = await signupWithProject();
    const scoped = await createTokenRecord(
      user.id,
      ['checks:write', 'checks:read', 'checks:write'],
      project.id,
    );
    const legacyRead = await createTokenRecord(user.id, ['read'], null);
    const legacyWrite = await createTokenRecord(user.id, ['write'], null);
    const unboundExplicit = await createTokenRecord(
      user.id,
      ['checks:read', 'checks:write'],
      null,
    );
    const query = `{
      apiCredential { authKind credentialMode capabilities projectId projectName }
    }`;

    await expect(
      gql<{ apiCredential: ApiCredentialResult }>(app, jwt, query),
    ).resolves.toMatchObject({
      data: {
        apiCredential: {
          authKind: 'session',
          credentialMode: 'SESSION',
          capabilities: [],
          projectId: null,
          projectName: null,
        },
      },
    });
    await expect(
      gql<{ apiCredential: ApiCredentialResult }>(app, scoped, query),
    ).resolves.toMatchObject({
      data: {
        apiCredential: {
          authKind: 'api-token',
          credentialMode: 'PROJECT_SCOPED',
          capabilities: ['checks:read', 'checks:write'],
          projectId: project.id,
          projectName: project.name,
        },
      },
    });
    await expect(
      gql<{ apiCredential: ApiCredentialResult }>(app, legacyRead, query),
    ).resolves.toMatchObject({
      data: {
        apiCredential: {
          authKind: 'api-token',
          credentialMode: 'LEGACY_BROAD',
          capabilities: ['checks:read'],
          projectId: null,
          projectName: null,
        },
      },
    });
    await expect(
      gql<{ apiCredential: ApiCredentialResult }>(app, legacyWrite, query),
    ).resolves.toMatchObject({
      data: {
        apiCredential: {
          authKind: 'api-token',
          credentialMode: 'LEGACY_BROAD',
          capabilities: ['checks:read', 'checks:write'],
          projectId: null,
          projectName: null,
        },
      },
    });
    await expect(
      gql<{ apiCredential: ApiCredentialResult }>(app, unboundExplicit, query),
    ).resolves.toMatchObject({
      data: null,
      errors: [
        expect.objectContaining({
          message: 'Scoped credential is missing a project binding',
        }),
      ],
    });

    const secretFields = await gql(
      app,
      scoped,
      `{ apiCredential { hash plaintext tokenHash userId email scopes } }`,
    );
    expect(secretFields.data).toBeUndefined();
    expect(secretFields.errors).toHaveLength(6);
  });

  it('rejects check capabilities on the unbound legacy token mutation', async () => {
    const { jwt, user } = await signupWithProject();

    for (const scopes of [
      ['checks:read'],
      ['checks:write'],
      ['read', 'checks:write'],
    ]) {
      const response = await gql(
        app,
        jwt,
        `mutation($scopes:[String!]!){
          createApiToken(name:"malformed", scopes:$scopes){ id }
        }`,
        { scopes },
      );

      expect(response.data).toBeNull();
      expect(response.errors?.[0]?.message).toBe(
        'Check capabilities require a project-scoped token',
      );
    }

    expect(
      await prisma.apiToken.count({
        where: { userId: user.id, name: 'malformed' },
      }),
    ).toBe(0);
  });

  it.each([[[]], [['unknown']], [['read', 'unknown']]])(
    'rejects unsupported legacy token scopes %j',
    async (scopes) => {
      const { jwt, user } = await signupWithProject();
      const response = await gql(
        app,
        jwt,
        `mutation($scopes:[String!]!){
          createApiToken(name:"unsupported", scopes:$scopes){ id }
        }`,
        { scopes },
      );

      expect(response.data).toBeNull();
      expect(response.errors?.[0]?.message).toBe(
        'Legacy tokens support only read and write scopes',
      );
      expect(
        await prisma.apiToken.count({
          where: { userId: user.id, name: 'unsupported' },
        }),
      ).toBe(0);
    },
  );

  it('does not authenticate revoked or expired credentials for apiCredential', async () => {
    const { user } = await signupWithProject();
    const revoked = await createTokenRecord(user.id, ['read'], null);
    const expired = await createTokenRecord(user.id, ['read'], null);
    await prisma.apiToken.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date() },
    });
    await prisma.apiToken.update({
      where: { tokenHash: hashToken(expired) },
      data: { revokedAt: null, expiresAt: new Date(Date.now() - 60_000) },
    });

    for (const [token, expectedMessage] of [
      [revoked, 'Credential revoked'],
      [expired, 'Credential expired'],
    ]) {
      const response = await gql(app, token, `{ apiCredential { authKind } }`);
      expect(response.data).toBeNull();
      expect(response.errors?.[0]?.message).toBe(expectedMessage);
    }
  });

  it('enforces a scoped token project on every check read and mutation path', async () => {
    const { user, project: projectA } = await signupWithProject();
    const organizationB = await prisma.organization.create({
      data: {
        name: 'Project B organization',
        slug: `project-b-org-${Date.now()}`,
        creatorUserId: user.id,
        memberships: {
          create: { userId: user.id, role: 'OWNER' },
        },
      },
    });
    const projectB = await prisma.project.create({
      data: {
        name: 'Project B',
        slug: `project-b-${Date.now()}`,
        organizationId: organizationB.id,
      },
    });
    const checkB = await prisma.check.create({
      data: {
        name: 'Project B check',
        slug: 'project-b-check',
        type: 'HEARTBEAT',
        status: 'NEW',
        projectId: projectB.id,
        pingSlug: `project-b-ping-${Date.now()}`,
        periodSeconds: 300,
        graceSeconds: 60,
      },
    });
    await prisma.checkEvent.create({
      data: { checkId: checkB.id, status: 'UP' },
    });
    const token = await createTokenRecord(
      user.id,
      ['checks:read', 'checks:write'],
      projectA.id,
    );

    const operations: Array<[string, string, Record<string, unknown>]> = [
      [
        'list',
        `query($projectId:ID!){ checks(projectId:$projectId){ id } }`,
        { projectId: projectB.id },
      ],
      [
        'read ID',
        `query($id:ID!){ check(id:$id){ id events { id } } }`,
        { id: checkB.id },
      ],
      [
        'update',
        `mutation($id:ID!){ updateCheck(id:$id,input:{name:"Denied"}){ id } }`,
        { id: checkB.id },
      ],
      [
        'pause',
        `mutation($id:ID!){ pauseCheck(id:$id){ id } }`,
        { id: checkB.id },
      ],
      [
        'resume',
        `mutation($id:ID!){ resumeCheck(id:$id){ id } }`,
        { id: checkB.id },
      ],
      ['delete', `mutation($id:ID!){ deleteCheck(id:$id) }`, { id: checkB.id }],
      [
        'create heartbeat',
        `mutation($projectId:ID!){
          createCheck(
            projectId:$projectId,name:"Denied heartbeat",
            periodSeconds:300,graceSeconds:60
          ){ id }
        }`,
        { projectId: projectB.id },
      ],
      [
        'create cron',
        `mutation($projectId:ID!){
          createCheck(
            projectId:$projectId,name:"Denied cron",
            schedule:"0 * * * *",tz:"UTC",graceSeconds:60
          ){ id }
        }`,
        { projectId: projectB.id },
      ],
      [
        'create HTTP',
        `mutation($projectId:ID!){
          createActiveCheck(
            projectId:$projectId,name:"Denied HTTP",type:"HTTP",
            target:"https://example.com",intervalSeconds:300,timeoutMs:5000
          ){ id }
        }`,
        { projectId: projectB.id },
      ],
      [
        'create TCP',
        `mutation($projectId:ID!){
          createActiveCheck(
            projectId:$projectId,name:"Denied TCP",type:"TCP",
            target:"example.com:443",intervalSeconds:300,timeoutMs:5000
          ){ id }
        }`,
        { projectId: projectB.id },
      ],
    ];

    const slugQuery = `query($org:String!,$project:String!,$check:String!){
      checkBySlug(orgSlug:$org,projectSlug:$project,checkSlug:$check){
        id events { id }
      }
    }`;
    const outOfScopeSlug = await gql<{ checkBySlug?: { id: string } }>(
      app,
      token,
      slugQuery,
      {
        org: organizationB.slug,
        project: projectB.slug,
        check: checkB.slug,
      },
    );
    const missingSlug = await gql<{ checkBySlug?: { id: string } }>(
      app,
      token,
      slugQuery,
      {
        org: 'missing-organization',
        project: 'missing-project',
        check: 'missing-check',
      },
    );

    expect(outOfScopeSlug.data?.checkBySlug).toBeUndefined();
    expect(missingSlug.data?.checkBySlug).toBeUndefined();
    expect(outOfScopeSlug.errors).toEqual(missingSlug.errors);
    expect(outOfScopeSlug.errors?.[0]?.message).toBe('Check not found');
    expect(outOfScopeSlug.errors?.[0]?.extensions?.status).toBe(404);

    for (const [label, query, variables] of operations) {
      const response = await gql(app, token, query, variables);
      expect({ label, data: response.data }).toEqual({
        label,
        data: null,
      });
      expect({ label, message: response.errors?.[0]?.message }).toEqual({
        label,
        message: 'Credential is bound to a different project',
      });
    }

    expect(
      await prisma.check.findUniqueOrThrow({ where: { id: checkB.id } }),
    ).toMatchObject({ name: 'Project B check', status: 'NEW' });
    expect(
      await prisma.check.count({ where: { projectId: projectB.id } }),
    ).toBe(1);
  });

  it('denies scoped tokens from every non-check API surface, including admin', async () => {
    const { user, organization, project } = await signupWithProject();
    await prisma.user.update({
      where: { id: user.id },
      data: { isAdmin: true },
    });
    const token = await createTokenRecord(
      user.id,
      ['checks:read', 'checks:write'],
      project.id,
    );

    const operations: Array<
      [string, string, Record<string, unknown> | undefined]
    > = [
      ['organization', `{ me { id } }`, undefined],
      ['project', `{ projects { id } }`, undefined],
      [
        'channel',
        `query($projectId:ID!){ channels(projectId:$projectId){ id } }`,
        { projectId: project.id },
      ],
      [
        'member',
        `query($organizationId:ID!){
          organizationMembers(organizationId:$organizationId){ id }
        }`,
        { organizationId: organization.id },
      ],
      [
        'status page',
        `query($projectId:ID!){ statusPages(projectId:$projectId){ id } }`,
        { projectId: project.id },
      ],
      ['billing', `{ mySubscription { plan } }`, undefined],
    ];

    for (const [label, query, variables] of operations) {
      const response = await gql(app, token, query, variables);
      expect({ label, data: response.data }).toEqual({ label, data: null });
      expect({ label, message: response.errors?.[0]?.message }).toEqual({
        label,
        message: 'Scoped credential cannot access this operation',
      });
    }

    for (const [label, query] of [
      ['token list', `{ apiTokens { id } }`],
      [
        'token creation',
        `mutation {
          createApiToken(name:"escape", scopes:["read","write"]){ id }
        }`,
      ],
    ]) {
      const response = await gql(app, token, query);
      expect({ label, data: response.data }).toEqual({ label, data: null });
      expect(response.errors?.[0]?.message).toMatch(/unauthorized/i);
    }

    const admin = await gql(
      app,
      token,
      `{ adminPing }`,
      undefined,
      '/admin/graphql',
    );
    expect(admin.data).toBeNull();
    expect(admin.errors?.[0]?.message).toBe(
      'Scoped credential cannot access this operation',
    );
  });

  it('allows checks:read but rejects every check mutation', async () => {
    const { user, project } = await signupWithProject();
    const check = await prisma.check.create({
      data: {
        name: 'Read only',
        slug: 'read-only',
        type: 'HEARTBEAT',
        status: 'NEW',
        projectId: project.id,
        pingSlug: `read-only-${Date.now()}`,
        periodSeconds: 300,
        graceSeconds: 60,
      },
    });
    const token = await createTokenRecord(user.id, ['checks:read'], project.id);

    const read = await gql<{ check: { id: string } }>(
      app,
      token,
      `query($id:ID!){ check(id:$id){ id } }`,
      { id: check.id },
    );
    expect(read.data?.check.id).toBe(check.id);

    const mutations = [
      `mutation($id:ID!){ updateCheck(id:$id,input:{name:"Denied"}){ id } }`,
      `mutation($id:ID!){ pauseCheck(id:$id){ id } }`,
      `mutation($id:ID!){ resumeCheck(id:$id){ id } }`,
      `mutation($id:ID!){ deleteCheck(id:$id) }`,
    ];
    for (const mutation of mutations) {
      const response = await gql(app, token, mutation, { id: check.id });
      expect(response.data).toBeNull();
      expect(response.errors?.[0]?.message).toBe(
        'Missing capability: checks:write',
      );
    }
    for (const mutation of [
      `mutation($projectId:ID!){
        createCheck(
          projectId:$projectId,name:"Denied",periodSeconds:300,graceSeconds:60
        ){ id }
      }`,
      `mutation($projectId:ID!){
        createCheck(
          projectId:$projectId,name:"Denied cron",
          schedule:"0 * * * *",tz:"UTC",graceSeconds:60
        ){ id }
      }`,
      `mutation($projectId:ID!){
        createActiveCheck(
          projectId:$projectId,name:"Denied",type:"HTTP",
          target:"https://example.com",intervalSeconds:300,timeoutMs:5000
        ){ id }
      }`,
    ]) {
      const response = await gql(app, token, mutation, {
        projectId: project.id,
      });
      expect(response.data).toBeNull();
      expect(response.errors?.[0]?.message).toBe(
        'Missing capability: checks:write',
      );
    }
  });

  it('allows the full checks preset to create every supported check type', async () => {
    const { user, project } = await signupWithProject();
    const token = await createTokenRecord(
      user.id,
      ['checks:read', 'checks:write'],
      project.id,
    );

    const heartbeat = await gql<{ createCheck: { type: string } }>(
      app,
      token,
      `mutation($projectId:ID!){
        createCheck(
          projectId:$projectId,name:"Heartbeat",periodSeconds:300,graceSeconds:60
        ){ type }
      }`,
      { projectId: project.id },
    );
    expect(heartbeat.data?.createCheck.type).toBe('HEARTBEAT');

    const cron = await gql<{
      createCheck: { type: string; schedule: string; tz: string };
    }>(
      app,
      token,
      `mutation($projectId:ID!){
        createCheck(
          projectId:$projectId,name:"Cron",schedule:"0 * * * *",
          tz:"UTC",graceSeconds:60
        ){ type schedule tz }
      }`,
      { projectId: project.id },
    );
    expect(cron.data?.createCheck).toMatchObject({
      type: 'HEARTBEAT',
      schedule: '0 * * * *',
      tz: 'UTC',
    });

    for (const [type, target] of [
      ['HTTP', 'https://example.com'],
      ['TCP', 'example.com:443'],
    ]) {
      const active = await gql<{ createActiveCheck: { type: string } }>(
        app,
        token,
        `mutation($projectId:ID!,$type:String!,$target:String!){
          createActiveCheck(
            projectId:$projectId,name:$type,type:$type,target:$target,
            intervalSeconds:300,timeoutMs:5000
          ){ type }
        }`,
        { projectId: project.id, type, target },
      );
      expect(active.data?.createActiveCheck.type).toBe(type);
    }
  });

  it('requires checks:read on events after a write-only token reaches its parent', async () => {
    const { user, project } = await signupWithProject();
    const token = await createTokenRecord(
      user.id,
      ['checks:write'],
      project.id,
    );

    const response = await gql(
      app,
      token,
      `mutation($projectId:ID!){
        createCheck(
          projectId:$projectId,name:"Write-only parent",
          periodSeconds:300,graceSeconds:60
        ){ id events { id } }
      }`,
      { projectId: project.id },
    );

    expect(response.data).toBeNull();
    expect(response.errors?.[0]?.message).toBe(
      'Missing capability: checks:read',
    );
    expect(response.errors?.[0]?.path).toEqual(['createCheck', 'events']);
    expect(
      await prisma.check.findFirst({
        where: { projectId: project.id, name: 'Write-only parent' },
      }),
    ).not.toBeNull();
  });

  it('retains membership defense when a forged token matches another owner project', async () => {
    const first = await signupWithProject();
    const second = await signupWithProject(email2);
    const otherCheck = await prisma.check.create({
      data: {
        name: 'Other owner check',
        slug: 'other-owner-check',
        type: 'HEARTBEAT',
        status: 'NEW',
        projectId: second.project.id,
        pingSlug: `other-owner-${Date.now()}`,
        periodSeconds: 300,
        graceSeconds: 60,
      },
    });
    const forged = await createTokenRecord(
      first.user.id,
      ['checks:read', 'checks:write'],
      second.project.id,
    );

    for (const [query, variables] of [
      [
        `query($projectId:ID!){ checks(projectId:$projectId){ id } }`,
        { projectId: second.project.id },
      ],
      [`query($id:ID!){ check(id:$id){ id } }`, { id: otherCheck.id }],
      [
        `mutation($projectId:ID!){
          createCheck(
            projectId:$projectId,name:"Forged create",
            periodSeconds:300,graceSeconds:60
          ){ id }
        }`,
        { projectId: second.project.id },
      ],
    ] as const) {
      const response = await gql(app, forged, query, variables);
      expect(response.data).toBeNull();
      expect(response.errors?.[0]?.message).toBe(
        'Credential project is no longer accessible',
      );
    }

    expect(
      await prisma.check.count({ where: { projectId: second.project.id } }),
    ).toBe(1);
  });

  it('uses shared account quota enforcement for scoped-token creation', async () => {
    const { user, project } = await signupWithProject();
    await prisma.subscription.update({
      where: { userId: user.id },
      data: { limits: { maxChecks: 1, minIntervalSeconds: 300 } },
    });
    await prisma.check.create({
      data: {
        name: 'Quota occupant',
        slug: 'quota-occupant',
        type: 'HEARTBEAT',
        status: 'NEW',
        projectId: project.id,
        pingSlug: `quota-occupant-${Date.now()}`,
        periodSeconds: 300,
        graceSeconds: 60,
      },
    });
    const token = await createTokenRecord(
      user.id,
      ['checks:read', 'checks:write'],
      project.id,
    );

    const response = await gql(
      app,
      token,
      `mutation($projectId:ID!){
        createCheck(
          projectId:$projectId,name:"Over quota",
          periodSeconds:300,graceSeconds:60
        ){ id }
      }`,
      { projectId: project.id },
    );

    expect(response.data).toBeNull();
    expect(response.errors?.[0]?.message).toMatch(/plan limit of 1 check/i);
    expect(await prisma.check.count({ where: { projectId: project.id } })).toBe(
      1,
    );
  });

  it('preserves legacy read/write policy and session JWT behavior for checks', async () => {
    const { jwt, user, project } = await signupWithProject();
    const check = await prisma.check.create({
      data: {
        name: 'Legacy',
        slug: 'legacy',
        type: 'HEARTBEAT',
        status: 'NEW',
        projectId: project.id,
        pingSlug: `legacy-${Date.now()}`,
        periodSeconds: 300,
        graceSeconds: 60,
      },
    });
    const legacyRead = await createTokenRecord(user.id, ['read'], null);
    const legacyWrite = await createTokenRecord(user.id, ['write'], null);

    const read = await gql<{ check: { id: string } }>(
      app,
      legacyRead,
      `query($id:ID!){ check(id:$id){ id } }`,
      { id: check.id },
    );
    expect(read.data?.check.id).toBe(check.id);
    const denied = await gql(
      app,
      legacyRead,
      `mutation($id:ID!){ pauseCheck(id:$id){ id } }`,
      { id: check.id },
    );
    expect(denied.errors?.[0]?.message).toBe(
      'Missing capability: checks:write',
    );

    const legacyMutation = await gql<{ pauseCheck: { status: string } }>(
      app,
      legacyWrite,
      `mutation($id:ID!){ pauseCheck(id:$id){ status } }`,
      { id: check.id },
    );
    expect(legacyMutation.data?.pauseCheck.status).toBe('PAUSED');
    const legacyWriteRead = await gql<{ check: { id: string } }>(
      app,
      legacyWrite,
      `query($id:ID!){ check(id:$id){ id } }`,
      { id: check.id },
    );
    expect(legacyWriteRead.data?.check.id).toBe(check.id);

    const legacyAccount = await gql<{ me: { id: string } }>(
      app,
      legacyRead,
      `{ me { id } }`,
    );
    expect(legacyAccount.data?.me.id).toBe(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: { isAdmin: true },
    });
    const legacyAdmin = await gql<{ adminPing: string }>(
      app,
      legacyRead,
      `{ adminPing }`,
      undefined,
      '/admin/graphql',
    );
    expect(legacyAdmin.data?.adminPing).toBe('ok');

    const sessionMutation = await gql<{ resumeCheck: { status: string } }>(
      app,
      jwt,
      `mutation($id:ID!){ resumeCheck(id:$id){ status } }`,
      { id: check.id },
    );
    expect(sessionMutation.data?.resumeCheck.status).toBe('NEW');
  });

  it('creates a scoped connection with normalized capabilities and no default expiration', async () => {
    const { jwt, organization, project } = await signupWithProject();
    const response = await createScoped(jwt, {
      name: 'Agent',
      capabilities: ['checks:write', 'checks:read', 'checks:write'],
      projectId: project.id,
    });

    expect(response.errors).toBeUndefined();
    expect(response.data!.createScopedApiToken).toMatchObject({
      name: 'Agent',
      scopes: ['checks:read', 'checks:write'],
      projectId: project.id,
      projectName: project.name,
      organizationName: organization.name,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(response.data!.createScopedApiToken.plaintext).toMatch(
      /^svt_[0-9a-f]{40}$/,
    );
  });

  it('calculates a 30-day expiration from the server timestamp', async () => {
    const { jwt, project } = await signupWithProject();
    const before = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const response = await createScoped(jwt, {
      name: 'Temporary agent',
      capabilities: ['checks:read', 'checks:write'],
      projectId: project.id,
      expirationDays: 30,
    });
    const after = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const expiresAt = Date.parse(
      response.data!.createScopedApiToken.expiresAt!,
    );

    expect(expiresAt).toBeGreaterThanOrEqual(before - 2_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 2_000);
  });

  it.each([
    ['missing write', ['checks:read']],
    [
      'unsupported capability',
      ['checks:read', 'checks:write', 'checks:delete'],
    ],
    ['empty capabilities', []],
  ])('rejects %s', async (_label, capabilities) => {
    const { jwt, project } = await signupWithProject();
    const response = await createScoped(jwt, {
      name: 'Invalid',
      capabilities,
      projectId: project.id,
    });

    expect(response.data).toBeNull();
    expect(response.errors?.[0]?.message).toMatch(/capabilities/i);
  });

  it.each([0, 3651])('rejects expirationDays=%s', async (expirationDays) => {
    const { jwt, project } = await signupWithProject();
    const response = await createScoped(jwt, {
      name: 'Invalid',
      capabilities: ['checks:read', 'checks:write'],
      projectId: project.id,
      expirationDays,
    });

    expect(response.data).toBeNull();
    expect(response.errors).toBeDefined();
  });

  it('rejects a non-integer expirationDays value', async () => {
    const { jwt, project } = await signupWithProject();
    const response = await createScoped(jwt, {
      name: 'Invalid',
      capabilities: ['checks:read', 'checks:write'],
      projectId: project.id,
      expirationDays: 1.5,
    });

    expect(response.data).toBeUndefined();
    expect(response.errors?.[0]?.message).toMatch(/Int/);
  });

  it('rejects a project inaccessible to the signed-in user', async () => {
    const first = await signupWithProject();
    const second = await signupWithProject(email2);
    const response = await createScoped(first.jwt, {
      name: 'Other project',
      capabilities: ['checks:read', 'checks:write'],
      projectId: second.project.id,
    });

    expect(response.data).toBeNull();
    expect(response.errors?.[0]?.message).toMatch(/project|member|access/i);
  });

  it('lists active, expired, and revoked history newest first without secrets', async () => {
    const { jwt, user, project } = await signupWithProject();
    const active = await createScoped(jwt, {
      name: 'Active',
      capabilities: ['checks:read', 'checks:write'],
      projectId: project.id,
    });
    const expired = await prisma.apiToken.create({
      data: {
        name: 'Expired',
        prefix: 'svt_exp',
        tokenHash: 'expired-token-hash',
        scopes: ['checks:read', 'checks:write'],
        userId: user.id,
        projectId: project.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const revoked = await createScoped(jwt, {
      name: 'Revoked',
      capabilities: ['checks:read', 'checks:write'],
      projectId: project.id,
    });
    await gql(app, jwt, `mutation($id:ID!){ revokeApiToken(id:$id) }`, {
      id: revoked.data!.createScopedApiToken.id,
    });
    const orderingBase = Date.now();
    await Promise.all([
      prisma.apiToken.update({
        where: { id: active.data!.createScopedApiToken.id },
        data: { createdAt: new Date(orderingBase - 3_000) },
      }),
      prisma.apiToken.update({
        where: { id: expired.id },
        data: { createdAt: new Date(orderingBase - 2_000) },
      }),
      prisma.apiToken.update({
        where: { id: revoked.data!.createScopedApiToken.id },
        data: { createdAt: new Date(orderingBase - 1_000) },
      }),
    ]);

    const response = await gql<{ apiTokens: CreateApiTokenResult[] }>(
      app,
      jwt,
      `{ apiTokens { ${TOKEN_FIELDS} } }`,
    );
    const ids = response.data!.apiTokens.map(({ id }) => id);

    expect(ids).toEqual([
      revoked.data!.createScopedApiToken.id,
      expired.id,
      active.data!.createScopedApiToken.id,
    ]);
    expect(
      response.data!.apiTokens.find(({ id }) => id === expired.id),
    ).toMatchObject({
      expiresAt: expired.expiresAt!.toISOString(),
      revokedAt: null,
    });
    expect(JSON.stringify(response.data!.apiTokens)).not.toContain('plaintext');
    expect(JSON.stringify(response.data!.apiTokens)).not.toContain('tokenHash');

    const secretFields = await gql(
      app,
      jwt,
      `{ apiTokens { plaintext tokenHash } }`,
    );
    expect(secretFields.data).toBeUndefined();
    expect(secretFields.errors).toHaveLength(2);
  });

  it('revokes immediately and idempotently only within the signed-in user tokens', async () => {
    const first = await signupWithProject();
    const second = await signupWithProject(email2);
    const own = await createScoped(first.jwt, {
      name: 'Own',
      capabilities: ['checks:read', 'checks:write'],
      projectId: first.project.id,
    });
    const other = await createScoped(second.jwt, {
      name: 'Other',
      capabilities: ['checks:read', 'checks:write'],
      projectId: second.project.id,
    });
    const revoke = (id: string) =>
      gql<{ revokeApiToken: boolean }>(
        app,
        first.jwt,
        `mutation($id:ID!){ revokeApiToken(id:$id) }`,
        { id },
      );

    expect((await revoke(own.data!.createScopedApiToken.id)).data).toEqual({
      revokeApiToken: true,
    });
    const revokedAt = (
      await prisma.apiToken.findUniqueOrThrow({
        where: { id: own.data!.createScopedApiToken.id },
      })
    ).revokedAt;
    expect(revokedAt).not.toBeNull();
    expect((await revoke(own.data!.createScopedApiToken.id)).data).toEqual({
      revokeApiToken: true,
    });
    expect(
      (
        await prisma.apiToken.findUniqueOrThrow({
          where: { id: own.data!.createScopedApiToken.id },
        })
      ).revokedAt,
    ).toEqual(revokedAt);

    await revoke(other.data!.createScopedApiToken.id);
    expect(
      (
        await prisma.apiToken.findUniqueOrThrow({
          where: { id: other.data!.createScopedApiToken.id },
        })
      ).revokedAt,
    ).toBeNull();
  });

  it('retains scoped connection history and rejects its token after project deletion', async () => {
    const { jwt, project, organization } = await signupWithProject();
    const created = await createScoped(jwt, {
      name: 'Deleted project agent',
      capabilities: ['checks:read', 'checks:write'],
      projectId: project.id,
    });
    const token = created.data!.createScopedApiToken;

    await prisma.project.update({
      where: { id: project.id },
      data: { name: 'Renamed live project' },
    });
    await prisma.organization.update({
      where: { id: organization.id },
      data: { name: 'Renamed live organization' },
    });
    const renamed = await gql<{ apiTokens: CreateApiTokenResult[] }>(
      app,
      jwt,
      `{ apiTokens { ${TOKEN_FIELDS} } }`,
    );
    expect(renamed.data!.apiTokens).toContainEqual(
      expect.objectContaining({
        id: token.id,
        projectName: 'Renamed live project',
        organizationName: 'Renamed live organization',
      }),
    );

    await prisma.project.delete({ where: { id: project.id } });

    const retained = await prisma.apiToken.findUnique({
      where: { id: token.id },
    });
    expect(retained).toMatchObject({
      id: token.id,
      projectId: null,
      projectNameSnapshot: project.name,
      organizationNameSnapshot: organization.name,
    });

    const listed = await gql<{ apiTokens: CreateApiTokenResult[] }>(
      app,
      jwt,
      `{ apiTokens { ${TOKEN_FIELDS} } }`,
    );
    expect(listed.data!.apiTokens).toContainEqual(
      expect.objectContaining({
        id: token.id,
        projectId: null,
        projectName: project.name,
        organizationName: organization.name,
      }),
    );

    const rejected = await gql(app, token.plaintext, `{ projects { id } }`);
    expect(rejected.data).toBeNull();
    expect(rejected.errors?.[0]?.message).toBe(
      'Credential project no longer exists',
    );
  });

  it.each([
    [
      'scoped create',
      `mutation($input:CreateApiTokenInput!){ createScopedApiToken(input:$input){ id } }`,
    ],
    [
      'legacy create',
      `mutation{ createApiToken(name:"Nested", scopes:["read"]){ id } }`,
    ],
    ['list', `{ apiTokens { id } }`],
    ['revoke', `mutation($id:ID!){ revokeApiToken(id:$id) }`],
  ])(
    'rejects an API token from the %s token-management operation',
    async (operation, query) => {
      const { jwt, project } = await signupWithProject();
      const created = await createScoped(jwt, {
        name: 'Agent',
        capabilities: ['checks:read', 'checks:write'],
        projectId: project.id,
      });
      const id = created.data!.createScopedApiToken.id;
      const response = await gql(
        app,
        created.data!.createScopedApiToken.plaintext,
        query,
        {
          input: {
            name: 'Nested',
            capabilities: ['checks:read', 'checks:write'],
            projectId: project.id,
          },
          id,
        },
      );

      expect(response.data).toBeNull();
      expect(response.errors?.[0]?.message).toMatch(/unauthorized/i);
    },
  );
});
