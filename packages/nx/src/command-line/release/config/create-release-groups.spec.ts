import { ProjectGraph } from '../../../config/project-graph';
import { createReleaseGroups } from './create-release-groups';

describe('create-release-groups', () => {
  let projectGraph: ProjectGraph;

  beforeEach(() => {
    projectGraph = {
      nodes: {
        'lib-a': {
          name: 'lib-a',
          type: 'lib',
          data: {
            root: 'libs/lib-a',
            targets: {
              'nx-release-publish': {},
            },
          } as any,
        },
        'lib-b': {
          name: 'lib-b',
          type: 'lib',
          data: {
            root: 'libs/lib-b',
            targets: {
              'nx-release-publish': {},
            },
          } as any,
        },
        'lib-c': {
          name: 'lib-c',
          type: 'lib',
          data: {
            root: 'libs/lib-c',
            targets: {
              'nx-release-publish': {},
            },
          } as any,
        },
      },
      dependencies: {},
    };
  });

  describe('no user specified groups', () => {
    it('should return a catch all release group containing all projects when no groups are specified', async () => {
      const res = await createReleaseGroups(projectGraph, {});
      expect(res).toMatchInlineSnapshot(`
        {
          "error": null,
          "releaseGroups": [
            {
              "name": "__default__",
              "projects": [
                "lib-a",
                "lib-b",
                "lib-c",
              ],
              "version": {
                "generator": "@nx/js:release-version",
                "generatorOptions": {},
                "specifierSource": "prompt",
              },
            },
          ],
        }
      `);
    });
  });

  describe('user specified groups', () => {
    it('should ignore any projects not matched to user specified groups', async () => {
      const res = await createReleaseGroups(projectGraph, {
        'group-1': {
          projects: ['lib-a', 'lib-c'], // intentionally no lib-b, so it should be ignored
        },
      });
      expect(res).toMatchInlineSnapshot(`
        {
          "error": null,
          "releaseGroups": [
            {
              "name": "group-1",
              "projects": [
                "lib-a",
                "lib-c",
              ],
              "version": {
                "generator": "@nx/js:release-version",
                "generatorOptions": {},
                "specifierSource": "prompt",
              },
            },
          ],
        }
      `);
    });

    it('should respect user overrides for "version" config', async () => {
      const res = await createReleaseGroups(projectGraph, {
        'group-1': {
          projects: ['lib-a'],
          version: {
            generator: '@custom/generator',
            generatorOptions: {
              optionsOverride: 'something',
            },
          },
        },
        'group-2': {
          projects: ['lib-b'],
          version: {
            generator: '@custom/generator-alternative',
          },
        },
        'group-3': {
          projects: ['lib-c'],
          version: {
            specifierSource: 'conventional-commits',
            generatorOptions: {
              currentVersionResolver: 'git-tag',
              currentVersionResolverMetadata: {
                tagVersionPrefix: 'v',
              },
            },
          },
        },
      });
      expect(res).toMatchInlineSnapshot(`
        {
          "error": null,
          "releaseGroups": [
            {
              "name": "group-1",
              "projects": [
                "lib-a",
              ],
              "version": {
                "generator": "@custom/generator",
                "generatorOptions": {
                  "optionsOverride": "something",
                },
                "specifierSource": "prompt",
              },
            },
            {
              "name": "group-2",
              "projects": [
                "lib-b",
              ],
              "version": {
                "generator": "@custom/generator-alternative",
                "generatorOptions": {},
                "specifierSource": "prompt",
              },
            },
            {
              "name": "group-3",
              "projects": [
                "lib-c",
              ],
              "version": {
                "generator": "@nx/js:release-version",
                "generatorOptions": {
                  "currentVersionResolver": "git-tag",
                  "currentVersionResolverMetadata": {
                    "tagVersionPrefix": "v",
                  },
                },
                "specifierSource": "conventional-commits",
              },
            },
          ],
        }
      `);
    });
  });

  describe('release group config errors', () => {
    it('should return an error if a project matches multiple groups', async () => {
      const res = await createReleaseGroups(projectGraph, {
        'group-1': {
          projects: ['lib-a'],
        },
        'group-2': {
          projects: ['lib-a'],
        },
      });
      expect(res).toMatchInlineSnapshot(`
        {
          "error": {
            "code": "PROJECT_MATCHES_MULTIPLE_GROUPS",
            "data": {
              "project": "lib-a",
            },
          },
          "releaseGroups": [],
        }
      `);
    });

    it('should return an error if no projects can be resolved for a group', async () => {
      const res = await createReleaseGroups(projectGraph, {
        'group-1': {
          projects: ['lib-does-not-exist'],
        },
      });
      expect(res).toMatchInlineSnapshot(`
        {
          "error": {
            "code": "RELEASE_GROUP_MATCHES_NO_PROJECTS",
            "data": {
              "releaseGroupName": "group-1",
            },
          },
          "releaseGroups": [],
        }
      `);
    });

    it('should return an error if any matched projects do not have the required target specified', async () => {
      const res = await createReleaseGroups(
        {
          ...projectGraph,
          nodes: {
            ...projectGraph.nodes,
            'project-without-target': {
              name: 'project-without-target',
              type: 'lib',
              data: {
                root: 'libs/project-without-target',
                targets: {},
              } as any,
            },
          },
        },
        {
          'group-1': {
            projects: '*', // using string form to ensure that is supported in addition to array form
          },
        },
        'nx-release-publish'
      );
      expect(res).toMatchInlineSnapshot(`
        {
          "error": {
            "code": "PROJECTS_MISSING_TARGET",
            "data": {
              "projects": [
                "project-without-target",
              ],
              "targetName": "nx-release-publish",
            },
          },
          "releaseGroups": [],
        }
      `);

      const res2 = await createReleaseGroups(
        {
          ...projectGraph,
          nodes: {
            ...projectGraph.nodes,
            'another-project-without-target': {
              name: 'another-project-without-target',
              type: 'lib',
              data: {
                root: 'libs/another-project-without-target',
                targets: {},
              } as any,
            },
          },
        },
        {},
        'nx-release-publish'
      );
      expect(res2).toMatchInlineSnapshot(`
        {
          "error": {
            "code": "PROJECTS_MISSING_TARGET",
            "data": {
              "projects": [
                "another-project-without-target",
              ],
              "targetName": "nx-release-publish",
            },
          },
          "releaseGroups": [],
        }
      `);
    });
  });
});
