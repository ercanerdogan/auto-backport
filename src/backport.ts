import * as core from "@actions/core";
import dedent from "dedent";

import { CreatePullRequestResponse, PullRequest } from "./github";
import { GithubApi } from "./github";
import * as git from "./git";
import * as utils from "./utils";

type PRContent = {
  title: string;
  body: string;
};

type Config = {
  pwd: string;
  labels: {
    pattern: RegExp;
  };
  pull: {
    description: string;
    title: string;
    comment_body: string;
  };
  copy_labels_pattern?: RegExp;
};

enum Output {
  wasSuccessful = "was_successful",
  wasSuccessfulByTarget = "was_successful_by_target",
}

export class Backport {
  private github;
  private config;

  constructor(github: GithubApi, config: Config) {
    this.github = github;
    this.config = config;
  }

  async run(): Promise<void> {
    try {
      const payload = this.github.getPayload();
      const owner = this.github.getRepo().owner;
      const repo = payload.repository?.name ?? this.github.getRepo().repo;
      const pull_number = this.github.getPullNumber();
      const mainpr = await this.github.getPullRequest(pull_number);

      if (!(await this.github.isMerged(mainpr))) {
        const message = "Only merged pull requests can be backported.";
        this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
        return;
      }

      const headref = mainpr.head.sha;
      const baseref = mainpr.base.sha;
      const labels = mainpr.labels;
      const prCommentBody = this.config.pull.comment_body;

      let parsedBranchNames= "";

      console.log(`PR body : ${prCommentBody}`);

      const portingCommand = `/port`;

      let beginInd = prCommentBody?.indexOf(portingCommand) ?? 0;

      if (beginInd>=0) {
        parsedBranchNames = prCommentBody?.slice(beginInd+portingCommand.length+1) as string;
      }

      console.log(`Branch names on PR comment: ${parsedBranchNames}`);

      var branchList = parsedBranchNames.split(",");

      console.log(`Detected list on PR: ${branchList}`);

      console.log(`Fetching all the commits from the pull request: ${mainpr.commits + 1}`);

      await git.fetch(
        `refs/pull/${pull_number}/head`,
        this.config.pwd,
        mainpr.commits + 1 // +1 in case this concerns a shallowly cloned repo
      );

      console.log(
        "Determining first and last commit shas, so we can cherry-pick the commit range"
      );

      const commitShas = await this.github.getCommits(mainpr);
      console.log(`Found commits: ${commitShas}`);

      let labelsToCopy: string[] = [];
      if (typeof this.config.copy_labels_pattern !== "undefined") {
        let copyLabelsPattern: RegExp = this.config.copy_labels_pattern;
        labelsToCopy = labels
          .map((label) => label.name)
          .filter(
            (label) =>
              label.match(copyLabelsPattern) &&
              !label.match(this.config.labels.pattern)
          );
      }
      console.log(
        `Will copy labels matching ${this.config.copy_labels_pattern}. Found matching labels: ${labelsToCopy}`
      );

      const successByTarget = new Map<string, boolean>();
      for (const branch of branchList) {

        console.log(`Working on label ${branch}`);

        const target= branch;

        console.log(`Found target in label: ${target}`);

        try {
          await git.fetch(target, this.config.pwd, 1);
        } catch (error) {
          if (error instanceof git.GitRefNotFoundError) {
            const message = this.composeMessageForFetchTargetFailure(error.ref);
            console.error(message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          } else {
            throw error;
          }
        }

        try {
          const targetDirectory = `port`;

          const branchname = `${targetDirectory}/port-${pull_number}-to-${target}`;

          console.log(`Start port to ${branchname}`);

          try {
            await git.checkout(branchname, `origin/${target}`, this.config.pwd);
          } catch (error) {
            const message = this.composeMessageForBackportScriptFailure(
              target,
              3,
              baseref,
              headref,
              branchname
            );
            console.error(message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          }

          try {
            await git.cherryPick(commitShas, this.config.pwd);
          } catch (error) {
            const message = this.composeMessageForBackportScriptFailure(
              target,
              4,
              baseref,
              headref,
              branchname
            );
            console.error(message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          }

          console.info(`Push branch to origin`);
          const pushExitCode = await git.push(branchname, this.config.pwd);
          if (pushExitCode != 0) {
            const message = this.composeMessageForGitPushFailure(
              target,
              pushExitCode
            );
            console.error(message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          }

          console.info(`Create PR for ${branchname}`);
          const { title, body } = this.composePRContent(target, mainpr);
          const new_pr_response = await this.github.createPR({
            owner,
            repo,
            title,
            body,
            head: branchname,
            base: target,
            maintainer_can_modify: true,
          });

          if (new_pr_response.status != 201) {
            console.error(JSON.stringify(new_pr_response));
            successByTarget.set(target, false);
            const message =
              this.composeMessageForCreatePRFailed(new_pr_response);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          }
          const new_pr = new_pr_response.data;

          if (labelsToCopy.length > 0) {
            const label_response = await this.github.labelPR(
              new_pr.number,
              labelsToCopy
            );
            if (label_response.status != 200) {
              console.error(JSON.stringify(label_response));
              // The PR was still created so let's still comment on the original.
            }
          }

          const message = this.composeMessageForSuccess(new_pr.number, target);
          successByTarget.set(target, true);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: message,
          });
        } catch (error) {
          if (error instanceof Error) {
            console.error(error.message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: error.message,
            });
          } else {
            throw error;
          }
        }
      }

      this.createOutput(successByTarget);
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
        core.setFailed(error.message);
      } else {
        console.error(`An unexpected error occurred: ${JSON.stringify(error)}`);
        core.setFailed(
          "An unexpected error occured. Please check the logs for details"
        );
      }
    }
  }

