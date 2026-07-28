import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

@InputType()
export class CreateApiTokenInput {
  @Field()
  @IsString()
  name!: string;

  @Field(() => [String])
  @IsArray()
  @IsString({ each: true })
  capabilities!: string[];

  @Field(() => ID)
  @IsString()
  projectId!: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expirationDays?: number;
}
