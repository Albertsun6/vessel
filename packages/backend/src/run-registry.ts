// Cross-connection run registry. Lets HTTP routes (e.g. emergency interrupt
// from iOS) reach into runs that were created on a specific WS connection.
// Adapted from hapi's permissions registry pattern (hub/src/web/routes/permissions.ts).
//
// ADR-023 (iOS disconnect reattach): this registry is now the *run-owned
// output sink* + state machine + terminal-record store + orphan reaper.
// All run emission (sdk_message / clear_run_messages / session_ended / error /
// permission_request rebroadcast) MUST go through `emit()` here, NOT a
// per-connection closure (I-13). ws_close detaches (does NOT abort); only
// `client_interrupt` and `ttl_expired` abort (I-12).

import type { ServerMessage } from "@vessel/shared";

// ── ADR-023 C4.4 TTL constants (locked in ADR-023) ──────────────────────
/** Detached run with no client: allow legit long turns 5-10min, then reap. */
export const DETACHED_TTL_MS = 600_000; // 10min
/** Detached run blocked on a permission: nobody is coming back to decide. */
export const WAITING_DETACHED_TTL_MS = 120_000; // 2min
/** Attached but no WS pong within this → treat as half-open → detach. */
export const ATTACHED_LIVENESS_TTL_MS = 90_000;
/** Keep a finished-run terminal record this long for a late reattach. */
export const TERMINAL_RECORD_TTL_MS = 300_000; // 5min
/** Reaper scan cadence. */
const REAPER_INTERVAL_MS = 30_000;

export type RunState =
  | "attached_running"
  | "detached_running"
  | "interrupting"
  | "completed_detached"
  | "expired";

