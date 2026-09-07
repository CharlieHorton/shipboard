import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { CLIENT_JS } from "./client.js";

type Handler = (event: Record<string, unknown>) => void;

class FakeElement {
  hidden = true;
  disabled = false;
  value = "";
  private content = "";
  readonly events: Record<string, Handler> = {};
  constructor(readonly attributes: Record<string, string> = {}) {}
  get textContent() { return this.content; }
  set textContent(value: string) { this.content = value; }
  get innerHTML() { return this.content; }
  set innerHTML(value: string) { this.content = value; }
  addEventListener(name: string, handler: Handler) { this.events[name] = handler; }
  hasAttribute(name: string) { return name in this.attributes; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  closest() { return this; }
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
  text(): Promise<string>;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The client runs unmodified; every external browser capability is an inert fake. */
function harness() {
  const ids = ["drawer", "drawer-body", "backdrop", "request-error", "project-filter", "sync-btn"];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["worktree-token"] = new FakeElement({ content: "fixture-token" });
  const documentEvents: Record<string, Handler> = {};
  const windowEvents: Record<string, Handler> = {};
  const requests: { url: string; method: string; options: RequestOptions | undefined; resolve: (response: FakeResponse) => void }[] = [];
  const fetch = vi.fn((url: string, options?: RequestOptions) => new Promise<FakeResponse>((resolve) => {
    requests.push({ url, method: options?.method ?? "GET", options, resolve });
  }));
  const location = { hash: "", pathname: "/", search: "", href: "/", reload: vi.fn() };
  const history = {
    pushState: vi.fn((_state: unknown, _title: string, url: string) => { location.hash = url; }),
    replaceState: vi.fn(() => { location.hash = ""; }),
  };
  const confirm = vi.fn((_message: string) => true);
  runInNewContext(CLIENT_JS, {
    document: {
      getElementById: (id: string) => elements[id],
      addEventListener: (name: string, handler: Handler) => { documentEvents[name] = handler; },
    },
    window: { addEventListener: (name: string, handler: Handler) => { windowEvents[name] = handler; } },
    location, history, confirm, fetch,
    setInterval: vi.fn(),
  });
  function click(attribute: string, value = "", attributes: Record<string, string> = {}) {
    const button = new FakeElement({ [attribute]: value, ...attributes });
    documentEvents["click"]!({ target: button });
    return button;
  }
  function respond(index: number, { status = 200, data = { ok: true }, html = "" }:
    { status?: number; data?: Record<string, unknown>; html?: string } = {}) {
    requests[index]!.resolve({ ok: status >= 200 && status < 300, status,
      json: async () => data, text: async () => html });
  }
  return { element: (id: string) => elements[id]!, click, respond, requests, location, confirm };
}

/** Drain the promise chain without real network calls, polling, or browser timers. */
const settle = () => setImmediate();

describe("worktree removal confirmation", () => {
  const path = "/synthetic/worktrees/feature with spaces";
  const head = "observed-worktree-head";

  it("canceling the removal explanation makes no request", () => {
    const h = harness();
    h.confirm.mockReturnValue(false);
    const button = h.click("data-worktree-remove", path, { "data-worktree-head": head });
    expect(h.confirm).toHaveBeenCalledOnce();
    const explanation = h.confirm.mock.calls[0]![0];
    expect(explanation).toContain("\n\n" + path + "\n\n");
    expect(explanation).toContain("including ignored files");
    expect(explanation).toContain("The branch is kept.");
    expect(h.requests).toHaveLength(0);
    expect(button.disabled).toBe(false);
    expect(h.location.reload).not.toHaveBeenCalled();
  });

  it("confirmed removal sends the displayed path, head and page token, then reloads on success", async () => {
    const h = harness();
    const button = h.click("data-worktree-remove", path, { "data-worktree-head": head });
    expect(button.disabled).toBe(true);
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0]!;
    expect(request.url).toBe("/worktrees/remove");
    expect(request.method).toBe("POST");
    expect(request.options?.headers).toEqual({
      "Content-Type": "application/json", "X-Shipboard-Worktree-Token": "fixture-token",
    });
    expect(JSON.parse(request.options!.body!)).toEqual({ path, expected_head: head });
    expect(h.location.reload).not.toHaveBeenCalled();
    h.respond(0);
    await settle();
    expect(h.location.reload).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);
    expect(h.element("request-error").hidden).toBe(true);
  });

  it.each([409, 500])("HTTP %s leaves the page intact, shows the removal error and enables retry", async (status) => {
    const h = harness();
    const button = h.click("data-worktree-remove", path, { "data-worktree-head": head });
    expect(button.disabled).toBe(true);
    h.respond(0, { status, data: { ok: false, error: "Worktree changed; inspect it before trying again." } });
    await settle();
    expect(button.disabled).toBe(false);
    expect(h.element("request-error").hidden).toBe(false);
    expect(h.element("request-error").textContent).toBe("Worktree changed; inspect it before trying again.");
    expect(h.location.reload).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
  });
});

