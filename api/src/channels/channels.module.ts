import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { ChannelsResolver } from './channels.resolver';
import { EmailVerificationService } from './email-verification.service';
import { EmailVerificationResolver } from './email-verification.resolver';

@Module({
  providers: [
    ChannelsService,
    ChannelsResolver,
    EmailVerificationService,
    EmailVerificationResolver,
  ],
  exports: [ChannelsService, EmailVerificationService],
})
export class ChannelsModule {}
