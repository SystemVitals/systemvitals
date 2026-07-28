import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ReadinessService, type ReadinessReason } from './readiness.service';

interface LiveResponse {
  status: 'ok';
}

interface ReadyResponse {
  status: 'ready';
}

interface NotReadyResponse {
  status: 'not_ready';
  reason: ReadinessReason;
}

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('live')
  live(): LiveResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadyResponse> {
    const result = await this.readiness.check();
    if (result.ready) {
      return { status: 'ready' };
    }

    throw new ServiceUnavailableException({
      status: 'not_ready',
      reason: result.reason ?? 'starting',
    } satisfies NotReadyResponse);
  }
}
