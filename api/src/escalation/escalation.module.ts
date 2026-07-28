import { Module } from '@nestjs/common';
import { EscalationService } from './escalation.service';
import { EscalationResolver } from './escalation.resolver';

@Module({ providers: [EscalationService, EscalationResolver] })
export class EscalationModule {}
