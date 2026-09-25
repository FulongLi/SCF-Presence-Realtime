import type { ToolRunner } from "../voice/tools/executor";
import { serializeResult, type ToolResult } from "../voice/tools/results";
import type { BackendStatus, FunctionCallItem, LiveClientEvent, LiveEvent } from "./events";

export interface LiveToolRecord {
  callId: string;
  name: string;
  arguments: string;
  delegationId?: string;
  responseId?: string;
  at: number;
  result?: ToolResult;
  ms?: number;
}

export interface DelegationHost {
  /** Sends a client event over the data channel; false when the channel is not open. */
  send(event: LiveClientEvent): boolean;
  /** Whether delegated work may be continued now (the session is running and not closing). */
  canContinue(): boolean;
  onDelegationStarted?(delegationId: string): void;
  onDelegationFinished?(delegationId: string, status: BackendStatus | "abandoned"): void;
  onToolStarted?(record: LiveToolRecord): void;
  onToolFinished?(record: LiveToolRecord): void;
}

/** Lightweight counters and timings for ?debug=1 A/B comparison. */
export interface DelegationStats {
  delegations: number;
  functionCalls: number;
  continuations: number;
  backendResponses: number;
  /** Delegation created → its first function call arrived (ms), for the most recent delegation that called one. */
  delegationToCallMs: number | null;
}

interface Delegation { id: string; createdAt: number; called: boolean; active: boolean }
interface BackendResponse { delegationId?: string; calls: number; pending: number; finished?: BackendStatus; settled: boolean }

/**
 * GPT-Live Responses delegation for SCF's visual tools (current GPT-Live delegation guide):
 *
 *   session.delegation.created { target: "responses" }     → a delegation is active (body may think)
 *   response.event › response.created                      → the backend response id for that delegation
 *   response.event › response.output_item.done (function)  → validate + execute with the shared ToolExecutor
 *                                                          → response.item.create { function_call_output }
 *   response.event › response.completed                    → once every call has a result: response.create
 *                                                            continues the backend, and GPT-Live speaks it
 *
 * Calls are read from the finished output item (it carries `call_id`, `name` and `arguments`); an
 * arguments-done event alone is not used. Lifecycle snapshots carry `output: []`, so they are only used
 * for status. Live speech is independent of this loop: GPT-Live keeps talking while tools run.
 */
export class LiveDelegationLoop {
  readonly history: LiveToolRecord[] = [];
  readonly stats: DelegationStats = { delegations: 0, functionCalls: 0, continuations: 0, backendResponses: 0, delegationToCallMs: null };
  private readonly delegations = new Map<string, Delegation>();
  private readonly responses = new Map<string, BackendResponse>();
  /** The latest backend response of each delegation (function-call items carry no response id). */
  private readonly current = new Map<string, string>();
  private readonly handled = new Set<string>();
  private lastResponseId?: string;
  private generation = 0;
  private sequence = 0;

  constructor(private readonly runner: ToolRunner, private readonly host: DelegationHost, private readonly clock: () => number = Date.now) {}

  get last(): LiveToolRecord | undefined { return this.history[this.history.length - 1]; }

  /** Delegations still running (waiting for the backend, a tool, or a continuation). */
  get active(): number {
    let count = 0;
    for (const delegation of this.delegations.values()) if (delegation.active) count++;
    return count;
  }

  handle(event: LiveEvent) {
    switch (event.type) {
      case "delegation.created":
        // Client delegation is not configured by SCF; its notices carry no work for this loop.
        if (event.target === "responses") this.start(event.delegationId);
        break;
      case "backend.response.started": {
        this.stats.backendResponses++;
        const delegationId = event.delegationId;
        if (delegationId) { this.start(delegationId); this.current.set(delegationId, event.responseId); }
        this.lastResponseId = event.responseId;
        if (!this.responses.has(event.responseId)) this.responses.set(event.responseId, { delegationId, calls: 0, pending: 0, settled: false });
        break;
      }
      case "backend.function_call": {
        const responseId = (event.delegationId && this.current.get(event.delegationId)) || this.lastResponseId;
        this.run(event.delegationId, responseId, event.call);
        break;
      }
      case "backend.response.finished": {
        const responseId = event.responseId ?? ((event.delegationId && this.current.get(event.delegationId)) || this.lastResponseId);
        const entry = responseId ? this.responses.get(responseId) : undefined;
        if (entry && responseId) { entry.finished = event.status; this.settle(responseId, entry); }
        else if (event.delegationId) this.finish(event.delegationId, event.status);
        break;
      }
    }
  }

