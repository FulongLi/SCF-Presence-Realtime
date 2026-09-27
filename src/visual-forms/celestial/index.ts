import type { VisualFormEntry, VisualFormPack } from "../types";
import { PLANET_GLYPHS, PLANETS, ZODIAC_GLYPHS, ZODIAC_SIGNS, type Planet, type ZodiacSign } from "./astrology/glyphs";
import { renderStarGlyph } from "./astrology/starGlyph";
import type { ConstellationData } from "./astronomy/catalog";
import { CONSTELLATIONS } from "./astronomy/constellations";
import { renderStarMap } from "./astronomy/starMap";

/**
 * The celestial pack, in two deliberately separate categories:
 * - astronomy: constellations as star maps, from catalogue positions and magnitudes;
 * - astrology: the zodiac signs and planetary symbols as glyphs drawn in stars.
 * Both share the celestial look (sparse, deep, faint dust); neither searches for images.
 */
const TRANSITION = { form: 2, return: 1.6 };

/** Names beyond the constellation's own, per constellation id. */
const CONSTELLATION_ALIASES: Readonly<Record<string, { aliases: string[]; terms?: string[] }>> = {
  orion: { aliases: ["orion", "orion the hunter", "猎户座", "獵戶座"], terms: ["hunter"] },
  "ursa-major": { aliases: ["ursa major", "great bear", "big dipper", "plough", "the plough", "plow", "大熊座", "北斗七星", "北斗"], terms: ["bear"] },
  cassiopeia: { aliases: ["cassiopeia", "仙后座"], terms: ["queen", "w"] },
  scorpius: { aliases: ["scorpius", "scorpio constellation"] },
  leo: { aliases: ["leo constellation"] },
  cygnus: { aliases: ["cygnus", "northern cross", "天鹅座", "天鵝座"], terms: ["swan"] },
  pleiades: { aliases: ["pleiades", "seven sisters", "m45", "昴星团", "昴星團", "昴宿"] },
};

const constellationForm = (data: ConstellationData): VisualFormEntry => ({
  id: `astronomy.${data.id}`,
  category: "astronomy",
  renderer: "star-map",
  label: data.id === "pleiades" ? "Pleiades (star cluster)" : `${data.name} (constellation)`,
  aliases: CONSTELLATION_ALIASES[data.id]?.aliases ?? [data.name],
  terms: CONSTELLATION_ALIASES[data.id]?.terms,
  // Only a figure with lines has a line-less variant.
  variants: data.lines.length ? [{ id: "lines", label: "with its figure" }, { id: "stars", label: "stars only" }] : undefined,
  render: variant => ({ visual: renderStarMap(data, { lines: variant !== "stars" }) }),
});

interface GlyphNames { symbol: string; name: string; zh: string[]; terms: string[] }

const ZODIAC: Readonly<Record<ZodiacSign, GlyphNames>> = {
  aries: { symbol: "♈", name: "Aries", zh: ["白羊座"], terms: ["ram"] },
  taurus: { symbol: "♉", name: "Taurus", zh: ["金牛座"], terms: ["bull"] },
  gemini: { symbol: "♊", name: "Gemini", zh: ["双子座", "雙子座"], terms: ["twins"] },
  cancer: { symbol: "♋", name: "Cancer", zh: ["巨蟹座"], terms: ["crab"] },
  leo: { symbol: "♌", name: "Leo", zh: ["狮子座", "獅子座"], terms: ["lion"] },
  virgo: { symbol: "♍", name: "Virgo", zh: ["处女座", "處女座"], terms: ["maiden", "virgin"] },
  libra: { symbol: "♎", name: "Libra", zh: ["天秤座"], terms: ["scales", "balance"] },
  scorpio: { symbol: "♏", name: "Scorpio", zh: ["天蝎座", "天蠍座"], terms: ["scorpion"] },
  sagittarius: { symbol: "♐", name: "Sagittarius", zh: ["射手座", "人马座", "人馬座"], terms: ["archer", "centaur"] },
  capricorn: { symbol: "♑", name: "Capricorn", zh: ["摩羯座", "山羊座"], terms: ["goat", "sea goat"] },
  aquarius: { symbol: "♒", name: "Aquarius", zh: ["水瓶座", "宝瓶座", "寶瓶座"], terms: ["water bearer", "water carrier"] },
  pisces: { symbol: "♓", name: "Pisces", zh: ["双鱼座", "雙魚座"], terms: ["fish", "fishes"] },
};

const PLANET_NAMES: Readonly<Record<Planet, GlyphNames>> = {
  sun: { symbol: "☉", name: "Sun", zh: ["太阳符号"], terms: ["sun", "solar"] },
  moon: { symbol: "☽", name: "Moon", zh: ["月亮符号"], terms: ["moon", "lunar", "crescent"] },
  mercury: { symbol: "☿", name: "Mercury", zh: ["水星符号"], terms: [] },
  venus: { symbol: "♀", name: "Venus", zh: ["金星符号"], terms: [] },
  mars: { symbol: "♂", name: "Mars", zh: ["火星符号"], terms: [] },
  jupiter: { symbol: "♃", name: "Jupiter", zh: ["木星符号"], terms: [] },
  saturn: { symbol: "♄", name: "Saturn", zh: ["土星符号"], terms: [] },
};

/** Extra names that are not simply "<name> symbol". */
const PLANET_EXTRA: Partial<Record<Planet, string[]>> = { moon: ["☾", "crescent moon symbol"], venus: ["female symbol"], mars: ["male symbol"] };

const zodiacForm = (sign: ZodiacSign): VisualFormEntry => {
  const names = ZODIAC[sign];
  return {
    id: `astrology.${sign}`,
    category: "astrology",
    renderer: "star-glyph",
    label: `${names.name} ${names.symbol} (zodiac sign)`,
    aliases: [sign, names.symbol, ...names.zh],
    terms: names.terms,
    render: () => ({ visual: renderStarGlyph(ZODIAC_GLYPHS[sign]()) }),
  };
};

const planetForm = (planet: Planet): VisualFormEntry => {
  const names = PLANET_NAMES[planet];
  return {
    id: `astrology.${planet}`,
    category: "astrology",
    renderer: "star-glyph",
    label: `${names.name} ${names.symbol} (planetary symbol)`,
    aliases: [`${planet} symbol`, `${planet} glyph`, names.symbol, ...names.zh, ...(PLANET_EXTRA[planet] ?? [])],
    terms: names.terms,
    render: () => ({ visual: renderStarGlyph(PLANET_GLYPHS[planet](), planet === "sun" ? [{ x: 0, y: 0, size: 2.6 }] : []) }),
  };
};

export const celestialPack: VisualFormPack = {
  id: "celestial",
  categories: [
    { id: "astronomy", family: "celestial", label: "Astronomy · constellations", hints: ["constellation", "constellations", "asterism"], transition: TRANSITION },
    {
      id: "astrology", family: "celestial", label: "Astrology · zodiac and planetary symbols",
      hints: ["zodiac", "sign", "signs", "horoscope", "astrology", "astrological", "planet", "planetary"], transition: TRANSITION,
    },
  ],
  forms: [...CONSTELLATIONS.map(constellationForm), ...ZODIAC_SIGNS.map(zodiacForm), ...PLANETS.map(planetForm)],
};
