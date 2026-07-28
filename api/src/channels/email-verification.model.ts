import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class EmailVerificationPreviewModel {
  @Field()
  status!: string;

  @Field({ nullable: true })
  maskedEmail?: string;

  @Field({ nullable: true })
  projectName?: string;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date;
}

@ObjectType()
export class EmailVerificationConfirmationModel {
  @Field()
  status!: string;

  @Field({ nullable: true })
  maskedEmail?: string;

  @Field({ nullable: true })
  projectName?: string;
}
