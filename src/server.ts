/**
 * The HTTP server behind `shipboard serve`.
 *
 * Routing, request bodies and JSON live here; every byte of markup comes from
 * src/web/render.ts and every read model from src/views.ts. It is a local tool:
 * it binds to 127.0.0.1, has no auth, needs no CORS and caches nothing.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nowIso, type Db } from "./db.js";
import * as store from "./store.js";
import { syncAll, type SyncResult } from "./sync.js";
import type { Config, RepoKey } from "./types.js";
import { renderDrawer, renderPage } from "./web/render.js";
import { SHIPBOARD_ICON } from "./web/brand.js";
import { collect, jsonItem, jsonSections, viewItem } from "./views.js";
import { nextActions } from "./actions.js";
import { buildResume, formatResume } from "./resume.js";
import { readSyncHealth } from "./sync-health.js";
import { captureEvidence } from "./evidence.js";
import { removeWorktree, WorktreeRemovalError } from "./worktree-removal.js";
import type { GitClient } from "./worktrees.js";

export const DEFAULT_PORT = 7373;
export const DEFAULT_HOST = "127.0.0.1";

/** Largest request body read; bytes past this are drained and dropped. */
const MAX_BODY = 64 * 1024;

class ConfirmationConflict extends Error {}

export interface ServerOptions {
  port?: number;
  /** Defaults to 127.0.0.1. */
  host?: string;
}

export interface AppDependencies {
  /** Tests supply an inert Git implementation. */
  git?: GitClient;
}

