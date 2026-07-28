import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, MinLength, validateSync } from 'class-validator';

const EMAIL_VERIFICATION_QUEUE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

class EnvVars {
  @IsString() DATABASE_URL!: string;
  @IsString() @MinLength(16) JWT_SECRET!: string;
  @IsOptional() @IsString() REDIS_URL?: string;
  @IsOptional() @IsString() QUEUE_ALERT?: string;
  @IsOptional() @IsString() QUEUE_INVITE?: string;
  @IsOptional() @IsString() QUEUE_EMAIL_VERIFICATION?: string;
  // Stripe billing (optional — non-billing dev/test boots without these)
  @IsOptional() @IsString() STRIPE_SECRET_KEY?: string;
  @IsOptional() @IsString() STRIPE_WEBHOOK_SECRET?: string;
  @IsOptional() @IsString() STRIPE_PRICE_SIGNAL?: string;
  @IsOptional() @IsString() STRIPE_PRICE_FLEET?: string;
  @IsOptional() @IsString() APP_URL?: string;
  @IsOptional() @IsString() ADMIN_EMAILS?: string;
  // Google OAuth (optional — absent means Google sign-in is disabled)
  @IsOptional() @IsString() GOOGLE_CLIENT_ID?: string;
  @IsOptional() @IsString() GOOGLE_CLIENT_SECRET?: string;
  @IsOptional() @IsString() GOOGLE_CALLBACK_URL?: string;
  @IsOptional() @IsString() TELEGRAM_BOT_TOKEN?: string;
  @IsOptional() @IsString() TELEGRAM_WEBHOOK_SECRET?: string;
  @IsOptional() @IsString() TELEGRAM_WEBHOOK_URL?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvVars, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length) throw new Error(errors.toString());

  validated.TELEGRAM_BOT_TOKEN = validated.TELEGRAM_BOT_TOKEN?.trim();
  validated.TELEGRAM_WEBHOOK_SECRET = validated.TELEGRAM_WEBHOOK_SECRET?.trim();
  validated.TELEGRAM_WEBHOOK_URL = validated.TELEGRAM_WEBHOOK_URL?.trim();
  if (validated.QUEUE_EMAIL_VERIFICATION === undefined) {
    validated.QUEUE_EMAIL_VERIFICATION = 'email-verification';
  } else {
    const queueName = validated.QUEUE_EMAIL_VERIFICATION.trim();
    if (!EMAIL_VERIFICATION_QUEUE_NAME_PATTERN.test(queueName)) {
      throw new Error('QUEUE_EMAIL_VERIFICATION has an invalid format');
    }
    validated.QUEUE_EMAIL_VERIFICATION = queueName;
  }

  const telegramValues = [
    validated.TELEGRAM_BOT_TOKEN,
    validated.TELEGRAM_WEBHOOK_SECRET,
    validated.TELEGRAM_WEBHOOK_URL,
  ];
  const configuredCount = telegramValues.filter((value) => value).length;

  if (configuredCount > 0 && configuredCount < telegramValues.length) {
    throw new Error(
      'Telegram configuration requires TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and TELEGRAM_WEBHOOK_URL',
    );
  }

  if (configuredCount === telegramValues.length) {
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(validated.TELEGRAM_WEBHOOK_SECRET ?? '')
    ) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET has an invalid format');
    }

    let webhookUrl: URL;
    try {
      webhookUrl = new URL(validated.TELEGRAM_WEBHOOK_URL ?? '');
    } catch {
      throw new Error('TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL');
    }
    if (webhookUrl.protocol !== 'https:') {
      throw new Error('TELEGRAM_WEBHOOK_URL must use HTTPS');
    }
  }

  return validated;
}
