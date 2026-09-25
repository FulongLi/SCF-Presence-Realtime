import type { Metadata, Viewport } from "next";
import PromoExperience from "@/promo/PromoExperience";

export const metadata: Metadata = {
  title: "SCF Presence — Film",
  description: "What if AI could have a presence? A film performed live by the SCF particle body.",
};
export const viewport: Viewport = { themeColor: "#000000", colorScheme: "dark" };

/** The promotional film. It runs the product's own body and visual system; `/` is untouched by it. */
export default function PromoPage() {
  return <PromoExperience />;
}
