import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  EmailVerificationConfirmationModel,
  EmailVerificationPreviewModel,
} from './email-verification.model';
import { EmailVerificationService } from './email-verification.service';

@Resolver()
export class EmailVerificationResolver {
  constructor(
    private readonly emailVerificationService: EmailVerificationService,
  ) {}

  @Query(() => EmailVerificationPreviewModel)
  emailChannelVerificationPreview(@Args('token') token: string) {
    return this.emailVerificationService.preview(token);
  }

  @Mutation(() => EmailVerificationConfirmationModel)
  verifyEmailChannel(@Args('token') token: string) {
    return this.emailVerificationService.verify(token);
  }
}
