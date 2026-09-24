import type { MorphTarget, VisualAction } from "./types";

export type InformationAction = Exclude<VisualAction, { type: "sphere" }>;
export type TargetResolver = (action: InformationAction, signal: AbortSignal) => Promise<MorphTarget>;
export type VisualPhase = "sphere" | "forming" | "holding" | "returning";
/** What became of a submitted action: its target is queued to form, it could not be resolved, or a newer one replaced it. */
export type SubmitOutcome = "queued" | "failed" | "cancelled" | "sphere";

export const transitionSeconds = { form: 1.6, return: 1.3 };
const ease = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

/**
 * Lifecycle of Visual Actions: sphere → controlled morph → information → hold → return → sphere.
 * A new action while another is shown first returns through the sphere, so the same particles
 * always carry the change and the target buffer is only replaced while the body is a sphere.
 */
export class VisualActionController {
  phase: VisualPhase = "sphere";
  /** Eased morph weight: 0 is the sphere, 1 is the formed information state. */
  level = 0;
  /** Increments whenever `target` is replaced; only ever while level is 0. */
  revision = 0;
  target: MorphTarget | null = null;
  /** Error code of the most recent action that could not be resolved (e.g. "portrait-not-found"). */
  lastFailure: string | null = null;
  private progress = 0;
  private holdLeft = 0;
  private pending: MorphTarget | null = null;
  private resolving?: AbortController;
  private request = 0;
  constructor(
    private readonly resolver: TargetResolver,
    private readonly onError: (error: unknown, action: InformationAction) => void = () => {},
  ) {}

  get busy() { return Boolean(this.resolving) || Boolean(this.pending) || this.phase !== "sphere"; }

  submit(action: VisualAction): Promise<SubmitOutcome> {
    this.cancel();
    if (action.type === "sphere") { this.release(); return Promise.resolve("sphere"); }
    const request = ++this.request;
    const abort = new AbortController();
    this.resolving = abort;
    return this.resolver(action, abort.signal).then(target => {
      if (request !== this.request) return "cancelled" as const;
      this.resolving = undefined;
      this.show(target);
      return "queued" as const;
    }, (error: unknown) => {
      if (request !== this.request) return "cancelled" as const;
      this.resolving = undefined;
      if (abort.signal.aborted) return "cancelled" as const;
      this.lastFailure = error instanceof Error && /^[a-z][a-z-]{0,39}$/.test(error.message) ? error.message : "unresolved";
      this.onError(error, action);
      return "failed" as const;
    });
  }

  /** Shows an already-resolved target, e.g. a local photo that never leaves the device. */
  show(target: MorphTarget) {
    this.pending = target;
    this.release();
  }

  /** Begins the return to the sphere from wherever the morph currently is. */
  release() {
    if (this.phase === "forming" || this.phase === "holding") this.phase = "returning";
  }

  cancel() {
    this.request++;
    this.resolving?.abort();
    this.resolving = undefined;
    this.pending = null;
  }

  sample(elapsed: number) {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    if (this.phase === "sphere" && this.pending) {
      this.target = this.pending;
      this.pending = null;
      this.revision++;
      this.phase = "forming";
      this.progress = 0;
    } else if (this.phase === "forming") {
      this.progress = Math.min(1, this.progress + dt / transitionSeconds.form);
      if (this.progress >= 1) { this.phase = "holding"; this.holdLeft = this.target?.hold ?? 0; }
    } else if (this.phase === "holding") {
      this.holdLeft -= dt;
      if (this.holdLeft <= 0) this.phase = "returning";
    } else if (this.phase === "returning") {
      this.progress = Math.max(0, this.progress - dt / transitionSeconds.return);
      if (this.progress <= 0) this.phase = "sphere";
    }
    this.level = ease(this.progress);
    return this.level;
  }
}
