import type { ClientEvent, FunctionCallItem, RealtimeEvent, ResponseStatus } from "./events";
import type { ToolRunner } from "../voice/tools/executor";
import { serializeResult, type ToolResult } from "../voice/tools/results";

export interface ToolCallRecord {
  callId: string;
  name: string;
  arguments: string;
  responseId: string;
  at: number;
  result?: ToolResult;
  ms?: number;
}

export type { ToolRunner };

export interface ToolLoopHost {
  /** Sends a client event over the data channel; false when the channel is not open. */
  send(event: ClientEvent): boolean;
  /** Whether a follow-up response may be requested now (the user is not speaking, nothing else is responding). */
  canContinue(): boolean;
  onToolStarted?(record: ToolCallRecord): void;
  onToolFinished?(record: ToolCallRecord): void;
}

interface ResponseEntry { calls: number; pending: number; finished?: { status: ResponseStatus; spoke: boolean }; settled: boolean }

/**
 * The GA Realtime function-calling lifecycle for SCF's native visual tools:
 *
 *   response.function_call_arguments.delta  → arguments assembled per call_id
 *   response.function_call_arguments.done   → validate + execute locally (voice keeps playing)
 *                                            → conversation.item.create { function_call_output }
 *   response.done                           → if that response only called tools and never spoke,
 *                                              response.create lets the model continue
 *
 * A response that already spoke does not get a follow-up: the visual accompanied the speech, and a
 * second response would make the model narrate the tool. Cancelled responses (barge-in) are never
 * continued; the user's new turn gets its own response.
 */
export class ToolCallLoop {
  readonly history: ToolCallRecord[] = [];
  private readonly handled = new Set<string>();
  private readonly partial = new Map<string, string>();
  private readonly responses = new Map<string, ResponseEntry>();
  private generation = 0;

  constructor(private readonly runner: ToolRunner, private readonly host: ToolLoopHost, private readonly clock: () => number = Date.now) {}

  get last(): ToolCallRecord | undefined { return this.history[this.history.length - 1]; }

  /** Arguments assembled from deltas so far (the `.done` event carries the final string). */
  assembled(callId: string) { return this.partial.get(callId) ?? ""; }

  handle(event: RealtimeEvent) {
    switch (event.type) {
      case "tool.arguments":
        if (!this.handled.has(event.callId)) this.partial.set(event.callId, this.assembled(event.callId) + event.delta);
        break;
      case "tool.call":
        this.run(event.responseId, event.call);
        break;
      case "response.finished": {
        // Fallback: a function call seen only in response.done (e.g. a missed .done event) still runs once.
        for (const call of event.functionCalls) this.run(event.responseId, call);
        const entry = this.responses.get(event.responseId);
        if (entry) { entry.finished = { status: event.status, spoke: event.spoke }; this.settle(event.responseId, entry); }
        break;
      }
    }
  }

  /** A new session starts a new conversation: late results from the old one are dropped. */
  reset() {
    this.generation++;
    this.handled.clear(); this.partial.clear(); this.responses.clear();
  }

  private entry(responseId: string) {
    let entry = this.responses.get(responseId);
    if (!entry) { entry = { calls: 0, pending: 0, settled: false }; this.responses.set(responseId, entry); }
    return entry;
  }

  private run(responseId: string, call: FunctionCallItem) {
    if (this.handled.has(call.callId)) return;
    this.handled.add(call.callId);
    const args = call.arguments || this.assembled(call.callId);
    this.partial.delete(call.callId);
    const entry = this.entry(responseId);
    entry.calls++; entry.pending++;
    const record: ToolCallRecord = { callId: call.callId, name: call.name, arguments: args, responseId, at: this.clock() };
    this.history.push(record);
    if (this.history.length > 20) this.history.shift();
    this.host.onToolStarted?.(record);
    const generation = this.generation;
    const finish = (result: ToolResult, ms?: number) => {
      if (generation !== this.generation) return;
      record.result = result; record.ms = ms;
      this.host.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.callId, output: serializeResult(result) } });
      entry.pending--;
      this.host.onToolFinished?.(record);
      this.settle(responseId, entry);
    };
    void this.runner.execute(call.name, args).then(
      execution => finish(execution.result, execution.ms),
      () => finish({ ok: false, status: "unresolved" }),
    );
  }

  private settle(responseId: string, entry: ResponseEntry) {
    if (entry.settled || !entry.finished || entry.pending > 0 || entry.calls === 0) return;
    entry.settled = true;
    this.responses.delete(responseId);
    if (entry.finished.status === "completed" && !entry.finished.spoke && this.host.canContinue()) {
      this.host.send({ type: "response.create" });
    }
  }
}
