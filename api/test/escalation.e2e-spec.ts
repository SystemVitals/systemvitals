import { randomUUID } from 'node:crypto';
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

interface EscalationStepShape {
  channelId: string;
  delaySeconds: number;
}

interface EscalationPolicyShape {
  id: string;
  projectId: string;
  steps: EscalationStepShape[];
}

interface GqlCreateEscalationPolicyResponse {
  data?: { createEscalationPolicy: EscalationPolicyShape };
  errors?: Array<{ message: string }>;
}

interface GqlEscalationPoliciesResponse {
  data?: { escalationPolicies: EscalationPolicyShape[] };
  errors?: Array<{ message: string }>;
}

interface GqlUpdateEscalationPolicyResponse {
  data?: { updateEscalationPolicy: EscalationPolicyShape };
  errors?: Array<{ message: string }>;
}

interface GqlDeleteEscalationPolicyResponse {
  data?: { deleteEscalationPolicy: boolean };
  errors?: Array<{ message: string }>;
}

interface GqlAcknowledgeCheckResponse {
  data?: { acknowledgeCheck: boolean };
  errors?: Array<{ message: string }>;
}

interface GqlCreateCheckResponse {
  data?: { createCheck: { id: string } };
  errors?: Array<{ message: string }>;
}

interface GqlCreateChannelResponse {
  data?: { createChannel: { id: string } };
  errors?: Array<{ message: string }>;
}

