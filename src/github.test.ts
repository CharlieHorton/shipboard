import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRS_QUERY, PR_QUERY, parseGithubRemote, repoForCwd } from "./github.js";
import type { Config, RepoConfig } from "./types.js";

const REPO: RepoConfig = {
  owner: "example",
  name: "API",
  dev_branch: "develop",
  prod_branch: "main",
  deploy: "manual",
};

const CFG: Config = {
  gating_bots: ["coderabbitai", "qodo-code-review"],
  ignored_authors: [],
  projects: [{ name: "example", repos: [REPO] }],
};

function gitRepoWithRemote(url: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "shipboard-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  if (url !== undefined) execFileSync("git", ["remote", "add", "origin", url], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("parseGithubRemote", () => {
  it("parses scp-style ssh remotes", () => {
    expect(parseGithubRemote("git@github.com:example/API.git")).toEqual({
      owner: "example",
      name: "API",
    });
    expect(parseGithubRemote("git@github.com:example/API")).toEqual({
      owner: "example",
      name: "API",
    });
  });

  it("parses https remotes, with or without .git and trailing slash", () => {
    expect(parseGithubRemote("https://github.com/example/web.git")).toEqual({
      owner: "example",
      name: "web",
    });
    expect(parseGithubRemote("https://github.com/example/web")).toEqual({
      owner: "example",
      name: "web",
    });
    expect(parseGithubRemote("https://github.com/example/web/")).toEqual({
      owner: "example",
      name: "web",
    });
    expect(parseGithubRemote("  https://token@github.com/example/tenants.git\n")).toEqual({
      owner: "example",
      name: "tenants",
    });
  });

  it("parses ssh:// and git:// remotes", () => {
    expect(parseGithubRemote("ssh://git@github.com/example/API.git")).toEqual({
      owner: "example",
      name: "API",
    });
    expect(parseGithubRemote("git://github.com/example/API.git")).toEqual({
      owner: "example",
      name: "API",
    });
  });

  it("rejects non-GitHub and malformed remotes", () => {
    expect(parseGithubRemote("")).toBeUndefined();
    expect(parseGithubRemote("git@gitlab.com:example/API.git")).toBeUndefined();
    expect(parseGithubRemote("https://example.com/example/API")).toBeUndefined();
    expect(parseGithubRemote("https://github.com/example")).toBeUndefined();
    expect(parseGithubRemote("https://github.com/a/b/c")).toBeUndefined();
    expect(parseGithubRemote("/Users/me/Projects/API")).toBeUndefined();
  });
});

describe("repoForCwd", () => {
  it("resolves a checkout to its configured repo", () => {
    const dir = gitRepoWithRemote("git@github.com:example/API.git");
    expect(repoForCwd(dir, CFG)).toEqual(REPO);
  });

  it("matches case-insensitively", () => {
    const dir = gitRepoWithRemote("https://github.com/EXAMPLE/api.git");
    expect(repoForCwd(dir, CFG)).toEqual(REPO);
  });

  it("returns undefined for an unconfigured repo, a remote-less repo and a non-repo", () => {
    expect(repoForCwd(gitRepoWithRemote("git@github.com:someone/other.git"), CFG)).toBeUndefined();
    expect(repoForCwd(gitRepoWithRemote(undefined), CFG)).toBeUndefined();
    expect(repoForCwd(mkdtempSync(join(tmpdir(), "shipboard-plain-")), CFG)).toBeUndefined();
    expect(repoForCwd("/no/such/directory", CFG)).toBeUndefined();
  });
});

describe("queries", () => {
  it("asks for open and merged PRs in one document, with every derived field", () => {
    expect(PRS_QUERY).toContain("open: pullRequests(first:50,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC})");
    expect(PRS_QUERY).toContain("merged: pullRequests(first:30,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC})");
    for (const field of [
      "headRefOid",
      "mergeCommit{oid}",
      "author{login __typename}",
      "reviews(first:100){nodes{author{login __typename} commit{oid} state submittedAt}}",
      "reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{login}}}}}",
      "commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}",
      "url",
    ]) {
      expect(PRS_QUERY).toContain(field);
      expect(PR_QUERY).toContain(field);
    }
  });

  it("fetches a single PR by number", () => {
    expect(PR_QUERY).toContain("pullRequest(number:$number)");
    expect(PR_QUERY).toContain("$number:Int!");
  });
});
