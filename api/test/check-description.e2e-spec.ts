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

// A SOLO account holds at most 5 checks; this suite creates 5.
describe('check description (e2e)', () => {
  let app: NestFastifyApplication;
  let token: string;
  let organizationId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = await signup(app, `description+${Date.now()}@example.com`);
    const me = await gql(app, token, `query { me { organizations { id } } }`);
    organizationId = (
      me.data as { me: { organizations: Array<{ id: string }> } }
    ).me.organizations[0].id;
  });

  afterAll(async () => {
    await app.get(PrismaService).$disconnect();
    await app.close();
  });

  async function update(id: string, input: Record<string, unknown>) {
    return gql(
      app,
      token,
      `mutation ($id: ID!, $input: UpdateCheckInput!) {
         updateCheck(id: $id, input: $input) { id name description agentInstructions }
       }`,
      { id, input },
    );
  }

  it('is set at creation for heartbeat and active checks', async () => {
    const heartbeat = await gql(
      app,
      token,
      `mutation ($o: ID!) {
         createCheck(
           organizationId: $o, name: "Described heartbeat", graceSeconds: 60,
           periodSeconds: 300, description: "  Restart the cron job  "
         ) { id description }
       }`,
      { o: organizationId },
    );
    expect(heartbeat.errors).toBeUndefined();
    expect(
      (heartbeat.data as { createCheck: { description: string } }).createCheck
        .description,
    ).toBe('Restart the cron job');

    const active = await gql(
      app,
      token,
      `mutation ($o: ID!) {
         createActiveCheck(
           organizationId: $o, name: "Described HTTP", type: "HTTP",
           target: "https://example.com/health", intervalSeconds: 300,
           timeoutMs: 5000, description: "Check the load balancer"
         ) { id description }
       }`,
      { o: organizationId },
    );
    expect(active.errors).toBeUndefined();
    expect(
      (active.data as { createActiveCheck: { description: string } })
        .createActiveCheck.description,
    ).toBe('Check the load balancer');
  });

  it('defaults to null, is updated, kept on unrelated edits, and cleared with a blank string', async () => {
    const created = await gql(
      app,
      token,
      `mutation ($o: ID!) {
         createCheck(organizationId: $o, name: "Runbook", graceSeconds: 60, periodSeconds: 300) {
           id description
         }
       }`,
      { o: organizationId },
    );
    const check = (
      created.data as { createCheck: { id: string; description: null } }
    ).createCheck;
    expect(check.description).toBeNull();

    const set = await update(check.id, {
      description: '1. SSH in\n2. Restart',
    });
    expect(
      (set.data as { updateCheck: { description: string } }).updateCheck
        .description,
    ).toBe('1. SSH in\n2. Restart');

    const renamed = await update(check.id, { name: 'Runbook renamed' });
    expect(
      (renamed.data as { updateCheck: { description: string } }).updateCheck
        .description,
    ).toBe('1. SSH in\n2. Restart');

    const fetched = await gql(
      app,
      token,
      `query ($id: ID!) { check(id: $id) { description } }`,
      { id: check.id },
    );
    expect(
      (fetched.data as { check: { description: string } }).check.description,
    ).toBe('1. SSH in\n2. Restart');

    const cleared = await update(check.id, { description: '  ' });
    expect(
      (cleared.data as { updateCheck: { description: string | null } })
        .updateCheck.description,
    ).toBeNull();
  });

  it('rejects a description over 2000 characters on create and update', async () => {
    const tooLong = 'x'.repeat(2001);
    const created = await gql(
      app,
      token,
      `mutation ($o: ID!, $d: String) {
         createCheck(organizationId: $o, name: "Too long", graceSeconds: 60, periodSeconds: 300, description: $d) { id }
       }`,
      { o: organizationId, d: tooLong },
    );
    expect(created.errors?.[0].message).toMatch(/2000 characters/);

    const check = await gql(
      app,
      token,
      `mutation ($o: ID!) {
         createCheck(organizationId: $o, name: "Too long later", graceSeconds: 60, periodSeconds: 300) { id }
       }`,
      { o: organizationId },
    );
    const id = (check.data as { createCheck: { id: string } }).createCheck.id;
    const updated = await update(id, { description: tooLong });
    expect(updated.errors?.[0].message).toMatch(/2000 characters/);
  });

  it('stores agent instructions separately, keeps them on unrelated edits, and enforces 4000 characters', async () => {
    const created = await gql(
      app,
      token,
      `mutation ($o: ID!) {
         createCheck(
           organizationId: $o, name: "Agent runbook", graceSeconds: 60,
           periodSeconds: 300, description: "Human steps",
           agentInstructions: "  Audit: read the logs\\nFix: restart  "
         ) { id description agentInstructions }
       }`,
      { o: organizationId },
    );
    expect(created.errors).toBeUndefined();
    const check = (
      created.data as {
        createCheck: {
          id: string;
          description: string;
          agentInstructions: string;
        };
      }
    ).createCheck;
    expect(check.description).toBe('Human steps');
    expect(check.agentInstructions).toBe('Audit: read the logs\nFix: restart');

    const renamed = await update(check.id, { description: 'New human steps' });
    expect(
      (renamed.data as { updateCheck: { agentInstructions: string } })
        .updateCheck.agentInstructions,
    ).toBe('Audit: read the logs\nFix: restart');

    const tooLong = await update(check.id, {
      agentInstructions: 'x'.repeat(4001),
    });
    expect(tooLong.errors?.[0].message).toMatch(/4000 characters/);

    const longest = await update(check.id, {
      agentInstructions: 'x'.repeat(4000),
    });
    expect(longest.errors).toBeUndefined();

    const cleared = await update(check.id, { agentInstructions: '' });
    expect(
      (cleared.data as { updateCheck: { agentInstructions: string | null } })
        .updateCheck.agentInstructions,
    ).toBeNull();
  });
});
