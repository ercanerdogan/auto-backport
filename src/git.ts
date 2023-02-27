import { execa } from "execa";

export class GitRefNotFoundError extends Error {
  ref: string;
  constructor(message: string, ref: string) {
    super(message);
    this.ref = ref;
  }
}

/**
 * Fetches a ref from origin
 *
 * @param ref the sha, branchname, etc to fetch
 * @param pwd the root of the git repository
 * @param depth the number of commits to fetch
 * @throws GitRefNotFoundError when ref not found
 * @throws Error for any other non-zero exit code
 */
export async function fetch(ref: string, pwd: string, depth: number) {
  const { exitCode } = await git(
    "fetch",
    [`--depth=${depth}`, "origin", ref],
    pwd
  );
  if (exitCode === 128) {
    throw new GitRefNotFoundError(
      `Expected to fetch '${ref}', but couldn't find it`,
      ref
    );
  } else if (exitCode !== 0) {
    throw new Error(
      `'git fetch origin ${ref}' failed with exit code ${exitCode}`
    );
  }
}

export async function push(branchname: string, pwd: string) {
  const { exitCode } = await git(
    "push",
    ["--set-upstream", "origin", branchname],
    pwd
  );
  return exitCode;
}

async function git(command: string, args: string[], pwd: string) {
  console.log(`git ${command} ${args.join(" ")}`);
  const child = execa("git", [command, ...args], {
    cwd: pwd,
    env: {
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com",
    },
    reject: false,
  });
  child.stderr?.pipe(process.stderr);
  return child;
}

export async function checkout(branch: string, start: string, pwd: string) {
  const { exitCode } = await git("switch", ["-c", branch, start], pwd);
  if (exitCode !== 0) {
    throw new Error(
      `'git switch -c ${branch} ${start}' failed with exit code ${exitCode}`
    );
  }
}

export async function cherryPick(commitShas: string[], pwd: string) {
  const { exitCode } = await git("cherry-pick", ["-x", ...commitShas], pwd);
  if (exitCode !== 0) {
    await git("cherry-pick", ["--abort"], pwd);
    throw new Error(
      `'git cherry-pick -x ${commitShas}' failed with exit code ${exitCode}`
    );
  }
}
