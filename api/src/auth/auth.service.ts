import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { Prisma, User } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from '../common/email';
import { slugify, isReservedOrgSlug } from '../common/slug';
import { createWithUniqueSlug } from '../common/create-with-unique-slug';

export interface AuthResult {
  token: string;
  userId: string;
}

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private sign(userId: string, email: string): string {
    return this.jwt.sign({ sub: userId, email });
  }

  private issue(user: Pick<User, 'id' | 'email'>): AuthResult {
    return { token: this.sign(user.id, user.email), userId: user.id };
  }

  /**
   * Creates a user together with the full starter account shape:
   * organization + OWNER membership + Default project + SOLO subscription.
   * Shared by password signup and Google signup so the two cannot drift.
   */
  private async provisionUser(
    tx: Prisma.TransactionClient,
    input: {
      email: string;
      passwordHash?: string | null;
      googleId?: string | null;
    },
    orgSlug: string,
  ): Promise<User> {
    const email = normalizeEmail(input.email);
    const user = await tx.user.create({
      data: {
        email,
        passwordHash: input.passwordHash ?? null,
        googleId: input.googleId ?? null,
      },
    });
    const localPart = email.split('@')[0];

    const org = await tx.organization.create({
      data: {
        name: `${localPart}'s org`,
        slug: orgSlug,
        creatorUserId: user.id,
      },
    });
    await tx.membership.create({
      data: { userId: user.id, organizationId: org.id, role: 'OWNER' },
    });
    await tx.project.create({
      data: { name: 'Default', slug: 'default', organizationId: org.id },
    });
    await tx.subscription.create({
      data: { userId: user.id, plan: 'SOLO' },
    });
    return user;
  }

  /**
   * Wraps provisionUser with slug-collision retry. Two concurrent signups
   * whose email local-parts normalize to the same base compute the same org
   * slug candidate, and the loser's `organization.create` fails the unique
   * constraint. That create runs inside provisionUser's transaction, and
   * Postgres aborts a transaction outright on its first failing statement —
   * so retrying just the failed statement isn't possible; each retry instead
   * reloads the current slugs and re-runs the whole transaction (the failed
   * attempt's User row rolls back with it, so re-creating it is safe).
   */
  private async provisionUserWithRetry(input: {
    email: string;
    passwordHash?: string | null;
    googleId?: string | null;
  }): Promise<User> {
    const email = normalizeEmail(input.email);
    const localPart = email.split('@')[0];
    let base = slugify(localPart);
    if (isReservedOrgSlug(base)) base = `${base}-org`;

    return createWithUniqueSlug({
      base,
      loadTakenSlugs: async () => {
        const orgs = await this.prisma.organization.findMany({
          select: { slug: true },
        });
        return orgs.map((o) => o.slug);
      },
      entityLabel: 'organization',
      create: (orgSlug) =>
        this.prisma.$transaction((tx) =>
          this.provisionUser(tx, input, orgSlug),
        ),
    });
  }

  async signup(email: string, password: string): Promise<AuthResult> {
    const passwordHash = await argon2.hash(password);
    const user = await this.provisionUserWithRetry({
      email: normalizeEmail(email),
      passwordHash,
    });
    return this.issue(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (user.suspendedAt) throw new UnauthorizedException('Account suspended');
    // Google-only account: no password to verify. Same generic message, so the
    // response never reveals which sign-in methods an account has.
    if (!user.passwordHash)
      throw new UnauthorizedException('Invalid credentials');
    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    return this.issue(user);
  }

  /**
   * Resolves a Google identity to a session, provisioning or linking as needed.
   * Auto-linking by email is only safe because we require Google to have
   * verified the address — see the design spec.
   */
  async loginWithGoogle(identity: GoogleIdentity): Promise<AuthResult> {
    const { googleId, emailVerified } = identity;
    // The verified-email check stays the very first statement. It is what makes
    // auto-linking by email safe, so nothing — not even a pure helper — should
    // creep above it and start eroding that ordering.
    if (emailVerified !== true) {
      throw new UnauthorizedException('Google account email is not verified');
    }
    const email = normalizeEmail(identity.email);

    const byGoogleId = await this.prisma.user.findUnique({
      where: { googleId },
    });
    if (byGoogleId) {
      if (byGoogleId.suspendedAt) {
        throw new UnauthorizedException('Account suspended');
      }
      return this.issue(byGoogleId);
    }

    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      if (byEmail.suspendedAt) {
        throw new UnauthorizedException('Account suspended');
      }
      const linked = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { googleId },
      });
      return this.issue(linked);
    }

    const created = await this.provisionUserWithRetry({ email, googleId });
    return this.issue(created);
  }

  /**
   * Sets or changes the caller's password. A user with no password yet (signed
   * up through Google) does not need to prove a current one — the session JWT
   * already proves who they are.
   */
  async setPassword(
    userId: string,
    newPassword: string,
    currentPassword?: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.passwordHash) {
      if (!currentPassword) {
        throw new UnauthorizedException('Current password is required');
      }
      const valid = await argon2.verify(user.passwordHash, currentPassword);
      if (!valid) throw new UnauthorizedException('Invalid credentials');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(newPassword) },
    });
    return true;
  }

  signImpersonation(
    userId: string,
    email: string,
    actorId: string,
  ): { token: string; expiresAt: Date } {
    const expiresInSec = 30 * 60;
    const token = this.jwt.sign(
      { sub: userId, email, act: actorId },
      { expiresIn: expiresInSec },
    );
    return { token, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
  }
}
