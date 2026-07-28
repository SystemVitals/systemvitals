import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ThrottlerModule } from '@nestjs/throttler';
import { GraphQLSchema } from 'graphql';
import { join } from 'path';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { AuthGraphqlModule } from './auth/auth-graphql.module';
import { TokensModule } from './tokens/tokens.module';
import { ProjectsModule } from './projects/projects.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MembersModule } from './members/members.module';
import { ChecksModule } from './checks/checks.module';
import { PingModule } from './ping/ping.module';
import { ChannelsModule } from './channels/channels.module';
import { QueueModule } from './queue/queue.module';
import { StatusPagesModule } from './status-pages/status-pages.module';
import { PublicStatusModule } from './public-status/public-status.module';
import { BillingModule } from './billing/billing.module';
import { AdminModule } from './admin/admin.module';
import { TelegramModule } from './telegram/telegram.module';

const PUBLIC_ONLY_SCHEMA_TYPES = new Set([
  'ApiCredential',
  'ManagedTelegramBotModel',
  'TelegramConnectionPreviewModel',
]);

function isolateAdminSchema(schema: GraphQLSchema): GraphQLSchema {
  const config = schema.toConfig();
  return new GraphQLSchema({
    ...config,
    types: config.types.filter(
      ({ name }) => !PUBLIC_ONLY_SCHEMA_TYPES.has(name),
    ),
  });
}

export function graphqlSchemaDestination(
  filename: string,
  nodeEnv = process.env.NODE_ENV,
): true | string {
  return nodeEnv === 'production' ? true : join(process.cwd(), 'src', filename);
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 10 }],
      skipIf: () =>
        process.env.NODE_ENV === 'test' ||
        process.env.DISABLE_THROTTLE === 'true',
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: graphqlSchemaDestination('schema.gql'),
      sortSchema: true,
      playground: process.env.NODE_ENV !== 'production',
      introspection: process.env.NODE_ENV !== 'production',
      context: ({ request }: { request: unknown }) => ({ req: request }),
      include: [
        AuthGraphqlModule,
        HealthModule,
        TokensModule,
        ProjectsModule,
        OrganizationsModule,
        MembersModule,
        ChecksModule,
        ChannelsModule,
        StatusPagesModule,
        BillingModule,
        TelegramModule,
      ],
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      path: '/admin/graphql',
      autoSchemaFile: graphqlSchemaDestination('admin-schema.gql'),
      sortSchema: true,
      playground: process.env.NODE_ENV !== 'production',
      introspection: process.env.NODE_ENV !== 'production',
      context: ({ request }: { request: unknown }) => ({ req: request }),
      include: [AdminModule],
      transformSchema: isolateAdminSchema,
      transformAutoSchemaFile: true,
    }),
    PrismaModule,
    AuthModule,
    AuthGraphqlModule,
    HealthModule,
    TokensModule,
    ProjectsModule,
    OrganizationsModule,
    MembersModule,
    ChecksModule,
    QueueModule,
    PingModule,
    ChannelsModule,
    StatusPagesModule,
    PublicStatusModule,
    BillingModule,
    AdminModule,
    TelegramModule,
  ],
})
export class AppModule {}
