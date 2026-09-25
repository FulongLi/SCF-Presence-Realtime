import type { SymbolName, VisualAction } from "../../visual-actions/types";
import { canvas, readCanvas } from "../transforms/raster";
import type { Raster } from "../types";

/**
 * Constructed visuals: text, numbers, clocks and symbols drawn on a canvas (browser only).
 * Rasters are sampled into particle positions; nothing is drawn on screen.
 */
const FONT = '600 {size}px "SF Pro Rounded", ui-rounded, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif';

const pad = (value: number) => String(value).padStart(2, "0");

/** The time a clock action should show: explicit time, else timestamp in local time, else now. */
export function clockText(action: Extract<VisualAction, { type: "clock" }>, now = new Date()) {
  if (action.time) return action.time;
  const date = action.timestamp !== undefined ? new Date(action.timestamp) : now;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A single line of text, fitted to at most 360 × 150 pixels. */
export function rasterizeText(text: string): Raster {
  const measure = canvas(8, 8);
  let size = 120;
  measure.font = FONT.replace("{size}", String(size));
  const width = measure.measureText(text).width;
  size = Math.max(40, Math.min(120, Math.floor(size * 330 / Math.max(1, width))));
  const context = canvas(Math.ceil(Math.min(360, width * size / 120 + size * 0.3)), Math.ceil(size * 1.25));
  context.font = FONT.replace("{size}", String(size));
  context.fillStyle = "#fff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, context.canvas.width / 2, context.canvas.height / 2 + size * 0.04);
  return readCanvas(context);
}

/** Symbols are drawn as paths so they never depend on installed symbol fonts. */
export function rasterizeSymbol(name: SymbolName): Raster {
  const c = canvas(160, 160);
  c.fillStyle = c.strokeStyle = "#fff";
  c.lineWidth = 20; c.lineCap = "round"; c.lineJoin = "round";
  const line = (...points: number[]) => {
    c.beginPath(); c.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1]);
    c.stroke();
  };
  switch (name) {
    case "check": line(36, 84, 68, 116, 126, 46); break;
    case "cross": line(44, 44, 116, 116); line(116, 44, 44, 116); break;
    case "plus": line(80, 34, 80, 126); line(34, 80, 126, 80); break;
    case "minus": line(34, 80, 126, 80); break;
    case "arrow-up": line(80, 128, 80, 36); line(44, 70, 80, 34, 116, 70); break;
    case "arrow-down": line(80, 32, 80, 124); line(44, 90, 80, 126, 116, 90); break;
    case "arrow-left": line(128, 80, 36, 80); line(70, 44, 34, 80, 70, 116); break;
    case "arrow-right": line(32, 80, 124, 80); line(90, 44, 126, 80, 90, 116); break;
    case "heart":
      c.beginPath(); c.moveTo(80, 132);
      c.bezierCurveTo(20, 92, 18, 40, 52, 34); c.bezierCurveTo(68, 31, 78, 42, 80, 52);
      c.bezierCurveTo(82, 42, 92, 31, 108, 34); c.bezierCurveTo(142, 40, 140, 92, 80, 132); c.fill(); break;
    case "star":
      c.beginPath();
      for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 26 : 62;
        c.lineTo(80 + Math.cos(angle) * r, 84 + Math.sin(angle) * r);
      }
      c.closePath(); c.fill(); break;
    case "question": case "exclamation":
      c.font = FONT.replace("{size}", "132"); c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(name === "question" ? "?" : "!", 80, 86); break;
  }
  return readCanvas(c);
}
