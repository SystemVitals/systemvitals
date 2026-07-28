import { Controller, Get, HttpCode, Param } from '@nestjs/common';
import {
  PublicStatusService,
  type PublicStatusPage,
} from './public-status.service';

@Controller('status')
export class PublicStatusController {
  constructor(private readonly publicStatusService: PublicStatusService) {}

  @Get(':slug')
  @HttpCode(200)
  async getStatus(@Param('slug') slug: string): Promise<PublicStatusPage> {
    return this.publicStatusService.getBySlug(slug);
  }
}
