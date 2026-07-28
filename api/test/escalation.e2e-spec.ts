import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildApp } from '../src/main';

interface SchemaResponse {
  data?: {
    __schema: {
      queryType: { fields: Array<{ name: string }> };
      mutationType: { fields: Array<{ name: string }> };
      types: Array<{
        name: string;
        fields?: Array<{ name: string }>;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const RETIRED_QUERIES = ['escalationPolicies'];
const RETIRED_MUTATIONS = [
  'createEscalationPolicy',
  'updateEscalationPolicy',
  'deleteEscalationPolicy',
  'acknowledgeCheck',
];

describe('retired escalation GraphQL schema (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function schemaAt(url: string): Promise<SchemaResponse> {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: {
        query: `{
          __schema {
            queryType { fields { name } }
            mutationType { fields { name } }
            types { name fields { name } }
          }
        }`,
      },
    });
    return JSON.parse(response.body) as SchemaResponse;
  }

  it('removes escalation and acknowledgement operations and types', async () => {
    const schemas = await Promise.all([
      schemaAt('/graphql'),
      schemaAt('/admin/graphql'),
    ]);

    for (const body of schemas) {
      expect(body.errors).toBeUndefined();
      const schema = body.data!.__schema;
      const queryNames = schema.queryType.fields.map(({ name }) => name);
      const mutationNames = schema.mutationType.fields.map(({ name }) => name);
      const typeNames = schema.types.map(({ name }) => name);

      expect(queryNames).toEqual(expect.not.arrayContaining(RETIRED_QUERIES));
      expect(mutationNames).toEqual(
        expect.not.arrayContaining(RETIRED_MUTATIONS),
      );
      expect(
        typeNames.filter((name) => /escalation|acknowledgement/i.test(name)),
      ).toEqual([]);
    }
  });

  it('preserves per-check notification channel routing', async () => {
    const body = await schemaAt('/graphql');

    expect(body.errors).toBeUndefined();
    const schema = body.data!.__schema;
    expect(schema.mutationType.fields.map(({ name }) => name)).toContain(
      'setCheckChannelEnabled',
    );
    expect(
      schema.types
        .find(({ name }) => name === 'CheckModel')
        ?.fields?.map(({ name }) => name),
    ).toContain('notificationChannelIds');
  });
});
