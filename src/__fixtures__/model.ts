/** Synthetic cache fixtures. These paths and repositories are never accessed. */
import type { Db } from "../db.js";
import type { Config, ItemRow, PrRow, WorktreeRow } from "../types.js";

export const API = "synthetic/api";
export const WEB = "synthetic/web";
export const OTHER = "synthetic/other";
export const AT = "2026-09-01T10:00:00.000Z";
export const CFG: Config = {
  gating_bots: ["review-bot"], ignored_authors: ["dependency-bot"], projects: [
    { name: "alpha", repos: ["api", "web"].map((name) => ({ owner: "synthetic", name,
      dev_branch: "develop", prod_branch: "main", deploy: "manual", local: `/synthetic/${name}` })) },
    { name: "beta", repos: [{ owner: "synthetic", name: "other", dev_branch: "develop", prod_branch: "main", deploy: "manual" }] },
  ],
};

export function item(over: Partial<ItemRow> = {}): ItemRow {
  return { id: 1, project: "alpha", title: "Restore abandoned work", summary: "Keep an exact resumption point.",
    changes: '["Preserve the worktree"]', linear_key: null, silo: null, repo_order: null, stage_override: null,
    blocked_reason: null, prod_deployed_at: null, prod_deploy_evidence: null,
    created_at: AT, updated_at: AT, archived_at: null, ...over };
}

export function pr(over: Partial<PrRow> = {}): PrRow {
  return { id: 1, item_id: null, repo: API, number: 11, title: "Synthetic change", author: "synthetic-user",
    url: "https://example.invalid/pull/11", head_branch: "feature/resume", base_branch: "develop", head_sha: "head-a",
    state: "OPEN", is_draft: 0, review_round: 1, unresolved_bot_threads: 0, bot_reviews_on_head: 1,
    ci_state: "SUCCESS", merged_at: null, merge_sha: null, in_release_pr: null, on_dev: 0, on_prod: 0,
    deployed_at: null, deploy_ref: null, synced_at: AT, ...over };
}

export function wt(over: Partial<WorktreeRow> = {}): WorktreeRow {
  return { path: "/synthetic/feature work/api", repo: API, branch: "feature/resume", head_sha: "head-a", silo: "shared",
    is_main: 0, ahead_of_dev: 2, unpushed: 0, on_origin: 1, dirty: 0, last_commit_at: AT, seen_at: AT, ...over };
}

export function insertItem(db: Db, over: Partial<ItemRow> = {}): ItemRow {
  const row = item(over);
  db.prepare(`INSERT INTO items (id, project, title, summary, changes, silo, repo_order, stage_override,
    blocked_reason, prod_deployed_at, prod_deploy_evidence, created_at, updated_at, archived_at)
    VALUES (@id, @project, @title, @summary, @changes, @silo, @repo_order, @stage_override,
    @blocked_reason, @prod_deployed_at, @prod_deploy_evidence, @created_at, @updated_at, @archived_at)`).run(row);
  return row;
}

export function insertPr(db: Db, over: Partial<PrRow> = {}): PrRow {
  const row = pr(over);
  db.prepare(`INSERT INTO prs (id, item_id, repo, number, title, author, url, head_branch, base_branch, head_sha,
    state, is_draft, review_round, unresolved_bot_threads, bot_reviews_on_head, ci_state, merged_at, merge_sha,
    in_release_pr, on_dev, on_prod, deployed_at, deploy_ref, synced_at)
    VALUES (@id, @item_id, @repo, @number, @title, @author, @url, @head_branch, @base_branch, @head_sha,
    @state, @is_draft, @review_round, @unresolved_bot_threads, @bot_reviews_on_head, @ci_state, @merged_at, @merge_sha,
    @in_release_pr, @on_dev, @on_prod, @deployed_at, @deploy_ref, @synced_at)`).run(row);
  return row;
}

export function insertWt(db: Db, over: Partial<WorktreeRow> = {}): WorktreeRow {
  const row = wt(over);
  db.prepare(`INSERT INTO worktrees (path, repo, branch, head_sha, silo, is_main, ahead_of_dev, unpushed,
    on_origin, dirty, last_commit_at, seen_at) VALUES (@path, @repo, @branch, @head_sha, @silo, @is_main,
    @ahead_of_dev, @unpushed, @on_origin, @dirty, @last_commit_at, @seen_at)`).run(row);
  return row;
}
