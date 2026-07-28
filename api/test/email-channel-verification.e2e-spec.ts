import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashEmailVerificationToken } from '../src/channels/email-verification-token';
import {
  EmailVerificationQueueService,
  type EmailVerificationJobData,
} from '../src/queue/email-verification-queue.service';
import { generateToken } from '../src/tokens/token.util';
import { cleanupTestUsers } from './cleanup-test-users';

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ChannelResult {
  id: string;
  enabled: boolean;
  verificationStatus: string;
  verificationDeliveryStatus: string;
  verificationExpiresAt: string | null;
}

const CHANNEL_FIELDS = `
  id enabled verificationStatus verificationDeliveryStatus verificationExpiresAt
`;

describe('email channel verification GraphQL flow (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ownerJwt: string;
  let intruderJwt: string;
  let ownerId: string;
  let projectId: string;
  let apiToken: string;
  let enqueueSpy: jest.SpiedFunction<EmailVerificationQueueService['enqueue']>;
  const capturedJobs: EmailVerificationJobData[] = [];

  const suffix = randomUUID();
  const ownerEmail = `email-verification-owner+${suffix}@systemvitals.com`;
  const intruderEmail = `email-verification-intruder+${suffix}@systemvitals.com`;

  async function gql<T>(
    query: string,
    variables?: unknown,
    token?: string,
  ): Promise<GqlResponse<T>> {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      payload: { query, variables },
    });
    return JSON.parse(response.body) as GqlResponse<T>;
  }

  async function signup(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'supersecret1' },
    });
    return (JSON.parse(response.body) as { token: string }).token;
  }

  async function createEmailChannel(
    authToken: string,
    destination: string,
  ): Promise<{ channel: ChannelResult; job: EmailVerificationJobData }> {
    const jobCountBefore = capturedJobs.length;
    const response = await gql<{ createChannel: ChannelResult }>(
      `mutation Create($projectId: ID!, $configJson: String!) {
        createChannel(projectId: $projectId, type: "EMAIL", configJson: $configJson) {
          ${CHANNEL_FIELDS}
        }
      }`,
      {
        projectId,
        configJson: JSON.stringify({ email: destination }),
      },
      authToken,
    );
    expect(response.errors).toBeUndefined();
    expect(capturedJobs).toHaveLength(jobCountBefore + 1);
    const channel = response.data!.createChannel;
    const job = capturedJobs[jobCountBefore];
    expect(job.channelId).toBe(channel.id);
    return { channel, job };
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    enqueueSpy = jest
      .spyOn(app.get(EmailVerificationQueueService), 'enqueue')
      .mockImplementation((job) => {
        capturedJobs.push({ ...job });
        return Promise.resolve();
      });
    await cleanupTestUsers(prisma, [ownerEmail, intruderEmail]);

    ownerJwt = await signup(ownerEmail);
    intruderJwt = await signup(intruderEmail);
    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: ownerEmail },
      include: {
        memberships: {
          include: { organization: { include: { projects: true } } },
        },
      },
    });
    ownerId = owner.id;
    projectId = owner.memberships[0].organization.projects[0].id;

    const generated = generateToken();
    apiToken = generated.plaintext;
    await prisma.apiToken.create({
      data: {
        name: `email-verification-${suffix}`,
        prefix: generated.prefix,
        tokenHash: generated.hash,
        scopes: ['read', 'write'],
        userId: ownerId,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [ownerEmail, intruderEmail]);
    } finally {
      capturedJobs.length = 0;
      enqueueSpy.mockRestore();
      await app.close();
    }
  });

  it('creates a pending email channel and only an explicit public mutation verifies it', async () => {
    const { channel, job } = await createEmailChannel(
      ownerJwt,
      `alerts-${suffix}@Example.COM`,
    );
    expect(channel).toMatchObject({
      enabled: false,
      verificationStatus: 'PENDING',
    });
    expect(channel.verificationDeliveryStatus).toBe('SENT');
    expect(channel.verificationExpiresAt).toBeTruthy();

    const pending = await prisma.notificationChannel.findUniqueOrThrow({
      where: { id: channel.id },
      select: {
        verificationTokenHash: true,
        verificationExpiresAt: true,
      },
    });
    expect(
      pending.verificationTokenHash ===
        hashEmailVerificationToken(job.rawToken),
    ).toBe(true);
    const expiresAt = pending.verificationExpiresAt!;

    const beforePreview = await prisma.notificationChannel.findUniqueOrThrow({
      where: { id: channel.id },
    });
    const preview = await gql<{
      emailChannelVerificationPreview: {
        status: string;
        maskedEmail: string | null;
        projectName: string | null;
        expiresAt: string | null;
      };
    }>(
      `query Preview($token: String!) {
        emailChannelVerificationPreview(token: $token) {
          status maskedEmail projectName expiresAt
        }
      }`,
      { token: job.rawToken },
    );
    expect(preview.errors).toBeUndefined();
    expect(preview.data!.emailChannelVerificationPreview).toMatchObject({
      status: 'PENDING',
      expiresAt: expiresAt.toISOString(),
    });
    expect(preview.data!.emailChannelVerificationPreview.maskedEmail).toMatch(
      /^a•+@example[.]com$/,
    );
    expect(
      preview.data!.emailChannelVerificationPreview.projectName,
    ).toBeTruthy();

    const afterPreview = await prisma.notificationChannel.findUniqueOrThrow({
      where: { id: channel.id },
    });
    expect(afterPreview.enabled).toBe(beforePreview.enabled);
    expect(afterPreview.verifiedAt).toEqual(beforePreview.verifiedAt);
    expect(afterPreview.verificationTokenHash).toBe(
      beforePreview.verificationTokenHash,
    );

    const confirmation = await gql<{
      verifyEmailChannel: {
        status: string;
        maskedEmail: string | null;
        projectName: string | null;
      };
    }>(
      `mutation Verify($token: String!) {
        verifyEmailChannel(token: $token) {
          status maskedEmail projectName
        }
      }`,
      { token: job.rawToken },
    );
    expect(confirmation.errors).toBeUndefined();
    expect(confirmation.data!.verifyEmailChannel.status).toBe('VERIFIED');

    const verified = await prisma.notificationChannel.findUniqueOrThrow({
      where: { id: channel.id },
    });
    expect(verified).toMatchObject({
      enabled: true,
      verificationTokenHash: null,
      verificationExpiresAt: null,
    });
    expect(verified.verifiedAt).toBeInstanceOf(Date);

    const replay = await gql<{
      verifyEmailChannel: {
        status: string;
        maskedEmail: string | null;
        projectName: string | null;
      };
    }>(
      `mutation Verify($token: String!) {
        verifyEmailChannel(token: $token) {
          status maskedEmail projectName
        }
      }`,
      { token: job.rawToken },
    );
    expect(replay.data!.verifyEmailChannel).toEqual({
      status: 'INVALID',
      maskedEmail: null,
      projectName: null,
    });
  });

  it('returns non-leaking EXPIRED and INVALID public responses', async () => {
    const { channel, job } = await createEmailChannel(
      ownerJwt,
      `expired-${suffix}@example.com`,
    );
    await prisma.notificationChannel.update({
      where: { id: channel.id },
      data: {
        verificationExpiresAt: new Date(Date.now() - 1),
      },
    });

    const query = `query Preview($token: String!) {
      emailChannelVerificationPreview(token: $token) {
        status maskedEmail projectName expiresAt
      }
    }`;
    const expired = await gql<{
      emailChannelVerificationPreview: Record<string, string | null>;
    }>(query, { token: job.rawToken });
    const invalid = await gql<{
      emailChannelVerificationPreview: Record<string, string | null>;
    }>(query, { token: 'malformed-or-missing' });

    expect(expired.data!.emailChannelVerificationPreview).toEqual({
      status: 'EXPIRED',
      maskedEmail: null,
      projectName: null,
      expiresAt: null,
    });
    expect(invalid.data!.emailChannelVerificationPreview).toEqual({
      status: 'INVALID',
      maskedEmail: null,
      projectName: null,
      expiresAt: null,
    });

    const confirmation = await gql<{
      verifyEmailChannel: Record<string, string | null>;
    }>(
      `mutation Verify($token: String!) {
        verifyEmailChannel(token: $token) {
          status maskedEmail projectName
        }
      }`,
      { token: job.rawToken },
    );
    expect(confirmation.data!.verifyEmailChannel).toEqual({
      status: 'EXPIRED',
      maskedEmail: null,
      projectName: null,
    });
    expect(
      await prisma.notificationChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: { enabled: true, verifiedAt: true },
      }),
    ).toEqual({ enabled: false, verifiedAt: null });
  });

  it('keeps resend authenticated and membership-authorized', async () => {
    const { channel, job: createJob } = await createEmailChannel(
      ownerJwt,
      `resend-${suffix}@example.com`,
    );
    await prisma.notificationChannel.update({
      where: { id: channel.id },
      data: { verificationSentAt: null },
    });
    const mutation = `mutation Resend($channelId: ID!) {
      resendEmailChannelVerification(channelId: $channelId) { ${CHANNEL_FIELDS} }
    }`;

    const anonymous = await gql(mutation, { channelId: channel.id });
    expect(anonymous.errors?.[0]?.message).toMatch(/unauthorized/i);

    const intruder = await gql(
      mutation,
      { channelId: channel.id },
      intruderJwt,
    );
    expect(intruder.errors?.[0]?.message).toMatch(/unavailable/i);

    const owner = await gql<{ resendEmailChannelVerification: ChannelResult }>(
      mutation,
      { channelId: channel.id },
      ownerJwt,
    );
    expect(owner.errors).toBeUndefined();
    expect(owner.data!.resendEmailChannelVerification).toMatchObject({
      id: channel.id,
      enabled: false,
      verificationStatus: 'PENDING',
    });
    const resendJob = capturedJobs.at(-1)!;
    expect(resendJob.channelId).toBe(channel.id);
    expect(resendJob.rawToken === createJob.rawToken).toBe(false);
    const resent = await prisma.notificationChannel.findUniqueOrThrow({
      where: { id: channel.id },
      select: { verificationTokenHash: true },
    });
    expect(
      resent.verificationTokenHash ===
        hashEmailVerificationToken(resendJob.rawToken),
    ).toBe(true);
  });

  it('lets API tokens create/resend pending channels but not set verified state', async () => {
    const { channel } = await createEmailChannel(
      apiToken,
      `api-token-${suffix}@example.com`,
    );
    expect(channel).toMatchObject({
      enabled: false,
      verificationStatus: 'PENDING',
    });

    await prisma.notificationChannel.update({
      where: { id: channel.id },
      data: { verificationSentAt: null },
    });
    const resend = await gql<{ resendEmailChannelVerification: ChannelResult }>(
      `mutation Resend($channelId: ID!) {
        resendEmailChannelVerification(channelId: $channelId) { ${CHANNEL_FIELDS} }
      }`,
      { channelId: channel.id },
      apiToken,
    );
    expect(resend.errors).toBeUndefined();
    expect(resend.data!.resendEmailChannelVerification.enabled).toBe(false);
    expect(
      await prisma.notificationChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: { verifiedAt: true },
      }),
    ).toEqual({ verifiedAt: null });
  });
});