  private composePRContent(target: string, main: PullRequest): PRContent {
    const title = utils.replacePlaceholders(
      this.config.pull.title,
      main,
      target
    );
    const body = utils.replacePlaceholders(
      this.config.pull.description,
      main,
      target
    );
    return { title, body };
  }

  private composeMessageForFetchTargetFailure(target: string) {
    return dedent`Backport failed for \`${target}\`: couldn't find remote ref \`${target}\`.
                  Please ensure that this Github repo has a branch named \`${target}\`.`;
  }

  private composeMessageForBackportScriptFailure(
    target: string,
    exitcode: number,
    baseref: string,
    headref: string,
    branchname: string
  ): string {
    const reasons: { [key: number]: string } = {
      1: "due to an unknown script error",
      2: "because it was unable to create/access the git worktree directory",
      3: "because it was unable to create a new branch",
      4: "because it was unable to cherry-pick the commit(s)",
      5: "because 1 or more of the commits are not available",
      6: "because 1 or more of the commits are not available",
    };
    const reason = reasons[exitcode] ?? "due to an unknown script error";

    const suggestion =
      exitcode <= 4
        ? dedent`\`\`\`bash
                git fetch origin ${target}
                git worktree add -d .worktree/${branchname} origin/${target}
                cd .worktree/${branchname}
                git checkout -b ${branchname}
                ancref=$(git merge-base ${baseref} ${headref})
                git cherry-pick -x $ancref..${headref}
                \`\`\``
        : dedent`Note that rebase and squash merges are not supported at this time.`;

    return dedent`Backport failed for \`${target}\`, ${reason}.

                  Please cherry-pick the changes locally.
                  ${suggestion}`;
  }

  private composeMessageForGitPushFailure(
    target: string,
    exitcode: number
  ): string {
    //TODO better error messages depending on exit code
    return dedent`Git push to origin failed for ${target} with exitcode ${exitcode}`;
  }

  private composeMessageForCreatePRFailed(
    response: CreatePullRequestResponse
  ): string {
    return dedent`Backport branch created but failed to create PR. 
                Request to create PR rejected with status ${response.status}.

                (see action log for full response)`;
  }

  private composeMessageForSuccess(pr_number: number, target: string) {
    return dedent`Successfully created backport PR for \`${target}\`:
                  - #${pr_number}`;
  }

  private createOutput(successByTarget: Map<string, boolean>) {
    const anyTargetFailed = Array.from(successByTarget.values()).includes(
      false
    );
    core.setOutput(Output.wasSuccessful, !anyTargetFailed);

    const byTargetOutput = Array.from(successByTarget.entries()).reduce<string>(
      (i, [target, result]) => `${i}${target}=${result}\n`,
      ""
    );
    core.setOutput(Output.wasSuccessfulByTarget, byTargetOutput);
  }
}