  /** A new session is a new conversation: late tool results from the old one are dropped. */
  reset() {
    this.generation++;
    for (const delegation of this.delegations.values()) if (delegation.active) this.host.onDelegationFinished?.(delegation.id, "abandoned");
    this.delegations.clear(); this.responses.clear(); this.current.clear(); this.handled.clear();
    this.lastResponseId = undefined;
  }

  private start(id: string) {
    const existing = this.delegations.get(id);
    if (existing) { if (!existing.active) { existing.active = true; this.host.onDelegationStarted?.(id); } return; }
    this.delegations.set(id, { id, createdAt: this.clock(), called: false, active: true });
    this.stats.delegations++;
    this.host.onDelegationStarted?.(id);
    // Keep the map small in long sessions: forget old finished delegations.
    if (this.delegations.size > 50) {
      for (const [key, value] of this.delegations) { if (!value.active) { this.delegations.delete(key); break; } }
    }
  }

  private finish(id: string | undefined, status: BackendStatus | "abandoned") {
    const delegation = id ? this.delegations.get(id) : undefined;
    if (!delegation?.active) return;
    delegation.active = false;
    this.host.onDelegationFinished?.(delegation.id, status);
  }

  private run(delegationId: string | undefined, responseId: string | undefined, call: FunctionCallItem) {
    if (this.handled.has(call.callId)) return;
    this.handled.add(call.callId);
    let entry = responseId ? this.responses.get(responseId) : undefined;
    if (!entry && responseId) { entry = { delegationId, calls: 0, pending: 0, settled: false }; this.responses.set(responseId, entry); }
    if (entry) { entry.calls++; entry.pending++; }
    const owner = delegationId ?? entry?.delegationId;
    const delegation = owner ? this.delegations.get(owner) : undefined;
    const at = this.clock();
    if (delegation && !delegation.called) { delegation.called = true; this.stats.delegationToCallMs = at - delegation.createdAt; }
    this.stats.functionCalls++;
    const record: LiveToolRecord = { callId: call.callId, name: call.name, arguments: call.arguments, delegationId: owner, responseId, at };
    this.history.push(record);
    if (this.history.length > 20) this.history.shift();
    this.host.onToolStarted?.(record);
    const generation = this.generation;
    const finish = (result: ToolResult, ms?: number) => {
      if (generation !== this.generation) return;
      record.result = result; record.ms = ms;
      this.host.send({
        type: "response.item.create", event_id: this.eventId("output"),
        item: { type: "function_call_output", call_id: call.callId, output: serializeResult(result) },
      });
      this.host.onToolFinished?.(record);
      if (entry && responseId) { entry.pending--; this.settle(responseId, entry); }
    };
    void this.runner.execute(call.name, call.arguments).then(
      execution => finish(execution.result, execution.ms),
      () => finish({ ok: false, status: "unresolved" }),
    );
  }

  /**
   * A backend response is settled once it has finished and every function call it made has a result.
   * With calls, a completed response is continued so the backend can report the outcome to GPT-Live;
   * without calls (or when it failed), the delegation is done.
   */
  private settle(responseId: string, entry: BackendResponse) {
    if (entry.settled || !entry.finished || entry.pending > 0) return;
    entry.settled = true;
    this.responses.delete(responseId);
    if (entry.calls > 0 && entry.finished === "completed" && this.host.canContinue()) {
      if (this.host.send({ type: "response.create", event_id: this.eventId("continue") })) {
        this.stats.continuations++;
        return; // Still active: the continuation arrives as a new response.created for this delegation.
      }
    }
    this.finish(entry.delegationId, entry.finished);
  }

  private eventId(kind: string) { return `scf_${kind}_${++this.sequence}`; }
}
