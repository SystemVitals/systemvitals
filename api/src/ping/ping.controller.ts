import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { PingService } from './ping.service';

@Controller('ping')
export class PingController {
  constructor(private readonly pingService: PingService) {}

  @Get(':slug')
  @HttpCode(200)
  async getPing(@Param('slug') slug: string): Promise<string> {
    await this.pingService.recordPing(slug);
    return 'OK';
  }

  @Post(':slug')
  @HttpCode(200)
  async postPing(@Param('slug') slug: string): Promise<string> {
    await this.pingService.recordPing(slug);
    return 'OK';
  }
}
