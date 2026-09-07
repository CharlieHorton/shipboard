/** Commands are parsed only by a shell function named git; no real git or removal runs. */
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import { collect, jsonWorktree, worktreeRemoveCommand, type WorktreeView } from "./views.js";
import { API, OTHER, CFG, insertWt, wt } from "./__fixtures__/model.js";
import type { Config, WorktreeRow } from "./types.js";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.close(); });

function cleanupView(over: Partial<WorktreeRow> = {}): WorktreeView {
  return { wt: wt({ ahead_of_dev: 0, ...over }), stage: "empty", pr: undefined,
    main_checkout: "/synthetic/owner checkout" };
}

/** A deliberately unrelated cwd; PATH is empty and git is a printing shell function. */
function parsedArguments(command: string): string[] {
  const result = spawnSync("/bin/sh", ["-c", `git() { printf '%s\\0' "$@"; }\n${command}`], {
    cwd: "/", env: { PATH: "", LC_ALL: "C" }, encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout.split("\0").slice(0, -1);
}

describe("cwd-independent worktree cleanup commands", () => {
  it("collects the owning repository root and explicitly targets it from any caller cwd", () => {
    insertWt(db, { repo: API, path: "/synthetic/feature work/api", ahead_of_dev: 0 });
    const view = collect(db, CFG).worktrees.housekeeping[0]!;
    expect(view.main_checkout).toBe("/synthetic/api");
    const command = worktreeRemoveCommand(view)!;
    expect(parsedArguments(command)).toEqual([
      "-C", "/synthetic/api", "worktree", "remove", "--", "/synthetic/feature work/api",
    ]);
    expect(jsonWorktree(view)).toMatchObject({ main_checkout: "/synthetic/api", remove_command: command });
  });

  it("preserves apostrophes, whitespace and shell metacharacters as literal arguments", () => {
    // The substitution probes only print harmless diagnostics if quoting breaks.
    const main = "/synthetic/owner's checkout $(printf ROOT_INJECTION >&2) `printf ROOT_BACKTICK >&2`";
    const target = "/synthetic/feature's checkout $(printf TARGET_INJECTION >&2) ; & $HOME\nnext line";
    const cfg: Config = { ...CFG, projects: [{ name: "alpha", repos: [{
      owner: "synthetic", name: "api", dev_branch: "develop", prod_branch: "main",
      deploy: "manual", local: main,
    }] }] };
    insertWt(db, { path: target, ahead_of_dev: 0 });
    const view = collect(db, cfg).worktrees.housekeeping[0]!;
    expect(view.main_checkout).toBe(main);
    expect(parsedArguments(worktreeRemoveCommand(view)!)).toEqual([
      "-C", main, "worktree", "remove", "--", target,
    ]);
  });

  it("does not invent an owning checkout for a repository without local configuration", () => {
    insertWt(db, { repo: OTHER, path: "/synthetic/other-feature", ahead_of_dev: 0 });
    const view = collect(db, CFG).worktrees.housekeeping[0]!;
    expect(view.main_checkout).toBeUndefined();
    expect(worktreeRemoveCommand(view)).toBeUndefined();
    expect(jsonWorktree(view)).toMatchObject({ main_checkout: null, remove_command: null });
  });

  it.each([
    { dirty: 1 as const }, { dirty: -1 as const }, { unpushed: 1 }, { unpushed: -1 },
    { ahead_of_dev: -1 }, { is_main: 1 as const }, { path: "relative/checkout" },
  ])("rejects unsafe or incomplete observations even with a cleanup stage: %j", (observation) => {
    const view = cleanupView(observation);
    expect(worktreeRemoveCommand(view)).toBeUndefined();
    expect(jsonWorktree(view).remove_command).toBeNull();
  });

  it.each(["unknown", "local-only", "needs-pr", "has-pr"] as const)("rejects stage %s", (stage) => {
    expect(worktreeRemoveCommand({ ...cleanupView(), stage })).toBeUndefined();
  });

  it("rejects absent or relative owning checkout paths", () => {
    const { main_checkout: _main, ...withoutMain } = cleanupView();
    expect(worktreeRemoveCommand(withoutMain)).toBeUndefined();
    expect(worktreeRemoveCommand({ ...withoutMain, main_checkout: "relative/main" })).toBeUndefined();
  });

  it("allows a fully observed merged feature checkout without force flags", () => {
    const view = { ...cleanupView(), stage: "merged" as const };
    expect(parsedArguments(worktreeRemoveCommand(view)!)).toEqual([
      "-C", "/synthetic/owner checkout", "worktree", "remove", "--", view.wt.path,
    ]);
  });
});
