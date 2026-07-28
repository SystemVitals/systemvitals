import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class StatusPageModel {
  @Field(() => ID) id!: string;
  @Field() slug!: string;
  @Field() title!: string;
  @Field({ nullable: true }) branding?: string;
  @Field(() => [String]) checkIds!: string[];
  @Field(() => ID) projectId!: string;
}
