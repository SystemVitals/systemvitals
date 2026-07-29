import { Global, Module } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';

@Global()
@Module({
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
