import { Module } from '@nestjs/common';
import { MembersService } from './members.service';
import { MembersResolver } from './members.resolver';

@Module({ providers: [MembersService, MembersResolver] })
export class MembersModule {}
