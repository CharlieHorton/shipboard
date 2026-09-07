import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INTERVAL,
  LABEL,
  checkCli,
  install,
  parseInterval,
  plistPath,
  plistXml,
  readInterval,
  status,
  uninstall,
  type CronDeps,
  type ExecResult,
} from "./cron.js";

// ---------- fixtures ----------

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

const PLIST_OPTS = {
  node: "/opt/homebrew/opt/node@22/bin/node",
  cli: "/Users/x/Projects/shipboard/dist/cli.js",
  interval: 600,
  log: "/Users/x/.shipboard/sync.log",
  path: "/opt/homebrew/bin:/usr/bin:/bin",
  home: "/Users/x",
};

/** A CronDeps with an in-memory filesystem and a launchctl that always agrees. */
function mkDeps(over: Partial<CronDeps> = {}): CronDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const deps: CronDeps & { files: Map<string, string> } = {
    files,
    exec: vi.fn(() => OK),
    plist: "/Users/x/Library/LaunchAgents/dev.shipboard.sync.plist",
    log: "/Users/x/.shipboard/sync.log",
    cli: "/Users/x/Projects/shipboard/dist/cli.js",
    node: "/opt/homebrew/opt/node@22/bin/node",
    home: "/Users/x",
    path: "/opt/homebrew/bin:/usr/bin:/bin",
    uid: 501,
    exists: (p) => files.has(p),
    read: (p) => files.get(p) ?? "",
    write: (p, body) => void files.set(p, body),
    remove: (p) => void files.delete(p),
    ...over,
  };
  // The built CLI is on disk unless a test says otherwise.
  if (over.exists === undefined) files.set(deps.cli, "#!/usr/bin/env node\n");
  return deps;
}

// ---------- pure ----------

describe("plistPath", () => {
  it("lives in the user's LaunchAgents directory under the label", () => {
    expect(plistPath("/Users/x")).toBe("/Users/x/Library/LaunchAgents/dev.shipboard.sync.plist");
  });
});

describe("parseInterval", () => {
  it("defaults to ten minutes", () => {
    expect(parseInterval(undefined)).toBe(DEFAULT_INTERVAL);
    expect(DEFAULT_INTERVAL).toBe(600);
  });

  it("accepts a positive whole number of seconds", () => {
    expect(parseInterval("300")).toBe(300);
  });

  it("rejects anything launchd would not take", () => {
    for (const bad of ["0", "-5", "1.5", "ten", ""]) {
      expect(() => parseInterval(bad), bad).toThrow(/positive whole number/);
    }
  });
});

