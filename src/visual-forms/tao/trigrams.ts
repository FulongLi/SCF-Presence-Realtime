/**
 * The eight trigrams (八卦 bāguà) as data. A line is 1 for yang (unbroken ⚊) and 0 for yin (broken ⚋);
 * lines are listed from the bottom up, the order in which a trigram is built and read.
 */
export type Line = 0 | 1;
export type TrigramName = "qian" | "dui" | "li" | "zhen" | "xun" | "kan" | "gen" | "kun";

export interface Trigram {
  name: TrigramName;
  /** Bottom, middle, top. */
  lines: readonly [Line, Line, Line];
  /** Simplified and traditional characters. */
  hanzi: readonly string[];
  pinyin: string;
  /** Its image in nature. */
  nature: string;
  /** The Unicode trigram symbol, U+2630 ☰ … U+2637 ☷. */
  symbol: string;
}

export const TRIGRAMS: Readonly<Record<TrigramName, Trigram>> = {
  qian: { name: "qian", lines: [1, 1, 1], hanzi: ["乾"], pinyin: "qián", nature: "heaven", symbol: "☰" },
  dui: { name: "dui", lines: [1, 1, 0], hanzi: ["兑", "兌"], pinyin: "duì", nature: "lake", symbol: "☱" },
  li: { name: "li", lines: [1, 0, 1], hanzi: ["离", "離"], pinyin: "lí", nature: "fire", symbol: "☲" },
  zhen: { name: "zhen", lines: [1, 0, 0], hanzi: ["震"], pinyin: "zhèn", nature: "thunder", symbol: "☳" },
  xun: { name: "xun", lines: [0, 1, 1], hanzi: ["巽"], pinyin: "xùn", nature: "wind", symbol: "☴" },
  kan: { name: "kan", lines: [0, 1, 0], hanzi: ["坎"], pinyin: "kǎn", nature: "water", symbol: "☵" },
  gen: { name: "gen", lines: [0, 0, 1], hanzi: ["艮"], pinyin: "gèn", nature: "mountain", symbol: "☶" },
  kun: { name: "kun", lines: [0, 0, 0], hanzi: ["坤"], pinyin: "kūn", nature: "earth", symbol: "☷" },
};

/** Fu Xi's order (乾兑离震巽坎艮坤), which is also the order of the Unicode trigram block. */
export const TRIGRAM_ORDER: readonly TrigramName[] = ["qian", "dui", "li", "zhen", "xun", "kan", "gen", "kun"];

/**
 * The two classical arrangements of the bagua, as the trigram at each compass direction. As on classical
 * Chinese diagrams, south is at the top and east on the left; the bottom line of each trigram faces the
 * centre.
 */
export type Direction = "S" | "SE" | "E" | "NE" | "N" | "NW" | "W" | "SW";
export const BAGUA_ARRANGEMENTS: Readonly<Record<"earlier-heaven" | "later-heaven", Readonly<Record<Direction, TrigramName>>>> = {
  /** 先天八卦, Fu Xi: heaven above, earth below, fire and water facing each other. */
  "earlier-heaven": { S: "qian", SE: "dui", E: "li", NE: "zhen", N: "kun", NW: "gen", W: "kan", SW: "xun" },
  /** 后天八卦, King Wen: fire in the south, water in the north. */
  "later-heaven": { S: "li", SE: "xun", E: "zhen", NE: "gen", N: "kan", NW: "qian", W: "dui", SW: "kun" },
};

/** Direction → angle in degrees on the drawing (0 = right, anticlockwise), with south at the top. */
export const DIRECTION_ANGLE: Readonly<Record<Direction, number>> = { S: 90, SE: 135, E: 180, NE: 225, N: 270, NW: 315, W: 0, SW: 45 };
