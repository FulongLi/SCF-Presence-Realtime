import { SPECTRUM_BANDS } from "@/audio/spectrum";
import { bodyLabel, bodyTransition, PERSISTENT_BODIES } from "@/aion/body";
import { AION_STATES, isGesture, type AionState } from "@/aion/state";
import type { RuntimeHandle } from "@/particle/ParticleRuntime";
import { qualityTiers } from "@/particle/quality";
import type { PresenceController } from "@/presence/controller";
import { PRESENCE_MODES, type PresenceMode } from "@/presence/signal";
import { livePhase } from "@/live/state";
import { sessionPhase } from "@/realtime/state";
import { VOICE_BACKEND_LABELS, VOICE_BACKENDS, type VoiceBackend } from "@/voice/backend";
import { LOCAL_ASSETS } from "@/visual-resolver";
import { IMAGE_INTENTS, SYMBOL_NAMES, TERRAIN_STYLES } from "@/visual-actions/types";
import { validateVisualAction } from "@/visual-actions/validate";
import { visualForms } from "@/visual-forms";
import { AION_TRANSFORM_TESTS, FORM_SAMPLES } from "./formSamples";

/**
 * Development diagnostics, loaded only for `?debug=1` in development builds (or with
 * NEXT_PUBLIC_SCF_DEBUG=1). It never sees the standard API key or the ephemeral secret.
 * Both voice backends are shown side by side in the same terms, for manual A/B comparison.
 */
