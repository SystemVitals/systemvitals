import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { BadRequestException, UseGuards } from '@nestjs/common';
import type { Role } from '@systemvitals/database';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { MembersService, type InviteRow } from './members.service';
import { InviteModel, InvitePreviewModel, MemberModel } from './members.model';

const ROLES: readonly string[] = ['OWNER', 'ADMIN', 'MEMBER'];

function parseRole(value: string): Role {
  if (!ROLES.includes(value)) {
    throw new BadRequestException(`Invalid role: ${value}`);
  }
  return value as Role;
}

@Resolver()
export class MembersResolver {
  constructor(private readonly members: MembersService) {}

  private toInviteModel(row: InviteRow): InviteModel {
    return { ...row, acceptUrl: this.members.inviteAcceptUrl(row.token) };
  }

  // --- unauthenticated -----------------------------------------------------

  @Query(() => InvitePreviewModel)
  invitePreview(@Args('token') token: string): Promise<InvitePreviewModel> {
    return this.members.previewInvite(token);
  }

  // --- authenticated -------------------------------------------------------

  @Query(() => [MemberModel])
  @UseGuards(ApiAuthGuard)
  organizationMembers(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
  ): Promise<MemberModel[]> {
    return this.members.listMembers(user.userId, organizationId);
  }

  @Query(() => [InviteModel])
  @UseGuards(ApiAuthGuard)
  async organizationInvites(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
  ): Promise<InviteModel[]> {
    const rows = await this.members.listInvites(user.userId, organizationId);
    return rows.map((r) => this.toInviteModel(r));
  }

  @Mutation(() => InviteModel)
  @UseGuards(ApiAuthGuard)
  async inviteMember(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
    @Args('email') email: string,
    @Args('role') role: string,
  ): Promise<InviteModel> {
    const row = await this.members.invite(
      user.userId,
      organizationId,
      email,
      parseRole(role),
    );
    return this.toInviteModel(row);
  }

  @Mutation(() => Boolean)
  @UseGuards(ApiAuthGuard)
  revokeInvite(
    @CurrentUser() user: JwtUser,
    @Args('inviteId', { type: () => ID }) inviteId: string,
  ): Promise<boolean> {
    return this.members.revokeInvite(user.userId, inviteId);
  }

  @Mutation(() => MemberModel)
  @UseGuards(ApiAuthGuard)
  acceptInvite(
    @CurrentUser() user: JwtUser,
    @Args('token') token: string,
  ): Promise<MemberModel> {
    return this.members.accept(user.userId, token);
  }

  @Mutation(() => MemberModel)
  @UseGuards(ApiAuthGuard)
  updateMemberRole(
    @CurrentUser() user: JwtUser,
    @Args('membershipId', { type: () => ID }) membershipId: string,
    @Args('role') role: string,
  ): Promise<MemberModel> {
    return this.members.updateRole(user.userId, membershipId, parseRole(role));
  }

  @Mutation(() => Boolean)
  @UseGuards(ApiAuthGuard)
  removeMember(
    @CurrentUser() user: JwtUser,
    @Args('membershipId', { type: () => ID }) membershipId: string,
  ): Promise<boolean> {
    return this.members.removeMember(user.userId, membershipId);
  }

  @Mutation(() => Boolean)
  @UseGuards(ApiAuthGuard)
  leaveOrganization(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
  ): Promise<boolean> {
    return this.members.leave(user.userId, organizationId);
  }
}
