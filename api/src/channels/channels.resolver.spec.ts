import type { ApiPrincipal } from '../tokens/api-principal';
import {
  assertWorkspaceSelector,
  type WorkspaceSelector,
} from '../workspaces/workspace-selector';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { EmailVerificationService } from './email-verification.service';
import { ChannelsResolver } from './channels.resolver';
import type { ChannelsService } from './channels.service';

const principal = {
  userId: 'user-1',
  authKind: 'session',
} as ApiPrincipal;

function harness() {
  const channels = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'channel-1' }),
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
    channels,
    workspaces,
    resolver: new ChannelsResolver(
      channels as unknown as ChannelsService,
      {} as EmailVerificationService,
      workspaces as unknown as WorkspacesService,
    ),
  };
}

describe('ChannelsResolver workspace selectors', () => {
  it('resolves canonical organization list/create scopes to the internal project', async () => {
    const h = harness();

    await h.resolver.channels(principal, 'org-1', undefined);
    await h.resolver.createChannel(
      principal,
      'org-1',
      undefined,
      'WEBHOOK',
      '{"url":"https://example.test/hook"}',
    );

    expect(h.channels.list).toHaveBeenCalledWith('user-1', 'p-1');
    expect(h.channels.create).toHaveBeenCalledWith(
      'user-1',
      'p-1',
      'WEBHOOK',
      '{"url":"https://example.test/hook"}',
    );
  });

  it('retains legacy project list/create scopes', async () => {
    const h = harness();

    await h.resolver.channels(principal, undefined, 'legacy-project');
    await h.resolver.createChannel(
      principal,
      undefined,
      'legacy-project',
      'WEBHOOK',
      '{"url":"https://example.test/hook"}',
    );

    expect(h.channels.list).toHaveBeenCalledWith('user-1', 'legacy-project');
    expect(h.channels.create).toHaveBeenCalledWith(
      'user-1',
      'legacy-project',
      'WEBHOOK',
      '{"url":"https://example.test/hook"}',
    );
  });

  it.each([
    ['both', 'org-1', 'project-1'],
    ['neither', undefined, undefined],
  ])(
    'rejects %s workspace selectors before channel access',
    async (_case, organizationId, projectId) => {
      const h = harness();

      await expect(
        h.resolver.channels(principal, organizationId, projectId),
      ).rejects.toThrow('Provide exactly one of organizationId or projectId');
      await expect(
        h.resolver.createChannel(
          principal,
          organizationId,
          projectId,
          'WEBHOOK',
          '{"url":"https://example.test/hook"}',
        ),
      ).rejects.toThrow('Provide exactly one of organizationId or projectId');
      expect(h.channels.list).not.toHaveBeenCalled();
      expect(h.channels.create).not.toHaveBeenCalled();
    },
  );
});
