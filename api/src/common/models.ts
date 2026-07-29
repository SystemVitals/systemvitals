import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    'Deprecated compatibility output. Organizations are the public workspace.',
})
export class ProjectModel {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() slug!: string;
  @Field() pingKey!: string;
  @Field(() => ID) organizationId!: string;
}

@ObjectType()
export class OrganizationModel {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() slug!: string;
  @Field() pingKey!: string;
  /** The requesting user's role in this organization. */
  @Field() role!: string;
  /** The organization's current subscription plan (SOLO/SIGNAL/FLEET). */
  @Field() plan!: string;
  @Field(() => ID) creatorUserId!: string;
  @Field() creatorLabel!: string;
  @Field(() => [ProjectModel], {
    deprecationReason: 'Organizations now contain one implicit workspace.',
  })
  projects!: ProjectModel[];
}

@ObjectType()
export class UserModel {
  @Field(() => ID) id!: string;
  @Field() email!: string;
  @Field() isAdmin!: boolean;
  @Field() hasPassword!: boolean;
  @Field() googleLinked!: boolean;
  @Field(() => [OrganizationModel]) organizations!: OrganizationModel[];
}
