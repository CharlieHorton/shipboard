/** Commit-bound human confirmations. Pure helpers; legacy timestamps are not evidence. */
import type { ItemRow, PrRow, TaskRow } from "./types.js";

/**
 * Capture the complete active PR set. Unknown commits cannot be certified.
 * Sorted, versioned JSON keeps evidence stable across query ordering and syncs.
 */
export function captureEvidence(prs: PrRow[]): string | null {
  const active = prs.filter((pr) => pr.state !== "CLOSED");
  if (active.length === 0 || active.some((pr) =>
    !pr.head_sha.trim() || (pr.state === "MERGED" && !pr.merge_sha?.trim()),
  )) return null;
  const commits = active.map((pr) => ({
    repo: pr.repo,
    number: pr.number,
    head_sha: pr.head_sha,
    merge_sha: pr.merge_sha,
  })).sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  return JSON.stringify({ version: 1, commits });
}

/** Exact set equality also invalidates evidence when PRs are linked or removed. */
export function evidenceMatches(evidence: string | null | undefined, prs: PrRow[]): boolean {
  if (!evidence) return false;
  const current = captureEvidence(prs);
  return current !== null && current === evidence;
}

/** Every requested test must have passed against the current set of commits. */
export function testsPassForCurrentPrs(tasks: TaskRow[], prs: PrRow[]): boolean {
  const tests = tasks.filter((task) => task.kind === "test");
  return tests.length > 0 && tests.every((task) =>
    Boolean(task.done_at) && evidenceMatches(task.completion_evidence, prs),
  );
}

export function manualDeployCoversCurrentPrs(item: ItemRow, prs: PrRow[]): boolean {
  return Boolean(item.prod_deployed_at) && evidenceMatches(item.prod_deploy_evidence, prs);
}
