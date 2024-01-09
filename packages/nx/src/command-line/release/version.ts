import * as chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { Generator } from '../../config/misc-interfaces';
import { readNxJson } from '../../config/nx-json';
import {
  ProjectGraph,
  ProjectGraphProjectNode,
} from '../../config/project-graph';
import {
  NxJsonConfiguration,
  joinPathFragments,
  logger,
  output,
  workspaceRoot,
} from '../../devkit-exports';
import { FsTree, Tree, flushChanges } from '../../generators/tree';
import {
  createProjectGraphAsync,
  readProjectsConfigurationFromProjectGraph,
} from '../../project-graph/project-graph';
import { combineOptionsForGenerator, handleErrors } from '../../utils/params';
import { parseGeneratorString } from '../generate/generate';
import { getGeneratorInformation } from '../generate/generator-utils';
import { VersionOptions } from './command-object';
import {
  createNxReleaseConfig,
  handleNxReleaseConfigError,
} from './config/config';
import {
  ReleaseGroupWithName,
  filterReleaseGroups,
} from './config/filter-release-groups';
import { gitAdd, gitTag } from './utils/git';
import { printDiff } from './utils/print-changes';
import {
  VersionData,
  commitChanges,
  createCommitMessageValues,
  createGitTagValues,
  handleDuplicateGitTags,
} from './utils/shared';

// Reexport some utils for use in plugin release-version generator implementations
export { deriveNewSemverVersion } from './utils/semver';
export type { VersionData } from './utils/shared';

export interface ReleaseVersionGeneratorSchema {
  // The projects being versioned in the current execution
  projects: ProjectGraphProjectNode[];
  releaseGroup: ReleaseGroupWithName;
  projectGraph: ProjectGraph;
  specifier?: string;
  specifierSource?: 'prompt' | 'conventional-commits';
  preid?: string;
  packageRoot?: string;
  currentVersionResolver?: 'registry' | 'disk' | 'git-tag';
  currentVersionResolverMetadata?: Record<string, unknown>;
  firstRelease?: boolean;
}

export interface NxReleaseVersionResult {
  /**
   * In one specific (and very common) case, an overall workspace version is relevant, for example when there is
   * only a single release group in which all projects have a fixed relationship to each other. In this case, the
   * overall workspace version is the same as the version of the release group (and every project within it). This
   * version could be a `string`, or it could be `null` if using conventional commits and no changes were detected.
   *
   * In all other cases (independent versioning, multiple release groups etc), the overall workspace version is
   * not applicable and will be `undefined` here. If a user attempts to use this value later when it is `undefined`
   * (for example in the changelog command), we will throw an appropriate error.
   */
  workspaceVersion: (string | null) | undefined;
  projectsVersionData: VersionData;
}

export const releaseVersionCLIHandler = (args: VersionOptions) =>
  handleErrors(args.verbose, () => releaseVersion(args));

/**
 * NOTE: This function is also exported for programmatic usage and forms part of the public API
 * of Nx. We intentionally do not wrap the implementation with handleErrors because users need
 * to have control over their own error handling when using the API.
 */