describe('escalation (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const suffix = randomUUID().slice(0, 8);
  const emailA = `esc-a+${suffix}@systemvitals.com`;
  const emailB = `esc-b+${suffix}@systemvitals.com`;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, [emailA, emailB]);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [emailA, emailB]);
    } finally {
      await app.close();
    }
  });

  let tokenA: string;
  let tokenB: string;
  let projectIdA: string;
  let projectIdB: string;
  let checkId: string;
  let channelId: string;
  let channelBId: string;
  let policyId: string;
  let policyIdForCrossUserTests: string;

  it('signup user A → get default projectId', async () => {
    tokenA = await signup(app, emailA);
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    projectIdA = me.data.me.organizations[0].projects[0].id;
    expect(projectIdA).toBeTruthy();
  });

  it('signup user B → get default projectId', async () => {
    tokenB = await signup(app, emailB);
    const meB = (await gql(
      app,
      tokenB,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    projectIdB = meB.data.me.organizations[0].projects[0].id;
    expect(projectIdB).toBeTruthy();
  });

  it('create a check in project A', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        name: 'Esc Check',
        periodSeconds: 300,
        graceSeconds: 30,
      },
    )) as GqlCreateCheckResponse;
    expect(res.errors).toBeUndefined();
    checkId = res.data!.createCheck.id;
    expect(checkId).toBeTruthy();
  });

  it('create an EMAIL channel in project A', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        type: 'EMAIL',
        configJson: '{"email":"oncall@example.com"}',
      },
    )) as GqlCreateChannelResponse;
    expect(res.errors).toBeUndefined();
    channelId = res.data!.createChannel.id;
    expect(channelId).toBeTruthy();
  });

  it('create an EMAIL channel in project B', async () => {
    const res = (await gql(
      app,
      tokenB,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        projectId: projectIdB,
        type: 'EMAIL',
        configJson: '{"email":"b-oncall@example.com"}',
      },
    )) as GqlCreateChannelResponse;
    expect(res.errors).toBeUndefined();
    channelBId = res.data!.createChannel.id;
    expect(channelBId).toBeTruthy();
  });

  it('createEscalationPolicy returns policy with one step', async () => {
    const stepsJson = JSON.stringify([{ channelId, delaySeconds: 300 }]);
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $stepsJson: String!) {
        createEscalationPolicy(projectId: $projectId, stepsJson: $stepsJson) {
          id
          projectId
          steps { channelId delaySeconds }
        }
      }`,
      { projectId: projectIdA, stepsJson },
    )) as GqlCreateEscalationPolicyResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createEscalationPolicy.projectId).toBe(projectIdA);
    expect(res.data?.createEscalationPolicy.steps).toHaveLength(1);
    expect(res.data?.createEscalationPolicy.steps[0].channelId).toBe(channelId);
    expect(res.data?.createEscalationPolicy.steps[0].delaySeconds).toBe(300);
    policyId = res.data!.createEscalationPolicy.id;
    expect(policyId).toBeTruthy();
  });

  it('escalationPolicies(projectId) lists the created policy', async () => {
    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        escalationPolicies(projectId: $projectId) {
          id projectId steps { channelId delaySeconds }
        }
      }`,
      { projectId: projectIdA },
    )) as GqlEscalationPoliciesResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.escalationPolicies.length).toBeGreaterThanOrEqual(1);
    const policy = res.data?.escalationPolicies.find((p) => p.id === policyId);
    expect(policy).toBeDefined();
    expect(policy?.steps[0].channelId).toBe(channelId);
  });

  it('steps referencing a channelId from ANOTHER project → error', async () => {
    const stepsJson = JSON.stringify([
      { channelId: channelBId, delaySeconds: 300 },
    ]);
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $stepsJson: String!) {
        createEscalationPolicy(projectId: $projectId, stepsJson: $stepsJson) {
          id
        }
      }`,
      { projectId: projectIdA, stepsJson },
    )) as GqlCreateEscalationPolicyResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/channel|project/i);
  });

  it('empty steps array → error', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $stepsJson: String!) {
        createEscalationPolicy(projectId: $projectId, stepsJson: $stepsJson) {
          id
        }
      }`,
      { projectId: projectIdA, stepsJson: '[]' },
    )) as GqlCreateEscalationPolicyResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/non-empty|empty/i);
  });

  it('negative delaySeconds → error', async () => {
    const stepsJson = JSON.stringify([{ channelId, delaySeconds: -1 }]);
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $stepsJson: String!) {
        createEscalationPolicy(projectId: $projectId, stepsJson: $stepsJson) {
          id
        }
      }`,
      { projectId: projectIdA, stepsJson },
    )) as GqlCreateEscalationPolicyResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/delay|negative/i);
  });

  it('cross-user create in first user project → error', async () => {
    const stepsJson = JSON.stringify([{ channelId, delaySeconds: 300 }]);
    const res = (await gql(
      app,
      tokenB,
      `mutation($projectId: ID!, $stepsJson: String!) {
        createEscalationPolicy(projectId: $projectId, stepsJson: $stepsJson) {
          id
        }
      }`,
      { projectId: projectIdA, stepsJson },
    )) as GqlCreateEscalationPolicyResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/not a member|forbidden/i);
  });

  it('create a dedicated policy for cross-user tests', async () => {
    const stepsJson = JSON.stringify([{ channelId, delaySeconds: 300 }]);
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $stepsJson: String!) {
        createEscalationPolicy(projectId: $projectId, stepsJson: $stepsJson) {
          id
          projectId
          steps { channelId delaySeconds }
        }
      }`,
      { projectId: projectIdA, stepsJson },
    )) as GqlCreateEscalationPolicyResponse;

    expect(res.errors).toBeUndefined();
    policyIdForCrossUserTests = res.data!.createEscalationPolicy.id;
    expect(policyIdForCrossUserTests).toBeTruthy();
  });

  it("cross-user update forbidden: tokenB calls updateEscalationPolicy(A's policy)", async () => {
    const stepsJson = JSON.stringify([{ channelId, delaySeconds: 60 }]);
    const res = (await gql(
      app,
      tokenB,
      `mutation($id: ID!, $stepsJson: String!) {
        updateEscalationPolicy(id: $id, stepsJson: $stepsJson) {
          id
        }
      }`,
      { id: policyIdForCrossUserTests, stepsJson },
    )) as GqlUpdateEscalationPolicyResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/not a member|forbidden/i);
  });

  it("cross-user delete forbidden: tokenB calls deleteEscalationPolicy(A's policy)", async () => {
    const res = (await gql(
      app,
      tokenB,
      `mutation($id: ID!) { deleteEscalationPolicy(id: $id) }`,
      { id: policyIdForCrossUserTests },
    )) as GqlDeleteEscalationPolicyResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/not a member|forbidden/i);
  });

  it('float delaySeconds rejected: tokenA calls createEscalationPolicy with float delay', async () => {
    const stepsJson = JSON.stringify([{ channelId, delaySeconds: 1.5 }]);
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $stepsJson: String!) {
        createEscalationPolicy(projectId: $projectId, stepsJson: $stepsJson) {
          id
        }
      }`,
      { projectId: projectIdA, stepsJson },
    )) as GqlCreateEscalationPolicyResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/delaySeconds|integer/i);
  });

  it('updateEscalationPolicy with 2 steps → updates', async () => {
    // Create a second channel in project A for the second step
    const res2ch = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        type: 'EMAIL',
        configJson: '{"email":"secondary@example.com"}',
      },
    )) as GqlCreateChannelResponse;
    const channel2Id = res2ch.data!.createChannel.id;

    const stepsJson = JSON.stringify([
      { channelId, delaySeconds: 0 },
      { channelId: channel2Id, delaySeconds: 600 },
    ]);
    const res = (await gql(
      app,
      tokenA,
      `mutation($id: ID!, $stepsJson: String!) {
        updateEscalationPolicy(id: $id, stepsJson: $stepsJson) {
          id steps { channelId delaySeconds }
        }
      }`,
      { id: policyId, stepsJson },
    )) as GqlUpdateEscalationPolicyResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.updateEscalationPolicy.steps).toHaveLength(2);
    expect(res.data?.updateEscalationPolicy.steps[0].delaySeconds).toBe(0);
    expect(res.data?.updateEscalationPolicy.steps[1].delaySeconds).toBe(600);
  });

  it('deleteEscalationPolicy returns true', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($id: ID!) { deleteEscalationPolicy(id: $id) }`,
      { id: policyId },
    )) as GqlDeleteEscalationPolicyResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.deleteEscalationPolicy).toBe(true);

    const listRes = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) { escalationPolicies(projectId: $projectId) { id } }`,
      { projectId: projectIdA },
    )) as GqlEscalationPoliciesResponse;
    const ids = listRes.data?.escalationPolicies.map((p) => p.id) ?? [];
    expect(ids).not.toContain(policyId);
  });

  it('acknowledgeCheck returns true', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($checkId: ID!) { acknowledgeCheck(checkId: $checkId) }`,
      { checkId },
    )) as GqlAcknowledgeCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.acknowledgeCheck).toBe(true);
  });

  it('acknowledgeCheck by a non-member user → error', async () => {
    const res = (await gql(
      app,
      tokenB,
      `mutation($checkId: ID!) { acknowledgeCheck(checkId: $checkId) }`,
      { checkId },
    )) as GqlAcknowledgeCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/not a member|forbidden/i);
  });
});
