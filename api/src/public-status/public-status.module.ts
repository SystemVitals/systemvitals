import { Module } from '@nestjs/common';
import { PublicStatusController } from './public-status.controller';
import { PublicStatusService } from './public-status.service';

@Module({
  controllers: [PublicStatusController],
  providers: [PublicStatusService],
})
export class PublicStatusModule {}
