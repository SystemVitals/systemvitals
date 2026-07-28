import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { EscalationStepModel, EscalationPolicyModel } from './escalation.model';

interface RawStep {
  channelId: string;
  delaySeconds: number;
}

@Injectable()
export class EscalationService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertProjectAccess(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new ForbiddenException('Project not found');

    const m = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: project.organizationId,
        },
      },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return project;
  }

  private async assertPolicyAccess(userId: string, policyId: string) {
    const policy = await this.prisma.escalationPolicy.findUnique({
      where: { id: policyId },
      include: { project: true },
    });
    if (!policy) throw new NotFoundException('EscalationPolicy not found');

    const m = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: policy.project.organizationId,
        },
      },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return policy;
  }

  private async assertCheckAccess(userId: string, checkId: string) {
    const check = await this.prisma.check.findUnique({
      where: { id: checkId },
      include: { project: true },
    });
    if (!check) throw new NotFoundException('Check not found');

    const m = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: check.project.organizationId,
        },
      },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return check;
  }

  private parseSteps(stepsJson: string): RawStep[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stepsJson);
    } catch {
      throw new BadRequestException('stepsJson must be valid JSON');
    }

    if (!Array.isArray(parsed)) {
      throw new BadRequestException('stepsJson must be a JSON array');
    }

    return parsed as RawStep[];
  }

  private async assertStepsValid(
    projectId: string,
    stepsJson: string,
  ): Promise<RawStep[]> {
    const steps = this.parseSteps(stepsJson);

    if (steps.length === 0) {
      throw new BadRequestException(
        'steps must be a non-empty array of escalation steps',
      );
    }

    for (const step of steps) {
      if (
        typeof step !== 'object' ||
        step === null ||
        typeof step.channelId !== 'string' ||
        typeof step.delaySeconds !== 'number'
      ) {
        throw new BadRequestException(
          'Each step must have channelId (string) and delaySeconds (number)',
        );
      }

      if (!Number.isInteger(step.delaySeconds) || step.delaySeconds < 0) {
        throw new BadRequestException(
          `delaySeconds must be a non-negative integer; got ${step.delaySeconds}`,
        );
      }
    }

    // Validate all channelIds belong to this project
    const channelIds = steps.map((s) => s.channelId);
    const channels = await this.prisma.notificationChannel.findMany({
      where: { id: { in: channelIds }, projectId },
      select: { id: true },
    });

    if (channels.length !== channelIds.length) {
      throw new BadRequestException(
        'One or more channelIds do not belong to this project',
      );
    }

    return steps;
  }

  private mapPolicy(policy: {
    id: string;
    projectId: string;
    steps: unknown;
  }): EscalationPolicyModel {
    const rawSteps = policy.steps as RawStep[];
    const steps: EscalationStepModel[] = rawSteps.map((s) => ({
      channelId: s.channelId,
      delaySeconds: s.delaySeconds,
    }));
    return {
      id: policy.id,
      projectId: policy.projectId,
      steps,
    };
  }

  async create(
    userId: string,
    projectId: string,
    stepsJson: string,
  ): Promise<EscalationPolicyModel> {
    await this.assertProjectAccess(userId, projectId);
    const steps = await this.assertStepsValid(projectId, stepsJson);

    const policy = await this.prisma.escalationPolicy.create({
      data: {
        projectId,
        steps: steps as unknown as Prisma.InputJsonValue,
      },
    });

    return this.mapPolicy(policy);
  }

  async list(
    userId: string,
    projectId: string,
  ): Promise<EscalationPolicyModel[]> {
    await this.assertProjectAccess(userId, projectId);
    const policies = await this.prisma.escalationPolicy.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    return policies.map((p) => this.mapPolicy(p));
  }

  async update(
    userId: string,
    id: string,
    stepsJson: string,
  ): Promise<EscalationPolicyModel> {
    const policy = await this.assertPolicyAccess(userId, id);
    const steps = await this.assertStepsValid(policy.projectId, stepsJson);

    const updated = await this.prisma.escalationPolicy.update({
      where: { id },
      data: { steps: steps as unknown as Prisma.InputJsonValue },
    });

    return this.mapPolicy(updated);
  }

  async delete(userId: string, id: string): Promise<boolean> {
    await this.assertPolicyAccess(userId, id);
    await this.prisma.escalationPolicy.delete({ where: { id } });
    return true;
  }

  async acknowledgeCheck(userId: string, checkId: string): Promise<boolean> {
    await this.assertCheckAccess(userId, checkId);
    await this.prisma.acknowledgement.create({
      data: { checkId, userId },
    });
    return true;
  }
}
