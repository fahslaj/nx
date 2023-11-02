import { exec } from 'child_process';

export async function gitAddChanges(
  gitOptions: {
    affectedFiles: string[];
  },
  options: {
    dryRun?: boolean;
    verbose?: boolean;
    logFn?: (message: string) => void;
  } = {}
): Promise<string> {
  // TODO: cross-reference gitignored files with affectedFiles and exclude them
  // without this, setting a packageRoot in a directory that is ignored will always fail

  const logFn = options.logFn || console.log;
  const affectedFilesStr = gitOptions.affectedFiles.join(' ');
  const command = `git add ${affectedFilesStr}`.trim();

  if (options.verbose) {
    logFn(`\nStaging files in git with the following command:`);
    logFn(command);
  }

  if (options.dryRun) {
    logFn('\nSkipping git add because the --dry-run flag was passed.');
    return;
  }

  return await new Promise<string>((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      if (stderr) {
        return reject(stderr);
      }
      return resolve(stdout.trim());
    });
  });
}
