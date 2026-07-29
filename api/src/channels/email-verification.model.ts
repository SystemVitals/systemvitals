import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class EmailVerificationPreviewModel {
  @Field()
  status!: string;

  @Field({ nullable: true })
  maskedEmail?: string;

  @Field({ nullable: true })
  organizationName?: string;

  @Field({
    nullable: true,
    deprecationReason: 'Use organizationName.',
  })
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
  organizationName?: string;

  @Field({
    nullable: true,
    deprecationReason: 'Use organizationName.',
  })
  projectName?: string;
}
