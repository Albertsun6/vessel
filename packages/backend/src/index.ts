import "dotenv/config";
import { checkRenamedEnvVars } from "./startup-env-check.js";

checkRenamedEnvVars();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { runSession } from "./cli-runner.js";
import { subscribeFs } from "./fs-watcher.js";
import { subscribeSession } from "./session-watcher.js";
import { contextRouter } from "./routes/context.js";
import { fsRouter } from "./routes/fs.js";
import { healthRouter } from "./routes/health.js";
import { gitRouter } from "./routes/git.js";
import { voiceRouter } from "./routes/voice.js";
import { sessionsRouter } from "./routes/sessions.js";
import { projectsRouter } from "./routes/projects.js";
import { ensureScratchProject } from "./projects-store.js";
import { telemetryRouter } from "./routes/telemetry.js";
import {
  permissionRouter,
  registerPermissionChannel,
  resolvePermission,
  detachPermissionChannel,
  reattachPermissionChannel,
  terminatePermissionChannel,
  getPendingPermission,
} from "./routes/permission.js";
import { inboxRouter } from "./routes/inbox.js";
import { setPimDbForInbox } from "./inbox-store.js";
import { pimRouter, setPimDbForRoutes, setPimBroadcast } from "./routes/pim.js";
import { pimCapturePageHandler } from "./routes/pim-page.js";
import { cleanupOrphanAiSuggestions, isPimAiEnabled } from "./pim-ai-suggester.js";
import { updateCheckRouter } from "./routes/update-check.js";
import { runsRouter } from "./routes/runs.js";
import { helpRouter } from "./routes/help.js";
import { vesselRouter, redactAgentResult } from "./routes/vessel-intent.js";
import { vesselFsRouter } from "./routes/vessel-fs.js";
import { buildWorkflowRouter } from "./routes/vessel-workflow.js";
import { vesselPanelHandler } from "./routes/vessel-panel.js";
import { runIntent } from "./orchestrator.js";
import { mcpManager, parseMcpSpecsFromEnv } from "./mcp/manager.js";
import { cleanupMcpConfig } from "./mcp/cli-config.js";
import { startMdnsPublisher, stopMdnsPublisher } from "./mdns/publisher.js";
import { vesselMemoryRouter } from "./routes/vessel-memory.js";
import { markInterruptedOnStartup } from "./memory/workflow-store.js";
import { harnessConfigRouter } from "./routes/harness-config.js";
import { harnessConfigEvents, startConfigWatcher } from "./harness-config.js";
import { loadEvaConfig } from "./eva-config-loader.js";
import { buildHarnessRouter } from "./routes/harness.js";
import { openHarnessDb } from "./harness-store.js";
import { worktreesRouter, workRouter } from "./routes/worktrees.js";
import { buildNotificationHub, type NotificationContext, type SessionEndReason } from "./notifications/index.js";
import {
  recordSpawn as heartbeatRecordSpawn,
  recordCompletion as heartbeatRecordCompletion,
  setActiveRunCountFn as heartbeatSetActiveRunCountFn,
  setNotificationChannelCount as heartbeatSetNotificationChannelCount,
} from "./heartbeat.js";
import {
  register as registerRun,
  unregister as unregisterRun,
  activeCount as runRegistryActiveCount,
  emit as emitRun,
  attach as attachRun,
  detach as detachRun,
  get as getRun,
  setSessionId as setRunSessionId,
  setPending as setRunPending,
  recordTerminal as recordRunTerminal,
  markInterrupting as markRunInterrupting,
  touchLiveness as touchRunLiveness,
  startReaper as startRunReaper,
  setReapListener as setRunReapListener,
  WAITING_DETACHED_TTL_MS,
} from "./run-registry.js";
import {
  authMiddleware,
  checkWsAuth,
  isAuthEnabled,
  isPathAllowlistEnabled,
  getAllowedRoots,
  verifyAllowedPath,
} from "./auth.js";
import type {
  ClientMessage,
  ServerMessage,
} from "@vessel/shared";

