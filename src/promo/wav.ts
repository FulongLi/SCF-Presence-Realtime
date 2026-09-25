/**
 * Minimal PCM WAV reading and writing (browser and Node): the promo's dialogue assets, the offline mix
 * handed to the export, and the preparation script's trimming all use it.
 */
export interface PcmAudio { sampleRate: number; channels: Float32Array[] }

export function decodeWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (bytes.length < 12 || text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error("wav-invalid");
  let offset = 12, format = 0, channels = 0, sampleRate = 0, bits = 0;
  let data: { start: number; length: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = text(offset);
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      // Streamed WAVs (e.g. from a speech API) may declare an unknown data length.
      if (size === 0xffffffff || body + size > bytes.length) size = bytes.length - body;
      data = { start: body, length: size };
      break;
    }
    offset = body + size + (size & 1);
  }
  if (!data || !channels || !sampleRate) throw new Error("wav-invalid");
  const pcm = format === 1 && (bits === 16 || bits === 24), float = format === 3 && bits === 32;
  if (!pcm && !float) throw new Error("wav-unsupported");
  const width = bits / 8, frames = Math.floor(data.length / (width * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const at = data.start + (i * channels + c) * width;
      out[c][i] = float ? view.getFloat32(at, true)
        : bits === 16 ? view.getInt16(at, true) / 32768
          : (((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8) >> 8) / 8388608;
    }
  }
  return { sampleRate, channels: out };
}

/** Interleaved PCM (16 or 24 bit), with triangular dither for 16 bit from a fixed seed. */
export function encodeWav(audio: PcmAudio, bits: 16 | 24 = 24): Uint8Array {
  const channels = audio.channels.length, frames = audio.channels[0]?.length ?? 0;
  const width = bits / 8, dataLength = frames * channels * width;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < 4; i++) bytes[offset + i] = value.charCodeAt(i); };
  write(0, "RIFF"); view.setUint32(4, 36 + dataLength, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * width, true);
  view.setUint16(32, channels * width, true); view.setUint16(34, bits, true);
  write(36, "data"); view.setUint32(40, dataLength, true);
  let seed = 0x2545f491;
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, audio.channels[c][i] || 0));
      if (bits === 16) {
        view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(sample * 32767 + noise() - noise()))), true);
      } else {
        const value = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388607)));
        bytes[at] = value & 0xff; bytes[at + 1] = (value >> 8) & 0xff; bytes[at + 2] = (value >> 16) & 0xff;
      }
      at += width;
    }
  }
  return bytes;
}
