import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { captureServerError } from './instrument';

@Catch()
export class SentryExceptionFilter extends SentryGlobalFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    // The SDK excludes every HttpException, including unexpected GraphQL 5xx.
    if (exception instanceof HttpException && exception.getStatus() >= 500) {
      captureServerError(exception);
    }
    super.catch(exception, host);
  }
}
