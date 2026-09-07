import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configPath, loadConfig } from "./config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "shipboard-config-"));
  vi.stubEnv("SHIPBOARD_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it("first run creates an empty profile without configured repositories or a workspace", () => {
  const config = loadConfig();
  expect(config.projects).toEqual([]);
  expect(config.linear_workspace).toBeUndefined();
  expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual(config);
});

it("preserves an existing user's repositories, paths, and optional settings", () => {
  const original = JSON.stringify({
    gating_bots: [], ignored_authors: [], linear_workspace: "team",
    projects: [{ name: "existing", repos: [{ owner: "team", name: "app",
      dev_branch: "main", prod_branch: "main", deploy: "manual", local: "/work/app" }] }],
  });
  writeFileSync(configPath(), original);
  expect(loadConfig()).toEqual(JSON.parse(original));
  expect(readFileSync(configPath(), "utf8")).toBe(original);
});
