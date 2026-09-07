import { describe, expect, it } from "vitest";
import { captureEvidence } from "../evidence.js";
import {
  ITEM_STAGES,
  type EventRow,
  type ItemRow,
  type ItemStage,
  type PrRow,
  type PrStage,
  type TaskRow,
  type WorktreeRow,
  type WorktreeStage,
} from "../types.js";
import type { ItemView, LsSections, PrView, WorktreeView } from "../views.js";
import { KANBAN_COLUMNS, escapeHtml, renderDrawer, renderPage, type PageOptions } from "./render.js";

const API = "example/API";

function mkPr(p: Partial<PrRow> = {}): PrRow {
  return {
    id: 1,
    item_id: 12,
    repo: API,
    number: 205,
    title: "Add Stripe Connect",
    author: "example",
    url: "https://github.com/example/API/pull/205",
    head_branch: "feature/stripe-connect",
    base_branch: "develop",
    head_sha: "aaaaaaa",
    state: "OPEN",
    is_draft: 0,
    review_round: 1,
    unresolved_bot_threads: 0,
    bot_reviews_on_head: 1,
    ci_state: "SUCCESS",
    merged_at: null,
    merge_sha: null,
    in_release_pr: null,
    on_dev: 0,
    on_prod: 0,
    deployed_at: null,
    deploy_ref: null,
    synced_at: "2026-09-03T00:00:00.000Z",
    ...p,
  };
}

function mkItem(p: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 12,
    project: "example",
    title: "Stripe Connect agents",
    summary: "Let agents onboard to Stripe Connect.",
    changes: JSON.stringify(["Add onboarding endpoint"]),
    linear_key: "PROP-42",
    silo: null,
    repo_order: null,
    stage_override: null,
    blocked_reason: null,
    prod_deployed_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    archived_at: null,
    ...p,
  };
}

function mkView(stage: ItemStage, p: Partial<ItemView> = {}): ItemView {
  const prStage: PrStage = stage === "blocked" ? "needs-addressing" : (stage as PrStage);
  return {
    item: mkItem(),
    stage,
    actor: null,
    prs: [{ pr: mkPr(), stage: prStage }],
    worktrees: [],
    warnings: [],
    ...p,
  };
}

/** Worktree rows are written by sync; the view layer only stages them. */
function mkWt(p: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: "/Users/x/Projects/example-features/sample-feature/API",
    repo: API,
    branch: "feature/sample-feature",
    head_sha: "ccccccc",
    silo: "sample-feature",
    is_main: 0,
    ahead_of_dev: 2,
    unpushed: 2,
    on_origin: 0,
    dirty: 0,
    last_commit_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
    seen_at: "2026-09-03T00:00:00.000Z",
    ...p,
  };
}

function mkWtView(stage: WorktreeStage, wt: Partial<WorktreeRow> = {}, pr?: PrRow): WorktreeView {
  return { wt: mkWt(wt), stage, pr, main_checkout: "/Users/x/Projects/main/API" };
}

const EMPTY: LsSections = {
  items: [],
  unlinked: [],
  release: [],
  worktrees: { untracked: [], housekeeping: [] },
};

function page(sections: Partial<LsSections> = {}, opts: Partial<PageOptions> = {}): string {
  return renderPage({ ...EMPTY, ...sections }, { projects: ["example"], ...opts });
}

