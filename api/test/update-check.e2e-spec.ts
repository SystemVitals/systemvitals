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

const CHECK_FIELDS = `
  id name type status pingSlug lastEventAt
  periodSeconds graceSeconds schedule tz
  target method expectedStatus intervalSeconds timeoutMs
`;

describe('updateCheck (e2e)', () => {
  let app: NestFastifyApplication;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = await signup(app, `edit+${Date.now()}@example.com`);

    const me = await gql(
      app,
      token,
      `query { me { organizations { projects { id } } } }`,
    );
    const orgs = (
      me.data as {
        me: { organizations: Array<{ projects: Array<{ id: string }> }> };
      }
    ).me.organizations;
    projectId = orgs[0].projects[0].id;
  });

  afterAll(async () => {
    await app.get(PrismaService).$disconnect();
    await app.close();
  });

  async function newHeartbeat(
    name: string,
    asToken: string = token,
    asProjectId: string = projectId,
  ) {
    const r = await gql(
      app,
      asToken,
      `mutation ($p: ID!, $n: String!) {
         createCheck(projectId: $p, name: $n, graceSeconds: 60, periodSeconds: 300) { ${CHECK_FIELDS} }
       }`,
      { p: asProjectId, n: name },
    );
    return (r.data as { createCheck: Record<string, unknown> }).createCheck;
  }

  async function newActiveCheck(
    name: string,
    asToken: string = token,
    asProjectId: string = projectId,
  ) {
    const r = await gql(
      app,
      asToken,
      `mutation ($p: ID!, $n: String!) {
         createActiveCheck(
           projectId: $p, name: $n, type: "HTTP", target: "https://example.com/health",
           intervalSeconds: 300, timeoutMs: 5000
         ) { ${CHECK_FIELDS} }
       }`,
      { p: asProjectId, n: name },
    );
    return (r.data as { createActiveCheck: Record<string, unknown> })
      .createActiveCheck;
  }

  it('renames a check without disturbing its timing', async () => {
    const check = await newHeartbeat('Before');
    const r = await gql(
      app,
      token,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: { name: "After" }) { ${CHECK_FIELDS} }
       }`,
      { id: check.id },
    );
    const updated = (r.data as { updateCheck: Record<string, unknown> })
      .updateCheck;
    expect(updated.name).toBe('After');
    expect(updated.periodSeconds).toBe(300);
    expect(updated.graceSeconds).toBe(60);
  });

  it('converts a heartbeat to HTTP, clearing heartbeat columns and keeping the ping slug', async () => {
    const check = await newHeartbeat('Converting');
    const r = await gql(
      app,
      token,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: {
           type: "HTTP", target: "https://example.com/health",
           intervalSeconds: 300, timeoutMs: 5000
         }) { ${CHECK_FIELDS} }
       }`,
      { id: check.id },
    );
    const updated = (r.data as { updateCheck: Record<string, unknown> })
      .updateCheck;

    expect(updated.type).toBe('HTTP');
    expect(updated.target).toBe('https://example.com/health');
    expect(updated.method).toBe('GET');
    expect(updated.periodSeconds).toBeNull();
    expect(updated.graceSeconds).toBeNull();
    // The ping URL stays dormant so converting back restores it.
    expect(updated.pingSlug).toBe(check.pingSlug);
  });

  // These two get their own owner/org/project, like the "refuses to edit"
  // test below — otherwise they'd add to the shared project's check count
  // and tip already-check-count-sensitive siblings (e.g. the FREE
  // `maxChecks` tests) over the plan limit.
  it('converting an UP active check INTO a heartbeat resets status to NEW and clears lastEventAt, so the watchdog cannot immediately sweep it (Fix 4)', async () => {
    const owner = await signup(app, `fix4-conv+${Date.now()}@example.com`);
    const ownerMe = await gql(
      app,
      owner,
      `query { me { organizations { projects { id } } } }`,
    );
    const ownerProjectId = (
      ownerMe.data as {
        me: { organizations: Array<{ projects: Array<{ id: string }> }> };
      }
    ).me.organizations[0].projects[0].id;

    const check = await newActiveCheck('WasUp', owner, ownerProjectId);

    // Simulate the worker having probed this HTTP check and found it UP a
    // while ago — exactly the state `create` deliberately avoids for a
    // brand-new heartbeat (status:'NEW', lastEventAt:null), and exactly what
    // the watchdog's overdue predicate keys off.
    await app.get(PrismaService).check.update({
      where: { id: check.id as string },
      data: {
        status: 'UP',
        lastEventAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    const r = await gql(
      app,
      owner,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: {
           type: "HEARTBEAT", periodSeconds: 300, graceSeconds: 60
         }) { ${CHECK_FIELDS} }
       }`,
      { id: check.id },
    );
    const updated = (r.data as { updateCheck: Record<string, unknown> })
      .updateCheck;

    expect(updated.type).toBe('HEARTBEAT');
    expect(updated.status).toBe('NEW');
    expect(updated.lastEventAt).toBeNull();
  });

  it('a plain edit of an existing heartbeat (no type change) does not disturb status or lastEventAt', async () => {
    const owner = await signup(app, `fix4-plain+${Date.now()}@example.com`);
    const ownerMe = await gql(
      app,
      owner,
      `query { me { organizations { projects { id } } } }`,
    );
    const ownerProjectId = (
      ownerMe.data as {
        me: { organizations: Array<{ projects: Array<{ id: string }> }> };
      }
    ).me.organizations[0].projects[0].id;

    const check = await newHeartbeat('AlreadyPinging', owner, ownerProjectId);
    await app.inject({
      method: 'GET',
      url: `/ping/${check.pingSlug as string}`,
    });

    const before = await app
      .get(PrismaService)
      .check.findUniqueOrThrow({ where: { id: check.id as string } });
    expect(before.status).toBe('UP');
    expect(before.lastEventAt).not.toBeNull();

    const r = await gql(
      app,
      owner,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: { graceSeconds: 90 }) { ${CHECK_FIELDS} }
       }`,
      { id: check.id },
    );
    const updated = (r.data as { updateCheck: Record<string, unknown> })
      .updateCheck;

    expect(updated.status).toBe('UP');
    expect(updated.lastEventAt).toBe(before.lastEventAt!.toISOString());
  });

  it('preserves event history across a conversion', async () => {
    const check = await newHeartbeat('Historic');
    await app.inject({
      method: 'GET',
      url: `/ping/${check.pingSlug as string}`,
    });

    await gql(
      app,
      token,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: {
           type: "TCP", target: "example.com:5432",
           intervalSeconds: 300, timeoutMs: 5000
         }) { id }
       }`,
      { id: check.id },
    );

    const events = await app
      .get(PrismaService)
      .checkEvent.count({ where: { checkId: check.id as string } });
    expect(events).toBeGreaterThan(0);
  });

  it('rejects PING, which has no prober', async () => {
    const check = await newHeartbeat('NoPing');
    const r = await gql(
      app,
      token,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: {
           type: "PING", target: "example.com",
           intervalSeconds: 300, timeoutMs: 5000
         }) { id }
       }`,
      { id: check.id },
    );
    expect(r.errors?.[0].message).toMatch(/HEARTBEAT, HTTP or TCP/);
  });

  it('rejects a conversion below the plan interval floor', async () => {
    const check = await newHeartbeat('TooFast');
    const r = await gql(
      app,
      token,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: {
           type: "HTTP", target: "https://example.com",
           intervalSeconds: 5, timeoutMs: 5000
         }) { id }
       }`,
      { id: check.id },
    );
    expect(r.errors?.[0].message).toMatch(/minimum interval/i);
  });

  it("refuses to edit a check in another member's organization", async () => {
    // Uses its own owner/org/project (rather than the project shared by the
    // other tests in this file) so it is immune to how many checks its
    // siblings have already created against the FREE plan's maxChecks limit.
    const owner = await signup(app, `owner+${Date.now()}@example.com`);
    const ownerMe = await gql(
      app,
      owner,
      `query { me { organizations { projects { id } } } }`,
    );
    const ownerProjectId = (
      ownerMe.data as {
        me: { organizations: Array<{ projects: Array<{ id: string }> }> };
      }
    ).me.organizations[0].projects[0].id;

    const check = await newHeartbeat('Private', owner, ownerProjectId);
    const stranger = await signup(app, `stranger+${Date.now()}@example.com`);
    const r = await gql(
      app,
      stranger,
      `mutation ($id: ID!) {
         updateCheck(id: $id, input: { name: "Hijacked" }) { id }
       }`,
      { id: check.id },
    );
    expect(r.errors?.[0].message).toBeTruthy();
  });
});
