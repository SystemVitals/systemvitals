import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

describe('health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => app.close());

  it('answers the health query', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ health }' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { health: string } };
    expect(body.data.health).toBe('ok');
  });
});
