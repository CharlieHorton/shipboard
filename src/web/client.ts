/**
 * The page's entire client script, inlined at the end of the body by render.ts.
 * Event delegation over `data-` attributes only — no inline handlers, so no
 * dynamic text ever reaches a JS parser.
 *
 * Contract with src/server.ts:
 *   GET  /item/:id            -> drawer HTML fragment
 *   POST /sync                -> { ok, results }        then reload
 *   POST /tasks/:id/done      -> { ok }                 then re-fetch drawer
 *   POST /items/:id/archive   -> { ok }                 then close + reload
 *   POST /items/:id/deployed  -> { ok }                 then re-fetch drawer
 */
export const CLIENT_JS = `
(function () {
  var drawer = document.getElementById("drawer");
  var body = document.getElementById("drawer-body");
  var backdrop = document.getElementById("backdrop");
  var current = null;
  var requestVersion = 0;
  var boardChanged = false;
  var errorBox = document.getElementById("request-error");
  var tokenElement = document.getElementById("worktree-token");
  var worktreeToken = tokenElement ? tokenElement.getAttribute("content") : "";

  function showError(error) {
    errorBox.textContent = error.message || "Request failed. Try again.";
    errorBox.hidden = false;
  }

  function fetchDrawer(id) {
    var version = ++requestVersion;
    return fetch("/item/" + encodeURIComponent(id))
      .then(function (r) { if (!r.ok) throw new Error("Could not load item (HTTP " + r.status + ")."); return r.text(); })
      .then(function (html) { if (current === id && version === requestVersion) body.innerHTML = html; })
      .catch(function (error) { if (current === id && version === requestVersion) showError(error); });
  }
  function openDrawer(id) {
    current = id;
    drawer.hidden = false;
    backdrop.hidden = false;
    if (location.hash !== "#item-" + id) history.pushState(null, "", "#item-" + id);
    body.textContent = "Loading…";
    errorBox.hidden = true;
    fetchDrawer(id).catch(showError);
  }
  function closeDrawer() {
    if (current === null) return;
    current = null;
    drawer.hidden = true;
    backdrop.hidden = true;
    body.innerHTML = "";
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (boardChanged) location.reload();
  }
  function post(url, evidence, payload) {
    errorBox.hidden = true;
    var options = { method: "POST" };
    if (payload) {
      options.headers = { "Content-Type": "application/json", "X-Shipboard-Worktree-Token": worktreeToken };
      options.body = JSON.stringify(payload);
    } else if (evidence !== null && evidence !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify({ expected_evidence: evidence });
    }
    return fetch(url, options).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || data.ok !== true) throw new Error(data.error || (data.errors || []).join("; ") || "Request failed (HTTP " + r.status + ").");
        return data;
      });
    });
  }
  function mutate(el, url, archive) {
    var itemAtStart = current;
    el.disabled = true;
    post(url, el.getAttribute("data-evidence")).then(function () {
      boardChanged = true;
      if (archive && current === itemAtStart && current !== null) { closeDrawer(); return; }
      if (current !== null) return fetchDrawer(current);
      location.reload();
    }).catch(showError).finally(function () { el.disabled = false; });
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest("[data-item],[data-close],[data-task-done],[data-archive],[data-deployed],[data-worktree-remove]");
    if (!el) return;
    if (el.hasAttribute("data-worktree-remove")) {
      var path = el.getAttribute("data-worktree-remove");
      if (!confirm("Remove this worktree?\\n\\n" + path + "\\n\\nThis deletes the checkout folder, including ignored files. The branch is kept. Local changes are checked again; force removal is never used.")) return;
      el.disabled = true;
      post("/worktrees/remove", null, { path: path, expected_head: el.getAttribute("data-worktree-head") })
        .then(function () { location.reload(); })
        .catch(showError)
        .finally(function () { el.disabled = false; });
      return;
    }
    if (el.hasAttribute("data-close")) { closeDrawer(); return; }
    if (el.hasAttribute("data-task-done")) {
      mutate(el, "/tasks/" + el.getAttribute("data-task-done") + "/done", false);
      return;
    }
    if (el.hasAttribute("data-deployed")) {
      mutate(el, "/items/" + el.getAttribute("data-deployed") + "/deployed", false);
      return;
    }
    if (el.hasAttribute("data-archive")) {
      if (!confirm("Archive this item?")) return;
      mutate(el, "/items/" + el.getAttribute("data-archive") + "/archive", true);
      return;
    }
    openDrawer(el.getAttribute("data-item"));
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeDrawer(); return; }
    var a = document.activeElement;
    if (e.key === "Enter" && a && a.hasAttribute && a.hasAttribute("data-item")) {
      e.preventDefault();
      openDrawer(a.getAttribute("data-item"));
    }
  });

  var filter = document.getElementById("project-filter");
  filter.addEventListener("change", function () {
    location.href = filter.value ? "/?project=" + encodeURIComponent(filter.value) : "/";
  });

  var sync = document.getElementById("sync-btn");
  sync.addEventListener("click", function () {
    sync.disabled = true;
    sync.textContent = "Syncing…";
    post("/sync").then(
      function () { location.reload(); },
      function (error) { showError(error); sync.disabled = false; sync.textContent = "Sync"; }
    );
  });

  function fromHash() {
    var m = /^#item-(\\d+)$/.exec(location.hash);
    if (m) openDrawer(m[1]); else closeDrawer();
  }
  window.addEventListener("popstate", fromHash);
  fromHash();

  setInterval(function () {
    if (drawer.hidden) location.reload();
    else if (current !== null) fetchDrawer(current).catch(showError);
  }, 120000);
})();
`;