export interface PendingPermission {
  kind: "permission";
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface RegisteredRun {
  abort: AbortController;
  cwd: string;
  prompt: string;
  startedAt: number;
  // ── ADR-023 ──
  state: RunState;
  lastActivityAt: number;
  /** liveness: last WS pong (or any inbound) while attached. */
  lastLivenessAt: number;
  detachedAt?: number;
  sessionId?: string;
  conversationId?: string;
  /** C6: only survive-disconnect-eligible if the creating client declared it. */
  capabilityReattach: boolean;
  /** permission.ts channel token — lets the reaper terminate it on expiry. */
  permissionToken: string;
  /** C4.1 run-owned sink — current bound connection's send, or undefined. */
  attachedSend?: (m: ServerMessage) => void;
  attachConnectionId?: string;
  /** Monotonic; bumped every attach. Stale-generation writes are dropped. */
  attachGeneration: number;
  pending?: PendingPermission;
  terminal?: { endedReason: "completed" | "interrupted" | "error"; endedAt: number };
}

export interface RegisterInput {
  abort: AbortController;
  cwd: string;
  prompt: string;
  startedAt: number;
  capabilityReattach: boolean;
  permissionToken: string;
  conversationId?: string;
  /** initial sink = the creating connection. */
  send: (m: ServerMessage) => void;
  connectionId: string;
}

const registry = new Map<string, RegisteredRun>();

/** Side-effect hook the reaper calls when it expires/GCs a run, so this
 *  module stays free of telemetry/permission imports (clean dep direction). */
type ReapListener = (
  runId: string,
  event: ReapAction,
  run: RegisteredRun,
) => void;
let reapListener: ReapListener | undefined;
let reaperTimer: NodeJS.Timeout | undefined;

export function setReapListener(fn: ReapListener): void {
  reapListener = fn;
}

export function register(runId: string, info: RegisterInput): void {
  const now = Date.now();
  registry.set(runId, {
    abort: info.abort,
    cwd: info.cwd,
    prompt: info.prompt,
    startedAt: info.startedAt,
    state: "attached_running",
    lastActivityAt: now,
    lastLivenessAt: now,
    sessionId: undefined,
    conversationId: info.conversationId,
    capabilityReattach: info.capabilityReattach,
    permissionToken: info.permissionToken,
    attachedSend: info.send,
    attachConnectionId: info.connectionId,
    attachGeneration: 1,
  });
}

export function unregister(runId: string): void {
  registry.delete(runId);
}

export function get(runId: string): RegisteredRun | undefined {
  return registry.get(runId);
}

/**
 * C4.1: emit a server message through the run's CURRENT sink (not a
 * closure-captured per-connection send). `gen` lets the producer fence
 * stale writes after a reattach swapped the sink. Returns false if dropped
 * (no sink bound — detached; recovered later via transcript catch-up).
 */
export function emit(runId: string, msg: ServerMessage, gen?: number): boolean {
  const run = registry.get(runId);
  if (!run) return false;
  run.lastActivityAt = Date.now();
  if (gen !== undefined && gen !== run.attachGeneration) return false; // stale
  if (!run.attachedSend) return false; // detached → drop (transcript recovers)
  try {
    run.attachedSend(msg);
    return true;
  } catch {
    return false;
  }
}

/** Current attach generation (producers capture this to fence stale writes). */
export function generation(runId: string): number {
  return registry.get(runId)?.attachGeneration ?? 0;
}

/**
 * C3/C4: atomic sink rebind on reattach. Bumps generation so any in-flight
 * write bound to the old connection is dropped by `emit`'s gen check.
 */
export function attach(
  runId: string,
  send: (m: ServerMessage) => void,
  connectionId: string,
): RegisteredRun | undefined {
  const run = registry.get(runId);
  if (!run) return undefined;
  run.attachedSend = send;
  run.attachConnectionId = connectionId;
  run.attachGeneration += 1;
  run.lastActivityAt = Date.now();
  run.lastLivenessAt = Date.now();
  if (run.state === "detached_running") run.state = "attached_running";
  delete run.detachedAt;
  return run;
}

/**
 * C3: ws_close (or liveness_lost). Detach the sink — DO NOT abort.
 * Only effective if `connectionId` still owns the run (a newer reattach
 * from another connection must not be clobbered by a late close).
 */
export function detach(runId: string, connectionId: string): RegisteredRun | undefined {
  const run = registry.get(runId);
  if (!run) return undefined;
  if (run.attachConnectionId !== connectionId) return run; // superseded
  run.attachedSend = undefined;
  run.attachConnectionId = undefined;
  if (run.state === "attached_running") {
    run.state = "detached_running";
    run.detachedAt = Date.now();
  }
  return run;
}

export function setSessionId(runId: string, sessionId: string): void {
  const run = registry.get(runId);
  if (run) run.sessionId = sessionId;
}

export function setPending(runId: string, pending: PendingPermission | undefined): void {
  const run = registry.get(runId);
  if (run) run.pending = pending;
}

export function markInterrupting(runId: string): void {
  const run = registry.get(runId);
  if (run) run.state = "interrupting";
}

export function touchLiveness(runId: string): void {
  const run = registry.get(runId);
  if (run) run.lastLivenessAt = Date.now();
}

/** C3 process_exit: keep a short terminal record so a late reattach can be
 *  answered with the real outcome instead of `unknown`. */
export function recordTerminal(
  runId: string,
  endedReason: "completed" | "interrupted" | "error",
): void {
  const run = registry.get(runId);
  if (!run) return;
  run.terminal = { endedReason, endedAt: Date.now() };
  if (run.state !== "expired") run.state = "completed_detached";
}

export function listActive(): Array<{ runId: string; cwd: string; promptPreview: string; startedAt: number; runningSec: number }> {
  const now = Date.now();
  return Array.from(registry.entries()).map(([runId, info]) => ({
    runId,
    cwd: info.cwd,
    promptPreview: info.prompt.slice(0, 80),
    startedAt: info.startedAt,
    runningSec: Math.floor((now - info.startedAt) / 1000),
  }));
}

export function activeCount(): number {
  return registry.size;
}

/** Force-interrupt a run by id (HTTP emergency path / client_interrupt). */
export function interrupt(runId: string): boolean {
  const info = registry.get(runId);
  if (!info) return false;
  info.state = "interrupting";
  info.abort.abort();
  return true;
}

/**
 * C4.2 orphan reaper. The ONLY abort path besides `client_interrupt`
 * (satisfies I-12). Side-effects (telemetry, permission terminate) are
 * delegated to the injected reap listener so this module imports nothing.
 */
export type ReapAction =
  | "liveness_lost"
  | "orphan_aborted"
  | "waiting_orphan_aborted"
  | "terminal_gc";

/**
 * Pure decision: what (if anything) the reaper should do to `run` at `now`.
 * No side-effects — so the TTL boundaries are deterministically unit-testable
 * (the load-bearing resource-safety logic; B2 was a BLOCKER about this).
 */
export function reapDecision(run: RegisteredRun, now: number): ReapAction | null {
  if (
    run.state === "attached_running" &&
    now - run.lastLivenessAt > ATTACHED_LIVENESS_TTL_MS
  ) {
    return "liveness_lost";
  }
  if (run.state === "detached_running" && run.detachedAt !== undefined) {
    const ttl = run.pending ? WAITING_DETACHED_TTL_MS : DETACHED_TTL_MS;
    if (now - run.detachedAt > ttl) {
      return run.pending ? "waiting_orphan_aborted" : "orphan_aborted";
    }
  }
  if (run.terminal && now - run.terminal.endedAt > TERMINAL_RECORD_TTL_MS) {
    return "terminal_gc";
  }
  return null;
}

/** One reaper sweep at `now` (extracted so tests can drive `now` directly).
 *  Applies the pure decision's side-effect; ONLY abort path besides
 *  client_interrupt (I-12). */
export function runReaperSweep(now: number): void {
  for (const [runId, run] of registry.entries()) {
    const action = reapDecision(run, now);
    if (action === null) continue;
    switch (action) {
      case "liveness_lost":
        run.attachedSend = undefined;
        run.attachConnectionId = undefined;
        run.state = "detached_running";
        run.detachedAt = now;
        reapListener?.(runId, "liveness_lost", run);
        break;
      case "orphan_aborted":
      case "waiting_orphan_aborted":
        run.state = "expired";
        run.abort.abort();
        reapListener?.(runId, action, run);
        break;
      case "terminal_gc":
        reapListener?.(runId, "terminal_gc", run);
        registry.delete(runId);
        break;
    }
  }
}

export function startReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => runReaperSweep(Date.now()), REAPER_INTERVAL_MS);
  reaperTimer.unref?.();
}
