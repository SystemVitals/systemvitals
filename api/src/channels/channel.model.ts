import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class ChannelModel {
  @Field(() => ID) id!: string;
  @Field() type!: string;
  @Field() configJson!: string;
  @Field() enabled!: boolean;
  @Field(() => ID) projectId!: string;
  @Field()
  verificationStatus!: string;
  @Field(() => Date, { nullable: true })
  verificationExpiresAt!: Date | null;
  @Field()
  verificationDeliveryStatus!: string;
}