const PORT = Number(process.env.PORT ?? 3030);
// Default-bind to localhost; only listen on all interfaces if BACKEND_HOST is set
// explicitly. Tailscale serve / reverse proxy handles external access.
const HOST = process.env.BACKEND_HOST ?? "127.0.0.1";
const BACKEND_BASE = process.env.BACKEND_BASE ?? `http://localhost:${PORT}`;
// ADR-023 C6: master gate. OFF by default → ws_close keeps the pre-ADR-023
// abort behavior for ALL runs (old-iOS byte-identical, NF2). Rollback = unset
// this env (no redeploy/client change). A run is survive-eligible only if this
// is on AND the creating client declared clientCapabilities.reattach.
const RUN_SURVIVES_DISCONNECT =
  process.env.VESSEL_RUN_SURVIVES_DISCONNECT === "1" ||
  process.env.VESSEL_RUN_SURVIVES_DISCONNECT === "true";

// ADR-023 C4.2: start the single orphan reaper. The reap listener does the
// side-effects (permission terminate + telemetry) so run-registry imports
// nothing. Only the reaper + client_interrupt abort runs (I-12).
setRunReapListener((runId, event, run) => {
  if (event === "terminal_gc") {
    unregisterRun(runId);
    return;
  }
  // orphan_aborted / waiting_orphan_aborted / liveness_lost
  if (event === "orphan_aborted" || event === "waiting_orphan_aborted") {
    terminatePermissionChannel(run.permissionToken);
  }
  console.log(`[reaper] ${event} run=${runId} state=${run.state}`);
});
startRunReaper();

// M1A-α 4-way review MAJOR R-M1Aα-3: vessel-core orchestrator routes can spawn
// Claude CLI subprocesses (capability-coding). Refuse to start when bound to a
// non-local interface AND VESSEL_TOKEN is empty — that combination = unauth RCE
// surface. Eva pre-Vessel allowed token-less binds because legacy routes were
// read-only-ish; M1A-α changes the threat model.
if (HOST !== "127.0.0.1" && HOST !== "localhost" && !process.env.VESSEL_TOKEN) {
  console.error(
    `[backend] FATAL: BACKEND_HOST=${HOST} (non-local) requires VESSEL_TOKEN to be set. ` +
    `Otherwise /api/vessel/intent would let any reachable client spawn Claude CLI subprocesses.`,
  );
  process.exit(1);
}

const app = new Hono();
// CORS allow Authorization so the frontend can attach a Bearer token.
app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"] }));

// Public: liveness + a tiny capability advertisement (no secrets).
app.get("/health", (c) =>
  c.json({
    ok: true,
    authRequired: isAuthEnabled(),
    pathAllowlist: isPathAllowlistEnabled(),
    activeRuns: globalActiveRuns(),
    cliBin: process.env.CLAUDE_CLI ?? "claude",
  }),
);
app.get("/api/auth/info", (c) =>
  c.json({
    authRequired: isAuthEnabled(),
    pathAllowlist: isPathAllowlistEnabled(),
    allowedRoots: isPathAllowlistEnabled() ? getAllowedRoots() : [],
  }),
);

// H12 v1: load eva.json (parallel-work declarative config). Soft fail — backend
// behavior 不依赖 eva.json，仅 status reader / 后续 H13 / ResourceLock 用。
loadEvaConfig();

// Everything else under /api requires the token (when VESSEL_TOKEN is set).
app.use("/api/*", authMiddleware);