describe("dashboard client failure handling", () => {
  it.each([
    ["data-task-done", "42", "/tasks/42/done"],
    ["data-deployed", "7", "/items/7/deployed"],
  ])("%s sends the exact displayed commit fingerprint", async (attribute, id, url) => {
    const h = harness();
    const fingerprint = '{"version":1,"commits":[{"repo":"example/app","number":1,"head_sha":"observed-head","merge_sha":"observed-merge"}]}';
    h.click("data-item", "7");
    h.respond(0, { html: "Observed revision" });
    await settle();
    h.click(attribute!, id!, { "data-evidence": fingerprint });
    const request = h.requests[1]!;
    expect(request.url).toBe(url);
    expect(request.method).toBe("POST");
    expect(request.options?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(request.options!.body!)).toEqual({ expected_evidence: fingerprint });
  });

  it("a stale-evidence conflict keeps the task pending and shows the server explanation", async () => {
    const h = harness();
    h.click("data-item", "7");
    h.respond(0, { html: "Test task pending" });
    await settle();
    const button = h.click("data-task-done", "42", { "data-evidence": "previous-fingerprint" });
    h.respond(1, { status: 409, data: { ok: false, error: "Linked commits changed. Refresh and verify them before confirming." } });
    await settle();
    expect(h.element("drawer-body").innerHTML).toBe("Test task pending");
    expect(h.element("request-error").hidden).toBe(false);
    expect(h.element("request-error").textContent).toBe("Linked commits changed. Refresh and verify them before confirming.");
    expect(button.disabled).toBe(false);
    expect(h.requests).toHaveLength(2);
    h.click("data-close");
    expect(h.location.reload).not.toHaveBeenCalled();
  });

  it("shows partial sync errors from HTTP 200 without reloading and enables retry", async () => {
    const h = harness();
    const sync = h.element("sync-btn");
    sync.events["click"]!({});
    expect(sync.disabled).toBe(true);
    expect(sync.textContent).toBe("Syncing…");
    expect(h.requests.map(({ url, method }) => ({ url, method }))).toEqual([{ url: "/sync", method: "POST" }]);

    h.respond(0, { data: { ok: false, errors: ["example/app: permission denied", "example/site: timed out"] } });
    await settle();

    expect(h.element("request-error").hidden).toBe(false);
    expect(h.element("request-error").textContent).toBe("example/app: permission denied; example/site: timed out");
    expect(h.location.reload).not.toHaveBeenCalled();
    expect(sync.disabled).toBe(false);
    expect(sync.textContent).toBe("Sync");
  });

  it("a failed task completion leaves the drawer intact and does not mark the board changed", async () => {
    const h = harness();
    h.click("data-item", "7");
    h.respond(0, { html: "Original task is still pending" });
    await settle();

    const button = h.click("data-task-done", "42");
    expect(button.disabled).toBe(true);
    expect(h.requests[1]!.url).toBe("/tasks/42/done");
    h.respond(1, { status: 500, data: { ok: false, error: "Could not save task" } });
    await settle();

    expect(button.disabled).toBe(false);
    expect(h.element("request-error").textContent).toBe("Could not save task");
    expect(h.element("request-error").hidden).toBe(false);
    expect(h.element("drawer-body").innerHTML).toBe("Original task is still pending");
    expect(h.element("drawer").hidden).toBe(false);
    expect(h.requests).toHaveLength(2);
    expect(h.location.reload).not.toHaveBeenCalled();
    h.click("data-close");
    expect(h.location.reload).not.toHaveBeenCalled();
  });

  it("a failed archive neither closes the drawer nor reloads the page", async () => {
    const h = harness();
    h.click("data-item", "7");
    h.respond(0, { html: "Item seven" });
    await settle();
    const button = h.click("data-archive", "7");
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.requests[1]!.url).toBe("/items/7/archive");
    h.respond(1, { status: 409, data: { error: "Archive could not be saved" } });
    await settle();

    expect(button.disabled).toBe(false);
    expect(h.element("request-error").textContent).toBe("Archive could not be saved");
    expect(h.element("request-error").hidden).toBe(false);
    expect(h.element("drawer").hidden).toBe(false);
    expect(h.element("backdrop").hidden).toBe(false);
    expect(h.element("drawer-body").innerHTML).toBe("Item seven");
    expect(h.location.hash).toBe("#item-7");
    expect(h.location.reload).not.toHaveBeenCalled();
  });
});

