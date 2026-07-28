import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString } from 'class-validator';

/**
 * Every field is optional and an absent field means "leave unchanged".
 * Callers never send explicit nulls — columns belonging to the mode a check is
 * leaving are cleared by the conversion rules in `check-update.ts`.
 *
 * `main.ts` installs a global `ValidationPipe({ whitelist: true })`, which
 * applies to GraphQL args too. Without a `class-validator` decorator on each
 * field, whitelist stripping silently drops every property to `{}` before it
 * reaches the resolver — so every field below needs `@IsOptional()` plus a
 * type validator, matching the existing `SetPasswordArgs` pattern in
 * `src/auth/dto.ts`.
 */
@InputType()
export class UpdateCheckInput {
  @Field({ nullable: true }) @IsOptional() @IsString() name?: string;
  @Field({ nullable: true }) @IsOptional() @IsString() slug?: string;
  @Field({ nullable: true }) @IsOptional() @IsString() type?: string;
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  periodSeconds?: number;
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  graceSeconds?: number;
  @Field({ nullable: true }) @IsOptional() @IsString() schedule?: string;
  @Field({ nullable: true }) @IsOptional() @IsString() tz?: string;
  @Field({ nullable: true }) @IsOptional() @IsString() target?: string;
  @Field({ nullable: true }) @IsOptional() @IsString() method?: string;
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  expectedStatus?: number;
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  intervalSeconds?: number;
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  timeoutMs?: number;
}