app.route("/api/context", contextRouter);
app.route("/api/fs", fsRouter);
app.route("/api/health", healthRouter);
app.route("/api/git", gitRouter);
app.route("/api/voice", voiceRouter);
app.route("/api/sessions", sessionsRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/telemetry", telemetryRouter);
app.route("/api/permission", permissionRouter);
app.route("/api/inbox", inboxRouter);
// M0-PIM (ADR-020) — PimItem CRUD + sanity-report + attach-issue
app.route("/api/pim", pimRouter);
// M0-PIM Day 4c — self-contained capture page (no React, cross-device).
// Mount BEFORE Eva SPA `/*` fallback (which routes everything to index.html).
app.get("/pim", pimCapturePageHandler() as never);
app.get("/pim/", pimCapturePageHandler() as never);
app.get("/pim/capture", pimCapturePageHandler() as never);
app.get("/pim/capture/", pimCapturePageHandler() as never);
app.route("/api/version", updateCheckRouter);
app.route("/api/runs", runsRouter);
app.route("/api/help", helpRouter);
app.route("/api/harness/config", harnessConfigRouter);
app.route("/api/worktrees", worktreesRouter);
// M1A-α: Vessel orchestrator routes — namespace-isolated from Eva (`/api/vessel/*`)
app.route("/api/vessel", vesselRouter);
// M1B: Vessel FS permission endpoint (separate router, same prefix — no route collision).
app.route("/api/vessel", vesselFsRouter);
// M1C-B+: long-term memory CRUD + KNN HTTP API
app.route("/api/vessel", vesselMemoryRouter);
// M1A-α minimal panel — self-contained HTML at `/vessel/min/`. Must register
// BEFORE Eva's SPA `/*` fallback (~ line 201) which would otherwise route to index.html.
app.get("/vessel/min", vesselPanelHandler() as never);
app.get("/vessel/min/", vesselPanelHandler() as never);
app.route("/api/work", workRouter);

// Harness M1: open SQLite DB here (early), but mount CRUD+scheduler routes after wss init
// (scheduler needs broadcastToAll which references wss.clients).
// Exception: error/disabled 503 handlers are still registered here (before wss) — that is intentional,
// since they don't use broadcastToAll and Hono matches them only when the success path is absent.
// HARNESS_DISABLED=1 skips DB init and returns 503 for all /api/harness/* routes
// except /api/harness/config (already mounted above).
let _harnessDb: ReturnType<typeof openHarnessDb> | null = null;
if (!process.env.HARNESS_DISABLED) {
  try {
    _harnessDb = openHarnessDb();
    console.log(`[harness] SQLite ready (schema v${_harnessDb.schemaVersion})`);
    // ADR-020 D3: POST /api/inbox dual-write 同时写 jsonl + pim_item.
    // 2-week buffer 期间 inbox.jsonl 与 pim_item 都接收新增, Week 3 末
    // 标 inbox.jsonl 为 .deprecated.
    setPimDbForInbox(_harnessDb);
    // ADR-020 D5 — PIM CRUD routes (/api/pim) need DB instance.
    setPimDbForRoutes(_harnessDb);
    // ADR-020 D9 Week 2 — cleanup orphan AI suggestions left by previous
    // crashed backend run (ai_status='running' > 5min → 'failed'). Idempotent.
    cleanupOrphanAiSuggestions(_harnessDb.db);
    console.log(
      `[pim-ai-suggester] PIM_AI_ENABLED=${isPimAiEnabled()} (set env var to 'true' to enable)`,
    );
  } catch (err) {
    console.error("[harness] DB init failed — harness routes unavailable:", err);
    app.all("/api/harness/*", (c) =>
      c.json({ ok: false, error: "harness unavailable (DB init failed)" }, 503)
    );
  }
} else {
  app.all("/api/harness/*", (c) => {
    return c.json({ ok: false, error: "harness disabled (HARNESS_DISABLED=1)" }, 503);
  });
}

// Notification hub: builds Server酱 / future channels from settings.
// Returns NoOpHub if no channels configured.
const notifyHub = buildNotificationHub();
heartbeatSetNotificationChannelCount(notifyHub.channelCount);

// Always-on scratch project — sticky-pinned no-cwd chat target.
ensureScratchProject().catch((err) => {
  console.warn("[backend] ensureScratchProject failed:", err);
});

// Track active runs across all WS clients so /health can report.
const allConnections = new Set<{ runs: Map<string, RunHandle> }>();
// Make active-run count visible to heartbeat snapshot.
heartbeatSetActiveRunCountFn(() => runRegistryActiveCount());
function globalActiveRuns(): number {
  let n = 0;
  for (const c of allConnections) n += c.runs.size;
  return n;
}

// Serve the frontend production build, if present.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, "../../frontend/dist");

if (existsSync(FRONTEND_DIST)) {
  console.log(`[backend] serving frontend from ${FRONTEND_DIST}`);

  // in-memory cache of pre-gzipped static assets keyed by file path.
  // Wins big on cellular: 873KB JS → ~280KB over wire.
  const gzipCache = new Map<string, Buffer>();
  const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|map)$/i;
  const IMMUTABLE = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|svg)$/;

  // Cache index.html by mtime so a frontend rebuild while backend stays up
  // is picked up automatically. Tiny file → safe to re-read on miss.
  const indexPath = path.join(FRONTEND_DIST, "index.html");
  let indexCache: { mtimeMs: number; html: string; htmlGz: Buffer } | null = null;
  const loadIndex = () => {
    const st = statSync(indexPath);
    if (indexCache && indexCache.mtimeMs === st.mtimeMs) return indexCache;
    const html = readFileSync(indexPath, "utf-8");
    const htmlGz = gzipSync(Buffer.from(html, "utf-8"));
    indexCache = { mtimeMs: st.mtimeMs, html, htmlGz };
    return indexCache;
  };

  const sendIndex = (c: any) => {
    const { html, htmlGz } = loadIndex();
    const ae = c.req.header("accept-encoding") ?? "";
    if (ae.includes("gzip")) {
      return new Response(htmlGz as unknown as BodyInit, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
          "content-length": String(htmlGz.length),
          "cache-control": "no-cache",
        },
      });
    }
    return c.html(html);
  };

  app.use("/*", async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/health") {
      return next();
    }
    // Root or any path without an extension → SPA index
    if (url.pathname === "/" || !/\.[a-z0-9]+$/i.test(url.pathname)) {
      return sendIndex(c);
    }

    const safe = path.normalize(url.pathname).replace(/^\/+/, "");
    const filePath = path.join(FRONTEND_DIST, safe);
    if (!filePath.startsWith(FRONTEND_DIST)) return next();

    if (!existsSync(filePath)) {
      // 404 for missing assets (don't fall back to index.html for asset-like requests)
      return c.text("not found", 404);
    }

    let body: Buffer;
    try { body = readFileSync(filePath); } catch { return next(); }

    const compressible = COMPRESSIBLE.test(filePath);
    const ae = c.req.header("accept-encoding") ?? "";
    const wantsGzip = compressible && ae.includes("gzip");

    let payload: Buffer = body;
    const headers: Record<string, string> = {};
    headers["cache-control"] = IMMUTABLE.test(url.pathname)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300";
    headers["content-type"] = mimeFor(filePath);

    if (wantsGzip) {
      let gz = gzipCache.get(filePath);
      if (!gz) { gz = gzipSync(body); gzipCache.set(filePath, gz); }
      payload = gz;
      headers["content-encoding"] = "gzip";
    }
    headers["content-length"] = String(payload.length);

    return new Response(payload as unknown as BodyInit, { headers });
  });
}

