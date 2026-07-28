import 'reflect-metadata';
import { validateEnv } from './env.validation';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://user:password@example.test/systemvitals',
  JWT_SECRET: 'synthetic-secret',
};

const TELEGRAM_ENV = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret',
  TELEGRAM_WEBHOOK_URL:
    'https://api.example.test/integrations/telegram/webhook',
};

describe('validateEnv Telegram configuration', () => {
  it('defaults the email-verification queue name when it is absent', () => {
    expect(validateEnv(BASE_ENV).QUEUE_EMAIL_VERIFICATION).toBe(
      'email-verification',
    );
  });

  it('trims a configured email-verification queue name', () => {
    expect(
      validateEnv({
        ...BASE_ENV,
        QUEUE_EMAIL_VERIFICATION: '  verification-delivery  ',
      }).QUEUE_EMAIL_VERIFICATION,
    ).toBe('verification-delivery');
  });

  it('accepts a safe custom email-verification queue name', () => {
    expect(
      validateEnv({
        ...BASE_ENV,
        QUEUE_EMAIL_VERIFICATION: 'verification_delivery-2',
      }).QUEUE_EMAIL_VERIFICATION,
    ).toBe('verification_delivery-2');
  });

  it.each([
    '',
    '   ',
    'verification:delivery',
    'verification delivery',
    'bad\nqueue',
  ])('rejects unsafe email-verification queue name %p', (queueName) => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        QUEUE_EMAIL_VERIFICATION: queueName,
      }),
    ).toThrow('QUEUE_EMAIL_VERIFICATION has an invalid format');
  });

  it('accepts configuration without Telegram values', () => {
    expect(() => validateEnv(BASE_ENV)).not.toThrow();
  });

  it('rejects partial Telegram configuration', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        TELEGRAM_BOT_TOKEN: 'test-token',
      }),
    ).toThrow(/Telegram configuration requires/);
  });

  it('rejects a malformed Telegram webhook secret', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        ...TELEGRAM_ENV,
        TELEGRAM_WEBHOOK_SECRET: 'bad secret',
      }),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('rejects a non-HTTPS Telegram webhook URL', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        ...TELEGRAM_ENV,
        TELEGRAM_WEBHOOK_URL:
          'http://api.example.test/integrations/telegram/webhook',
      }),
    ).toThrow(/HTTPS/);
  });

  it('sanitizes malformed Telegram webhook URL errors', () => {
    let error: unknown;

    try {
      validateEnv({
        ...BASE_ENV,
        ...TELEGRAM_ENV,
        TELEGRAM_WEBHOOK_URL: 'not a valid URL',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/TELEGRAM_WEBHOOK_URL/);
    expect(message).not.toContain(TELEGRAM_ENV.TELEGRAM_BOT_TOKEN);
    expect(message).not.toContain(TELEGRAM_ENV.TELEGRAM_WEBHOOK_SECRET);
    expect(message).not.toContain('not a valid URL');
  });

  it('accepts and trims a complete valid Telegram configuration', () => {
    const validated = validateEnv({
      ...BASE_ENV,
      TELEGRAM_BOT_TOKEN: ` ${TELEGRAM_ENV.TELEGRAM_BOT_TOKEN} `,
      TELEGRAM_WEBHOOK_SECRET: ` ${TELEGRAM_ENV.TELEGRAM_WEBHOOK_SECRET} `,
      TELEGRAM_WEBHOOK_URL: ` ${TELEGRAM_ENV.TELEGRAM_WEBHOOK_URL} `,
    });

    expect(validated).toMatchObject(TELEGRAM_ENV);
  });
});
