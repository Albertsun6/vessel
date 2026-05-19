// ADR-023 dogfood gates — the in-process slices (no booted server / no
// 590s real wait). Covers contract §11 #2 (permission security 承重墙),
// #3 (run-owned sink rebind + generation fence), and the non-time parts of
// #5 (state machine: ws_close detaches not aborts; client_interrupt aborts).
//
// Time-based reaper expiry (DETACHED/WAITING TTL firing) + #4 characterization
// (real CLI transcript compare) remain the e2e gate — see contract §11/§12.
//
// Run: pnpm --filter @vessel/backend exec tsx src/test-adr023-reattach.ts

import {
  register,
  get,
  attach,
  detach,
  emit,
  recordTerminal,
  interrupt as registryInterrupt,
  markInterrupting,
  unregister,
  reapDecision,
  runReaperSweep,
  setReapListener,
  setPending,
  DETACHED_TTL_MS,
  WAITING_DETACHED_TTL_MS,
  ATTACHED_LIVENESS_TTL_MS,
  TERMINAL_RECORD_TTL_MS,
} from "./run-registry.js";
import {
  registerPermissionChannel,
  detachPermissionChannel,
  permissionRouter,
} from "./routes/permission.js";
import type { ServerMessage } from "@vessel/shared";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failures++;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── #3 — run-owned rebindable sink + generation fence ───────────────────
async function testSinkRebind() {
  console.log("#3 run-owned sink rebind + generation fence");
  const ac = new AbortController();
  const got1: ServerMessage[] = [];
  register("r3", {
    abort: ac, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tok3",
    send: (m) => got1.push(m), connectionId: "connA",
  });
  emit("r3", { type: "sdk_message", runId: "r3", message: { a: 1 } });
  assert(got1.length === 1, "emit reaches the initial (creating) sink");

  detach("r3", "connA");
  const droppedWhileDetached = emit("r3", { type: "sdk_message", runId: "r3", message: { b: 2 } });
  assert(droppedWhileDetached === false, "emit is dropped while detached (no sink — transcript recovers)");
  assert(got1.length === 1, "detached emit did NOT leak to the dead connection");

  const got2: ServerMessage[] = [];
  attach("r3", (m) => got2.push(m), "connB");
  emit("r3", { type: "sdk_message", runId: "r3", message: { c: 3 } });
  assert(got2.length === 1, "after reattach, emit reaches the NEW connection sink");
  assert(got1.length === 1, "old connection sink no longer receives anything");

  // Generation fence: a producer holding a stale generation must be dropped.
  const staleGen = 1; // attach bumped generation to 2
  const fenced = emit("r3", { type: "sdk_message", runId: "r3", message: { d: 4 } }, staleGen);
  assert(fenced === false, "stale-generation write is fenced (dropped) after reattach");
  assert(got2.length === 1, "fenced write did not reach the new sink");

  recordTerminal("r3", "completed");
  assert(get("r3")?.state === "completed_detached", "recordTerminal → completed_detached (late reattach answerable)");
  assert(get("r3")?.terminal?.endedReason === "completed", "terminal record carries endedReason");
  unregister("r3");
}

// ── #5 (non-time) — ws_close detaches, client_interrupt aborts ──────────
async function testStateMachineAbortBoundary() {
  console.log("#5 state machine: ws_close detaches (no abort); client_interrupt aborts");

  // ws_close path: detach() must NOT abort the run.
  const acDetach = new AbortController();
  register("r5a", {
    abort: acDetach, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tok5a",
    send: () => {}, connectionId: "c1",
  });
  detach("r5a", "c1");
  assert(acDetach.signal.aborted === false, "I-12: detach (ws_close) did NOT abort the run");
  assert(get("r5a")?.state === "detached_running", "ws_close → state=detached_running");
  unregister("r5a");

  // client_interrupt path: registry.interrupt() aborts + marks interrupting.
  const acInt = new AbortController();
  register("r5b", {
    abort: acInt, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tok5b",
    send: () => {}, connectionId: "c1",
  });
  const found = registryInterrupt("r5b");
  assert(found === true, "interrupt() finds the run");
  assert(acInt.signal.aborted === true, "client_interrupt → run aborted (user Stop really stops, I-8)");
  assert(get("r5b")?.state === "interrupting", "client_interrupt → state=interrupting");
  unregister("r5b");

  // markInterrupting alone (the WS interrupt handler) sets the state.
  const acM = new AbortController();
  register("r5c", {
    abort: acM, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tok5c",
    send: () => {}, connectionId: "c1",
  });
  markInterrupting("r5c");
  assert(get("r5c")?.state === "interrupting", "markInterrupting → state=interrupting");
  unregister("r5c");
}