function mimeFor(p: string): string {
  if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json; charset=utf-8";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[backend] http  http://${info.address}:${info.port}`);
  console.log(`[backend] ws    ws://${info.address}:${info.port}/ws`);
  if (!isAuthEnabled()) {
    console.log("[backend] ⚠ no auth token — set VESSEL_TOKEN before exposing.");
  }
  if (!isPathAllowlistEnabled()) {
    console.log("[backend] ⚠ no path allowlist — set VESSEL_ALLOWED_ROOTS to limit cwd.");
  }
});

// M1B: start configured MCP server subprocesses (VESSEL_MCP_SERVERS env var).
// Non-blocking; spawn failures warn but don't crash vessel-core.
void (async () => {
  const specs = parseMcpSpecsFromEnv();
  for (const spec of specs) await mcpManager.spawn(spec);
  if (specs.length > 0) {
    console.log(`[mcp] started ${mcpManager.running().length}/${specs.length} configured servers`);
  }
})();

// M2-iOS-α: broadcast `_vessel._tcp` via mDNS so iOS NWBrowser / LAN clients
// can discover this vessel-core. Opt-out with VESSEL_DISABLE_MDNS=1 (e.g. CI,
// test sandboxes that don't want mDNS chatter on their network).
if (process.env.VESSEL_DISABLE_MDNS !== '1') {
  startMdnsPublisher({ port: PORT });
}

// M1B: shut down MCP servers on process exit. Stacks with any existing signal handlers.
// M1B+: also unlink temp --mcp-config file so /tmp doesn't accumulate.
// M2-iOS-α: stop mDNS publisher so the dns-sd subprocess doesn't outlive us.
(['SIGTERM', 'SIGINT'] as const).forEach((sig) => {
  process.once(sig, () => {
    cleanupMcpConfig();
    stopMdnsPublisher();
    void mcpManager.shutdown().finally(() => {
      // Allow other 'once' handlers (e.g. from harness, http server) to run first by
      // yielding one tick, then exit. process.exit() is the safety net in case
      // nothing else terminates the loop.
      setImmediate(() => process.exit(sig === 'SIGINT' ? 130 : 143));
    });
  });
});

// M1A-β review BLOCKER R-M1Aβ-4: cap WS frame size so 32K text limit fires before
// JSON.parse buffers a 100MB attacker frame.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

