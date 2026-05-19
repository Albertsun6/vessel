// ADR-023 dogfood #1: contract-shape round-trip for the iOS-disconnect
// reattach wire additions (reattach_run / run_status / clientCapabilities /
// permission_reply.message). The Swift side's `RunStatus(rawValue:) ?? .unknown`
// forward-compat is asserted in the iOS test target; here we lock the TS
// contract shape + JSON round-trip so the two ends can't silently diverge.
import { describe, it, expect } from "vitest";
import type { ClientMessage, ServerMessage } from "../protocol";

function roundTrip<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("ADR-023 — reattach_run ClientMessage", () => {
  it("round-trips with all fields", () => {
    const msg: ClientMessage = {
      type: "reattach_run",
      runId: "run-1",
      conversationId: "conv-1",
      sessionId: "sess-1",
      cwd: "/Users/test/p",
    };
    const r = roundTrip(msg);
    expect(r.type).toBe("reattach_run");
    if (r.type === "reattach_run") {
      expect(r.runId).toBe("run-1");
      expect(r.conversationId).toBe("conv-1");
      expect(r.sessionId).toBe("sess-1");
      expect(r.cwd).toBe("/Users/test/p");
    }
  });

  it("sessionId is optional (new conversation pre-systemInit, invariant #8)", () => {
    const msg: ClientMessage = {
      type: "reattach_run",
      runId: "run-2",
      conversationId: "conv-2",
      cwd: "/Users/test/p",
    };
    const r = roundTrip(msg);
    if (r.type === "reattach_run") expect(r.sessionId).toBeUndefined();
  });
});

describe("ADR-023 — run_status ServerMessage (C2)", () => {
  const STATUSES = [
    "running",
    "interrupting",
    "completed",
    "failed",
    "aborted",
    "expired",
    "unknown",
  ] as const;

  it("covers exactly the 7 contracted statuses (no waiting_workflow_choice)", () => {
    for (const status of STATUSES) {
      const msg: ServerMessage = { type: "run_status", runId: "r", status };
      const r = roundTrip(msg);
      expect(r.type).toBe("run_status");
      if (r.type === "run_status") expect(r.status).toBe(status);
    }
    // Workflow choice is intentionally NOT a run_status (it's a runId-less
    // broadcast subsystem — descoped from this wire per ADR-023 F2).
    expect(STATUSES).not.toContain("waiting_workflow_choice" as never);
  });

  it("carries a pending permission to re-surface (A2/C)", () => {
    const msg: ServerMessage = {
      type: "run_status",
      runId: "r",
      status: "running",
      sessionId: "s",
      pending: { kind: "permission", requestId: "pr-1", toolName: "Bash", input: { cmd: "ls" } },
    };
    const r = roundTrip(msg);
    if (r.type === "run_status") {
      expect(r.pending?.kind).toBe("permission");
      expect(r.pending?.requestId).toBe("pr-1");
      expect(r.pending?.toolName).toBe("Bash");
    }
  });

  it("forward-compat: an unknown future status string survives JSON parse so the Swift `?? .unknown` decoder has something to default", () => {
    const wire = JSON.stringify({ type: "run_status", runId: "r", status: "some_future_value" });
    const parsed = JSON.parse(wire) as { type: string; status: string };
    expect(parsed.type).toBe("run_status");
    expect(parsed.status).toBe("some_future_value"); // Swift maps → .unknown
  });
});

describe("ADR-023 — capability negotiation + deny-with-instruction", () => {
  it("user_prompt carries clientCapabilities.reattach (C6)", () => {
    const msg: ClientMessage = {
      type: "user_prompt",
      runId: "r",
      prompt: "hi",
      cwd: "/p",
      model: "claude-haiku-4-5",
      permissionMode: "default",
      clientCapabilities: { reattach: true },
    };
    const r = roundTrip(msg);
    if (r.type === "user_prompt") expect(r.clientCapabilities?.reattach).toBe(true);
  });

  it("old client omits clientCapabilities → undefined (NF2 byte-identical path)", () => {
    const msg: ClientMessage = {
      type: "user_prompt",
      runId: "r",
      prompt: "hi",
      cwd: "/p",
      model: "claude-haiku-4-5",
      permissionMode: "default",
    };
    const r = roundTrip(msg);
    if (r.type === "user_prompt") expect(r.clientCapabilities).toBeUndefined();
  });

  it("permission_reply carries an optional deny instruction (Phase C)", () => {
    const msg: ClientMessage = {
      type: "permission_reply",
      requestId: "pr-1",
      decision: "deny",
      runId: "r",
      message: "不要删文件，移动到 .trash/ 代替",
    };
    const r = roundTrip(msg);
    if (r.type === "permission_reply") {
      expect(r.decision).toBe("deny");
      expect(r.message).toBe("不要删文件，移动到 .trash/ 代替");
    }
  });
});