export async function releaseVersion(
  args: VersionOptions
): Promise<NxReleaseVersionResult> {
  const projectGraph = await createProjectGraphAsync({ exitOnError: true });
  const { projects } = readProjectsConfigurationFromProjectGraph(projectGraph);
  const nxJson = readNxJson();

  if (args.verbose) {
    process.env.NX_VERBOSE_LOGGING = 'true';
  }

  // Apply default configuration to any optional user configuration
  const { error: configError, nxReleaseConfig } = await createNxReleaseConfig(
    projectGraph,
    nxJson.release,
    'nx-release-publish'
  );
  if (configError) {
    return await handleNxReleaseConfigError(configError);
  }

  const {
    error: filterError,
    releaseGroups,
    releaseGroupToFilteredProjects,
  } = filterReleaseGroups(
    projectGraph,
    nxReleaseConfig,
    args.projects,
    args.groups
  );
  if (filterError) {
    output.error(filterError);
    process.exit(1);
  }

  const tree = new FsTree(workspaceRoot, args.verbose);

  const versionData: VersionData = {};
  const userCommitMessage: string | undefined =
    args.gitCommitMessage || nxReleaseConfig.version.git.commitMessage;

  if (args.projects?.length) {
    /**
     * Run versioning for all remaining release groups and filtered projects within them
     */
    for (const releaseGroup of releaseGroups) {
      const releaseGroupName = releaseGroup.name;

      // Resolve the generator data for the current release group
      const generatorData = resolveGeneratorData({
        ...extractGeneratorCollectionAndName(
          `release-group "${releaseGroupName}"`,
          releaseGroup.version.generator
        ),
        configGeneratorOptions: releaseGroup.version.generatorOptions,
        projects,
      });

      const releaseGroupProjectNames = Array.from(
        releaseGroupToFilteredProjects.get(releaseGroup)
      );

      await runVersionOnProjects(
        projectGraph,
        nxJson,
        args,
        tree,
        generatorData,
        releaseGroupProjectNames,
        releaseGroup,
        versionData
      );
    }

    // Resolve any git tags as early as possible so that we can hard error in case of any duplicates before reaching the actual git command
    const gitTagValues: string[] =
      args.gitTag ?? nxReleaseConfig.version.git.tag
        ? createGitTagValues(
            releaseGroups,
            releaseGroupToFilteredProjects,
            versionData
          )
        : [];
    handleDuplicateGitTags(gitTagValues);

    printAndFlushChanges(tree, !!args.dryRun);

    if (args.gitCommit ?? nxReleaseConfig.version.git.commit) {
      await commitChanges(
        tree.listChanges().map((f) => f.path),
        !!args.dryRun,
        !!args.verbose,
        createCommitMessageValues(
          releaseGroups,
          releaseGroupToFilteredProjects,
          versionData,
          userCommitMessage
        ),
        args.gitCommitArgs || nxReleaseConfig.version.git.commitArgs
      );
    }

    if (args.gitTag ?? nxReleaseConfig.version.git.tag) {
      output.logSingleLine(`Tagging commit with git`);
      for (const tag of gitTagValues) {
        await gitTag({
          tag,
          message: args.gitTagMessage || nxReleaseConfig.version.git.tagMessage,
          additionalArgs:
            args.gitTagArgs || nxReleaseConfig.version.git.tagArgs,
          dryRun: args.dryRun,
          verbose: args.verbose,
        });
      }
    }

    if (args.dryRun) {
      logger.warn(`\nNOTE: The "dryRun" flag means no changes were made.`);
    }

    return {
      // An overall workspace version cannot be relevant when filtering to independent projects
      workspaceVersion: undefined,
      projectsVersionData: versionData,
    };
  }

  /**
   * Run versioning for all remaining release groups
   */
  for (const releaseGroup of releaseGroups) {
    const releaseGroupName = releaseGroup.name;

    // Resolve the generator data for the current release group
    const generatorData = resolveGeneratorData({
      ...extractGeneratorCollectionAndName(
        `release-group "${releaseGroupName}"`,
        releaseGroup.version.generator
      ),
      configGeneratorOptions: releaseGroup.version.generatorOptions,
      projects,
    });

    await runVersionOnProjects(
      projectGraph,
      nxJson,
      args,
      tree,
      generatorData,
      releaseGroup.projects,
      releaseGroup,
      versionData
    );
  }

  // Resolve any git tags as early as possible so that we can hard error in case of any duplicates before reaching the actual git command
  const gitTagValues: string[] =
    args.gitTag ?? nxReleaseConfig.version.git.tag
      ? createGitTagValues(
          releaseGroups,
          releaseGroupToFilteredProjects,
          versionData
        )
      : [];
  handleDuplicateGitTags(gitTagValues);

  printAndFlushChanges(tree, !!args.dryRun);

  // Only applicable when there is a single release group with a fixed relationship
  let workspaceVersion: string | null | undefined = undefined;
  if (releaseGroups.length === 1) {
    const releaseGroup = releaseGroups[0];
    if (releaseGroup.projectsRelationship === 'fixed') {
      const releaseGroupProjectNames = Array.from(
        releaseGroupToFilteredProjects.get(releaseGroup)
      );
      workspaceVersion = versionData[releaseGroupProjectNames[0]].newVersion; // all projects have the same version so we can just grab the first
    }
  }

  const changedFiles = tree.listChanges().map((f) => f.path);

  // No further actions are necessary in this scenario (e.g. if conventional commits detected no changes)
  if (!changedFiles.length) {
    return {
      workspaceVersion,
      projectsVersionData: versionData,
    };
  }

  if (args.stageChanges) {
    output.logSingleLine(
      `Staging changed files with git because --stage-changes was set`
    );
    await gitAdd({
      changedFiles,
      dryRun: args.dryRun,
      verbose: args.verbose,
    });
  }

  if (args.gitCommit ?? nxReleaseConfig.version.git.commit) {
    await commitChanges(
      changedFiles,
      !!args.dryRun,
      !!args.verbose,
      createCommitMessageValues(
        releaseGroups,
        releaseGroupToFilteredProjects,
        versionData,
        userCommitMessage
      ),
      args.gitCommitArgs || nxReleaseConfig.version.git.commitArgs
    );
  }

  if (args.gitTag ?? nxReleaseConfig.version.git.tag) {
    output.logSingleLine(`Tagging commit with git`);
    for (const tag of gitTagValues) {
      await gitTag({
        tag,
        message: args.gitTagMessage || nxReleaseConfig.version.git.tagMessage,
        additionalArgs: args.gitTagArgs || nxReleaseConfig.version.git.tagArgs,
        dryRun: args.dryRun,
        verbose: args.verbose,
      });
    }
  }

  if (args.dryRun) {
    logger.warn(`\nNOTE: The "dryRun" flag means no changes were made.`);
  }

  return {
    workspaceVersion,
    projectsVersionData: versionData,
  };
}

