"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ParticleScene } from "@/particle/ParticleScene";
import type { RuntimeHandle, RuntimeInputs } from "@/particle/ParticleRuntime";
import { PresenceController } from "./controller";
import { StageNotice } from "./StageNotice";
import { stringsFor } from "./strings";

const DEBUG_BUILD = process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_SCF_DEBUG === "1";
const subscribeLanguage = (callback: () => void) => {
  window.addEventListener("languagechange", callback);
  return () => window.removeEventListener("languagechange", callback);
};

/**
 * The Presence: one full-screen particle body that hears, thinks, speaks and shows.
 * There is no chat panel or dashboard; the body is the interface. Only first-run setup and
 * connection problems ever put words on the stage.
 */
export default function Presence() {
  const language = useSyncExternalStore(subscribeLanguage, () => navigator.language, () => "en");
  const t = stringsFor(language);
  const [controller] = useState(() => new PresenceController());
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const [inputs] = useState<RuntimeInputs>(() => ({ presence: controller.engine, morph: controller.visual }));
  const [graphicsError, setGraphicsError] = useState<string | null>(null);
  const stage = useRef<HTMLElement>(null);
  const runtime = useRef<RuntimeHandle | null>(null);

  useEffect(() => {
    controller.start();
    const gesture = () => controller.gesture();
    document.addEventListener("pointerdown", gesture);
    document.addEventListener("keydown", gesture);
    return () => {
      document.removeEventListener("pointerdown", gesture);
      document.removeEventListener("keydown", gesture);
      controller.stop();
    };
  }, [controller]);

  // Development diagnostics (?debug=1). Independent of WebGPU, so Realtime can be inspected without graphics.
  useEffect(() => {
    const container = stage.current;
    if (!DEBUG_BUILD || new URLSearchParams(location.search).get("debug") !== "1" || !container) return;
    let detach: (() => void) | undefined, cancelled = false;
    void import("@/dev/debugPanel").then(({ attachDebugPanel }) => {
      if (!cancelled) detach = attachDebugPanel(container, { controller, runtime: () => runtime.current });
    });
    return () => { cancelled = true; detach?.(); };
  }, [controller]);

  const onGraphicsError = useCallback((code: string) => setGraphicsError(code), []);
  const onReady = useCallback((handle: RuntimeHandle) => { runtime.current = handle; }, []);

  return (
    <main className="presence" ref={stage}>
      <h1 className="sr-only">SCF Presence Realtime</h1>
      <ParticleScene inputs={inputs} label={t.stage} onError={onGraphicsError} onReady={onReady} />
      <StageNotice t={t} ui={ui} graphicsError={graphicsError}
        onAllow={() => controller.allowMicrophone()} onRetry={() => controller.retry()} />
    </main>
  );
}
