import { exec } from 'child_process';

export async function gitTag(
  gitOptions: {
    tag: string;
    gitArgs?: string[];
  },
  options: {
    dryRun?: boolean;
    verbose?: boolean;
    logFn?: (message: string) => void;
  } = {}
): Promise<string> {
  const logFn = options.logFn || console.log;
  const tag = gitOptions.tag;
  const args = gitOptions.gitArgs || [];
  const command = `git tag ${tag} -m ${tag} ${args.join(' ')}`.trim();

  if (options.verbose) {
    logFn(`\nTagging commit with the following command:`);
    logFn(command);
  }

  if (options.dryRun) {
    logFn('\nSkipping git tag because the --dry-run flag was passed.');
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