function appendVersionData(
  existingVersionData: VersionData,
  newVersionData: VersionData
): VersionData {
  // Mutate the existing version data
  for (const [key, value] of Object.entries(newVersionData)) {
    if (existingVersionData[key]) {
      throw new Error(
        `Version data key "${key}" already exists in version data. This is likely a bug.`
      );
    }
    existingVersionData[key] = value;
  }
  return existingVersionData;
}

async function runVersionOnProjects(
  projectGraph: ProjectGraph,
  nxJson: NxJsonConfiguration,
  args: VersionOptions,
  tree: Tree,
  generatorData: GeneratorData,
  projectNames: string[],
  releaseGroup: ReleaseGroupWithName,
  versionData: VersionData
) {
  const generatorOptions: ReleaseVersionGeneratorSchema = {
    // Always ensure a string to avoid generator schema validation errors
    specifier: args.specifier ?? '',
    preid: args.preid ?? '',
    ...generatorData.configGeneratorOptions,
    // The following are not overridable by user config
    projects: projectNames.map((p) => projectGraph.nodes[p]),
    projectGraph,
    releaseGroup,
    firstRelease: args.firstRelease,
  };

  // Apply generator defaults from schema.json file etc
  const combinedOpts = await combineOptionsForGenerator(
    generatorOptions as any,
    generatorData.collectionName,
    generatorData.normalizedGeneratorName,
    readProjectsConfigurationFromProjectGraph(projectGraph),
    nxJson,
    generatorData.schema,
    false,
    null,
    relative(process.cwd(), workspaceRoot),
    args.verbose
  );

  const releaseVersionGenerator = generatorData.implementationFactory();

  // We expect all version generator implementations to return a VersionData object, rather than a GeneratorCallback
  const versionDataForProjects = (await releaseVersionGenerator(
    tree,
    combinedOpts
  )) as unknown as VersionData;

  if (typeof versionDataForProjects === 'function') {
    throw new Error(
      `The version generator ${generatorData.collectionName}:${generatorData.normalizedGeneratorName} returned a function instead of an expected VersionData object`
    );
  }

  // Merge the extra version data into the existing
  appendVersionData(versionData, versionDataForProjects);
}

function printAndFlushChanges(tree: Tree, isDryRun: boolean) {
  const changes = tree.listChanges();

  console.log('');

  // Print the changes
  changes.forEach((f) => {
    if (f.type === 'CREATE') {
      console.error(
        `${chalk.green('CREATE')} ${f.path}${
          isDryRun ? chalk.keyword('orange')(' [dry-run]') : ''
        }`
      );
      printDiff('', f.content?.toString() || '');
    } else if (f.type === 'UPDATE') {
      console.error(
        `${chalk.white('UPDATE')} ${f.path}${
          isDryRun ? chalk.keyword('orange')(' [dry-run]') : ''
        }`
      );
      const currentContentsOnDisk = readFileSync(
        joinPathFragments(tree.root, f.path)
      ).toString();
      printDiff(currentContentsOnDisk, f.content?.toString() || '');
    } else if (f.type === 'DELETE') {
      throw new Error(
        'Unexpected DELETE change, please report this as an issue'
      );
    }
  });

  if (!isDryRun) {
    flushChanges(workspaceRoot, changes);
  }
}

function extractGeneratorCollectionAndName(
  description: string,
  generatorString: string
) {
  let collectionName: string;
  let generatorName: string;
  const parsedGeneratorString = parseGeneratorString(generatorString);
  collectionName = parsedGeneratorString.collection;
  generatorName = parsedGeneratorString.generator;

  if (!collectionName || !generatorName) {
    throw new Error(
      `Invalid generator string: ${generatorString} used for ${description}. Must be in the format of [collectionName]:[generatorName]`
    );
  }

  return { collectionName, generatorName };
}

interface GeneratorData {
  collectionName: string;
  generatorName: string;
  configGeneratorOptions: NxJsonConfiguration['release']['groups'][number]['version']['generatorOptions'];
  normalizedGeneratorName: string;
  schema: any;
  implementationFactory: () => Generator<unknown>;
}

function resolveGeneratorData({
  collectionName,
  generatorName,
  configGeneratorOptions,
  projects,
}): GeneratorData {
  const { normalizedGeneratorName, schema, implementationFactory } =
    getGeneratorInformation(
      collectionName,
      generatorName,
      workspaceRoot,
      projects
    );

  return {
    collectionName,
    generatorName,
    configGeneratorOptions,
    normalizedGeneratorName,
    schema,
    implementationFactory,
  };
}
