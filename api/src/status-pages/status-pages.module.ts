import { Module } from '@nestjs/common';
import { StatusPagesService } from './status-pages.service';
import { StatusPagesResolver } from './status-pages.resolver';

@Module({ providers: [StatusPagesService, StatusPagesResolver] })
export class StatusPagesModule {}
