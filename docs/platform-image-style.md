# Tile Hero Image — Generation Style Guide

Single source of truth for every **generated** tile hero image on the Platform
pass studio. The block between the `STYLE_DIRECTIVE` markers below is injected
**verbatim** into each generation prompt by `lib/platform/image-style.ts` (it is
re-read per call, so edits take effect with no redeploy). The subject of the
image comes from the tile's title + description; this file governs the *look*.

The generated image is always **duotone-mapped to the brand palette** afterward,
so the model's job is composition, subject, and light — **not** final colour.
Generate at medium quality; we re-grade regardless.

## Non-negotiables (every image)
- 3:4 portrait (tiles render at 300×400).
- NO text, letters, numbers, logos, or watermarks anywhere in the image.
- Keep the **top third visually calm / darker** — a title is overlaid there.
- One clear subject. No collage, no split scenes, no busy backgrounds.
- Natural, cinematic, directional light. Editorial, restrained, premium.
- Muted, near-monochromatic tonality (we recolour it anyway).

## Avoid
- Stock-photo cheese: staged smiles, thumbs-up, corporate handshakes.
- Oversaturation, HDR look, heavy vignetting (we add our own).
- Hard geometry near the top that fights the overlaid title.

> **Faces:** allowed for now — we're trying it. If generated faces start coming
> back uncanny, add "no tight face close-ups; figures in profile or from behind"
> to the directive below.

## Composition
- Subject lower-center or lower-third; breathing room at the top.
- Rule of thirds; one strong focal point; generous negative space.

## Subject direction by theme
(Encoded in `SUBJECT_RULES` in `lib/platform/image-style.ts` — keep in sync.)
- Conversation / coaching → two people mid-conversation, warm side light.
- Team / culture → a small group working together in a warm modern room.
- Assessment / scoring / journaling → hands with a notebook on a desk.
- Strategy / systems / method → a lone figure in a large architectural space.
- Faith / worship → a quiet, contemplative moment in soft window light.
- Fitness / discipline → an athletic training moment in early light.
- Mindset / inner / guarding → a solitary figure at a threshold or horizon.
- Intro / foundation / journey → an open landscape at first light, a path.

## STYLE DIRECTIVE (injected into every prompt)
<!-- STYLE_DIRECTIVE:START -->
> Cinematic editorial photograph. Natural directional light, shallow depth of
> field, muted near-monochromatic palette, premium and restrained. A calm,
> darker top third with negative space for a title. A single clear subject.
> No text, no letters, no numbers, no logos, no watermark. 3:4 portrait.
<!-- STYLE_DIRECTIVE:END -->

## Provider status
- **Live provider:** OpenAI `gpt-image-1` (portrait `1024x1536`, quality
  `medium`). Not yet wired — the pipeline currently returns a placeholder from
  `lib/platform/image-generate.ts`. To go live: implement the commented seam
  there and set `OPENAI_API_KEY` in Doppler (`gpt-image-1` needs OpenAI org
  verification first).
