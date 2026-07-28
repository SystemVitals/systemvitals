import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class CheckEventModel {
  @Field(() => ID) id!: string;
  @Field() status!: string;
  @Field() timestamp!: Date;
  @Field({ nullable: true }) error?: string;
  @Field(() => Int, { nullable: true }) responseTimeMs?: number;
  @Field(() => Int, { nullable: true }) statusCode?: number;
}

@ObjectType()
export class CheckModel {
  @Field(() => ID) id!: string;
  notificationChannelIds?: string[];
  @Field() name!: string;
  @Field() slug!: string;
  @Field() type!: string;
  @Field() status!: string;
  @Field({ nullable: true }) pingSlug?: string;
  @Field(() => Int, { nullable: true }) periodSeconds?: number;
  @Field(() => Int, { nullable: true }) graceSeconds?: number;
  @Field({ nullable: true }) schedule?: string;
  @Field({ nullable: true }) tz?: string;
  @Field({ nullable: true }) nextExpectedAt?: Date;
  @Field({ nullable: true }) lastEventAt?: Date;
  @Field(() => ID) projectId!: string;
  @Field({ nullable: true }) target?: string;
  @Field({ nullable: true }) method?: string;
  @Field(() => Int, { nullable: true }) expectedStatus?: number;
  @Field(() => Int, { nullable: true }) intervalSeconds?: number;
  @Field(() => Int, { nullable: true }) timeoutMs?: number;
}