// M1A-β review BLOCKER R-M1Aβ-1: process-wide cap on Vessel orchestrator runs.
// Per-connection vesselRuns map gates per-client; this gates fork-bomb across N
// concurrent WS connections (each could open 5 → unbounded otherwise).
const vesselTotalInflight = { count: 0 };
const VESSEL_TOTAL_INFLIGHT_CAP = 8;

// Lazy broadcast — safe to call before any WS client connects.
function broadcastToAll(msg: unknown): void {
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Mount harness CRUD + scheduler routes (needs broadcastToAll, so wss must be ready first).
if (_harnessDb) {
  app.route("/api/harness", buildHarnessRouter(_harnessDb.db, broadcastToAll));
}

// ADR-020 Week 2 Day 12 — PIM routes broadcast `{type:'pim_event', kind, id}` on
// mutations for cross-device sync. Injected here (after wss.clients ready).
setPimBroadcast(broadcastToAll);

// M1C-A: Workflow Engine routes (broadcastToAll injected per cursor B-级 review M-2).
app.route("/api/vessel", buildWorkflowRouter(broadcastToAll));

// M1C-A: On startup, mark any 'running' workflows as 'interrupted' (server died mid-step).
{
  const interrupted = markInterruptedOnStartup();
  if (interrupted > 0) {
    console.log(`[workflow] marked ${interrupted} workflow(s) as interrupted after restart`);
  }
}

// Broadcast harness_event{config_changed} to all connected WS clients when
// fallback-config.json is modified in-process (chokidar watch in harness-config.ts).
// tsx watch restart also reconnects iOS, but this covers the rare in-process path.
//
// M2 Loop 7a: chokidar.watch() moved out of module load; production must
// explicitly start the watcher before mounting the listener below. Tests
// don't call startConfigWatcher() so process can exit cleanly.
startConfigWatcher();

harnessConfigEvents.on("config_changed", () => {
  const msg: ServerMessage = { type: "harness_event", kind: "config_changed" };
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
  console.log("[harness] config_changed broadcast to", wss.clients.size, "client(s)");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.split("?")[0] !== "/ws") {
    socket.destroy();
    return;
  }
  if (!checkWsAuth(req.url, req.headers.authorization as string | undefined)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

interface RunHandle {
  abort: AbortController;
  permissionToken: string;
  /** ADR-023 C6: did the creating user_prompt declare reattach + flag on? */
  surviveEligible: boolean;
}

wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  const runs = new Map<string, RunHandle>();
  const conn = { runs };
  allConnections.add(conn);
  // ADR-023: stable id so run-registry knows which connection owns a run's
  // sink; a late ws_close from a superseded connection won't clobber a newer
  // reattach (run-registry.detach checks this).
  const connectionId = randomUUID();

  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // ADR-023 C4.3 S5: backend-owned WS liveness. Heartbeat ping every 30s;
  // a pong (or any inbound frame) refreshes lastLivenessAt for this
  // connection's runs. The reaper detaches attached_running runs whose
  // liveness is stale > ATTACHED_LIVENESS_TTL_MS (half-open / iOS-suspend).
  const touchOwnRunsLiveness = () => {
    for (const runId of runs.keys()) touchRunLiveness(runId);
  };
  const livenessTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch { /* socket dying; reaper will reap */ }
    }
  }, 30_000);
  livenessTimer.unref?.();
  ws.on("pong", touchOwnRunsLiveness);

  // Per-connection fs watch subscriptions: cwd → unsubscribe.
  const fsSubs = new Map<string, () => void>();
  // Per-connection session jsonl tail subscriptions: "cwd::sid" → unsubscribe.
  const sessionSubs = new Map<string, () => void>();
  // M1A-β: per-connection Vessel orchestrator runs (vessel_intent / vessel_cancel
  // routing). Keyed by runId; isolated from Eva `runs` (cli-runner subprocesses)
  // because they have different lifecycle + permission flow.
  const vesselRuns = new Map<string, { abort: AbortController; vesselSessionId: string }>();

  ws.on("message", async (raw) => {
    // Any inbound frame proves the client is alive (S5 liveness).
    touchOwnRunsLiveness();
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", error: "invalid JSON" });
      return;
    }

    if (msg.type === "permission_reply") {
      // O(1) via this connection's runs; else via run-registry (the run may
      // have been reattached so it's no longer in this map but still global).
      if (msg.runId) {
        const handle = runs.get(msg.runId);
        const token = handle?.permissionToken ?? getRun(msg.runId)?.permissionToken;
        if (token) {
          resolvePermission(token, msg.requestId, msg.decision, msg.message);
          setRunPending(msg.runId, undefined); // clears the shorter waiting-TTL
          return;
        }
      }
      for (const handle of runs.values()) {
        resolvePermission(handle.permissionToken, msg.requestId, msg.decision, msg.message);
      }
      return;
    }

    // ADR-023 C1/S6: reattach a still-believed-busy conversation after a
    // reconnect. Replaces the client's old unconditional force-clear.
    if (msg.type === "reattach_run") {
      const cwdErr = verifyAllowedPath(msg.cwd); // m-CWD: same gate as user_prompt
      if (cwdErr) {
        send({ type: "error", runId: msg.runId, error: cwdErr });
        return;
      }
      const run = getRun(msg.runId);
      if (!run) {
        // No record (backend restarted / GC'd) → explicit unknown; client
        // falls back to transcript reconcile or force-clear (I-7).
        send({ type: "run_status", runId: msg.runId, status: "unknown" });
        return;
      }
      if (run.terminal) {
        send({
          type: "run_status",
          runId: msg.runId,
          status:
            run.terminal.endedReason === "completed" ? "completed"
              : run.terminal.endedReason === "interrupted" ? "aborted"
              : "failed",
          endedReason: run.terminal.endedReason,
          sessionId: run.sessionId,
        });
        return;
      }
      if (run.state === "expired") {
        send({ type: "run_status", runId: msg.runId, status: "expired", sessionId: run.sessionId });
        return;
      }
      if (run.state === "interrupting") {
        // Don't synthesize `aborted` inside cli-runner's SIGTERM→SIGKILL 5s
        // window — the real session_ended drives the final UI state.
        attachRun(msg.runId, send, connectionId);
        runs.set(msg.runId, { abort: run.abort, permissionToken: run.permissionToken, surviveEligible: true });
        reattachPermissionChannel(run.permissionToken);
        send({ type: "run_status", runId: msg.runId, status: "interrupting", sessionId: run.sessionId });
        return;
      }
      // running (attached or detached) → atomically rebind the sink to THIS
      // connection; subsequent sdk_message/session_ended flow here.
      attachRun(msg.runId, send, connectionId);
      runs.set(msg.runId, { abort: run.abort, permissionToken: run.permissionToken, surviveEligible: true });
      reattachPermissionChannel(run.permissionToken);
      const pend = getPendingPermission(run.permissionToken);
      send({
        type: "run_status",
        runId: msg.runId,
        status: "running",
        sessionId: run.sessionId,
        pending: pend
          ? { kind: "permission", requestId: pend.requestId, toolName: pend.toolName, input: pend.input }
          : undefined,
      });
      return;
    }

    if (msg.type === "interrupt") {
      // C3: client_interrupt is a REAL abort (distinct from ws_close detach).
      if (msg.runId) {
        markRunInterrupting(msg.runId);
        (runs.get(msg.runId)?.abort ?? getRun(msg.runId)?.abort)?.abort();
      } else {
        for (const h of runs.values()) h.abort.abort();
      }
      return;
    }

    if (msg.type === "fs_subscribe") {
      const cwdErr = verifyAllowedPath(msg.cwd);
      if (cwdErr) {
        send({ type: "error", error: cwdErr });
        return;
      }
      if (fsSubs.has(msg.cwd)) return; // already subscribed
      const unsub = subscribeFs(msg.cwd, send);
      fsSubs.set(msg.cwd, unsub);
      return;
    }

    if (msg.type === "fs_unsubscribe") {
      const unsub = fsSubs.get(msg.cwd);
      if (unsub) {
        unsub();
        fsSubs.delete(msg.cwd);
      }
      return;
    }

    if (msg.type === "session_subscribe") {
      const cwdErr = verifyAllowedPath(msg.cwd);
      if (cwdErr) {
        send({ type: "error", error: cwdErr });
        return;
      }
      if (!/^[\w-]+$/.test(msg.sessionId)) {
        send({ type: "error", error: "invalid sessionId" });
        return;
      }
      const k = `${msg.cwd}::${msg.sessionId}`;
      if (sessionSubs.has(k)) return; // already subscribed on this connection
      const unsub = subscribeSession(msg.cwd, msg.sessionId, msg.fromByteOffset, send);
      sessionSubs.set(k, unsub);
      return;
    }

    if (msg.type === "session_unsubscribe") {
      const k = `${msg.cwd}::${msg.sessionId}`;
      const unsub = sessionSubs.get(k);
      if (unsub) {
        unsub();
        sessionSubs.delete(k);
      }
      return;
    }

    if (msg.type === "user_prompt") {
      const runId = msg.runId;

      // Defense-in-depth: even though /api routes check this, the WS path
      // accepts cwd directly — verify here too.
      const cwdErr = verifyAllowedPath(msg.cwd);
      if (cwdErr) {
        send({ type: "error", runId, error: cwdErr });
        send({ type: "session_ended", runId, reason: "error" });
        return;
      }

      const notifyCtx: NotificationContext = {
        runId,
        cwd: msg.cwd,
        promptPreview: msg.prompt.slice(0, 80),
        agentName: "Claude",
      };

      const abort = new AbortController();
      const permissionToken = randomUUID();
      // ADR-023 C6: survive-disconnect only if flag on AND client declared it.
      const surviveEligible = RUN_SURVIVES_DISCONNECT && !!msg.clientCapabilities?.reattach;

      // ADR-023 I-13: run output goes through the run-owned sink (run-registry
      // emit), NOT a closure-captured per-connection `send`. emitRun looks up
      // the CURRENT bound connection so a reattach transparently redirects.
      const channelSend = (m: unknown) => {
        const obj = m as { type?: string; toolName?: string };
        if (obj?.type === "permission_request") {
          emitRun(runId, { ...(m as any), runId } as ServerMessage);
          setRunPending(runId, {
            kind: "permission",
            requestId: (m as any).requestId,
            toolName: obj.toolName ?? "(unknown tool)",
            input: (m as any).input,
          });
          void notifyHub.publishPermissionPending(notifyCtx, obj.toolName ?? "(unknown tool)");
        } else {
          emitRun(runId, m as ServerMessage);
        }
      };
      registerPermissionChannel(permissionToken, channelSend);

      runs.set(runId, { abort, permissionToken, surviveEligible });
      registerRun(runId, {
        abort,
        cwd: msg.cwd,
        prompt: msg.prompt,
        startedAt: Date.now(),
        capabilityReattach: surviveEligible,
        permissionToken,
        conversationId: undefined,
        send,
        connectionId,
      });
      heartbeatRecordSpawn();

      void (async () => {
        let endReason: SessionEndReason = "completed";
        try {
          await runSession({
            prompt: msg.prompt,
            cwd: msg.cwd,
            model: msg.model,
            permissionMode: msg.permissionMode,
            resumeSessionId: msg.resumeSessionId,
            attachments: msg.attachments,
            permissionToken,
            backendBase: BACKEND_BASE,
            authToken: process.env.VESSEL_TOKEN,
            signal: abort.signal,
            onMessage: (cliMsg) => {
              emitRun(runId, { type: "sdk_message", runId, message: cliMsg });
              const m = cliMsg as { type?: string; subtype?: string; sessionId?: string; session_id?: string };
              if (m?.type === "system" && m?.subtype === "init") {
                const sid = m.sessionId ?? m.session_id;
                if (sid) { notifyCtx.sessionId = sid; setRunSessionId(runId, sid); }
              }
            },
            onClearRunMessages: () => emitRun(runId, { type: "clear_run_messages", runId }),
          });
          endReason = abort.signal.aborted ? "interrupted" : "completed";
          recordRunTerminal(runId, endReason);
          emitRun(runId, { type: "session_ended", runId, reason: endReason });
          heartbeatRecordCompletion(endReason);
          void notifyHub.publishSessionCompletion(notifyCtx, endReason);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[session error]", err);
          endReason = "error";
          recordRunTerminal(runId, "error");
          emitRun(runId, { type: "error", runId, error: message });
          emitRun(runId, { type: "session_ended", runId, reason: "error" });
          heartbeatRecordCompletion("error");
          void notifyHub.publishSessionCompletion(notifyCtx, "error");
        } finally {
          // C5: real run end → terminate (deny any in-flight so the hook
          // fetch resolves; no zombie). NOT detach (that's ws_close only).
          terminatePermissionChannel(permissionToken);
          runs.delete(runId);
          // Keep the run in run-registry with its terminal record so a late
          // reattach gets the real status; the reaper GCs it after
          // TERMINAL_RECORD_TTL (NF1). recordRunTerminal already set state.
          notifyHub.forgetRun(runId);
        }
      })();
    }

    // ── M1A-β Vessel kernel WS handlers ───────────────────────────────
    if (msg.type === "vessel_cancel") {
      vesselRuns.get(msg.runId)?.abort.abort();
      return;
    }

    if (msg.type === "vessel_intent") {
      const { runId, text, vesselSessionId, skill } = msg;
      if (typeof runId !== "string" || typeof text !== "string" || text.trim() === "") {
        send({ type: "vessel_error", runId: runId ?? "", error: { type: "BadRequest", message: "missing runId or text" } });
        return;
      }
      if (text.length > 32 * 1024) {
        send({ type: "vessel_error", runId, error: { type: "PayloadTooLarge", message: "text > 32K chars" } });
        return;
      }
      // Concurrency cap: per-connection ≤ 5 (mirrors HTTP MAX_CONCURRENT_INTENTS).
      if (vesselRuns.size >= 5) {
        send({ type: "vessel_error", runId, error: { type: "TooManyRequests", message: "≥ 5 in-flight Vessel runs on this connection" } });
        return;
      }
      // Process-wide cap (R-M1Aβ-1): N connections × 5 would otherwise = unbounded.
      if (vesselTotalInflight.count >= VESSEL_TOTAL_INFLIGHT_CAP) {
        send({ type: "vessel_error", runId, error: { type: "TooManyRequests", message: `≥ ${VESSEL_TOTAL_INFLIGHT_CAP} in-flight Vessel runs across all connections` } });
        return;
      }
      const abort = new AbortController();
      const handle = { abort, vesselSessionId: vesselSessionId ?? "" };
      vesselRuns.set(runId, handle);
      vesselTotalInflight.count += 1;

      void (async () => {
        try {
          const result = await runIntent({
            text,
            sessionId: vesselSessionId,
            skill,
            abortSignal: abort.signal,
            onTraceEvent: (event) => {
              // R-M1Aβ vesselSessionId backfill: when caller didn't pass one,
              // orchestrator boots a fresh session — first trace event carries
              // its session_id; latch it so downstream vessel_completed and
              // subsequent events carry the same id (γ relies on this routing).
              if (!handle.vesselSessionId) {
                const eSession = (event as { session_id?: unknown }).session_id;
                if (typeof eSession === 'string') handle.vesselSessionId = eSession;
              }
              send({ type: "vessel_trace", runId, vesselSessionId: handle.vesselSessionId, event });
            },
            onSkillMessage: (message) => {
              send({ type: "vessel_progress", runId, vesselSessionId: handle.vesselSessionId, message });
            },
          });
          // R-M1Aβ-3 + cursor BLOCKER: AgentResult.artifact.{files,stdoutPath} carry
          // absolute home paths; M1A-α HTTP path used redactAgentResult — apply same
          // here so WS doesn't bypass the fix.
          send({ type: "vessel_completed", runId, vesselSessionId: handle.vesselSessionId, result: redactAgentResult(result) });
        } catch (err) {
          const errObj = {
            type: err instanceof Error ? err.constructor.name : "UnknownError",
            message: err instanceof Error ? err.message : String(err),
          };
          send({ type: "vessel_error", runId, vesselSessionId: handle.vesselSessionId, error: errObj });
        } finally {
          vesselRuns.delete(runId);
          vesselTotalInflight.count = Math.max(0, vesselTotalInflight.count - 1);
        }
      })();
      return;
    }
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    clearInterval(livenessTimer);
    for (const [runId, h] of runs.entries()) {
      if (h.surviveEligible) {
        // ADR-023 C3/I-12: ws_close DETACHES, never aborts. The run keeps
        // running; the reaper bounds it (DETACHED_TTL / WAITING_DETACHED_TTL).
        detachRun(runId, connectionId);
        detachPermissionChannel(h.permissionToken, WAITING_DETACHED_TTL_MS);
      } else {
        // Old client / flag off → pre-ADR-023 behavior, byte-identical (NF2).
        h.abort.abort();
        terminatePermissionChannel(h.permissionToken);
        unregisterRun(runId);
      }
    }
    runs.clear();
    for (const unsub of fsSubs.values()) unsub();
    fsSubs.clear();
    for (const unsub of sessionSubs.values()) unsub();
    sessionSubs.clear();
    // M1A-β: abort any in-flight Vessel orchestrator runs on disconnect.
    for (const h of vesselRuns.values()) h.abort.abort();
    vesselRuns.clear();
    allConnections.delete(conn);
  });
});
