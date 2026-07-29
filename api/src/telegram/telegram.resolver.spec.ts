import type { JwtUser } from '../auth/jwt.strategy';
import {
  assertWorkspaceSelector,
  type WorkspaceSelector,
} from '../workspaces/workspace-selector';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { TelegramBotClient } from './telegram-bot.client';
import type { TelegramConnectionsService } from './telegram-connections.service';
import { TelegramResolver } from './telegram.resolver';

const user = { userId: 'user-1' } as JwtUser;

function harness() {
  const connections = {
    connect: jest.fn().mockResolvedValue({ id: 'channel-1' }),
  };
  const workspaces = {
    resolveForUser: jest.fn((_userId: string, selector: WorkspaceSelector) => {
      const asserted = assertWorkspaceSelector(selector);
      return Promise.resolve(
        'organizationId' in asserted
          ? { organizationId: asserted.organizationId, projectId: 'p-1' }
          : { organizationId: 'org-1', projectId: asserted.projectId },
      );
    }),
  };
  return {
    connections,
    resolver: new TelegramResolver(
      {} as TelegramBotClient,
      connections as unknown as TelegramConnectionsService,
      workspaces as unknown as WorkspacesService,
    ),
  };
}

describe('TelegramResolver workspace selectors', () => {
  it('connects canonically by organization', async () => {
    const h = harness();

    await h.resolver.connectTelegramChannel(
      user,
      'challenge',
      'org-1',
      undefined,
    );

    expect(h.connections.connect).toHaveBeenCalledWith(
      'user-1',
      'challenge',
      'p-1',
    );
  });

  it('retains legacy project connection', async () => {
    const h = harness();

    await h.resolver.connectTelegramChannel(
      user,
      'challenge',
      undefined,
      'legacy-project',
    );

    expect(h.connections.connect).toHaveBeenCalledWith(
      'user-1',
      'challenge',
      'legacy-project',
    );
  });

  it.each([
    ['both', 'org-1', 'project-1'],
    ['neither', undefined, undefined],
  ])(
    'rejects %s workspace selectors before consuming the challenge',
    async (_case, organizationId, projectId) => {
      const h = harness();

      await expect(
        h.resolver.connectTelegramChannel(
          user,
          'challenge',
          organizationId,
          projectId,
        ),
      ).rejects.toThrow('Provide exactly one of organizationId or projectId');
      expect(h.connections.connect).not.toHaveBeenCalled();
    },
  );
});