// ---------- responses ----------

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendHtml(res: ServerResponse, body: string): void {
  send(res, 200, "text/html; charset=utf-8", body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  send(res, status, "text/plain; charset=utf-8", body);
}

// ---------- request bodies ----------

/** Read at most MAX_BODY bytes; empty and unparseable bodies are `{}`. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    if (size < MAX_BODY) chunks.push(buf.subarray(0, MAX_BODY - size));
    size += buf.length;
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

// ---------- routing ----------

type Params = readonly (string | undefined)[];

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Params,
  url: URL,
) => void | Promise<void>;

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  handle: Handler;
}

/** A positive integer path segment, else undefined (the caller answers 400). */
function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** `?project=` with no value means "all projects". */
function queryProject(url: URL): string | undefined {
  return url.searchParams.get("project") || undefined;
}

/** Most recent sync across all PRs; undefined when nothing has ever synced. */
function lastSyncedAt(db: Db): string | undefined {
  const row = db.prepare(`SELECT max(synced_at) AS at FROM prs`).get() as
    | { at: string | null }
    | undefined;
  return row?.at ? row.at : undefined;
}

/**
 * The request handler, without a listening socket: tests drive it through
 * `startServer`, but it is a plain `(req, res)` function.
 */
export function createApp(db: Db, cfg: Config, deps: AppDependencies = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const worktreeToken = randomUUID();
  const removing = new Set<string>();
  /** One sync at a time; a second request awaits the one already running. */
  let running: Promise<SyncResult[]> | null = null;
  function sync(repo: string | undefined): Promise<SyncResult[]> {
    if (removing.size) return Promise.reject(new ConfirmationConflict("Worktree removal is in progress. Retry sync after it finishes."));
    if (running) return running;
    const opts = repo === undefined ? undefined : { repos: [repo as RepoKey] };
    const started = syncAll(db, cfg, opts).finally(() => {
      running = null;
    });
    running = started;
    return started;
  }

  function board(url: URL) {
    const project = queryProject(url);
    return collect(db, cfg, {
      attention: false,
      ...(project !== undefined ? { project } : {}),
    });
  }

  function health(url: URL) {
    const project = queryProject(url);
    return readSyncHealth(db, cfg, project === undefined ? {} : { project });
  }

  /** Compare with the drawer's displayed commit set before recording a human confirmation. */
  function assertEvidence(id: number, body: Record<string, unknown>): void {
    const current = captureEvidence(store.prsForItem(db, id));
    if (current === null || body["expected_evidence"] !== current) {
      throw new ConfirmationConflict("The linked commits changed or cannot be verified. Reopen the item, review its current commits, and confirm again.");
    }
  }

  /** Patch one item, record an event, `{ ok: true }`. */
  function mutateItem(
    res: ServerResponse,
    params: Params,
    patch: store.ItemPatch,
    event: string,
  ): void {
    const id = parseId(params[0]);
    if (id === undefined) return sendJson(res, 400, { ok: false, error: "Bad item id" });
    if (!store.getItem(db, id)) return sendJson(res, 404, { ok: false, error: `No item #${id}` });
    store.updateItem(db, id, patch);
    store.addEvent(db, id, "user", event);
    sendJson(res, 200, { ok: true });
  }

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/(?:favicon|icon)\.svg$/,
      handle: (_req, res) => send(res, 200, "image/svg+xml; charset=utf-8", SHIPBOARD_ICON),
    },
    {
      method: "GET",
      pattern: /^\/$/,
      handle: (_req, res, _params, url) => {
        sendHtml(
          res,
          renderPage(board(url), {
            project: queryProject(url),
            projects: cfg.projects.map((p) => p.name),
            syncedAt: lastSyncedAt(db),
            linearWorkspace: cfg.linear_workspace,
            health: health(url),
            worktreeToken,
          }),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/item\/([^/]+)$/,
      handle: (_req, res, params) => {
        const id = parseId(params[0]);
        if (id === undefined) return sendText(res, 400, `Bad item id "${params[0] ?? ""}"`);
        const item = store.getItem(db, id);
        if (!item) return sendText(res, 404, `No item #${id}`);
        sendHtml(
          res,
          renderDrawer(
            viewItem(db, cfg, item),
            store.tasksForItem(db, id),
            store.eventsForItem(db, id, 50),
            { linearWorkspace: cfg.linear_workspace },
          ),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/board$/,
      handle: (_req, res, _params, url) => sendJson(res, 200, { ...jsonSections(board(url)), health: health(url) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/next$/,
      handle: (_req, res, _params, url) => sendJson(res, 200, { actions: nextActions(board(url)), health: health(url) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/items\/([^/]+)\/resume$/,
      handle: (_req, res, params, url) => {
        const id = parseId(params[0]);
        if (id === undefined) return sendJson(res, 400, { ok: false, error: "Bad item id" });
        const brief = buildResume(db, cfg, id);
        if (!brief) return sendJson(res, 404, { ok: false, error: `No item #${id}` });
        if (url.searchParams.get("format") === "text") sendText(res, 200, formatResume(brief));
        else sendJson(res, 200, brief);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/items\/([^/]+)$/,
      handle: (_req, res, params) => {
        const id = parseId(params[0]);
        if (id === undefined) return sendJson(res, 400, { ok: false, error: "Bad item id" });
        const item = store.getItem(db, id);
        if (!item) return sendJson(res, 404, { ok: false, error: `No item #${id}` });
        sendJson(res, 200, {
          ...jsonItem(viewItem(db, cfg, item)),
          tasks: store.tasksForItem(db, id),
          events: store.eventsForItem(db, id, 50),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/worktrees\/remove$/,
      handle: async (req, res) => {
        // This destructive local action accepts only the dashboard's token from
        // a loopback origin. A foreign site or DNS-rebound Host cannot invoke it.
        const host = req.headers.host;
        const port = req.socket.localPort;
        const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
        const remote = req.socket.remoteAddress;
        if (!host || !localHosts.includes(host) || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "") ||
            (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site" ||
            req.headers["x-shipboard-worktree-token"] !== worktreeToken ||
            req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
          return sendJson(res, 403, { ok: false, error: "Remove worktrees from the local dashboard. Refresh the page if it was restarted." });
        }
        const body = await readJsonBody(req);
        const path = bodyString(body, "path");
        const expected_head = bodyString(body, "expected_head");
        if (!path || !expected_head) return sendJson(res, 400, { ok: false, error: "Worktree path and displayed commit are required." });
        if (running || removing.has(path)) return sendJson(res, 409, { ok: false, error: "A sync or removal is already in progress. Try again when it finishes." });
        removing.add(path);
        try {
          await removeWorktree(db, cfg, { path, expected_head }, deps.git);
          sendJson(res, 200, { ok: true });
        } finally {
          removing.delete(path);
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/sync$/,
      handle: async (req, res) => {
        const results = await sync(bodyString(await readJsonBody(req), "repo"));
        const errors = results.flatMap((r) => r.errors.map((e) => `${r.repo}: ${e}`));
        sendJson(
          res,
          200,
          errors.length > 0 ? { ok: false, errors, results } : { ok: true, results },
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/tasks\/([^/]+)\/done$/,
      handle: async (req, res, params) => {
        const body = await readJsonBody(req);
        const id = parseId(params[0]);
        if (id === undefined) return sendJson(res, 400, { ok: false, error: "Bad task id" });
        const existing = store.getTask(db, id);
        if (!existing) return sendJson(res, 404, { ok: false, error: `No task ${id}` });
        const task = db.transaction(() => {
          if (existing.kind === "test") assertEvidence(existing.item_id, body);
          const completed = store.completeTask(db, id);
          store.addEvent(db, completed.item_id, "user", `done ${completed.kind}: ${completed.text}`);
          return completed;
        }).immediate();
        sendJson(res, 200, { ok: true, task });
      },
    },
    {
      method: "POST",
      pattern: /^\/items\/([^/]+)\/archive$/,
      handle: (_req, res, params) =>
        mutateItem(res, params, { archived_at: nowIso() }, "archived"),
    },
    {
      method: "POST",
      pattern: /^\/items\/([^/]+)\/deployed$/,
      handle: async (req, res, params) => {
        const body = await readJsonBody(req);
        const id = parseId(params[0]);
        if (id === undefined) return sendJson(res, 400, { ok: false, error: "Bad item id" });
        if (!store.getItem(db, id)) return sendJson(res, 404, { ok: false, error: `No item #${id}` });
        db.transaction(() => {
          assertEvidence(id, body);
          store.updateItem(db, id, { prod_deployed_at: nowIso() });
          store.addEvent(db, id, "user", "deployed to prod");
        }).immediate();
        sendJson(res, 200, { ok: true });
      },
    },
  ];

  const debug = process.env["SHIPBOARD_SERVE_DEBUG"] !== undefined;

  return (req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    if (debug) {
      res.on("finish", () => {
        console.error(
          `${method} ${url.pathname}${url.search} ${res.statusCode} ${Date.now() - started}ms`,
        );
      });
    }
    void (async () => {
      try {
        const matched = routes.filter((r) => r.pattern.test(url.pathname));
        const route = matched.find((r) => r.method === method);
        if (!route) {
          if (matched.length === 0) return sendText(res, 404, `No route for ${url.pathname}`);
          res.setHeader("Allow", matched.map((r) => r.method).join(", "));
          return sendText(res, 405, `${method} not allowed on ${url.pathname}`);
        }
        await route.handle(req, res, route.pattern.exec(url.pathname)?.slice(1) ?? [], url);
      } catch (err) {
        // A bad request must never take the process down.
        const error = err instanceof Error ? err.message : String(err);
        if (!(err instanceof ConfirmationConflict) && !(err instanceof WorktreeRemovalError)) console.error(`shipboard serve: ${method} ${url.pathname}: ${error}`);
        if (res.headersSent) res.end();
        else sendJson(res, err instanceof WorktreeRemovalError ? err.status : err instanceof ConfirmationConflict ? 409 : 500, { ok: false, error });
      }
    })();
  };
}

/** Listen on `opts.port` (0 picks a free one) and report the real URL. */
export async function startServer(
  db: Db,
  cfg: Config,
  opts: ServerOptions = {},
  deps: AppDependencies = {},
): Promise<{ server: http.Server; port: number; url: string }> {
  const host = opts.host ?? DEFAULT_HOST;
  const server = http.createServer(createApp(db, cfg, deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? DEFAULT_PORT);
  return { server, port, url: `http://${host}:${port}` };
}
