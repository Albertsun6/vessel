import { Hono } from "hono";
import { randomUUID } from "node:crypto";

export type PermissionDecision = "allow" | "deny";

// ADR-023 C5: this module is the SINGLE OWNER of permission resolver timers
// (I-14). run-registry / index.ts drive it via detach/reattach/terminate —
// they never setTimeout/clearTimeout a permission timer themselves.

interface PermissionOutcome {
  decision: PermissionDecision;
  /** ADR-023 Phase C: deny reason forwarded to the hook (Claude sees it). */
  reason?: string;
}

interface PendingResolver {
  resolve: (outcome: PermissionOutcome) => void;
  timer: NodeJS.Timeout;
  // Snapshot so a reattach can re-surface the request to the new connection.
  requestId: string;
  toolName: string;
  input: unknown;
}

interface RegistryEntry {
  send: (msg: unknown) => void;
  pending: Map<string, PendingResolver>;
  /** detached = no live client bound; new/!resolved permissions must NOT
   *  fail-open allow (I-9/I-15) — they deny+expire instead. */
  detached: boolean;
}

// Hook-script timeout is 600s (configured in cli-runner). Match that here so
// the HTTP request from the hook resolves before the hook itself times out
// (which would yield an unbounded zombie hook process otherwise).
const PENDING_TIMEOUT_MS = 590_000;
// ADR-023 C4.4 WAITING_DETACHED_TTL (locked in ADR-023). Inlined rather than
// imported to keep the dep direction one-way (run-registry never imports this).
const WAITING_DETACHED_TTL_MS = 120_000;

const registry = new Map<string, RegistryEntry>();

/** Arm the ATTACHED fail-open timer: a live client exists, the user just
 *  hasn't tapped — keep current fail-open-after-590s semantics. */
function armAttachedTimer(token: string, requestId: string): NodeJS.Timeout {
  return setTimeout(() => {
    const e = registry.get(token);
    const r = e?.pending.get(requestId);
    if (!e || !r) return;
    e.pending.delete(requestId);
    r.resolve({ decision: "allow" });
  }, PENDING_TIMEOUT_MS);
}

/** Arm the DETACHED expire timer: no client; never allow (I-15). On expiry
 *  resolve deny so the hook fetch doesn't zombie (cross M4). */
function armDetachedTimer(token: string, requestId: string, ttlMs: number): NodeJS.Timeout {
  return setTimeout(() => {
    const e = registry.get(token);
    const r = e?.pending.get(requestId);
    if (!e || !r) return;
    e.pending.delete(requestId);
    r.resolve({ decision: "deny", reason: "run expired while detached" });
  }, ttlMs);
}

export function registerPermissionChannel(
  token: string,
  send: (msg: unknown) => void,
): () => void {
  registry.set(token, { send, pending: new Map(), detached: false });
  // Returned closure = terminate (real run end). ws_close uses
  // detachPermissionChannel instead (does NOT fake-deny — NF1).
  return () => terminatePermissionChannel(token);
}

/** ADR-023 C5: ws_close. Mark detached + re-arm every pending as a bounded
 *  deny-on-expiry (NOT fake-deny now, NOT allow). `entry.send` is the run's
 *  channelSend which routes through the run-owned sink (emitRun) — it stays
 *  put and naturally drops while detached, so a reattach transparently
 *  redirects future emission to the new connection. */
export function detachPermissionChannel(token: string, waitingTtlMs: number): void {
  const entry = registry.get(token);
  if (!entry) return;
  entry.detached = true;
  for (const [requestId, r] of entry.pending.entries()) {
    clearTimeout(r.timer);
    r.timer = armDetachedTimer(token, requestId, waitingTtlMs);
  }
}

/** ADR-023 C5: reattach. Clear detached + restore attached fail-open timers.
 *  Emission already flows via the run-owned sink (channelSend→emitRun, which
 *  attachRun just rebound), so there is nothing to re-bind here. Re-surfacing
 *  the pending request is done by the caller via `run_status.pending` (it
 *  carries runId for routing; a bare permission_request would be dropped). */
export function reattachPermissionChannel(token: string): void {
  const entry = registry.get(token);
  if (!entry) return;
  entry.detached = false;
  for (const [requestId, r] of entry.pending.entries()) {
    clearTimeout(r.timer);
    r.timer = armAttachedTimer(token, requestId);
  }
}

/** ADR-023 C5: real run end (aborted/expired/failed/completed). Deny all
 *  in-flight (so the hook fetch resolves, no zombie) and drop the channel. */
export function terminatePermissionChannel(token: string): void {
  const entry = registry.get(token);
  if (entry) {
    for (const r of entry.pending.values()) {
      clearTimeout(r.timer);
      r.resolve({ decision: "deny", reason: "run ended" });
    }
  }
  registry.delete(token);
}

/** Snapshot of in-flight pending for a token (run_status.pending / reattach). */
export function getPendingPermission(
  token: string,
): { requestId: string; toolName: string; input: unknown } | undefined {
  const entry = registry.get(token);
  if (!entry) return undefined;
  for (const r of entry.pending.values()) {
    return { requestId: r.requestId, toolName: r.toolName, input: r.input };
  }
  return undefined;
}

export function resolvePermission(
  token: string,
  requestId: string,
  decision: PermissionDecision,
  reason?: string,
): void {
  const entry = registry.get(token);
  if (!entry) return;
  const resolver = entry.pending.get(requestId);
  if (!resolver) return;
  entry.pending.delete(requestId);
  clearTimeout(resolver.timer);
  resolver.resolve({ decision, reason });
}

export const permissionRouter = new Hono();

permissionRouter.post("/ask", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ decision: "allow", reason: "missing token" });
  const entry = registry.get(token);
  if (!entry) return c.json({ decision: "allow", reason: "session not found" });

  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ decision: "allow", reason: "bad payload" });
  }

  const requestId = randomUUID();
  const toolName = payload?.tool_name ?? "unknown";
  const input = payload?.tool_input ?? {};
  const outcome = await new Promise<PermissionOutcome>((resolve) => {
    // I-9: a new permission that arrives while detached must NOT fail-open
    // allow. Arm a bounded deny timer instead and don't try to send (no conn).
    const detached = entry.detached;
    const timer = detached
      ? armDetachedTimer(token, requestId, WAITING_DETACHED_TTL_MS)
      : armAttachedTimer(token, requestId);
    entry.pending.set(requestId, { resolve, timer, requestId, toolName, input });
    if (!detached) {
      entry.send({ type: "permission_request", requestId, toolName, input });
    }
  });

  // permission-hook.mjs forwards `reason` as the deny reason → Claude sees
  // the user's "do this instead" instruction (ADR-023 Phase C).
  return c.json({ decision: outcome.decision, reason: outcome.reason });
});
