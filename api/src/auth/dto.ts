import { ArgsType, Field } from '@nestjs/graphql';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CredentialsDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
}

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
}

@ArgsType()
export class SetPasswordArgs {
  @Field()
  @IsString()
  @MinLength(8)
  newPassword!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
