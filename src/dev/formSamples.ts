/**
 * The ?debug=1 acceptance set for visual forms: one click each, through the real ToolExecutor (show_form),
 * with no OpenAI and no network. Pure data, so tests can check every entry resolves to a registered form.
 */
export interface FormSample { label: string; group: "Tao" | "Astronomy" | "Astrology"; args: { form: string; variant?: string } }

export const FORM_SAMPLES: readonly FormSample[] = [
  { group: "Tao", label: "Yin Yang", args: { form: "tao.yin-yang" } },
  { group: "Tao", label: "Qian ☰", args: { form: "tao.qian" } },
  { group: "Tao", label: "Kun ☷", args: { form: "tao.kun" } },
  { group: "Tao", label: "Li ☲", args: { form: "tao.li" } },
  { group: "Tao", label: "Kan ☵", args: { form: "tao.kan" } },
  { group: "Tao", label: "Bagua", args: { form: "tao.bagua" } },
  { group: "Tao", label: "Bagua (Later Heaven)", args: { form: "tao.bagua", variant: "later-heaven" } },
  { group: "Astronomy", label: "Orion", args: { form: "astronomy.orion" } },
  { group: "Astronomy", label: "Ursa Major", args: { form: "astronomy.ursa-major" } },
  { group: "Astronomy", label: "Cassiopeia", args: { form: "astronomy.cassiopeia" } },
  { group: "Astronomy", label: "Pleiades", args: { form: "astronomy.pleiades" } },
  { group: "Astrology", label: "Aries ♈", args: { form: "astrology.aries" } },
  { group: "Astrology", label: "Leo ♌", args: { form: "astrology.leo" } },
  { group: "Astrology", label: "Scorpio ♏", args: { form: "astrology.scorpio" } },
  { group: "Astrology", label: "Pisces ♓", args: { form: "astrology.pisces" } },
];

/** ?debug=1 body → information → body tests: take the figure, show a form, and let it re-form as the figure. */
export const AION_TRANSFORM_TESTS: readonly { label: string; body: "figure" | "sphere"; form: { form: string } }[] = [
  { label: "Figure → Orion → Figure", body: "figure", form: { form: "astronomy.orion" } },
  { label: "Figure → Yin Yang → Figure", body: "figure", form: { form: "tao.yin-yang" } },
  { label: "Sphere → Orion → Sphere", body: "sphere", form: { form: "astronomy.orion" } },
];
