import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
  Body,
} from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { AccountSessionOnly } from '../auth/account-session.guard';
import { BillingService } from './billing.service';
import { CheckoutDto } from './dto';

interface FastifyRawRequest {
  rawBody?: Buffer;
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout')
  @AccountSessionOnly()
  async checkout(
    @CurrentUser() user: JwtUser,
    @Body() body: CheckoutDto,
  ): Promise<{ url: string }> {
    return this.billingService.createCheckout(
      user.userId,
      body.plan,
      body.interval ?? 'month',
    );
  }

  @Post('portal')
  @AccountSessionOnly()
  async portal(@CurrentUser() user: JwtUser): Promise<{ url: string }> {
    return this.billingService.createPortal(user.userId);
  }

  @Post('webhook')
  async webhook(
    @Req() req: FastifyRawRequest,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean }> {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Missing raw body');
    }

    await this.billingService.handleWebhook(rawBody, signature);
    return { received: true };
  }
}
