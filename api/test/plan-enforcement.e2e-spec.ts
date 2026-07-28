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
  return JSON.parse(r.body) as unknown;
}

interface GqlMeResponse {
  data: {
    me: {
      organizations: Array<{
        projects: Array<{ id: string }>;
      }>;
    };
  };
}

interface GqlCreateCheckResponse {
  data?: { createCheck: { id: string } };
  errors?: Array<{ message: string }>;
}

interface GqlCreateActiveCheckResponse {
  data?: { createActiveCheck: { id: string } };
  errors?: Array<{ message: string }>;
}

const CREATE_CHECK_MUTATION = `
  mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
    createCheck(
      projectId: $projectId,
      name: $name,
      periodSeconds: $periodSeconds,
      graceSeconds: $graceSeconds
    ) {
      id
    }
  }
`;

const CREATE_ACTIVE_CHECK_MUTATION = `
  mutation($projectId: ID!, $name: String!, $type: String!, $target: String!, $intervalSeconds: Int!, $timeoutMs: Int!) {
    createActiveCheck(
      projectId: $projectId,
      name: $name,
      type: $type,
      target: $target,
      intervalSeconds: $intervalSeconds,
      timeoutMs: $timeoutMs
    ) {
      id
    }
  }
`;

describe('plan enforcement (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  // use +x@ pattern so emails are distinct from other test suites
  const emailCount = 'plan-enforcement+count@systemvitals.com';
  const emailInterval = 'plan-enforcement+interval@systemvitals.com';
  const emailActive = 'plan-enforcement+active@systemvitals.com';
  const emailActiveCount = 'plan-enforcement+active-count@systemvitals.com';

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, [
      emailCount,
      emailInterval,
      emailActive,
      emailActiveCount,
    ]);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [
        emailCount,
        emailInterval,
        emailActive,
        emailActiveCount,
      ]);
    } finally {
      await app.close();
    }
  });

  describe('heartbeat check count limit (SOLO = 5)', () => {
    it('allows creating 5 heartbeat checks at periodSeconds=300 and rejects the 6th', async () => {
      const token = await signup(app, emailCount);
      const me = (await gql(
        app,
        token,
        `{ me { organizations { projects { id } } } }`,
      )) as GqlMeResponse;
      const projectId = me.data.me.organizations[0].projects[0].id;

      // Create 5 checks — all should succeed
      for (let i = 1; i <= 5; i++) {
        const res = (await gql(app, token, CREATE_CHECK_MUTATION, {
          projectId,
          name: `Check ${i}`,
          periodSeconds: 300,
          graceSeconds: 30,
        })) as GqlCreateCheckResponse;

        expect(res.errors).toBeUndefined();
        expect(res.data?.createCheck.id).toBeTruthy();
      }

      // 6th check must be rejected with a plan/limit/upgrade error
      const res6 = (await gql(app, token, CREATE_CHECK_MUTATION, {
        projectId,
        name: 'Check 6',
        periodSeconds: 300,
        graceSeconds: 30,
      })) as GqlCreateCheckResponse;

      expect(res6.errors).toBeDefined();
      expect(res6.errors?.[0]?.message).toMatch(/limit|plan|upgrade/i);
    });
  });

  describe('heartbeat check interval floor (SOLO = 300s)', () => {
    it('rejects a heartbeat check with periodSeconds below the plan minimum', async () => {
      const token = await signup(app, emailInterval);
      const me = (await gql(
        app,
        token,
        `{ me { organizations { projects { id } } } }`,
      )) as GqlMeResponse;
      const projectId = me.data.me.organizations[0].projects[0].id;

      const res = (await gql(app, token, CREATE_CHECK_MUTATION, {
        projectId,
        name: 'Too-fast heartbeat',
        periodSeconds: 30,
        graceSeconds: 10,
      })) as GqlCreateCheckResponse;

      expect(res.errors).toBeDefined();
      expect(res.errors?.[0]?.message).toMatch(/interval|minimum/i);
    });
  });

  describe('active check interval floor (SOLO = 300s)', () => {
    it('rejects an active check with intervalSeconds below the plan minimum', async () => {
      const token = await signup(app, emailActive);
      const me = (await gql(
        app,
        token,
        `{ me { organizations { projects { id } } } }`,
      )) as GqlMeResponse;
      const projectId = me.data.me.organizations[0].projects[0].id;

      const res = (await gql(app, token, CREATE_ACTIVE_CHECK_MUTATION, {
        projectId,
        name: 'Too-fast active',
        type: 'HTTP',
        target: 'https://example.com',
        intervalSeconds: 60,
        timeoutMs: 5000,
      })) as GqlCreateActiveCheckResponse;

      expect(res.errors).toBeDefined();
      expect(res.errors?.[0]?.message).toMatch(/interval|minimum/i);
    });
  });

  describe('active check count limit (SOLO = 5)', () => {
    it('allows creating 5 active HTTP checks and rejects the 6th', async () => {
      const token = await signup(app, emailActiveCount);
      const me = (await gql(
        app,
        token,
        `{ me { organizations { projects { id } } } }`,
      )) as GqlMeResponse;
      const projectId = me.data.me.organizations[0].projects[0].id;

      // Create 5 active checks — all should succeed
      for (let i = 1; i <= 5; i++) {
        const res = (await gql(app, token, CREATE_ACTIVE_CHECK_MUTATION, {
          projectId,
          name: `Active Check ${i}`,
          type: 'HTTP',
          target: 'https://example.com',
          intervalSeconds: 300,
          timeoutMs: 5000,
        })) as GqlCreateActiveCheckResponse;

        expect(res.errors).toBeUndefined();
        expect(res.data?.createActiveCheck.id).toBeTruthy();
      }

      // 6th check must be rejected with a plan/limit/upgrade error
      const res6 = (await gql(app, token, CREATE_ACTIVE_CHECK_MUTATION, {
        projectId,
        name: 'Active Check 6',
        type: 'HTTP',
        target: 'https://example.com',
        intervalSeconds: 300,
        timeoutMs: 5000,
      })) as GqlCreateActiveCheckResponse;

      expect(res6.errors).toBeDefined();
      expect(res6.errors?.[0]?.message).toMatch(/limit|plan|upgrade/i);
    });
  });

  describe('updateCheck interval floor bypass (SOLO = 300s)', () => {
    it('rejects updating periodSeconds below plan minimum on an existing check', async () => {
      const email = 'plan-enforcement+update-interval@systemvitals.com';
      // clean up before
      await cleanupTestUsers(prisma, email);

      const token = await signup(app, email);
      const me = (await gql(
        app,
        token,
        `{ me { organizations { projects { id } } } }`,
      )) as GqlMeResponse;
      const projectId = me.data.me.organizations[0].projects[0].id;

      // Create a valid check at 300s
      const createRes = (await gql(app, token, CREATE_CHECK_MUTATION, {
        projectId,
        name: 'Update bypass test check',
        periodSeconds: 300,
        graceSeconds: 30,
      })) as GqlCreateCheckResponse;
      expect(createRes.errors).toBeUndefined();
      const checkId = createRes.data!.createCheck.id;

      // Try to update to 30s (below SOLO minimum of 300s) — must be rejected
      const updateRes = (await gql(
        app,
        token,
        `mutation($id: ID!, $input: UpdateCheckInput!) {
        updateCheck(id: $id, input: $input) { id }
      }`,
        { id: checkId, input: { periodSeconds: 30 } },
      )) as { data?: unknown; errors?: Array<{ message: string }> };

      expect(updateRes.errors).toBeDefined();
      expect(updateRes.errors?.[0]?.message).toMatch(/interval|minimum/i);

      // clean up after
      await cleanupTestUsers(prisma, email);
    });
  });
});
