import { Global, Module } from '@nestjs/common';
import { AlertQueueService } from './alert-queue.service';
import { EmailVerificationQueueService } from './email-verification-queue.service';
import { InviteQueueService } from './invite-queue.service';

@Global()
@Module({
  providers: [
    AlertQueueService,
    EmailVerificationQueueService,
    InviteQueueService,
  ],
  exports: [
    AlertQueueService,
    EmailVerificationQueueService,
    InviteQueueService,
  ],
})
export class QueueModule {}