export function attachDebugPanel(container: HTMLElement, { controller, runtime }: {
  controller: PresenceController; runtime: () => RuntimeHandle | null;
}) {
  const { engine, visual, executor, assistant, resolver, aion } = controller;
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
  el("strong", "SCF Presence · development");
  const now = () => performance.now() / 1000;
  const fixed = (value: number, digits = 2) => value.toFixed(digits);
  const age = (at: number | null | undefined) => at ? `${Math.round((performance.now() - at) / 1000)} s ago` : "—";

  // Aion: identity, persistent body and body-language state, each testable without the model.
  const aionSection = section(aion.identity.name, true);
  const aionOut = el("output", "", aionSection);
  let lastAion = "";
  const identityRow = el("div", "", aionSection);
  button("greet", identityRow, () => { lastAion = controller.greet() ? "greeting sent" : "greeting not sent (not connected or busy)"; });
  button("onboarding", identityRow, () => { lastAion = controller.onboard() ? "onboarding sent" : "onboarding not sent (not connected or busy)"; });
  const bodyRow = el("div", "", aionSection);
  el("span", "body ", bodyRow);
  for (const body of PERSISTENT_BODIES) button(body.label, bodyRow, () => { controller.setBody(body.id); });
  const stateRow = el("div", "", aionSection);
  el("span", "state ", stateRow);
  button("auto", stateRow, () => aion.state.force(null));
  // Held states are forced; gestures (greeting, acknowledging, curious) play once.
  for (const state of AION_STATES) {
    button(state, stateRow, () => {
      if (isGesture(state)) { aion.state.force(null); aion.gesture(state); } else aion.state.force(state as AionState);
    });
  }
  const transformRow = el("div", "", aionSection);
  el("span", "transform ", transformRow);
  // Body → information → body: the visual dissolves out of the figure and re-forms into it.
  for (const test of AION_TRANSFORM_TESTS) {
    button(test.label, transformRow, () => {
      // Let the body finish re-forming first, so the visual clearly dissolves out of it.
      const wait = controller.setBody(test.body) || aion.body.transitioning ? bodyTransition.seconds * 1000 + 400 : 0;
      setTimeout(() => runTool("show_form", test.form), wait);
    });
  }

  const voice = section("voice backend", true);
  // A/B: switch the backend on the same microphone; the choice is kept in the URL (?voice=) for reloads.
  const selector = el("div", "", voice);
  const backendButtons = VOICE_BACKENDS.map(name => {
    const node = button(VOICE_BACKEND_LABELS[name], selector, () => {
      controller.setBackend(name as VoiceBackend);
      const url = new URL(location.href);
      url.searchParams.set("voice", name);
      history.replaceState(history.state, "", url);
    });
    return [name, node] as const;
  });
  const voiceOut = el("output", "", voice);
  const connection = el("div", "", voice);
  button("disconnect", connection, () => controller.client.disconnect());
  button("reconnect", connection, () => { controller.client.disconnect(); controller.retry(); });
  button("end (idle)", connection, () => controller.client.disconnect("ended"));

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
  // The manual acceptance set: the resolver and body without depending on what the model decides.
  const manual: [string, string, Record<string, unknown>][] = [
    ["portrait: Nikola Tesla", "show_portrait", { person: "Nikola Tesla" }],
    ["image: Tesla Model Y", "show_image", { query: "Tesla Model Y", intent: "vehicle" }],
    ["image: Taylor Swift", "show_image", { query: "Taylor Swift", intent: "celebrity" }],
    ["image: concept car", "show_image", { query: "futuristic concept car", intent: "reference" }],
    // Curated first-party asset: exercises the local-asset resolver (no OpenAI, no web search).
    ...LOCAL_ASSETS.map(asset => [`local asset: ${asset.brand} ${asset.type}`, "show_image", { query: `${asset.brand} ${asset.type}` }] as [string, string, Record<string, unknown>]),
    ["terrain: Wales", "show_terrain", { region: "Wales", style: "terrain" }],
    ["terrain: United Kingdom", "show_terrain", { region: "United Kingdom", style: "topography" }],
    ["clock", "show_clock", {}],
    ["text: Hello", "show_text", { value: "Hello" }],
    ["number: 42%", "show_number", { value: "42%" }],
    ["symbol: check", "show_symbol", { symbol: "check" }],
    // Emoji are drawn locally from the system emoji font: no OpenAI, no network, no image search.
    ...["😊", "🤔", "🎉", "🚀", "❤️", "👨‍🚀", "🇬🇧"].map(emoji => [`emoji: ${emoji}`, "show_emoji", { emoji }] as [string, string, Record<string, unknown>]),
    ["sphere", "return_to_sphere", {}],
    ["bad args", "show_text", { value: "<script>" }],
    ["bad emoji: 😊😂", "show_emoji", { emoji: "😊😂" }],
  ];
  for (const [label, name, args] of manual) button(label, toolRow, () => runTool(name, args));
  const imageRow = el("div", "", tools);
  const query = el("input", "", imageRow);
  query.placeholder = "image query"; query.value = "wind turbine";
  const intent = el("select", "", imageRow);
  for (const name of IMAGE_INTENTS) { const option = el("option", name, intent); option.value = name; }
  intent.value = "general";
  button("show_image", imageRow, () => runTool("show_image", { query: query.value.trim(), intent: intent.value }));
  const emojiRow = el("div", "", tools);
  const emoji = el("input", "", emojiRow);
  emoji.placeholder = "one emoji"; emoji.value = "💡"; emoji.size = 6;
  // Sent as typed (only trimmed): invalid input reports invalid-arguments under "manual" above.
  button("show_emoji", emojiRow, () => runTool("show_emoji", { emoji: emoji.value.trim() }));
  const terrainRow = el("div", "", tools);
  const region = el("input", "", terrainRow);
  region.placeholder = "region"; region.value = "Swiss Alps";
  const terrainStyle = el("select", "", terrainRow);
  for (const name of TERRAIN_STYLES) { const option = el("option", name, terrainStyle); option.value = name; }
  button("show_terrain", terrainRow, () => runTool("show_terrain", { region: region.value.trim(), style: terrainStyle.value }));

  // Visual forms: SCF's own visual language, drawn procedurally (no OpenAI, no network, no image search).
  const forms = section("visual forms", true);
  for (const group of ["Tao", "Astronomy", "Astrology"] as const) {
    const row = el("div", "", forms);
    el("span", `${group} `, row);
    for (const sample of FORM_SAMPLES.filter(item => item.group === group)) button(sample.label, row, () => runTool("show_form", sample.args));
  }
  const formRow = el("div", "", forms);
  const formPick = el("select", "", formRow);
  for (const form of visualForms.forms()) { const option = el("option", `${form.id} · ${form.label}`, formPick); option.value = form.id; }
  button("show", formRow, () => runTool("show_form", { form: formPick.value }));
  const freeRow = el("div", "", forms);
  const formName = el("input", "", freeRow);
  // Any id or name, sent as typed: aliases ("yin yang", "猎户座", "Leo zodiac sign") and misses (form-not-found).
  formName.placeholder = "form id or name"; formName.value = "Leo constellation";
  const formVariant = el("input", "", freeRow);
  formVariant.placeholder = "variant (optional)"; formVariant.size = 12;
  button("show_form", freeRow, () => runTool("show_form", {
    form: formName.value.trim(), ...(formVariant.value.trim() ? { variant: formVariant.value.trim() } : {}),
  }));

  const resolving = section("visual resolver", true);
  const resolverOut = el("output", "", resolving);

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
  // A local file never leaves the device: as a portrait, an object, or a grayscale heightmap (2.5D).
  const localAs = el("select", "", actions);
  for (const name of ["portrait", "object", "heightmap"]) { const option = el("option", `local file as ${name}`, localAs); option.value = name; }
  const photo = el("input", "", actions);
  photo.type = "file"; photo.accept = "image/jpeg,image/png,image/webp";
  photo.addEventListener("change", () => {
    const file = photo.files?.[0];
    const as = localAs.value as "portrait" | "object" | "heightmap";
    if (file) void resolver.local(file, file.name, as).then(target => visual.show(target), error => console.warn(error));
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
  const ms = (value: number | null) => value === null ? "—" : `${value} ms`;
  const session = (id: string | null, connectedAt: number | null, now: number) =>
    `session ${id ? `${id.slice(0, 14)}…` : "—"} · ${connectedAt ? `${Math.round((now - connectedAt) / 1000)} s` : "—"}`;

  const timer = setInterval(() => {
    const client = controller.client, now = performance.now();
    const handle = runtime();
    if (handle && !tuningBuilt) buildTuning(handle);
    for (const [name, node] of backendButtons) node.disabled = name === controller.backend;
    const t = controller.timings;
    const timings = `timing: connect ${ms(t.connectMs)} · speech end → audio ${ms(t.replyMs)} · tool result → audio ${ms(t.resultToAudioMs)}`;
    if (client.backend === "realtime") {
      const s = client.state, u = s.usage;
      voiceOut.textContent = [
        `backend realtime · phase ${sessionPhase(s, now)}${s.error ? ` · error ${s.error}` : ""}`,
        `webrtc ${client.transport.peer} · data channel ${client.transport.channel}`,
        `model ${s.model ?? client.token?.model ?? "—"} · voice ${client.token?.voice ?? "—"}`,
        session(s.sessionId, s.connectedAt, now),
        `responses ${s.responses} · tokens ${u.totalTokens} (in ${u.inputTokens} = audio ${u.inputAudioTokens} + text ${u.inputTextTokens}, cached ${u.cachedTokens}; out ${u.outputTokens} = audio ${u.outputAudioTokens} + text ${u.outputTextTokens})`,
        timings,
      ].join("\n");
      conversationOut.textContent = [
        `user speaking (OpenAI VAD) ${s.userSpeaking}`,
        `response active ${s.responseActive} · audio buffer ${s.audioActive ? "playing" : "idle"}`,
        `interruptions ${s.interruptions}`,
      ].join("\n");
    } else {
      const s = client.state, u = s.backendUsage, d = client.delegation.stats, close = client.lastClose;
      voiceOut.textContent = [
        `backend live · phase ${livePhase(s, now)}${s.error ? ` · error ${s.error}` : ""}`,
        `webrtc ${client.transport.peer} · ice ${client.transport.ice} · data channel ${client.transport.channel}`,
        `live model ${s.model ?? "—"} · backend model ${s.backendModel ?? "—"} · voice ${s.voice ?? "—"}`,
        session(s.sessionId, s.connectedAt, now),
        `voice duration ${s.usageSeconds.toFixed(1)} s${s.contextRatio !== null ? ` · context ${(s.contextRatio * 100).toFixed(0)}%` : ""}`
          + ` · backend tokens ${u.totalTokens} (in ${u.inputTokens}, cached ${u.cachedTokens}; out ${u.outputTokens})`,
        `delegations ${d.delegations} · active ${client.delegation.active} · backend responses ${d.backendResponses} · function calls ${d.functionCalls} · continuations ${d.continuations}`,
        `${timings} · delegation → call ${ms(d.delegationToCallMs)}`,
        close ? `last close ${close.reason}${close.confirmed ? "" : " (final usage unconfirmed)"} · ${close.seconds.toFixed(1)} s` : "",
      ].filter(Boolean).join("\n");
      conversationOut.textContent = [
        `user heard (input transcript) ${s.userHeardAt !== null && now - s.userHeardAt < 900} · assistant transcript ${s.assistantHeardAt !== null && now - s.assistantHeardAt < 900}`,
        `delegating ${s.delegationsActive > 0} · tools active ${s.toolsActive}`,
        `full-duplex cuts (assistant audio stopped under the user) ${engine.cuts}`,
      ].join("\n");
    }
    const signal = engine.signal;
    audioOut.textContent = [
      `user amplitude ${fixed(signal.userAmplitude)} · VAD ${controller.listener.vad.voiced ? "voiced" : "quiet"}`,
      `assistant amplitude ${fixed(signal.assistantAmplitude)} · playback ${assistant.playback}`,
      `bands ${Array.from(signal.assistantBands, value => Math.round(value * 9)).join("")}`,
    ].join("\n");
    const last = client.backend === "realtime" ? client.tools.last : client.delegation.last;
    toolsOut.textContent = [
      last ? `last call ${last.name} ${age(last.at)}` : "last call —",
      last ? `arguments ${last.arguments || "{}"}` : "",
      last?.result ? `result ${JSON.stringify(last.result)}${last.ms !== undefined ? ` (${last.ms} ms)` : ""}` : last ? "result pending" : "",
      lastManual ? `manual ${lastManual}` : "",
    ].filter(Boolean).join("\n");
    const trace = resolver.lastTrace;
    resolverOut.textContent = trace ? [
      `${trace.action}${trace.query ? ` "${trace.query}"` : ""}${trace.intent ? ` · ${trace.intent}` : ""} → ${trace.status}${trace.error ? ` (${trace.error})` : ""}`,
      ...trace.chain.map((step, index) => `  ${index + 1}. ${step.provider}: ${step.outcome} · ${step.ms} ms`),
      trace.provider ? `provider ${trace.provider}${trace.sourceType ? ` · ${trace.sourceType}` : ""}` : "",
      trace.source ? `source ${trace.source.slice(0, 140)}` : "",
      trace.targetType ? `target ${trace.targetType}${trace.targetStyle ? `/${trace.targetStyle}` : ""}${trace.raster ? ` · raster ${trace.raster.width}×${trace.raster.height}` : ""}`
        + (trace.layout ? ` · layout ${trace.layout.points} points, ${trace.layout.strokes} strokes` : "") : "",
      trace.field ? `height field ${trace.field.width}×${trace.field.height} · normalized ${fixed(trace.field.min)}–${fixed(trace.field.max)}`
        + (trace.field.elevation ? ` · ${trace.field.elevation.min}–${trace.field.elevation.max} m` : "") : "",
      `fetch ${trace.fetchMs} ms · resolve ${trace.resolveMs ?? "…"} ms`,
    ].filter(Boolean).join("\n") : "—";
    const q = handle?.quality();
    if (q) tier.value = String(q.tier);
    aionOut.textContent = [
      `${aion.identity.name} · ${aion.identity.product} · ${aion.identity.creatorCompany} / ${aion.identity.leadCreator}`,
      `Body: ${bodyLabel(aion.currentBody)}${aion.body.transitioning ? ` (re-forming ${fixed(aion.body.level)})` : ""}`,
      `State: ${aion.currentState}${aion.state.override ? " (forced)" : ""} · greeting ${aion.greeting.status}`,
      lastAion,
    ].filter(Boolean).join("\n");
    presenceOut.textContent = [
      `${signal.mode}${engine.override ? " (forced)" : ""} · focus ${fixed(signal.acousticFocus)} · thinking ${fixed(signal.thinking)}`,
      `visual ${visual.phase} ${fixed(visual.level)} · ${visual.target ? visual.target.label : "sphere"}${visual.lastFailure ? ` · last failure ${visual.lastFailure}` : ""}`,
      q ? `quality tier ${q.tier}/${q.ceiling} · ${q.count} particles · ${fixed(q.frameMs, 1)} ms` : "quality — (no WebGPU runtime)",
    ].join("\n");
    transcriptOut.textContent = client.transcripts.map(entry => `${entry.role === "user" ? "you" : "ai"}: ${entry.text}`).join("\n") || "—";
  }, 150);
  return () => { clearInterval(timer); clearInterval(synthetic); panel.remove(); };
}
