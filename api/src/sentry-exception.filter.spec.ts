jest.mock('./instrument', () => ({ captureServerError: jest.fn() }));

import {
  ArgumentsHost,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { captureServerError } from './instrument';
import { SentryExceptionFilter } from './sentry-exception.filter';

describe('SentryExceptionFilter', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('captures GraphQL HttpException 500 and preserves the thrown exception', () => {
    const host = { getType: () => 'graphql' } as ArgumentsHost;
    const error = new InternalServerErrorException('Workspace is inconsistent');
    expect(() => new SentryExceptionFilter().catch(error, host)).toThrow(error);
    expect(captureServerError).toHaveBeenCalledWith(error);
    expect(captureServerError).toHaveBeenCalledTimes(1);
  });

  it('keeps expected GraphQL 4xx excluded', () => {
    const host = { getType: () => 'graphql' } as ArgumentsHost;
    const error = new BadRequestException('Invalid request');
    expect(() => new SentryExceptionFilter().catch(error, host)).toThrow(error);
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it('delegates ordinary errors without double reporting', () => {
    const base = jest
      .spyOn(SentryGlobalFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
    const host = { getType: () => 'http' } as ArgumentsHost;
    const error = new Error('database unavailable');
    new SentryExceptionFilter().catch(error, host);
    expect(base).toHaveBeenCalledWith(error, host);
    expect(captureServerError).not.toHaveBeenCalled();
  });
});
