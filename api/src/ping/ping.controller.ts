import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { normalizeClientIp } from './client-ip';
import { PingService } from './ping.service';

@Controller('ping')
export class PingController {
  constructor(private readonly pingService: PingService) {}

  @Get(':slug')
  @HttpCode(200)
  async getPing(
    @Param('slug') slug: string,
    @Req() req: FastifyRequest,
  ): Promise<string> {
    await this.pingService.recordPing(slug, normalizeClientIp(req.ip));
    return 'OK';
  }

  @Post(':slug')
  @HttpCode(200)
  async postPing(
    @Param('slug') slug: string,
    @Req() req: FastifyRequest,
  ): Promise<string> {
    await this.pingService.recordPing(slug, normalizeClientIp(req.ip));
    return 'OK';
  }
}
