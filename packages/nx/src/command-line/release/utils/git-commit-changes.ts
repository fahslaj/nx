import { exec } from 'child_process';

export async function gitCommitChanges(
  gitOptions: {
    message?: string;
    amend?: boolean;
    gitArgs?: string[];
  },
  options: {
    dryRun?: boolean;
    verbose?: boolean;
    logFn?: (message: string) => void;
  } = {}
): Promise<string> {
  const logFn = options.logFn || console.log;
  const message = gitOptions.message || 'chore: release';
  const args = gitOptions.gitArgs || [];

  if (gitOptions.amend) {
    args.unshift('--amend', '--no-edit');
  } else {
    args.unshift('-m', `"${message}"`);
  }

  const commitCommand = `git commit ${args.join(' ')}`.trim();

  if (options.verbose) {
    logFn(`\nCommitting files with the following command:`);
    logFn(commitCommand);
  }

  if (options.dryRun) {
    logFn('\nSkipping git commit because the --dry-run flag was passed.');
    return;
  }

  const hasStagedFiles = await new Promise<boolean>((resolve, reject) => {
    exec(`git diff-index --quiet HEAD`, (error) => {
      if (error) {
        // this command failing means there are changes
        return resolve(true);
      }
      return resolve(false);
    });
  });

  if (!hasStagedFiles) {
    logFn('\nNo staged files found. Skipping commit.');
    return;
  }

  return await new Promise<string>((resolve, reject) => {
    exec(commitCommand, (error, stdout, stderr) => {
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
