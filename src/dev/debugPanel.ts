import { SPECTRUM_BANDS } from "@/audio/spectrum";
import type { RuntimeHandle } from "@/particle/ParticleRuntime";
import { qualityTiers } from "@/particle/quality";
import type { PresenceController } from "@/presence/controller";
import { PRESENCE_MODES, type PresenceMode } from "@/presence/signal";
import { sessionPhase } from "@/realtime/state";
import { localPortrait } from "@/visual-actions/resolve";
import { SYMBOL_NAMES } from "@/visual-actions/types";
import { validateVisualAction } from "@/visual-actions/validate";

/**
 * Development diagnostics, loaded only for `?debug=1` in development builds (or with
 * NEXT_PUBLIC_SCF_DEBUG=1). It never sees the standard API key or the ephemeral secret.
 */
export function attachDebugPanel(container: HTMLElement, { controller, runtime }: {
  controller: PresenceController; runtime: () => RuntimeHandle | null;
}) {
  const { engine, visual, client, executor, assistant } = controller;
  const panel = document.createElement("aside");
  panel.className = "debug-panel";
  // Clicks inside the panel are not conversation gestures and must not move particles.
  panel.addEventListener("pointerdown", event => event.stopPropagation());
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", parent: HTMLElement = panel) => {
    const node = document.createElement(tag);
    node.textContent = text; parent.append(node);
    return node;
  };
  const button = (label: string, parent: HTMLElement, action: () => void) => {
    const node = el("button", label, parent); node.type = "button"; node.addEventListener("click", action);
    return node;
  };
  const section = (title: string, open = false) => {
    const group = el("details"); group.open = open; el("summary", title, group);
    return group;
  };
  el("strong", "SCF Presence Realtime · development");
  const now = () => performance.now() / 1000;
  const fixed = (value: number, digits = 2) => value.toFixed(digits);
  const age = (at: number | null | undefined) => at ? `${Math.round((performance.now() - at) / 1000)} s ago` : "—";

  const realtime = section("realtime", true);
  const realtimeOut = el("output", "", realtime);
  const connection = el("div", "", realtime);
  button("disconnect", connection, () => client.disconnect());
  button("reconnect", connection, () => { client.disconnect(); controller.retry(); });
  button("end (idle)", connection, () => client.disconnect("ended"));

  const conversation = section("conversation", true);
  const conversationOut = el("output", "", conversation);

  const audio = section("audio", true);
  const audioOut = el("output", "", audio);

  const tools = section("tools", true);
  const toolsOut = el("output", "", tools);
  // Native tool path without OpenAI: the same executor the Realtime function calls use.
  const toolRow = el("div", "", tools);
  const runTool = (name: string, args: unknown) => void executor.execute(name, JSON.stringify(args))
    .then(result => { lastManual = `${name} ${JSON.stringify(args)} → ${JSON.stringify(result.result)} (${result.ms} ms)`; });
  let lastManual = "";
  button("show_clock()", toolRow, () => runTool("show_clock", {}));
  button("show_portrait(Tesla)", toolRow, () => runTool("show_portrait", { person: "Nikola Tesla" }));
  button("show_number(42%)", toolRow, () => runTool("show_number", { value: "42%" }));
  button("bad args", toolRow, () => runTool("show_text", { value: "<script>" }));

  const actions = section("visual actions (direct)", true);
  const submit = (action: unknown) => {
    const valid = validateVisualAction(action);
    if (valid) void visual.submit(valid); else console.warn("Rejected Visual Action", action);
  };
  const actionRow = el("div", "", actions);
  button("sphere", actionRow, () => submit({ type: "sphere" }));
  button("clock", actionRow, () => submit({ type: "clock" }));
  button("15:42", actionRow, () => submit({ type: "clock", time: "15:42" }));
  button("42%", actionRow, () => submit({ type: "number", value: "42%" }));
  button("Hello", actionRow, () => submit({ type: "text", value: "Hello" }));
  const symbol = el("select", "", actions);
  for (const name of SYMBOL_NAMES) { const option = el("option", name, symbol); option.value = name; }
  button("symbol", actions, () => submit({ type: "symbol", value: symbol.value }));
  const person = el("input", "", actions);
  person.value = "Nikola Tesla";
  button("portrait", actions, () => submit({ type: "portrait", person: person.value.trim() }));
  const photo = el("input", "", actions);
  photo.type = "file"; photo.accept = "image/jpeg,image/png,image/webp";
  photo.addEventListener("change", () => {
    const file = photo.files?.[0];
    if (file) void localPortrait(file, file.name).then(target => visual.show(target), error => console.warn(error));
    photo.value = "";
  });

  const presence = section("presence", true);
  const presenceOut = el("output", "", presence);
  const states = el("div", "", presence);
  button("auto", states, () => { engine.override = null; });
  for (const mode of PRESENCE_MODES) button(mode, states, () => { engine.override = mode as PresenceMode; });
  const impulses = el("div", "", presence);
  button("focus impulse", impulses, () => { engine.focusImpulse.reset(); engine.triggerFocus(0.9, now()); });
  let synthetic = 0;
  const speech = button("synthetic speech: off", impulses, () => {
    if (synthetic) { clearInterval(synthetic); synthetic = 0; speech.textContent = "synthetic speech: off"; return; }
    speech.textContent = "synthetic speech: on";
    let t = 0;
    const bands = new Float32Array(SPECTRUM_BANDS);
    synthetic = window.setInterval(() => {
      t += 1 / 60;
      // Syllable-like bursts at ~4.5 Hz with phrase pauses: exercises the real speaking pipeline.
      const syllable = Math.max(0, Math.sin(t * Math.PI * 4.5)) ** 1.5;
      const phrase = Math.sin(t * 0.9) > -0.35 ? 1 : 0;
      const level = syllable * phrase * (0.45 + 0.35 * Math.sin(t * 1.7) ** 2);
      for (let i = 0; i < bands.length; i++) bands[i] = level * Math.exp(-((i - 5 - 3 * Math.sin(t * 2.3)) ** 2) / 8);
      engine.assistantAudio(level, bands, now());
    }, 1000 / 60);
  });

  const quality = section("quality");
  const tier = el("select", "", quality);
  qualityTiers.forEach((value, index) => { const option = el("option", `${index} · ${value.count}`, tier); option.value = String(index); });
  tier.addEventListener("change", () => runtime()?.setTier(Number(tier.value)));

  const transcripts = section("transcript (memory only)");
  const transcriptOut = el("output", "", transcripts);

  let tuningBuilt = false;
  const buildTuning = (handle: RuntimeHandle) => {
    tuningBuilt = true;
    for (const [name, values] of Object.entries(handle.config)) {
      const group = section(`tune · ${name}`);
      for (const [key, value] of Object.entries(values as Record<string, number>)) {
        if (name === "geometry" && key === "radius") continue;
        const label = el("label", key, group);
        const input = el("input", "", label);
        input.type = "number"; input.value = String(value); input.min = "0";
        input.max = String(Math.max(value * 3, 1)); input.step = String(value < 0.1 ? 0.001 : 0.05);
        input.addEventListener("change", () => {
          const next = Number(input.value);
          if (!Number.isFinite(next)) return;
          (values as Record<string, number>)[key] = Math.max(0, Math.min(Number(input.max), next));
          handle.tuning = true;
        });
      }
    }
  };

  container.append(panel);
  const timer = setInterval(() => {
    const s = client.state, ms = performance.now();
    const handle = runtime();
    if (handle && !tuningBuilt) buildTuning(handle);
    const u = s.usage;
    realtimeOut.textContent = [
      `phase ${sessionPhase(s, ms)}${s.error ? ` · error ${s.error}` : ""}`,
      `webrtc ${client.transport.peer} · data channel ${client.transport.channel}`,
      `model ${s.model ?? client.token?.model ?? "—"} · voice ${client.token?.voice ?? "—"}`,
      `session ${s.sessionId ? `${s.sessionId.slice(0, 12)}…` : "—"} · ${s.connectedAt ? `${Math.round((ms - s.connectedAt) / 1000)} s` : "—"}`,
      `responses ${s.responses} · tokens ${u.totalTokens} (in ${u.inputTokens} = audio ${u.inputAudioTokens} + text ${u.inputTextTokens}, cached ${u.cachedTokens}; out ${u.outputTokens} = audio ${u.outputAudioTokens} + text ${u.outputTextTokens})`,
    ].join("\n");
    conversationOut.textContent = [
      `user speaking (OpenAI VAD) ${s.userSpeaking}`,
      `response active ${s.responseActive} · audio buffer ${s.audioActive ? "playing" : "idle"}`,
      `interruptions ${s.interruptions}`,
    ].join("\n");
    const signal = engine.signal;
    audioOut.textContent = [
      `user amplitude ${fixed(signal.userAmplitude)} · VAD ${controller.listener.vad.voiced ? "voiced" : "quiet"}`,
      `assistant amplitude ${fixed(signal.assistantAmplitude)} · playback ${assistant.playback}`,
      `bands ${Array.from(signal.assistantBands, value => Math.round(value * 9)).join("")}`,
    ].join("\n");
    const last = client.tools.last;
    toolsOut.textContent = [
      last ? `last call ${last.name} ${age(last.at)}` : "last call —",
      last ? `arguments ${last.arguments || "{}"}` : "",
      last?.result ? `result ${JSON.stringify(last.result)}${last.ms !== undefined ? ` (${last.ms} ms)` : ""}` : last ? "result pending" : "",
      lastManual ? `manual ${lastManual}` : "",
    ].filter(Boolean).join("\n");
    const q = handle?.quality();
    if (q) tier.value = String(q.tier);
    presenceOut.textContent = [
      `${signal.mode}${engine.override ? " (forced)" : ""} · focus ${fixed(signal.acousticFocus)} · thinking ${fixed(signal.thinking)}`,
      `visual ${visual.phase} ${fixed(visual.level)} · ${visual.target ? visual.target.label : "sphere"}${visual.lastFailure ? ` · last failure ${visual.lastFailure}` : ""}`,
      q ? `quality tier ${q.tier}/${q.ceiling} · ${q.count} particles · ${fixed(q.frameMs, 1)} ms` : "quality — (no WebGPU runtime)",
    ].join("\n");
    transcriptOut.textContent = client.transcripts.map(entry => `${entry.role === "user" ? "you" : "ai"}: ${entry.text}`).join("\n") || "—";
  }, 150);
  return () => { clearInterval(timer); clearInterval(synthetic); panel.remove(); };
}
