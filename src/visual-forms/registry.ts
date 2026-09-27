import type { MorphTarget } from "../visual-actions/types";
import type { FormCategory, FormRendering, VisualFormEntry, VisualFormPack } from "./types";

/** `<category>.<name>`: lower-case ASCII words joined by dashes. */
export const FORM_ID = /^[a-z][a-z0-9]*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Longest form name accepted from a tool call (an id or an alias). */
export const FORM_NAME_MAX = 60;

/**
 * Folds a free-form name for matching: accents removed (pinyin "Qián" → "qian"), lower case, possessives
 * and punctuation dropped, dashes and dots become spaces. Letters of every script, digits and symbols
 * (☯, ☰, ♈) are kept, so "Yin–Yang", "yin-yang" and "YIN YANG" are the same name.
 */
export function normalizeFormName(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’`]s\b/g, "").replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\p{S}]+/gu, " ").trim();
}

/** Words that never carry the name of a form ("the Pleiades", "a symbol of Aries"). */
const FILLER = new Set(["the", "a", "an", "of", "for", "symbol", "symbols", "glyph", "form", "shape", "icon", "picture", "diagram", "show", "me", "draw"]);

export interface FormMatch { entry: VisualFormEntry; variant?: string }

/** A rendered form, ready to become a MorphTarget. */
export interface RenderedForm extends FormRendering {
  entry: VisualFormEntry;
  variant?: string;
  transition?: MorphTarget["transition"];
}

/**
 * The registry of visual forms: ids, categories, aliases and variants, checked when packs are registered
 * (unique ids, ids prefixed by a known category, no alias naming two different forms), and a cache of
 * rendered targets (forms are deterministic, so each is drawn once).
 *
 * Lookup order for a free-form name:
 *   1. a form id ("tao.qian", any case);
 *   2. an alias ("yin yang", "太极", "♈", "big dipper");
 *   3. category hints: "Leo constellation" → hint astronomy, name "leo" → astronomy.leo; "fire trigram" → the
 *      term "fire" within tao;
 *   4. the name without filler words ("the Pleiades" → "pleiades");
 *   5. a form's own name when only one category has it ("ursa major" → astronomy.ursa-major).
 */
export class VisualFormRegistry {
  private readonly entries = new Map<string, VisualFormEntry>();
  private readonly categoryMap = new Map<string, FormCategory>();
  private readonly aliasMap = new Map<string, FormMatch>();
  private readonly names = new Map<string, VisualFormEntry[]>();
  /** Category-scoped terms: `${category} ${term}` → form. */
  private readonly terms = new Map<string, VisualFormEntry>();
  private readonly hints = new Map<string, string>();
  private readonly cache = new Map<string, RenderedForm>();

  constructor(packs: readonly VisualFormPack[] = []) {
    for (const pack of packs) this.register(pack);
  }

  register(pack: VisualFormPack) {
    for (const category of pack.categories) {
      if (!/^[a-z][a-z0-9]*$/.test(category.id) || this.categoryMap.has(category.id)) throw new Error(`visual-form-category-invalid: ${category.id}`);
      this.categoryMap.set(category.id, category);
      for (const hint of category.hints) {
        const key = normalizeFormName(hint);
        if (this.hints.has(key) && this.hints.get(key) !== category.id) throw new Error(`visual-form-hint-collision: ${key}`);
        this.hints.set(key, category.id);
      }
    }
    for (const entry of pack.forms) {
      if (!FORM_ID.test(entry.id)) throw new Error(`visual-form-id-invalid: ${entry.id}`);
      if (this.entries.has(entry.id)) throw new Error(`visual-form-id-duplicate: ${entry.id}`);
      if (!this.categoryMap.has(entry.category) || !entry.id.startsWith(`${entry.category}.`)) throw new Error(`visual-form-category-unknown: ${entry.id}`);
      if (!entry.label.trim()) throw new Error(`visual-form-label-missing: ${entry.id}`);
      const variants = entry.variants ?? [];
      if (new Set(variants.map(variant => variant.id)).size !== variants.length || variants.some(variant => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(variant.id))) {
        throw new Error(`visual-form-variant-invalid: ${entry.id}`);
      }
      this.entries.set(entry.id, entry);
      const name = entry.id.slice(entry.category.length + 1).replace(/-/g, " ");
      this.names.set(name, [...(this.names.get(name) ?? []), entry]);
      for (const alias of entry.aliases) this.alias(alias, { entry });
      for (const term of entry.terms ?? []) {
        const key = `${entry.category} ${normalizeFormName(term)}`;
        if (this.terms.has(key) && this.terms.get(key) !== entry) throw new Error(`visual-form-term-collision: ${key}`);
        this.terms.set(key, entry);
      }
      for (const variant of variants) for (const alias of variant.aliases ?? []) this.alias(alias, { entry, variant: variant.id });
    }
  }

  private alias(alias: string, match: FormMatch) {
    const key = normalizeFormName(alias);
    if (!key) throw new Error(`visual-form-alias-empty: ${match.entry.id}`);
    const existing = this.aliasMap.get(key);
    if (existing && (existing.entry !== match.entry || existing.variant !== match.variant)) {
      throw new Error(`visual-form-alias-collision: "${key}" (${existing.entry.id}, ${match.entry.id})`);
    }
    this.aliasMap.set(key, match);
  }

  get size() { return this.entries.size; }
  get(id: string) { return this.entries.get(id); }
  has(id: string) { return this.entries.has(id); }
  ids() { return [...this.entries.keys()]; }
  forms() { return [...this.entries.values()]; }
  categories() { return [...this.categoryMap.values()]; }
  category(id: string) { return this.categoryMap.get(id); }

  /** Finds the form a name refers to (see the lookup order above), or null. */
  lookup(query: string): FormMatch | null {
    if (typeof query !== "string" || !query.trim() || Array.from(query).length > FORM_NAME_MAX) return null;
    const id = this.entries.get(query.trim().toLowerCase());
    if (id) return { entry: id };
    const name = normalizeFormName(query);
    if (!name) return null;
    const alias = this.aliasMap.get(name);
    if (alias) return alias;
    const words = name.split(" ");
    const hinted = new Set(words.map(word => this.hints.get(word)).filter((value): value is string => Boolean(value)));
    const core = words.filter(word => !this.hints.has(word) && !FILLER.has(word)).join(" ");
    if (!core) return null;
    for (const category of hinted) {
      const scoped = this.inCategory(category, core);
      if (scoped) return scoped;
    }
    const plain = this.aliasMap.get(core);
    if (plain && (!hinted.size || hinted.has(plain.entry.category))) return plain;
    const named = this.names.get(core);
    return named?.length === 1 && (!hinted.size || hinted.has(named[0].category)) ? { entry: named[0] } : null;
  }

  /** A name within one category: its own form name, one of its terms, an alias of one of its forms, or an alias ending in a hint. */
  private inCategory(category: string, core: string): FormMatch | null {
    const own = this.entries.get(`${category}.${core.replace(/ /g, "-")}`) ?? this.terms.get(`${category} ${core}`);
    if (own) return { entry: own };
    const candidates = [core, ...(this.categoryMap.get(category)?.hints ?? []).map(hint => `${core} ${normalizeFormName(hint)}`)];
    for (const candidate of candidates) {
      const match = this.aliasMap.get(candidate);
      if (match?.entry.category === category) return match;
    }
    return null;
  }

  /** A variant of a form by its id or one of its aliases; undefined when the form has no such variant. */
  variant(entry: VisualFormEntry, value: unknown): string | undefined {
    if (typeof value !== "string" || !entry.variants?.length) return undefined;
    const key = normalizeFormName(value);
    return entry.variants.find(variant => normalizeFormName(variant.id) === key
      || (variant.aliases ?? []).some(alias => normalizeFormName(alias) === key))?.id;
  }

  /** A form's label, with its variant's when one is chosen, e.g. "Bagua (八卦) · Later Heaven (后天八卦, King Wen)". */
  label(id: string, variant?: string): string {
    const entry = this.entries.get(id);
    if (!entry) return id;
    const chosen = entry.variants?.find(item => item.id === variant);
    return chosen ? `${entry.label} · ${chosen.label}` : entry.label;
  }

  /** Renders a form (cached; rendered targets are shared and must be treated as read-only). */
  render(id: string, variant?: string): RenderedForm {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("form-not-found");
    const chosen = variant && entry.variants?.some(item => item.id === variant) ? variant : undefined;
    const key = `${id}#${chosen ?? ""}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const rendering = entry.render(chosen);
    const rendered: RenderedForm = { ...rendering, entry, variant: chosen, transition: this.categoryMap.get(entry.category)?.transition };
    this.cache.set(key, rendered);
    return rendered;
  }
}
