import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configPath } from "./config.js";
import { addProjectRepository, discoverRepository } from "./project-config.js";

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "shipboard-project-")));
  vi.stubEnv("SHIPBOARD_HOME", join(scratch, "profile"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function checkout(branch = "main"): string {
  const path = join(scratch, "checkout with spaces");
  mkdirSync(path);
  git(path, "init", "-q", `--initial-branch=${branch}`);
  git(path, "remote", "add", "origin", "git@github.com:example/app.git");
  git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture");
  return path;
}
function config(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
}
const remoteOnly = () => discoverRepository({ repo: "example/app" }, scratch);

it("detects a GitHub origin from a subdirectory and selects develop plus the default branch", () => {
  const path = checkout("release");
  git(path, "branch", "develop");
  git(path, "update-ref", "refs/remotes/origin/release", "HEAD");
  git(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
  const sub = join(path, "nested");
  mkdirSync(sub);
  expect(discoverRepository({}, sub)).toEqual({
    owner: "example", name: "app", local: path, dev_branch: "develop", prod_branch: "release", deploy: "manual",
  });
  expect(existsSync(configPath())).toBe(false);
});

it("uses main or master for a single-branch checkout", () => {
  const path = checkout("master");
  expect(discoverRepository({ local: path }, scratch)).toMatchObject({ dev_branch: "master", prod_branch: "master" });
});

it("finds develop in cached remote refs and does not fetch", () => {
  const path = checkout();
  git(path, "update-ref", "refs/remotes/origin/develop", "HEAD");
  expect(discoverRepository({ local: path }, scratch).dev_branch).toBe("develop");
  expect(existsSync(join(path, ".git", "FETCH_HEAD"))).toBe(false);
});

it("registers the main checkout when run from a linked worktree", () => {
  const path = checkout();
  const linked = join(scratch, "feature worktree");
  git(path, "worktree", "add", "-qb", "feature/example", linked);
  expect(discoverRepository({ local: linked }, scratch).local).toBe(path);
});

it("accepts explicit branches and deployment without attaching the current checkout", () => {
  const path = checkout();
  expect(discoverRepository({ repo: "other/api", devBranch: "dev", prodBranch: "production", deploy: "auto" }, path))
    .toEqual({ owner: "other", name: "api", dev_branch: "dev", prod_branch: "production", deploy: "auto" });
});

it("requires a checkout with a GitHub origin and refuses mismatched explicit repositories", () => {
  expect(() => discoverRepository({}, scratch)).toThrow("No Git checkout");
  const path = checkout();
  expect(() => discoverRepository({ local: path, repo: "other/app" }, scratch)).toThrow("does not match");
  git(path, "remote", "set-url", "origin", "git@gitlab.com:example/app.git");
  expect(() => discoverRepository({ local: path }, scratch)).toThrow("GitHub origin");
});

it("rejects invalid repository keys, branch names, and deployment modes", () => {
  for (const repo of ["https://github.com/example/app", "example", "example/app/extra", "example/.."])
    expect(() => discoverRepository({ repo }, scratch)).toThrow("owner/name");
  for (const devBranch of ["", "two words", "@{-1}", "refs/heads/main", "--help", "a..b"])
    expect(() => discoverRepository({ repo: "example/app", devBranch }, scratch)).toThrow("branch name");
  expect(() => discoverRepository({ repo: "example/app", deploy: "maybe" }, scratch)).toThrow("manual or auto");
});

it("creates a new profile and leaves the database uncreated", () => {
  addProjectRepository("sample", remoteOnly());
  expect(config()).toEqual({ gating_bots: ["coderabbitai", "qodo-code-review"], ignored_authors: ["dependabot"],
    projects: [{ name: "sample", repos: [{ owner: "example", name: "app", dev_branch: "main", prod_branch: "main", deploy: "manual" }] }] });
  expect(existsSync(join(scratch, "profile", "shipboard.db"))).toBe(false);
  expect(existsSync(`${configPath()}.lock`)).toBe(false);
});

it("appends repos and projects while preserving existing integrations and unknown fields", () => {
  mkdirSync(join(scratch, "profile"));
  const oldRepo = { owner: "team", name: "api", local: "/work/api", eas: { cwd: "/work/api", branch: "production" }, extra: true };
  const oldProject = { name: "existing", color: "blue", repos: [oldRepo] };
  writeFileSync(configPath(), JSON.stringify({ gating_bots: [], ignored_authors: [], linear_workspace: "team", extra: { value: 7 }, projects: [oldProject] }));
  addProjectRepository("existing", remoteOnly());
  addProjectRepository("second", { ...remoteOnly(), name: "web" });
  expect(config()).toEqual({ gating_bots: [], ignored_authors: [], linear_workspace: "team", extra: { value: 7 }, projects: [
    { ...oldProject, repos: [oldRepo, remoteOnly()] }, { name: "second", repos: [{ ...remoteOnly(), name: "web" }] },
  ] });
});

it("refuses case-insensitive duplicate repos across projects without changing config", () => {
  addProjectRepository("first", remoteOnly());
  const before = readFileSync(configPath(), "utf8");
  expect(() => addProjectRepository("second", { ...remoteOnly(), owner: "EXAMPLE", name: "APP" })).toThrow('already registered in project "first"');
  expect(readFileSync(configPath(), "utf8")).toBe(before);
});

it("preserves malformed config and releases the writer lock on failure", () => {
  mkdirSync(join(scratch, "profile"));
  for (const original of ["{broken", 'null', '{"projects":{}}', '{"projects":[{"name":"x","repos":null}]}']) {
    writeFileSync(configPath(), original);
    expect(() => addProjectRepository("new", remoteOnly())).toThrow("existing file was not changed");
    expect(readFileSync(configPath(), "utf8")).toBe(original);
    expect(existsSync(`${configPath()}.lock`)).toBe(false);
  }
});

it("refuses another writer's lock and invalid project names", () => {
  expect(() => addProjectRepository("  ", remoteOnly())).toThrow("Project name");
  expect(existsSync(configPath())).toBe(false);
  addProjectRepository("first", remoteOnly());
  const before = readFileSync(configPath(), "utf8");
  writeFileSync(`${configPath()}.lock`, "another writer");
  expect(() => addProjectRepository("second", remoteOnly())).toThrow("Cannot lock");
  expect(readFileSync(configPath(), "utf8")).toBe(before);
  expect(readFileSync(`${configPath()}.lock`, "utf8")).toBe("another writer");
});

it("exposes project add through the CLI with useful output and nonzero duplicate errors", () => {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, "project", "add", ...args], {
    encoding: "utf8", env: process.env, timeout: 20_000,
  });
  const added = run("sample", "--repo", "example/app", "--dev-branch", "develop", "--deploy", "auto");
  expect(added.status).toBe(0);
  expect(added.stdout).toContain('Added example/app to project "sample"');
  expect(added.stdout).toContain("develop → main; production deploy: auto");
  expect(added.stdout).toContain("shipboard sync --repo example/app");
  const duplicate = run("sample", "--repo", "example/app");
  expect(duplicate.status).toBe(1);
  expect(duplicate.stderr).toContain("already registered");
});
