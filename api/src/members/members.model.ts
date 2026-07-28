import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class MemberModel {
  /** Membership id — the handle for role changes and removal. */
  @Field(() => ID) id!: string;
  @Field(() => ID) userId!: string;
  @Field() email!: string;
  @Field() role!: string;
  @Field() createdAt!: Date;
}

@ObjectType()
export class InviteModel {
  @Field(() => ID) id!: string;
  @Field() email!: string;
  @Field() role!: string;
  @Field() token!: string;
  /** Ready-to-share accept URL, built from APP_URL. */
  @Field() acceptUrl!: string;
  @Field() expiresAt!: Date;
  @Field() createdAt!: Date;
}

@ObjectType()
export class InvitePreviewModel {
  @Field() organizationName!: string;
  @Field() maskedEmail!: string;
  /** PENDING | ACCEPTED | REVOKED | EXPIRED | NOT_FOUND */
  @Field() status!: string;
}
