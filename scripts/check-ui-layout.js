// Run with Playwright CLI against `npm run dev:web`:
// mkdir -p output/playwright
// playwright-cli open http://localhost:5173
// playwright-cli run-code "$(cat scripts/check-ui-layout.js)"
// All API traffic is intercepted, including writes. No Orca state is changed.
async (page) => {
  const base = page.url().split("/").slice(0, 3).join("/");
  const runId = "run_layout_check";
  const now = "2026-09-24T09:00:00Z";
  const result = { decision: "Keep history", environment: { database: "isolated", validated: false }, count: 0, unknownField: "<script>literal</script>" };
  const nodes = ["completed", "dispatched", "blocked", "ready", "pending", "failed"].map((status, index) => ({
    id: `task_${index}`, label: ["Review results / 验收结果", "Implement readable worker records / 执行记录可读化", "Approve rollout / 审核发布"][index] || `Stage ${index}`,
    status, spec: "Check the information hierarchy and preserve exact runtime evidence.", result: index === 0 ? JSON.stringify(result) : null,
    createdAt: now, completedAt: index === 0 ? now : null, dispatchId: null, assigneeHandle: null, parentId: null,
  }));
  const worker = { taskId: "task_1", runId, dispatchId: "dispatch_very_long_exact_identifier_123456789", workerState: "supervised", dispatchStatus: "active", terminalState: "release_pending", agentTerminalHandle: null,
    projection: { outcome: null, host: { kind: "local", id: "local" }, provider: { model: "example-model" }, liveness: { verdict: "unverifiable", reason: "missing_status" }, attention: { requiresAction: true, categories: ["unverifiable"] } } };
  const status = { running: false, phase: "idle", runId, attempts: [], busy: 0, maxConcurrency: null, error: null, startedAt: 0, lastTick: 0, lastReconciledAt: 0, completedAt: null, coordinatorHandle: null, inbox: { pending: [], recent: [] }, cleanupDebt: [], unownedDispatches: [], recovery: null, lastStopReport: null };
  const gates = [{ id: "gate_layout", taskId: "task_2", question: "Approve rollout after review? / 是否批准发布？", options: ["approve", "reject"], status: "pending", resolution: null }];
  const errors = [];
  const unexpected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.unroute("**/api/**");
  await page.route("**/api/**", async (route) => {
    const path = "/" + route.request().url().split("/").slice(3).join("/").split("?")[0];
    if (path === "/api/activity/stream") return route.fulfill({ contentType: "text/event-stream", body: "" });
    let data;
    if (route.request().method() !== "GET") {
      if (path !== "/api/config") unexpected.push(path);
      data = {};
    } else if (path === "/api/config") data = { runId, defaultHarness: "claude", maxConcurrency: 4 };
    else if (path === "/api/session") data = { token: "fixture", allowCustomCommands: false };
    else if (path === "/api/readiness") data = { executionEnabled: false, reason: "Read-only UI acceptance fixture", version: "1.4.209", cli: "orca", workspace: "/fixture", worktree: "path:/fixture" };
    else if (path === "/api/runs") data = { runs: [{ id: runId, objective: "Readable orchestration / 可读的任务编排", createdAt: now }], nextCursor: null };
    else if (path === "/api/dag") data = { runId, nodes, edges: [], hierarchy: [], gates, readyWave: { taskIds: ["task_3"], freeSlots: null }, readiness: {}, generatedAt: 0 };
    else if (path === "/api/run-status") data = status;
    else if (path === "/api/workers") data = { workers: [worker] };
    else if (path.startsWith("/api/workers/")) data = { detail: { ...worker, fleet: worker, dispatch: null, worker: null, terminal: null, observation: null, liveness: { verdict: "unverifiable", qualifiedWorking: false } } };
    else if (path === "/api/activity") data = { runId, events: [], presence: [], checks: [], pendingCount: 0, truncated: false, inboxWindow: null, generatedAt: 0 };
    else if (path === "/api/run-health") data = { runId, ownership: "unbound", warnings: [], counts: { tasks: 6, messages: 0, workers: 1, gates: 1, pendingGates: 1 }, evidenceComplete: true };
    else if (path === "/api/audiences") data = { runId, coordinatorActive: false, audiences: [], workersError: null, worktreesError: null };
    else if (path === "/api/environments") data = { environments: [] };
    else if (path === "/api/session-bindings") data = { bindings: [] };
    else if (path === "/api/worktree-lanes") data = { runId, lanes: [] };
    else if (path === "/api/capabilities") data = { runtime: { cli: "orca", version: "1.4.209" }, advertised: [], capabilities: [], unknownAdvertised: [] };
    else if (path === "/api/requests") data = { requests: [{ requestId: "request_exact_123456789", operation: "worker-start", taskId: worker.taskId, dispatchId: worker.dispatchId, runId, updatedAt: now, settledLocally: false }], otherRunCount: 0 };
    else if (path.startsWith("/api/requests/")) data = { receipt: { state: "absent", interpretation: "Absence does not prove the operation did not happen.", outcome: { accepted: false, count: 0, warnings: ["Inspect before retrying"] }, probe: "orca", probedAt: now } };
    else if (path === "/api/worktrees") data = { worktrees: [] };
    else if (path === "/api/repos") data = { repos: [] };
    else { unexpected.push(path); data = {}; }
    await route.fulfill({ json: data });
  });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  for (const lang of ["en", "zh"]) {
    await page.evaluate((lang) => localStorage.setItem("orca-dag:lang", lang), lang);
    await page.goto(base);
    await page.locator(".run-overview__stat").first().waitFor();
    await page.locator(".btn--activity").click();
    check(await page.getByRole("tab").count() === 2, "Communication must contain only Activity and Chat");
    await page.getByRole("tab", { name: lang === "en" ? "Chat" : "聊天", exact: true }).click();
    await page.locator(".btn--operations").click();
    check(await page.getByRole("tab").count() === 0, "Operations must be independent of communication tabs");
    await page.locator(".operations-center__title").waitFor();
    await page.locator(".btn--activity").click();
    check(await page.getByRole("tab", { name: lang === "en" ? "Chat" : "聊天", exact: true }).getAttribute("aria-selected") === "true", "Switching panels must preserve Chat selection");
    await page.locator(".btn--operations").click();
    await page.locator(".ops-attention__action").last().click();
    await page.locator("#operations-execution .workers__detail").waitFor();
    check(await page.locator("#operations-execution").isVisible(), "Attention must switch category and reveal worker");
    check((await page.locator(".workers__toggle").innerText()).includes(nodes[1].label), "Worker summary must resolve the task name");
    check(!(await page.locator(".workers__toggle").innerText()).includes(worker.dispatchId), "Exact Dispatch id belongs in details");
    await page.locator(".workers__filters select").first().selectOption("released");
    await page.locator(".operations-nav button").first().click();
    await page.locator(".ops-attention__action").last().click();
    await page.locator("#operations-execution .workers__detail").waitFor();
    await page.waitForFunction(() => document.querySelector(".workers__filters select")?.value === "all");
    await page.screenshot({ path: `output/playwright/workers-${lang}.png`, scale: "css" });
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      check(await page.locator(".communication-center__body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "Worker panel overflow");
      await page.screenshot({ path: `output/playwright/workers-${lang}-${width}.png`, scale: "css" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".operations-nav button").first().click();
    await page.locator(".ops-attention__action").first().click();
    check(await page.locator('[data-operation-kind="gate"]').isVisible(), "Gate attention must reveal the decision control");
    await page.screenshot({ path: `output/playwright/decisions-${lang}.png`, scale: "css" });
    await page.locator(".operations-nav button").nth(2).click();
    await page.locator(".audit__toggle").click();
    await page.locator(".audit__detail").waitFor();
    check((await page.locator(".audit__state").innerText()).includes(lang === "en" ? "No runtime record" : "运行时无记录"), "Absent must not imply success");
    for (const width of [1280, 900, 620, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${lang} ${width}: page overflow`);
      check(await page.locator(".communication-center__body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${lang} ${width}: panel overflow`);
      const notice = await page.locator(".exec__notices").boundingBox();
      const toolbar = await page.locator(".dag-toolbar").boundingBox();
      check(notice.y + notice.height <= toolbar.y + 1, "Execution notice must not cover toolbar navigation");
      await page.screenshot({ path: `output/playwright/layout-${lang}-${width}.png`, scale: "css" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".communication-center__close").click();
    await page.locator('.react-flow__node[data-id="task_0"]').click();
    await page.locator(".node-result").waitFor();
    check((await page.locator(".node-result").innerText()).includes("Keep history"), "Arbitrary JSON must have visible readable fields");
    await page.locator(".node-result .structured-data summary").click();
    const body = await page.locator(".node-result").innerText();
    check(body.includes("isolated") && body.includes("0") && body.includes(lang === "en" ? "No" : "否"), "Nested and falsy values must survive");
    check(body.includes("<script>literal</script>"), "Text must stay literal");
    await page.screenshot({ path: `output/playwright/result-${lang}.png`, scale: "css" });
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const panelBounds = await page.locator(".node-panel").boundingBox();
      check(panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= width, "Result panel must stay inside viewport");
      check(await page.locator(".node-panel").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "Result panel overflow");
      await page.screenshot({ path: `output/playwright/result-${lang}-${width}.png`, scale: "css" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // Exercise malformed report fields and the full-report expansion in the same real renderer.
    for (const value of [{ outcome: 42, subject: {}, completedAt: false }, [null, false, 0], { subject: "Completed review", body: "Evidence. ".repeat(80), filesModified: ["one.ts", 17] }]) {
      nodes[0].result = JSON.stringify(value);
      await page.reload();
      await page.locator('.react-flow__node[data-id="task_0"]').click();
      await page.locator(".node-result").waitFor();
      check(!(await page.locator(".node-result").innerText()).includes("[object Object]"), "Malformed fields must not crash or coerce objects");
      if (value.body) {
        await page.getByText(lang === "en" ? "Read full report" : "查看完整报告", { exact: true }).click();
        check((await page.locator(".node-result").innerText()).includes(value.body.trim()), "Full report must remain available");
      }
    }
    nodes[0].result = JSON.stringify(result);
  }
  check(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  check(unexpected.length === 0, `Unexpected API calls: ${unexpected.join(", ")}`);
  console.log("PASS: two locales, five widths, operation navigation, exact evidence, nested/falsy/malformed JSON, no mutations.");
}
