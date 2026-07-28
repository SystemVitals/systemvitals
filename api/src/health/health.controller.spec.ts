import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { HealthController } from './health.controller';
import { ReadinessService, type ReadinessResult } from './readiness.service';

describe('HealthController', () => {
  let app: NestFastifyApplication;
  const check = jest.fn<Promise<ReadinessResult>, []>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: ReadinessService, useValue: { check } }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(() => {
    check.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns process liveness without authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 200 when the application is ready', async () => {
    check.mockResolvedValue({ ready: true });

    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('returns a sanitized 503 reason when the application is not ready', async () => {
    check.mockResolvedValue({
      ready: false,
      reason: 'postgres_unavailable',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      reason: 'postgres_unavailable',
    });
  });
});
