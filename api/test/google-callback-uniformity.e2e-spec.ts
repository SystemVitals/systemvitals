/**
 * Finding 4 (#5): a passport authentication failure and a loginWithGoogle()
 * rejection must be indistinguishable to the browser — both are generic
 * failures and neither should leak which step failed. This exercises the
 * real /auth/google/callback route (not a unit-level call) with GoogleAuthGuard
 * overridden to simulate each case, since driving actual passport/Google
 * failure and success paths end-to-end isn't practical in a test.
 */
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ExecutionContext, ValidationPipe } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/google-auth.guard';
import { AuthService } from '../src/auth/auth.service';

/** Simulates a passport failure: the guard admits the request but leaves req.user unset. */
class AdmitWithNoUserGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/** Simulates passport success: the guard admits the request with a real Google identity. */
class AdmitWithUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = {
      googleId: 'g-uniformity-test',
      email: 'uniformity@example.com',
      emailVerified: true,
    };
    return true;
  }
}

async function buildTestApp(
  guardOverride: new () => CanActivate,
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideGuard(GoogleAuthGuard)
    .useClass(guardOverride)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
    { rawBody: true },
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.enableCors({ origin: true, credentials: true });
  return app;
}

describe('GET /auth/google/callback failure uniformity (e2e)', () => {
  it('a passport failure and a loginWithGoogle rejection produce byte-identical responses', async () => {
    const appPassportFailure = await buildTestApp(AdmitWithNoUserGuard);
    await appPassportFailure.init();
    await appPassportFailure.getHttpAdapter().getInstance().ready();

    const appServiceFailure = await buildTestApp(AdmitWithUserGuard);
    appServiceFailure.get(AuthService).loginWithGoogle = jest
      .fn()
      .mockRejectedValue(new Error('db down'));
    await appServiceFailure.init();
    await appServiceFailure.getHttpAdapter().getInstance().ready();

    try {
      const resPassportFailure = await appPassportFailure.inject({
        method: 'GET',
        url: '/auth/google/callback',
      });
      const resServiceFailure = await appServiceFailure.inject({
        method: 'GET',
        url: '/auth/google/callback',
      });

      expect(resPassportFailure.statusCode).toBe(resServiceFailure.statusCode);
      expect(resPassportFailure.headers.location).toBe(
        resServiceFailure.headers.location,
      );
      expect(resPassportFailure.body).toBe(resServiceFailure.body);

      // Sanity: both actually landed on the generic failure redirect.
      expect(String(resPassportFailure.headers.location)).toContain(
        '/login?error=google',
      );
    } finally {
      await appPassportFailure.close();
      await appServiceFailure.close();
    }
  });
});
