import type { VisualFormEntry, VisualFormPack } from "../types";
import { renderBagua, renderLine, renderTrigram, renderYinYang } from "./draw";
import { BAGUA_ARRANGEMENTS, TRIGRAM_ORDER, TRIGRAMS } from "./trigrams";

/**
 * The Tao / Eastern symbol pack: the yin-yang, the two lines, the eight trigrams and the bagua. Calm forms
 * in ink: they gather more slowly than information does, and the yin-yang and bagua turn slowly while
 * held, the way the taiji is drawn as a movement rather than a sign.
 */
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Clockwise, the way the bright fish swims: up the left side, head over the top. */
const SPIN = { yinYang: -0.12, bagua: -0.05 };

const trigramForms: VisualFormEntry[] = TRIGRAM_ORDER.map(name => {
  const trigram = TRIGRAMS[name];
  return {
    id: `tao.${name}`,
    category: "tao",
    renderer: "ink",
    label: `${capitalize(trigram.pinyin)} ${trigram.symbol} (${trigram.hanzi[0]}, ${capitalize(trigram.nature)})`,
    aliases: [name, trigram.symbol, ...trigram.hanzi, ...trigram.hanzi.map(character => `${character}卦`), `${trigram.nature} trigram`],
    terms: [trigram.nature],
    render: () => ({ visual: renderTrigram(name) }),
  };
});

export const taoPack: VisualFormPack = {
  id: "tao",
  categories: [{
    id: "tao", family: "tao", label: "Tao / Eastern symbols",
    hints: ["trigram", "trigrams", "gua", "taoist", "daoist"],
    transition: { form: 2.2, return: 1.7 },
  }],
  forms: [
    {
      id: "tao.yin-yang",
      category: "tao",
      renderer: "ink",
      label: "Yin-yang ☯ (太极)",
      aliases: ["yin yang", "yinyang", "yin and yang", "taiji", "tai ji", "taijitu", "taiji symbol", "tai chi", "taichi", "tai chi symbol",
        "☯", "太极", "太極", "太极图", "太極圖", "阴阳", "陰陽", "阴阳鱼", "陰陽魚"],
      render: () => ({ visual: renderYinYang(), spin: SPIN.yinYang }),
    },
    {
      id: "tao.yin-line",
      category: "tao",
      renderer: "ink",
      label: "Yin line ⚋ (阴爻)",
      aliases: ["yin line", "yin yao", "⚋", "阴爻", "陰爻"],
      render: () => ({ visual: renderLine(0) }),
    },
    {
      id: "tao.yang-line",
      category: "tao",
      renderer: "ink",
      label: "Yang line ⚊ (阳爻)",
      aliases: ["yang line", "yang yao", "⚊", "阳爻", "陽爻"],
      render: () => ({ visual: renderLine(1) }),
    },
    ...trigramForms,
    {
      id: "tao.bagua",
      category: "tao",
      renderer: "ink",
      label: "Bagua (八卦)",
      aliases: ["bagua", "ba gua", "pakua", "pa kua", "eight trigrams", "8 trigrams", "all eight trigrams", "八卦", "八卦图", "八卦圖"],
      variants: [
        { id: "earlier-heaven", label: "Earlier Heaven (先天八卦, Fu Xi)", aliases: ["先天八卦", "fu xi", "fuxi", "fu xi bagua", "earlier heaven bagua", "primordial bagua"] },
        { id: "later-heaven", label: "Later Heaven (后天八卦, King Wen)", aliases: ["后天八卦", "後天八卦", "king wen", "wen wang", "king wen bagua", "later heaven bagua", "manifested bagua"] },
      ],
      render: variant => ({ visual: renderBagua(variant === "later-heaven" ? "later-heaven" : "earlier-heaven"), spin: SPIN.bagua }),
    },
  ],
};

/** Exposed for tests and docs: every arrangement the bagua form can draw. */
export const BAGUA_VARIANTS = Object.keys(BAGUA_ARRANGEMENTS) as (keyof typeof BAGUA_ARRANGEMENTS)[];
