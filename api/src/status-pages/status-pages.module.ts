import { Module } from '@nestjs/common';
import { StatusPagesService } from './status-pages.service';
import { StatusPagesResolver } from './status-pages.resolver';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [WorkspacesModule],
  providers: [StatusPagesService, StatusPagesResolver],
})
export class StatusPagesModule {}
