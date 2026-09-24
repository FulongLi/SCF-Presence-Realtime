import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from "three";

export class PointerPusher {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  active = false;
  private initialized = false;
  private readonly ndc = new Vector2();
  private readonly ray = new Raycaster();
  private readonly plane = new Plane(new Vector3(0, 0, 1), 0);
  private readonly target = new Vector3();
  private readonly previous = new Vector3();
  private readonly move = (event: PointerEvent) => {
    const bounds = this.element.getBoundingClientRect();
    this.ndc.set((event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this.active = true;
  };
  private readonly leave = () => { this.active = false; this.initialized = false; this.velocity.set(0, 0, 0); };
  private readonly release = (event: PointerEvent) => { if (event.pointerType !== "mouse") this.leave(); };
  constructor(private readonly element: HTMLElement, private readonly camera: PerspectiveCamera) {
    element.addEventListener("pointermove", this.move);
    element.addEventListener("pointerdown", this.move);
    element.addEventListener("pointerleave", this.leave);
    element.addEventListener("pointercancel", this.leave);
    element.addEventListener("pointerup", this.release);
    window.addEventListener("blur", this.leave);
  }
  step(dt: number, follow: number, maxSpeed: number) {
    if (!this.active) { this.velocity.set(0, 0, 0); return; }
    this.ray.setFromCamera(this.ndc, this.camera);
    if (!this.ray.ray.intersectPlane(this.plane, this.target)) return;
    if (!this.initialized) { this.position.copy(this.target); this.initialized = true; }
    this.previous.copy(this.position);
    this.position.lerp(this.target, 1 - Math.exp(-follow * dt));
    this.velocity.subVectors(this.position, this.previous).divideScalar(dt).clampLength(0, maxSpeed);
  }
  reset() { this.leave(); }
  dispose() {
    this.element.removeEventListener("pointermove", this.move);
    this.element.removeEventListener("pointerdown", this.move);
    this.element.removeEventListener("pointerleave", this.leave);
    this.element.removeEventListener("pointercancel", this.leave);
    this.element.removeEventListener("pointerup", this.release);
    window.removeEventListener("blur", this.leave);
  }
}
