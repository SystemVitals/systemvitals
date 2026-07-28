import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class EscalationStepModel {
  @Field(() => ID) channelId!: string;
  @Field(() => Int) delaySeconds!: number;
}

@ObjectType()
export class EscalationPolicyModel {
  @Field(() => ID) id!: string;
  @Field(() => ID) projectId!: string;
  @Field(() => [EscalationStepModel]) steps!: EscalationStepModel[];
}
