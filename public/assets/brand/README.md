# Curated brand assets

First-party visual assets for the particle body. They are resolved **locally** by the Visual Resolver's
`local-assets` provider (`src/visual-resolver/sources/localAssets.ts`) before any public image source.

| Asset | Expected file | Asked for as |
| --- | --- | --- |
| Spirit Connect logo | `spirit-connect-logo.svg` | "Spirit Connect logo", "our company logo", "company logo", … |

Place the real SVG here as `public/assets/brand/spirit-connect-logo.svg`. Until it exists, a request for
the logo fails with `image-unavailable` (by design, no web image is substituted).

SVG requirements: self-contained (no scripts, event handlers, `foreignObject`, or external `href`/`url()`
references; `#id` references and embedded PNG/JPEG/WebP data URIs are fine), ideally with a `viewBox`
and a transparent background. A plain opaque background is keyed out automatically.
