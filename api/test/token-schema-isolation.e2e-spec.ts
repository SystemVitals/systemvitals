import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';

interface SchemaResponse {
  data?: {
    __schema: {
      queryType: { fields: Array<{ name: string }> };
      mutationType: {
        fields: Array<{
          name: string;
          args: Array<{ name: string; type: { name: string | null } }>;
        }>;
      };
      types: Array<{
        name: string;
        fields?: Array<{
          name: string;
          isDeprecated: boolean;
          deprecationReason: string | null;
          type: {
            kind: string;
            name: string | null;
            ofType: { kind: string; name: string | null } | null;
          };
        }>;
        inputFields?: Array<{
          name: string;
          isDeprecated: boolean;
          deprecationReason: string | null;
          type: {
            kind: string;
            name: string | null;
            ofType: { kind: string; name: string | null } | null;
          };
        }>;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const TOKEN_QUERIES = ['apiCredential', 'apiTokens'];
const TOKEN_MUTATIONS = [
  'createApiToken',
  'createScopedApiToken',
  'revokeApiToken',
];
const TELEGRAM_QUERIES = ['managedTelegramBot', 'telegramConnectionPreview'];
const TELEGRAM_MUTATIONS = ['connectTelegramChannel'];
const TELEGRAM_TYPES = [
  'ManagedTelegramBotModel',
  'TelegramConnectionPreviewModel',
];
const email = 'token-schema-isolation@systemvitals.com';

describe('token GraphQL schema isolation (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, email);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, email);
    } finally {
      await app.close();
    }
  });

  async function schemaAt(url: string): Promise<SchemaResponse> {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: {
        query: `{
          __schema {
            queryType { fields { name } }
            mutationType { fields { name args { name type { name } } } }
            types {
              name
              fields(includeDeprecated: true) {
                name isDeprecated deprecationReason
                type { kind name ofType { kind name } }
              }
              inputFields(includeDeprecated: true) {
                name isDeprecated deprecationReason
                type { kind name ofType { kind name } }
              }
            }
          }
        }`,
      },
    });
    return JSON.parse(response.body) as SchemaResponse;
  }

  it('registers token management only on the public GraphQL schema', async () => {
    const [publicSchema, adminSchema] = await Promise.all([
      schemaAt('/graphql'),
      schemaAt('/admin/graphql'),
    ]);
    const publicQueries = publicSchema.data!.__schema.queryType.fields.map(
      ({ name }) => name,
    );
    const publicMutations = publicSchema.data!.__schema.mutationType.fields.map(
      ({ name }) => name,
    );
    const adminQueries = adminSchema.data!.__schema.queryType.fields.map(
      ({ name }) => name,
    );
    const adminMutations = adminSchema.data!.__schema.mutationType.fields.map(
      ({ name }) => name,
    );
    const publicTypes = publicSchema.data!.__schema.types.map(
      ({ name }) => name,
    );
    const adminTypes = adminSchema.data!.__schema.types.map(({ name }) => name);

    expect(publicQueries).toEqual(expect.arrayContaining(TOKEN_QUERIES));
    expect(publicMutations).toEqual(expect.arrayContaining(TOKEN_MUTATIONS));
    expect(adminQueries).toEqual(expect.not.arrayContaining(TOKEN_QUERIES));
    expect(adminMutations).toEqual(expect.not.arrayContaining(TOKEN_MUTATIONS));
    expect(publicTypes).toContain('ApiCredential');
    expect(adminTypes).not.toContain('ApiCredential');
    expect(publicQueries).toEqual(expect.arrayContaining(TELEGRAM_QUERIES));
    expect(publicMutations).toEqual(expect.arrayContaining(TELEGRAM_MUTATIONS));
    expect(adminQueries).toEqual(expect.not.arrayContaining(TELEGRAM_QUERIES));
    expect(adminMutations).toEqual(
      expect.not.arrayContaining(TELEGRAM_MUTATIONS),
    );
    expect(publicTypes).toEqual(expect.arrayContaining(TELEGRAM_TYPES));
    expect(adminTypes).toEqual(expect.not.arrayContaining(TELEGRAM_TYPES));
    const publicCredential = publicSchema.data!.__schema.types.find(
      ({ name }) => name === 'ApiCredential',
    );
    expect(publicCredential?.fields?.map(({ name }) => name)).toContain(
      'credentialMode',
    );
    expect(publicCredential?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'organizationId',
          isDeprecated: false,
        }),
        expect.objectContaining({
          name: 'organizationName',
          isDeprecated: false,
        }),
        expect.objectContaining({
          name: 'projectId',
          isDeprecated: true,
          deprecationReason: 'Use organizationId.',
        }),
        expect.objectContaining({
          name: 'projectName',
          isDeprecated: true,
          deprecationReason: 'Use organizationName.',
        }),
      ]),
    );

    const publicToken = publicSchema.data!.__schema.types.find(
      ({ name }) => name === 'ApiTokenModel',
    );
    expect(publicToken?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'organizationId',
          isDeprecated: false,
        }),
        expect.objectContaining({
          name: 'projectId',
          isDeprecated: true,
          deprecationReason: 'Use organizationId.',
        }),
        expect.objectContaining({
          name: 'projectName',
          isDeprecated: false,
        }),
      ]),
    );

    const publicTokenInput = publicSchema.data!.__schema.types.find(
      ({ name }) => name === 'CreateApiTokenInput',
    );
    expect(publicTokenInput?.inputFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'organizationId',
          isDeprecated: false,
          type: expect.objectContaining({
            kind: 'SCALAR',
            name: 'ID',
          }) as object,
        }),
        expect.objectContaining({
          name: 'projectId',
          isDeprecated: true,
          deprecationReason: 'Use organizationId.',
          type: expect.objectContaining({
            kind: 'SCALAR',
            name: 'ID',
          }) as object,
        }),
      ]),
    );
    expect(
      publicTokenInput?.inputFields
        ?.filter(({ name }) => ['organizationId', 'projectId'].includes(name))
        .every(({ type }) => type.kind !== 'NON_NULL'),
    ).toBe(true);
    expect(adminTypes).not.toContain('ApiCredential');
    expect(adminTypes).not.toContain('CreateApiTokenInput');
  });

  it('does not let an ordinary session access token management on the admin endpoint', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'supersecret1' },
    });
    const jwt = (JSON.parse(signup.body) as { token: string }).token;
    const response = await app.inject({
      method: 'POST',
      url: '/admin/graphql',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { query: `{ apiTokens { id } }` },
    });
    const body = JSON.parse(response.body) as {
      data?: unknown;
      errors?: Array<{ message: string }>;
    };

    expect(body.data).toBeUndefined();
    expect(body.errors?.[0]?.message).toMatch(
      /cannot query field "apiTokens"/i,
    );
  });

  it('exposes public email verification without adding private mutation inputs', async () => {
    const schema = await schemaAt('/graphql');
    const queryNames = schema.data!.__schema.queryType.fields.map(
      ({ name }) => name,
    );
    const mutations = schema.data!.__schema.mutationType.fields;
    const mutationNames = mutations.map(({ name }) => name);

    expect(queryNames).toContain('emailChannelVerificationPreview');
    expect(mutationNames).toEqual(
      expect.arrayContaining([
        'verifyEmailChannel',
        'resendEmailChannelVerification',
        'createChannel',
        'deleteChannel',
      ]),
    );

    const forbiddenInputs = [
      'verified',
      'enabled',
      'verifiedAt',
      'verificationTokenHash',
      'tokenHash',
    ];
    for (const mutation of mutations) {
      expect(mutation.args.map(({ name }) => name)).toEqual(
        expect.not.arrayContaining(forbiddenInputs),
      );
    }

    const channelFields = schema.data!.__schema.types.find(
      ({ name }) => name === 'ChannelModel',
    )!.fields!;
    expect(
      channelFields.find(({ name }) => name === 'verificationStatus')!.type,
    ).toEqual({
      kind: 'NON_NULL',
      name: null,
      ofType: { kind: 'SCALAR', name: 'String' },
    });
    expect(
      channelFields.find(({ name }) => name === 'verificationDeliveryStatus')!
        .type,
    ).toEqual({
      kind: 'NON_NULL',
      name: null,
      ofType: { kind: 'SCALAR', name: 'String' },
    });
    expect(
      channelFields.find(({ name }) => name === 'verificationExpiresAt'),
    ).toBeDefined();
  });

  it('keeps channel management guarded while preview and confirmation are public', async () => {
    const operations = [
      `{ channels(projectId: "missing") { id } }`,
      `mutation { createChannel(projectId: "missing", type: "EMAIL", configJson: "{}") { id } }`,
      `mutation { deleteChannel(id: "missing") }`,
      `mutation { resendEmailChannelVerification(channelId: "missing") { id } }`,
    ];
    for (const query of operations) {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });
      const body = JSON.parse(response.body) as {
        errors?: Array<{ message: string }>;
      };
      expect(body.errors?.[0]?.message).toMatch(/unauthorized/i);
    }

    for (const query of [
      `{ emailChannelVerificationPreview(token: "invalid") { status } }`,
      `mutation { verifyEmailChannel(token: "invalid") { status } }`,
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });
      const body = JSON.parse(response.body) as {
        data?: Record<string, { status: string }>;
        errors?: Array<{ message: string }>;
      };
      expect(body.errors).toBeUndefined();
      expect(Object.values(body.data!)[0].status).toBe('INVALID');
    }
  });
});
