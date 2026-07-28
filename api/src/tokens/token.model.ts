import { Field, ID, ObjectType } from '@nestjs/graphql';

export type CredentialMode = 'SESSION' | 'LEGACY_BROAD' | 'PROJECT_SCOPED';

@ObjectType()
export class ApiTokenModel {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() prefix!: string;
  @Field(() => [String]) scopes!: string[];
  @Field(() => ID, { nullable: true }) projectId?: string;
  @Field({ nullable: true }) projectName?: string;
  @Field({ nullable: true }) organizationName?: string;
  @Field({ nullable: true }) expiresAt?: Date;
  @Field({ nullable: true }) lastUsedAt?: Date;
  @Field({ nullable: true }) revokedAt?: Date;
  @Field() createdAt!: Date;
}

@ObjectType()
export class ApiTokenCreateResult extends ApiTokenModel {
  @Field() plaintext!: string; // shown ONCE
}

@ObjectType()
export class ApiCredential {
  @Field() authKind!: string;
  @Field() credentialMode!: CredentialMode;
  @Field(() => [String]) capabilities!: string[];
  @Field(() => ID, { nullable: true }) projectId!: string | null;
  @Field(() => String, { nullable: true }) projectName!: string | null;
}
