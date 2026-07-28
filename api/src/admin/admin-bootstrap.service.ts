import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { PrismaClient } from '@systemvitals/database';
import { normalizeEmail } from '../common/email';

export async function promoteAdmins(
  prisma: Pick<PrismaClient, 'user'>,
  raw: string | undefined,
): Promise<void> {
  const emails = (raw ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  if (emails.length === 0) return;
  await prisma.user.updateMany({
    where: { email: { in: emails }, isAdmin: false },
    data: { isAdmin: true },
  });
}

@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {}
  async onApplicationBootstrap() {
    const raw = this.cfg.get<string>('ADMIN_EMAILS');
    await promoteAdmins(this.prisma, raw);
    if (raw) this.logger.log(`Ensured admin for: ${raw}`);
  }
}
