"use client";

import { useEffect, useRef } from "react";
import type { RuntimeHandle, RuntimeInputs } from "./ParticleRuntime";

export function ParticleScene({ inputs, label, onError, onReady }: {
  inputs: RuntimeInputs; label: string;
  onError: (code: string) => void; onReady?: (runtime: RuntimeHandle) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const lifetime = new AbortController();
    void import("./ParticleRuntime").then(({ createParticleRuntime }) =>
      createParticleRuntime(container, inputs, lifetime.signal, onError),
    ).then(runtime => {
      if (runtime && !lifetime.signal.aborted) onReady?.(runtime);
    }).catch((error: unknown) => {
      if (!lifetime.signal.aborted) onError(error instanceof Error ? error.message : "webgpu-failed");
    });
    return () => lifetime.abort();
  }, [inputs, onError, onReady]);
  return <div className="particle-stage" ref={host} role="img" aria-label={label} />;
}
