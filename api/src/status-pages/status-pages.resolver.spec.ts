import type { JwtUser } from '../auth/jwt.strategy';
import {
  assertWorkspaceSelector,
  type WorkspaceSelector,
} from '../workspaces/workspace-selector';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import { StatusPagesResolver } from './status-pages.resolver';
import type { StatusPagesService } from './status-pages.service';

const user = { userId: 'user-1' } as JwtUser;

function harness() {
  const pages = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'page-1' }),
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
    pages,
    resolver: new StatusPagesResolver(
      pages as unknown as StatusPagesService,
      workspaces as unknown as WorkspacesService,
    ),
  };
}

describe('StatusPagesResolver workspace selectors', () => {
  it('resolves canonical organization list/create scopes', async () => {
    const h = harness();

    await h.resolver.statusPages(user, 'org-1', undefined);
    await h.resolver.createStatusPage(
      user,
      'org-1',
      undefined,
      'public',
      'Public',
      ['check-1'],
    );

    expect(h.pages.list).toHaveBeenCalledWith('user-1', 'p-1');
    expect(h.pages.create).toHaveBeenCalledWith(
      'user-1',
      'p-1',
      'public',
      'Public',
      ['check-1'],
      undefined,
    );
  });

  it('retains legacy project list/create scopes', async () => {
    const h = harness();

    await h.resolver.statusPages(user, undefined, 'legacy-project');
    await h.resolver.createStatusPage(
      user,
      undefined,
      'legacy-project',
      'public',
      'Public',
      [],
    );

    expect(h.pages.list).toHaveBeenCalledWith('user-1', 'legacy-project');
    expect(h.pages.create).toHaveBeenCalledWith(
      'user-1',
      'legacy-project',
      'public',
      'Public',
      [],
      undefined,
    );
  });

  it.each([
    ['both', 'org-1', 'project-1'],
    ['neither', undefined, undefined],
  ])(
    'rejects %s workspace selectors before status-page access',
    async (_case, organizationId, projectId) => {
      const h = harness();

      await expect(
        h.resolver.statusPages(user, organizationId, projectId),
      ).rejects.toThrow('Provide exactly one of organizationId or projectId');
      await expect(
        h.resolver.createStatusPage(
          user,
          organizationId,
          projectId,
          'public',
          'Public',
          [],
        ),
      ).rejects.toThrow('Provide exactly one of organizationId or projectId');
      expect(h.pages.list).not.toHaveBeenCalled();
      expect(h.pages.create).not.toHaveBeenCalled();
    },
  );
});