// ── #2 — permission security 承重墙 ─────────────────────────────────────
// detach passes its own ttl param, so we use a tiny ttl: no 590s wait, no
// server. Two cases: (a) in-flight permission then detach → resolves DENY
// (the armed 590s allow-timer must be cleared); (b) a NEW permission that
// ARRIVES while detached must NOT fail-open allow (I-9/I-15).
async function testPermissionSecurity() {
  console.log("#2 permission security: detached must DENY, never auto-allow");

  // (a) in-flight permission, then ws_close detach with a tiny waiting ttl.
  registerPermissionChannel("secTok1", () => {});
  const askA = permissionRouter.request("/ask?token=secTok1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_name: "Bash", tool_input: { cmd: "rm -rf /" } }),
  });
  await sleep(20); // let /ask arm the pending (590s attached allow-timer)
  detachPermissionChannel("secTok1", 40); // ws_close → re-arm bounded DENY
  const resA = await askA;
  const bodyA = (await resA.json()) as { decision: string; reason?: string };
  assert(bodyA.decision === "deny", "in-flight permission + detach → DENY (armed 590s allow-timer cleared)");
  assert(typeof bodyA.reason === "string" && bodyA.reason.length > 0, "deny carries a reason (hook forwards it, no zombie)");

  // (b) NEW permission arriving while already detached → must DENY (I-9).
  registerPermissionChannel("secTok2", () => {});
  detachPermissionChannel("secTok2", 40); // detached BEFORE the ask
  const resB = await permissionRouter.request("/ask?token=secTok2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_name: "Write", tool_input: { path: "/etc/x" } }),
  });
  const bodyB = (await resB.json()) as { decision: string };
  assert(bodyB.decision === "deny", "I-9: permission arriving while detached → DENY, never fail-open allow");

  // (c) sanity: an ATTACHED pending must NOT auto-resolve synchronously —
  // only a user reply / 590s fail-open / detach decides it. We then drain
  // the dangling request via the terminate closure so the process can exit.
  const terminateC = registerPermissionChannel("secTok3", () => {});
  const askC = permissionRouter.request("/ask?token=secTok3", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_name: "Read", tool_input: {} }),
  });
  await sleep(20);
  let settledEarly = false;
  void askC.then(() => { settledEarly = true; });
  await sleep(30);
  assert(settledEarly === false, "attached pending does NOT auto-resolve (only user reply / 590s / detach decides)");
  terminateC();           // real run end → resolves the dangling ask (deny)
  await askC;             // drain so the event loop empties and we can exit
}

// ── #5 (time) — reaper TTL boundaries via the pure decision (no real wait) ─
async function testReaperTTL() {
  console.log("#5 reaper TTL boundaries (now injected — deterministic)");
  const events: Array<{ runId: string; event: string }> = [];
  setReapListener((runId, event) => events.push({ runId, event }));

  // (a) attached_running, fresh liveness → no action.
  const acA = new AbortController();
  register("rt-a", {
    abort: acA, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tt-a",
    send: () => {}, connectionId: "c1",
  });
  const runA = get("rt-a")!;
  assert(reapDecision(runA, Date.now()) === null, "attached + fresh liveness → no reap");
  assert(
    reapDecision(runA, Date.now() + ATTACHED_LIVENESS_TTL_MS + 1) === "liveness_lost",
    "attached + stale liveness (> ATTACHED_LIVENESS_TTL) → liveness_lost",
  );
  unregister("rt-a");

  // (b) detached_running, no pending: orphan_aborted only AFTER DETACHED_TTL.
  const acB = new AbortController();
  register("rt-b", {
    abort: acB, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tt-b",
    send: () => {}, connectionId: "c1",
  });
  detach("rt-b", "c1");
  const runB = get("rt-b")!;
  assert(reapDecision(runB, Date.now() + WAITING_DETACHED_TTL_MS + 1) === null,
    "detached, NO pending → still alive at WAITING ttl (long turns get full DETACHED_TTL)");
  assert(reapDecision(runB, Date.now() + DETACHED_TTL_MS + 1) === "orphan_aborted",
    "detached, no pending, past DETACHED_TTL → orphan_aborted");
  runReaperSweep(Date.now() + DETACHED_TTL_MS + 1);
  assert(runB.state === "expired", "sweep → state=expired");
  assert(acB.signal.aborted === true, "sweep → run aborted (resource bound enforced, B2)");
  assert(events.some(e => e.runId === "rt-b" && e.event === "orphan_aborted"),
    "reap listener fired orphan_aborted");
  unregister("rt-b");

  // (c) detached_running WITH pending: shorter WAITING_DETACHED_TTL applies.
  const acC = new AbortController();
  register("rt-c", {
    abort: acC, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tt-c",
    send: () => {}, connectionId: "c1",
  });
  detach("rt-c", "c1");
  setPending("rt-c", { kind: "permission", requestId: "p1", toolName: "Bash", input: {} });
  const runC = get("rt-c")!;
  assert(reapDecision(runC, Date.now() + WAITING_DETACHED_TTL_MS + 1) === "waiting_orphan_aborted",
    "detached + pending → reaped at the SHORTER WAITING_DETACHED_TTL (nobody decides)");
  unregister("rt-c");

  // (d) terminal record GC after TERMINAL_RECORD_TTL.
  const acD = new AbortController();
  register("rt-d", {
    abort: acD, cwd: "/p", prompt: "x", startedAt: Date.now(),
    capabilityReattach: true, permissionToken: "tt-d",
    send: () => {}, connectionId: "c1",
  });
  recordTerminal("rt-d", "completed");
  const runD = get("rt-d")!;
  assert(reapDecision(runD, Date.now() + 1000) === null,
    "fresh terminal record kept (late reattach can still read the real outcome)");
  assert(reapDecision(runD, Date.now() + TERMINAL_RECORD_TTL_MS + 1) === "terminal_gc",
    "terminal record past TERMINAL_RECORD_TTL → terminal_gc");
  runReaperSweep(Date.now() + TERMINAL_RECORD_TTL_MS + 1);
  assert(get("rt-d") === undefined, "sweep GC'd the terminal record (registry entry deleted)");
}

async function main() {
  await testSinkRebind();
  await testStateMachineAbortBoundary();
  await testReaperTTL();
  await testPermissionSecurity();
  if (failures > 0) {
    console.error(`\nADR-023 dogfood: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nADR-023 dogfood (#2 security / #3 sink / #5 abort-boundary + reaper TTL): ALL PASS");
  process.exit(0);
}

void main();