describe("drawer response ordering", () => {
  it("an old drawer error does not pollute the newly selected drawer", async () => {
    const h = harness();
    h.click("data-item", "1");
    h.click("data-item", "2");
    h.respond(1, { html: "Current item two" });
    await settle();
    h.respond(0, { status: 500 });
    await settle();
    expect(h.element("drawer-body").innerHTML).toBe("Current item two");
    expect(h.element("request-error").hidden).toBe(true);
    expect(h.location.hash).toBe("#item-2");
  });

  it("an old error is ignored even after returning to the same item", async () => {
    const h = harness();
    h.click("data-item", "1");
    h.click("data-item", "2");
    h.click("data-item", "1");
    h.respond(2, { html: "Current item one" });
    await settle();
    h.respond(0, { status: 500 });
    h.respond(1, { status: 404 });
    await settle();
    expect(h.element("drawer-body").innerHTML).toBe("Current item one");
    expect(h.element("request-error").hidden).toBe(true);
  });

  it("a successful archive does not close a different item selected while it was pending", async () => {
    const h = harness();
    h.click("data-item", "1");
    h.respond(0, { html: "Item one" });
    await settle();
    const button = h.click("data-archive", "1");
    h.click("data-item", "2");
    h.respond(2, { html: "Item two" });
    await settle();
    h.respond(1);
    await settle();
    expect(h.element("drawer").hidden).toBe(false);
    expect(h.element("backdrop").hidden).toBe(false);
    expect(h.location.hash).toBe("#item-2");
    expect(h.location.reload).not.toHaveBeenCalled();
    expect(h.requests[3]!.url).toBe("/item/2");
    h.respond(3, { html: "Refreshed item two" });
    await settle();
    expect(button.disabled).toBe(false);
    expect(h.element("drawer-body").innerHTML).toBe("Refreshed item two");
    h.click("data-close");
    expect(h.location.reload).toHaveBeenCalledOnce();
  });

  it("an older item response cannot replace the newer selected item", async () => {
    const h = harness();
    h.click("data-item", "1");
    h.click("data-item", "2");
    h.respond(1, { html: "Latest: item two" });
    await settle();
    h.respond(0, { html: "Stale: item one" });
    await settle();
    expect(h.element("drawer-body").innerHTML).toBe("Latest: item two");
    expect(h.location.hash).toBe("#item-2");
  });

  it("an older response cannot replace a newer response after returning to the same item", async () => {
    const h = harness();
    h.click("data-item", "1");
    h.click("data-item", "2");
    h.click("data-item", "1");
    h.respond(2, { html: "Latest item one" });
    await settle();
    h.respond(0, { html: "Old item one" });
    h.respond(1, { html: "Old item two" });
    await settle();
    expect(h.element("drawer-body").innerHTML).toBe("Latest item one");
  });

  it("a response arriving after close cannot repopulate the hidden drawer", async () => {
    const h = harness();
    h.click("data-item", "1");
    h.click("data-close");
    h.respond(0, { html: "Late response" });
    await settle();
    expect(h.element("drawer").hidden).toBe(true);
    expect(h.element("drawer-body").innerHTML).toBe("");
  });
});
