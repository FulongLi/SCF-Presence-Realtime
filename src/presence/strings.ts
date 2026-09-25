// The stage has almost no words; these are the few setup and status lines it may show, in two languages.
const en = {
  lang: "en",
  stage: "A particle sphere: the living visual body of a realtime voice AI",
  micTitle: "Talk with the presence",
  micBody: "While a session is open, your voice streams to OpenAI (Realtime or GPT-Live). The body's motion is computed on this device.",
  micAllow: "Allow microphone",
  micDenied: "The microphone is blocked. Allow it in your browser's site settings, then reload.",
  micUnavailable: "Voice needs a secure (HTTPS) page and a current browser with microphone access.",
  tapToBegin: "Tap anywhere to begin",
  tapToHear: "Tap anywhere to hear the voice",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  ended: "The session paused while quiet. Tap anywhere to resume.",
  retry: "Try again",
  errors: {
    "not-configured": "The server has no OpenAI API key. Add OPENAI_API_KEY to .env.local and restart.",
    "invalid-api-key": "OpenAI rejected the server's API key.",
    "forbidden-origin": "This page's origin may not start voice sessions.",
    "rate-limited": "OpenAI's rate limit was reached. Try again shortly.",
    "upstream-rejected": "OpenAI rejected the session configuration. Check the model and voice settings.",
    default: "The voice connection failed.",
  } as Record<string, string>,
  graphics: {
    "webgpu-unavailable": "This presence needs a browser with WebGPU enabled. Voice still works.",
    "webgpu-failed": "WebGPU could not start. Check that graphics acceleration is on.",
    "device-lost": "The graphics device stopped. Reload to restore the body.",
  } as Record<string, string>,
};
export type Strings = typeof en;

const zh: Strings = {
  lang: "zh-CN",
  stage: "一个粒子球：实时语音 AI 的视觉身体",
  micTitle: "与它对话",
  micBody: "会话开启时，你的声音会实时传送到 OpenAI（Realtime 或 GPT-Live）。粒子身体的运动只在本机计算。",
  micAllow: "允许麦克风",
  micDenied: "麦克风已被阻止。请在浏览器的网站设置中允许后刷新页面。",
  micUnavailable: "语音需要 HTTPS 页面和支持麦克风的较新浏览器。",
  tapToBegin: "轻触任意处开始",
  tapToHear: "轻触任意处以播放声音",
  connecting: "正在连接…",
  reconnecting: "正在重新连接…",
  ended: "安静一段时间后会话已暂停。轻触任意处继续。",
  retry: "重试",
  errors: {
    "not-configured": "服务器未配置 OpenAI API 密钥。请在 .env.local 中设置 OPENAI_API_KEY 并重启。",
    "invalid-api-key": "OpenAI 拒绝了服务器的 API 密钥。",
    "forbidden-origin": "此页面的来源无权开启语音会话。",
    "rate-limited": "已达到 OpenAI 速率限制，请稍后再试。",
    "upstream-rejected": "OpenAI 拒绝了会话配置，请检查模型和声音设置。",
    default: "语音连接失败。",
  },
  graphics: {
    "webgpu-unavailable": "需要启用 WebGPU 的浏览器。语音仍可使用。",
    "webgpu-failed": "WebGPU 无法启动，请确认已开启图形加速。",
    "device-lost": "图形设备已停止，请刷新页面。",
  },
};

export function stringsFor(language: string | undefined): Strings {
  return language?.toLowerCase().startsWith("zh") ? zh : en;
}