/** The slice of `html` between `<h3>heading</h3>` and the next h3 or section end. */
function group(html: string, heading: string): string {
  const tag = `<h3>${heading}</h3>`;
  const start = html.indexOf(tag);
  expect(start, `missing heading ${heading}`).toBeGreaterThan(-1);
  const rest = html.slice(start + tag.length);
  const ends = [rest.indexOf("<h3>"), rest.indexOf("</section>")].filter((i) => i >= 0);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

describe("renderPage", () => {
  it("renders a document with the title and the item's id", () => {
    const html = page({ items: [mkView("needs-addressing", { actor: "agent" })] });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Shipboard</title>");
    expect(html).toContain("#12");
    expect(html).toContain("Stripe Connect agents");
  });

  it("puts agent-actionable items under 'Agent can act' and human ones under 'Needs you'", () => {
    const agent = mkView("needs-addressing", { actor: "agent" });
    const human = mkView("ready-to-merge", {
      actor: "human",
      item: mkItem({ id: 13, title: "Chinese translations" }),
      prs: [{ pr: mkPr({ id: 2, number: 237 }), stage: "ready-to-merge" }],
    });
    const html = page({ items: [agent, human] });
    expect(group(html, "Agent can act")).toContain("Stripe Connect agents");
    expect(group(html, "Agent can act")).not.toContain("Chinese translations");
    expect(group(html, "Needs you")).toContain("Chinese translations");
  });

  it("lists untracked PRs needing action, and nothing else", () => {
    const html = page({
      unlinked: [
        { pr: mkPr({ id: 3, number: 237, item_id: null, unresolved_bot_threads: 3 }), stage: "needs-addressing" },
        { pr: mkPr({ id: 4, number: 240, item_id: null }), stage: "awaiting-review" },
      ],
    });
    const attention = group(html, "Untracked PRs needing action");
    expect(attention).toContain("API#237");
    expect(attention).not.toContain("API#240");
    // The full listing below the board still shows both.
    expect(html).toContain("Untracked open PRs");
    expect(html).toContain("API#240");
  });

  it("says so calmly when nothing needs attention", () => {
    expect(page()).toContain("Nothing needs attention.");
  });

  it("renders every kanban column title", () => {
    const html = page({ items: [mkView("drafting")] });
    for (const col of KANBAN_COLUMNS) expect(html).toContain(`<h3>${col.title}</h3>`);
  });

  it("shows blocked items with a red blocked badge", () => {
    const blocked = mkView("blocked", {
      actor: "human",
      item: mkItem({ blocked_reason: "waiting on Stripe support" }),
    });
    const html = page({ items: [blocked] });
    expect(html).toContain('<span class="badge s-blocked">blocked</span>');
    expect(html).toContain("waiting on Stripe support");
  });

  it("shows unresolved thread counts and merge-order warnings", () => {
    const v = mkView("needs-addressing", {
      actor: "agent",
      prs: [{ pr: mkPr({ unresolved_bot_threads: 11 }), stage: "needs-addressing" }],
      warnings: ["web#359 is ready to merge but API#205 must merge first"],
    });
    const html = page({ items: [v] });
    expect(html).toContain("API#205 (11)");
    expect(html).toContain("needs-addressing (11)");
    expect(html).toContain("! web#359 is ready to merge but API#205 must merge first");
  });

  it("escapes dynamic text", () => {
    const html = page({ items: [mkView("drafting", { item: mkItem({ title: "<script>alert(1)</script>" }) })] });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("marks the current project selected in the filter", () => {
    const html = page({}, { projects: ["example", "sideproject"], project: "example" });
    expect(html).toContain('<option value="example" selected>example</option>');
    expect(html).toContain('<option value="sideproject">sideproject</option>');
    expect(html).toContain('<option value="">All projects</option>');
  });

  it("reports the sync age", () => {
    expect(page()).toContain("never synced");
    expect(page({}, { syncedAt: new Date(Date.now() - 3 * 60_000).toISOString() })).toContain("synced 3m ago");
  });

  it("does not let a fresh repository hide another source's failure", () => {
    const now = new Date().toISOString();
    const html = page({}, { syncedAt: now, health: [
      { repo: "synthetic/fresh", source: "github", status: "healthy", last_attempt_at: now, last_success_at: now, errors: [] },
      { repo: "synthetic/stale", source: "worktrees", status: "failed", last_attempt_at: now, last_success_at: null, errors: ["unreadable <path>"] },
    ] });
    expect(html).toContain("1 sources need checking");
    expect(html).not.toContain("All sources fresh");
    expect(html).toContain("synthetic/stale");
    expect(html).toContain("unreadable &lt;path&gt;");
    expect(html).toContain('<details id="sync-health" open>');
  });

  it("surfaces a draft item's CI failure in the ranked moves and attention", () => {
    const v = mkView("drafting", { actor: null, prs: [{ pr: mkPr({ is_draft: 1, ci_state: "FAILURE" }), stage: "drafting" }] });
    const html = page({ items: [v] });
    expect(html).toContain("Your next three moves");
    expect(group(html, "Agent can act")).toContain("Investigate failing CI");
  });
});

describe("KANBAN_COLUMNS", () => {
  it("covers every item stage exactly once, except blocked", () => {
    const seen = new Map<string, number>();
    for (const col of KANBAN_COLUMNS) {
      for (const s of col.stages) seen.set(s, (seen.get(s) ?? 0) + 1);
    }
    for (const stage of ITEM_STAGES) {
      expect(seen.get(stage) ?? 0, stage).toBe(stage === "blocked" ? 0 : 1);
    }
    expect(seen.size).toBe(ITEM_STAGES.length - 1);
  });
});

describe("renderDrawer", () => {
  const tasks: TaskRow[] = [
    { id: 1, item_id: 12, kind: "test", text: "test on dev", created_at: "2026-09-01T00:00:00.000Z", done_at: "2026-09-02T00:00:00.000Z" },
    { id: 2, item_id: 12, kind: "flag", text: "flip stripe_connect flag", created_at: "2026-09-01T00:00:00.000Z", done_at: null },
  ];
  const events: EventRow[] = [
    { id: 1, item_id: 12, at: "2026-09-01T00:00:00.000Z", source: "sync", text: "older event" },
    { id: 2, item_id: 12, at: "2026-09-03T00:00:00.000Z", source: "hook", text: "newer event" },
  ];

  it("renders the header, meta and changes", () => {
    const html = renderDrawer(mkView("needs-addressing", { actor: "agent" }), [], []);
    expect(html).toContain("#12");
    expect(html).toContain("Stripe Connect agents");
    expect(html).toContain("PROP-42");
    expect(html).toContain("Add onboarding endpoint");
    expect(html).toContain("API#205");
  });

  it("offers Done for open tasks and reconfirmation for stale completed tests", () => {
    const html = renderDrawer(mkView("needs-testing", { actor: "human" }), tasks, []);
    expect(html).toContain("[x]");
    expect(html).toContain("[ ]");
    expect(html).toContain('data-task-done="2"');
    expect(html).toContain('data-task-done="1"');
    expect(html).toContain("Confirm retest");
    expect(html).toContain("Previous result does not cover current commits");
  });

  it("keeps a current test confirmation complete and exposes the resume briefing", () => {
    const view = mkView("needs-release");
    const current = tasks.map((t) => ({ ...t, completion_evidence: captureEvidence(view.prs.map((p) => p.pr)) }));
    const html = renderDrawer(view, current, []);
    expect(html).not.toContain('data-task-done="1"');
    expect(html).toContain("Resume briefing");
    expect(html).toContain("/api/items/12/resume?format=text");
  });

  it("offers 'Mark deployed to prod' only in needs-prod-deploy", () => {
    expect(renderDrawer(mkView("needs-prod-deploy", { actor: "human" }), [], [])).toContain('data-deployed="12"');
    expect(renderDrawer(mkView("needs-testing", { actor: "human" }), [], [])).not.toContain("data-deployed");
  });

  it("always offers Archive", () => {
    expect(renderDrawer(mkView("done"), [], [])).toContain('data-archive="12"');
  });

  it("orders the timeline newest first", () => {
    const html = renderDrawer(mkView("done"), [], events);
    expect(html.indexOf("newer event")).toBeLessThan(html.indexOf("older event"));
  });

  it("escapes event text and blocked reasons", () => {
    const view = mkView("blocked", { item: mkItem({ blocked_reason: "<b>nope</b>" }) });
    const html = renderDrawer(view, [], [
      { id: 3, item_id: 12, at: "2026-09-03T00:00:00.000Z", source: "user", text: "<img src=x>" },
    ]);
    expect(html).toContain("&lt;b&gt;nope&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five dangerous characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("Linear links", () => {
  const WS = "example";
  const URL = "https://linear.app/example/issue/PROP-42";

  it("links the drawer's Linear key when a workspace is configured", () => {
    const html = renderDrawer(mkView("needs-addressing", { actor: "agent" }), [], [], {
      linearWorkspace: WS,
    });
    expect(html).toContain(`<a href="${URL}" target="_blank" rel="noreferrer">PROP-42</a>`);
  });

  it("leaves the key as plain text without a workspace", () => {
    const html = renderDrawer(mkView("needs-addressing", { actor: "agent" }), [], []);
    expect(html).toContain("PROP-42");
    expect(html).not.toContain("linear.app");
  });

  it("chips the key on attention rows and cards, linking out when it can", () => {
    const v = mkView("needs-addressing", { actor: "agent" });
    const linked = page({ items: [v] }, { linearWorkspace: WS });
    // Once in the attention row, once on the board card.
    expect(linked.split(`<a class="chip" href="${URL}"`).length - 1).toBe(2);

    const plain = page({ items: [v] });
    expect(plain).toContain('<span class="chip">PROP-42</span>');
    expect(plain).not.toContain("linear.app");
  });

  it("omits the chip for an item with no Linear key", () => {
    const v = mkView("needs-addressing", { actor: "agent", item: mkItem({ linear_key: null }) });
    expect(page({ items: [v] }, { linearWorkspace: WS })).not.toContain("PROP-42");
  });

  it("escapes a hostile key in both the href and the text", () => {
    const v = mkView("drafting", { item: mkItem({ linear_key: 'A"><b>' }) });
    const html = page({ items: [v] }, { linearWorkspace: WS });
    expect(html).toContain(
      '<a class="chip" href="https://linear.app/example/issue/A&quot;&gt;&lt;b&gt;"',
    );
    expect(html).toContain(">A&quot;&gt;&lt;b&gt;</a>");
    expect(html).not.toContain("<b>");
  });
});

describe("shipped column", () => {
  it("shows the OTA ship time with the update group as its tooltip", () => {
    const shipped = mkPr({
      state: "MERGED",
      merged_at: "2026-08-31T00:00:00.000Z",
      merge_sha: "bbbbbbb",
      on_dev: 1,
      on_prod: 1,
      deployed_at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
      deploy_ref: "1b2c3d4e-ota",
    });
    const html = renderDrawer(
      mkView("merged-main", { prs: [{ pr: shipped, stage: "merged-main" }] }),
      [],
      [],
    );
    expect(html).toContain("<th>Shipped</th>");
    expect(html).toContain('<span title="1b2c3d4e-ota">✓ 3d ago</span>');
  });

  it("dashes the column for a PR nothing has shipped", () => {
    const html = renderDrawer(mkView("needs-addressing", { actor: "agent" }), [], []);
    expect(html).toContain("<th>Shipped</th>");
    expect(html).toContain("<td>–</td>");
  });
});

describe("worktrees", () => {
  it("gives local branches their own first column", () => {
    const html = page({ items: [mkView("local-only")] });
    expect(html).toContain("<h3>Local</h3>");
    expect(KANBAN_COLUMNS[0]?.title).toBe("Local");
    // The Local column is the one holding the card.
    const local = html.slice(html.indexOf("<h3>Local</h3>"), html.indexOf("<h3>Drafting</h3>"));
    expect(local).toContain("Stripe Connect agents");
  });

  it("lists a card's PR-less worktrees under its PRs", () => {
    const v = mkView("local-only", {
      prs: [],
      worktrees: [mkWtView("local-only")],
    });
    expect(page({ items: [v] })).toContain("API ⎇ feature/sample-feature local-only (2 unpushed)");
  });

  it("counts a pushed branch by how far it is ahead, not by unpushed", () => {
    const v = mkView("needs-pr", {
      prs: [],
      worktrees: [mkWtView("needs-pr", { unpushed: 0, ahead_of_dev: 3, on_origin: 1 })],
    });
    expect(page({ items: [v] })).toContain("API ⎇ feature/sample-feature needs-pr (3 ahead)");
  });

  it("leaves a worktree that already has a PR off the card", () => {
    const v = mkView("awaiting-review", {
      worktrees: [mkWtView("has-pr", {}, mkPr())],
    });
    expect(page({ items: [v] })).not.toContain("⎇");
  });

  it("groups forgotten local work by silo, with counts and age", () => {
    const html = page({
      worktrees: {
        untracked: [
          mkWtView("local-only"),
          mkWtView("local-only", {
            path: "/Users/x/Projects/example-features/agent-analytics/API",
            branch: "feature/analytics",
            silo: "agent-analytics",
            unpushed: 1,
            last_commit_at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
          }),
        ],
        housekeeping: [],
      },
    });
    const forgotten = group(html, "Forgotten local work");
    expect(forgotten).toContain('<span class="silo">sample-feature</span>');
    expect(forgotten).toContain("API ⎇ feature/sample-feature");
    expect(forgotten).toContain("· 2 unpushed · 1d ago");
    expect(forgotten).toContain('<span class="silo">agent-analytics</span>');
    expect(forgotten).toContain("· 1 unpushed · 3d ago");
    // Nothing to open: these rows are not clickable, and the hint says what to do.
    expect(forgotten).not.toContain("data-item");
    expect(html).toContain("Create item:");
  });

  it("surfaces needs-pr worktrees in the attention queue", () => {
    const html = page({
      worktrees: { untracked: [mkWtView("needs-pr", { on_origin: 1 })], housekeeping: [] },
    });
    expect(html).not.toContain("Nothing needs attention.");
    expect(html).toContain("Prepare a PR:");
  });

  it("lists every untracked worktree, needs-pr included, below the board", () => {
    const html = page({
      worktrees: { untracked: [mkWtView("needs-pr", { on_origin: 1 })], housekeeping: [] },
    });
    expect(html).toContain("Untracked worktrees");
    const section = html.slice(html.indexOf('id="untracked-worktrees"'));
    expect(section).toContain("needs-pr");
  });

  it("prints the removal command for worktrees to clean up", () => {
    const html = page({
      worktrees: {
        untracked: [],
        housekeeping: [
          mkWtView(
            "merged",
            {
              path: "/Users/x/Projects/example-features/crm-signup-link/API",
              branch: "feature/crm-signup-link",
              silo: "crm-signup-link",
              ahead_of_dev: 0,
              unpushed: 0,
              on_origin: 1,
            },
            mkPr({ number: 303, state: "MERGED" }),
          ),
        ],
      },
    });
    expect(html).toContain("Worktrees to clean up");
    expect(html).toContain("merged (PR #303)");
    expect(html).toContain(
      "<code>git -C &#39;/Users/x/Projects/main/API&#39; worktree remove -- &#39;/Users/x/Projects/example-features/crm-signup-link/API&#39;</code>",
    );
    expect(html).toContain("Remove worktree</button>");
    expect(html).toContain('data-worktree-remove="/Users/x/Projects/example-features/crm-signup-link/API"');
  });

  it("shows unavailable local observations without negative counts", () => {
    const view = mkWtView("unknown", { ahead_of_dev: -1, unpushed: -1, dirty: -1 });
    const html = renderDrawer(mkView("drafting", { worktrees: [view] }), [], []);
    expect(html).toContain("unknown");
    expect(html).not.toContain("<td>-1</td>");
    expect(html).toContain("Check local state:");
  });

  it("tabulates the item's worktrees in the drawer", () => {
    const html = renderDrawer(
      mkView("local-only", { prs: [], worktrees: [mkWtView("local-only", { dirty: 1 })] }),
      [],
      [],
    );
    expect(html).toContain("<h3>Worktrees</h3>");
    expect(html).toContain("<th>Unpushed</th>");
    expect(html).toContain('<span class="badge s-agent">local-only</span>');
    expect(html).toContain("feature/sample-feature");
    expect(html).toContain(
      "<code>/Users/x/Projects/example-features/sample-feature/API</code>",
    );
    // dirty ✓, last commit a day ago
    expect(html).toContain("<td>✓</td>");
    expect(html).toContain("<td>1d ago</td>");
  });

  it("omits the drawer's worktree table when there are none", () => {
    expect(renderDrawer(mkView("drafting"), [], [])).not.toContain("<h3>Worktrees</h3>");
  });

  it("escapes worktree paths and branches", () => {
    const html = page({
      worktrees: {
        untracked: [],
        housekeeping: [mkWtView("empty", { path: "/tmp/<script>", branch: "feature/<b>" })],
      },
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("/tmp/<script>");
  });
});
