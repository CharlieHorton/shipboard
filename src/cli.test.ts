import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openDb } from "./db.js";
import * as store from "./store.js";

it("next and resume run against an isolated cache without external CLIs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "shipboard-cli-test-"));
  const path = join(scratch, "fixture.db");
  const cfg = { gating_bots: [], ignored_authors: [], projects: [{ name: "fixture", repos: [
    { owner: "example", name: "app", dev_branch: "dev", prod_branch: "main", deploy: "manual" },
  ] }] };
  writeFileSync(join(scratch, "config.json"), JSON.stringify(cfg));
  const db = openDb(path);
  try {
    const item = store.createItem(db, { project: "fixture", title: "Resume synthetic work", summary: "Check the fixture only." });
    db.prepare("INSERT INTO prs (item_id,repo,number,state,is_draft,ci_state,head_sha) VALUES (?, 'example/app', 1, 'OPEN', 1, 'FAILURE', 'fixture-sha')").run(item.id);
    store.addEvent(db, item.id, "user", "Next: inspect the fixture logs");
    const run = (...args: string[]) => execFileSync(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args],
      { encoding: "utf8", timeout: 20_000, env: { ...process.env, SHIPBOARD_HOME: scratch, SHIPBOARD_DB: path, PATH: scratch } });
    const next = JSON.parse(run("next", "--json")) as { actions: { kind: string }[]; health: { status: string }[] };
    expect(next.actions[0]?.kind).toBe("ci-failing");
    expect(next.health[0]?.status).toBe("never");
    const resume = run("resume", String(item.id));
    expect(resume).toContain("Next: inspect the fixture logs");
    expect(resume).toContain("fixture-sha");
    expect(JSON.parse(run("next", "--project", "missing", "--json"))).toEqual({ actions: [], health: [] });
    expect(store.eventsForItem(db, item.id)).toHaveLength(1);
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
