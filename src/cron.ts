/**
 * `shipboard cron` — run `shipboard sync` on a schedule via launchd.
 *
 * The design doc asks for a 10-minute poll so bot reviews landing while no
 * session is open still show up. A user LaunchAgent is the least surprising way
 * to get that on macOS: one plist in ~/Library/LaunchAgents, bootstrapped into
 * the GUI domain of the current uid.
 *
 * Everything here that produces a string is pure; every process and filesystem
 * call goes through `CronDeps` so the tests never touch launchd or $HOME.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shipboardHome } from "./config.js";

export const LABEL = "dev.shipboard.sync";
export const DEFAULT_INTERVAL = 600;

/** How many trailing log lines `cron status` echoes. */
const LOG_TAIL = 3;

const BUILD_HINT =
  "launchd needs the built CLI, not the TypeScript sources. Run `npm run build`, " +
  "then `node dist/cli.js cron install`.";

// ---------- pure ----------

/** `~/Library/LaunchAgents/dev.shipboard.sync.plist`. */
export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** Where launchd sends both stdout and stderr of the sync. */
export function logPath(): string {
  return join(shipboardHome(), "sync.log");
}

/**
 * The CLI launchd should run. Resolved against this module, so a `dist/` build
 * points at `dist/cli.js`; under tsx it points inside `src/`, which node cannot
 * execute — `checkCli` rejects that.
 */
export function cliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/** `--interval`, in seconds. Throws on anything launchd would not accept. */
export function parseInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INTERVAL;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--interval must be a positive whole number of seconds, got "${raw}".`);
  }
  return n;
}

/** Throws unless `cli` is a JS entry point that exists on disk. */
export function checkCli(cli: string, exists: (p: string) => boolean = existsSync): void {
  if (cli.endsWith(".ts")) throw new Error(`${BUILD_HINT} (resolved ${cli})`);
  if (!exists(cli)) throw new Error(`${BUILD_HINT} (no file at ${cli})`);
}

function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface PlistOptions {
  /** Absolute node binary, normally `process.execPath`. */
  node: string;
  /** Absolute path of the built CLI. */
  cli: string;
  interval: number;
  log: string;
  /** launchd's own PATH has no Homebrew, so `gh` would not be found. */
  path: string;
  home: string;
}

export function plistXml(o: PlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.node)}</string>
    <string>${xml(o.cli)}</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key>
  <integer>${o.interval}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.path)}</string>
    <key>HOME</key>
    <string>${xml(o.home)}</string>
  </dict>
</dict>
</plist>
`;
}

/** `StartInterval` out of an installed plist, or undefined if it has none. */
export function readInterval(plist: string): number | undefined {
  const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

// ---------- effects ----------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (file: string, args: string[]) => ExecResult;

export interface CronDeps {
  exec: Exec;
  plist: string;
  log: string;
  cli: string;
  node: string;
  home: string;
  path: string;
  uid: number;
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, body: string) => void;
  remove: (p: string) => void;
}

function realExec(file: string, args: string[]): ExecResult {
  const r = spawnSync(file, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function defaultDeps(): CronDeps {
  const home = homedir();
  return {
    exec: realExec,
    plist: plistPath(home),
    log: logPath(),
    cli: cliPath(),
    node: process.execPath,
    home,
    path: process.env["PATH"] ?? "",
    uid: process.getuid?.() ?? 0,
    exists: existsSync,
    read: (p) => readFileSync(p, "utf8"),
    write: (p, body) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    },
    remove: (p) => rmSync(p, { force: true }),
  };
}

function target(deps: CronDeps): string {
  return `gui/${deps.uid}`;
}

/** Write the plist and (re)load it. Throws with a usable message on failure. */
export function install(interval: number, deps: CronDeps = defaultDeps()): string {
  checkCli(deps.cli, deps.exists);
  deps.write(
    deps.plist,
    plistXml({
      node: deps.node,
      cli: deps.cli,
      interval,
      log: deps.log,
      path: deps.path,
      home: deps.home,
    }),
  );
  // A previous version may still be loaded; booting it out first is the
  // supported way to replace it, and failing here just means it was not loaded.
  deps.exec("launchctl", ["bootout", target(deps), deps.plist]);
  const boot = deps.exec("launchctl", ["bootstrap", target(deps), deps.plist]);
  if (boot.code !== 0) {
    const why = (boot.stderr || boot.stdout).trim();
    throw new Error(`Wrote ${deps.plist} but launchctl bootstrap failed: ${why || `exit ${boot.code}`}`);
  }
  return [
    `Installed ${LABEL}: \`shipboard sync\` every ${interval}s (RunAtLoad, so it just ran).`,
    `  plist ${deps.plist}`,
    `  log   ${deps.log}`,
  ].join("\n");
}

export function uninstall(deps: CronDeps = defaultDeps()): string {
  if (!deps.exists(deps.plist)) return `Not installed — no ${deps.plist}. Nothing to do.`;
  deps.exec("launchctl", ["bootout", target(deps), deps.plist]);
  deps.remove(deps.plist);
  return `Uninstalled ${LABEL} and removed ${deps.plist}.`;
}

export function status(deps: CronDeps = defaultDeps()): string {
  if (!deps.exists(deps.plist)) {
    return `${LABEL} is not installed (no ${deps.plist}). Run \`shipboard cron install\`.`;
  }
  const interval = readInterval(deps.read(deps.plist));
  const printed = deps.exec("launchctl", ["print", `${target(deps)}/${LABEL}`]);
  const lines = [
    `${LABEL} is installed and ${printed.code === 0 ? "loaded" : "NOT loaded"} in ${target(deps)}.`,
    `  interval ${interval === undefined ? "unknown" : `${interval}s`}`,
    `  plist    ${deps.plist}`,
    `  log      ${deps.log}`,
  ];
  if (deps.exists(deps.log)) {
    const tail = deps
      .read(deps.log)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-LOG_TAIL);
    for (const l of tail) lines.push(`  | ${l}`);
  }
  return lines.join("\n");
}