describe("plistXml", () => {
  const xml = plistXml(PLIST_OPTS);

  it("names the label, the interval, node and the CLI", () => {
    expect(xml).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`);
    expect(xml).toContain("<key>StartInterval</key>\n  <integer>600</integer>");
    expect(xml).toContain("<string>/opt/homebrew/opt/node@22/bin/node</string>");
    expect(xml).toContain("<string>/Users/x/Projects/shipboard/dist/cli.js</string>");
    expect(xml).toContain("<string>sync</string>");
  });

  it("carries PATH and HOME so launchd can find gh", () => {
    expect(xml).toContain("<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(xml).toContain("<key>HOME</key>\n    <string>/Users/x</string>");
  });

  it("runs at load and logs both streams to one file", () => {
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml.match(/<string>\/Users\/x\/\.shipboard\/sync\.log<\/string>/g)).toHaveLength(2);
  });

  it("escapes XML metacharacters in paths", () => {
    const xml = plistXml({ ...PLIST_OPTS, cli: "/Users/x/a & b/<cli>.js" });
    expect(xml).toContain("<string>/Users/x/a &amp; b/&lt;cli&gt;.js</string>");
    expect(xml).not.toContain("a & b");
  });

  it("round-trips through readInterval", () => {
    expect(readInterval(plistXml({ ...PLIST_OPTS, interval: 900 }))).toBe(900);
    expect(readInterval("<plist/>")).toBeUndefined();
  });
});

describe("checkCli", () => {
  it("refuses the TypeScript sources and says how to fix it", () => {
    expect(() => checkCli("/Users/x/Projects/shipboard/src/cli.ts", () => true)).toThrow(
      /npm run build.*node dist\/cli\.js cron install/s,
    );
  });

  it("refuses a path that is not there", () => {
    expect(() => checkCli("/Users/x/dist/cli.js", () => false)).toThrow(/no file at/);
  });

  it("accepts a built entry point", () => {
    expect(() => checkCli("/Users/x/dist/cli.js", () => true)).not.toThrow();
  });
});

// ---------- effects (launchctl is always a stub) ----------

describe("install", () => {
  it("writes the plist, boots the old one out, then bootstraps", () => {
    const deps = mkDeps();
    const out = install(600, deps);

    expect(deps.files.get(deps.plist)).toContain("<integer>600</integer>");
    expect(deps.exec).toHaveBeenNthCalledWith(1, "launchctl", [
      "bootout",
      "gui/501",
      deps.plist,
    ]);
    expect(deps.exec).toHaveBeenNthCalledWith(2, "launchctl", [
      "bootstrap",
      "gui/501",
      deps.plist,
    ]);
    expect(out).toContain("every 600s");
    expect(out).toContain(deps.plist);
  });

  it("refuses a .ts CLI path before writing anything", () => {
    const deps = mkDeps({ cli: "/Users/x/Projects/shipboard/src/cli.ts" });
    expect(() => install(600, deps)).toThrow(/npm run build/);
    expect(deps.files.has(deps.plist)).toBe(false);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("surfaces a bootstrap failure with launchctl's own words", () => {
    const deps = mkDeps({
      exec: vi.fn((_file: string, args: string[]) =>
        args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Input/output error\n" } : OK,
      ),
    });
    expect(() => install(600, deps)).toThrow(/bootstrap failed: Input\/output error/);
  });

  // A previously-loaded agent makes bootout succeed and bootstrap the only gate.
  it("ignores a failing bootout", () => {
    const deps = mkDeps({
      exec: vi.fn((_file: string, args: string[]) =>
        args[0] === "bootout" ? { code: 3, stdout: "", stderr: "No such process" } : OK,
      ),
    });
    expect(() => install(600, deps)).not.toThrow();
  });
});

describe("uninstall", () => {
  it("boots the agent out and deletes the plist", () => {
    const deps = mkDeps();
    install(600, deps);
    (deps.exec as ReturnType<typeof vi.fn>).mockClear();

    expect(uninstall(deps)).toContain("Uninstalled");
    expect(deps.files.has(deps.plist)).toBe(false);
    expect(deps.exec).toHaveBeenCalledExactlyOnceWith("launchctl", [
      "bootout",
      "gui/501",
      deps.plist,
    ]);
  });

  it("is a no-op that says so when nothing is installed", () => {
    const deps = mkDeps();
    expect(uninstall(deps)).toContain("Not installed");
    expect(deps.exec).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("says so, without touching launchctl, when nothing is installed", () => {
    const deps = mkDeps();
    expect(status(deps)).toContain("is not installed");
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("reports the interval, the load state and the last three log lines", () => {
    const deps = mkDeps();
    install(900, deps);
    deps.files.set(deps.log, ["one", "two", "three", "four", ""].join("\n"));

    const out = status(deps);
    expect(out).toContain("installed and loaded in gui/501");
    expect(out).toContain("interval 900s");
    expect(out).toContain("  | two");
    expect(out).toContain("  | four");
    expect(out).not.toContain("  | one");
  });

  it("calls out an installed but unloaded agent", () => {
    const deps = mkDeps({
      exec: vi.fn((_file: string, args: string[]) =>
        args[0] === "print" ? { code: 113, stdout: "", stderr: "Could not find service" } : OK,
      ),
    });
    install(600, deps);
    expect(status(deps)).toContain("NOT loaded");
  });
});
