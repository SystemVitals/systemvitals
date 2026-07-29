import { assertWorkspaceSelector } from './workspace-selector';

describe('assertWorkspaceSelector', () => {
  it('returns only the organization discriminator', () => {
    expect(assertWorkspaceSelector({ organizationId: 'org-1' })).toEqual({
      organizationId: 'org-1',
    });
  });

  it('returns only the legacy project discriminator', () => {
    expect(assertWorkspaceSelector({ projectId: 'project-1' })).toEqual({
      projectId: 'project-1',
    });
  });

  it('rejects both identifiers with the stable XOR error', () => {
    expect(() =>
      assertWorkspaceSelector({
        organizationId: 'org-1',
        projectId: 'project-1',
      }),
    ).toThrow('Provide exactly one of organizationId or projectId');
  });

  it('rejects neither identifier with the stable XOR error', () => {
    expect(() => assertWorkspaceSelector({})).toThrow(
      'Provide exactly one of organizationId or projectId',
    );
  });
});
