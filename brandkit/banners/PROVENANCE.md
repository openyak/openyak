# Banner provenance

See the [brandkit guide](../README.md) for reusable visual rules. All source paths
below are relative to the repository root unless linked otherwise.

## Current banner

[`readme-dark.png`](readme-dark.png) is AI-generated brand artwork, not a product screenshot. It was
redesigned with the built-in `image_gen` tool using the existing App logo at
`app/src/main/assets/macos-icon-1024.png` as the authoritative visual reference.
The original App icon is unchanged. The banner uses its yellow/white/teal palette,
forward-leaning letterforms, black edging and white sticker contour. This is a
generated adaptation, not a claim of pixel-identical logo compositing.

The final 2172 × 724 image was copied without post-processing. Both READMEs now
reference `brandkit/banners/readme-dark.png` (formerly `docs/images/banner-v2.png`). The previous banner is
recoverable from Git history (commit `6be6a2de`).

Initial redesign prompt (old banner as image 1, App logo as image 2):

```text
Use case: compositing
Asset type: replacement OpenYak GitHub README banner, wide 3:1 landscape.
Input images: Image 1 is the old banner to completely redesign; retain only its brand name and tagline. Image 2 is the authoritative existing OpenYak app logo: preserve its YAK silhouette, slant, cream-yellow Y, white A, teal-blue K, thick black letter outlines and white outer sticker contour. Do not redesign or reinterpret the logo.
Primary request: Rebuild the banner's visual identity around that actual YAK logo. A crisp, confident editorial brand composition with a prominent faithful YAK logo at left and clean typography at right. The reference logo should occupy about the left 40 percent, visually balanced against the text, not tiny and not cropped. No visible square tile around the logo. Keep generous margins.
Scene/backdrop: matte near-black, flat sharp graphic design, restrained oversized diagonal corner cuts and very subtle offset contour shapes derived from the logo's angles. Only a few cream-yellow and teal-blue geometric accents at the outer edges; leave the central content spacious and uncluttered.
Typography: on the right, "OpenYak" in large bold slightly forward-leaning sans serif, white, followed below by the exact tagline "One chat. Every agent." on two balanced lines, cream-yellow then white. Typography must feel related to the energetic logo but remain exceptionally readable at 900px banner width.
Palette: use the supplied logo's cream yellow, white and teal blue, with near-black. No purple, no electric royal blue.
Constraints: Only the original YAK letters within the logo plus "OpenYak" and "One chat. Every agent." as text. Preserve the existing logo's letter shapes, outlines, proportions and color order closely. Remove all old network lines, generic technology icons, glowing dots and gradients. No mascots, UI panels, screenshot mockups, random symbols, metallic effects, 3D, grain or lens glow. Output a finished premium brand banner, not a presentation sheet.
```

Layout refinement prompt (initial redesign as the reference):

```text
Use case: compositing
Edit the supplied brand banner only to make it a genuinely wide README header: output aspect ratio exactly 3:1, target 2160 by 720 pixels. The current 2:1 canvas is too tall.
Preserve the same YAK logo identity, cream-yellow Y, white A, teal-blue K, thick black edges and white sticker border. Preserve the black background and the restrained angular corner accents. Keep the exact text "OpenYak" and "One chat. Every agent." and the current bold forward-leaning typography.
Recompose logo at left and text at right in a compact horizontal lockup with generous outer margins. Scale all main content to fit fully within a safe central band, about 460 pixels tall; never crop the logo or text. Reduce the background ghost outlines so they remain secondary. Keep everything crisp, flat and uncluttered, no new symbols or words. This is a proportion/layout correction, not another branding redesign.
```

## Previous banner (superseded)

The previous version of `banner-v2.png` was original AI-generated brand artwork,
not a product screenshot.
Generated on 2026-09-04 with the built-in `image_gen` tool in generation mode,
without reference images; copied into this repository without modification.

Prompt:

```text
Use case: ads-marketing
Asset type: GitHub README banner for OpenYak v2, very wide 3:1 composition, approximately 1800x600.
Primary request: Design a polished, distinctive dark banner for an open-source desktop workbench for AI agents. This is brand artwork, NOT a screenshot or mock application interface.
Scene/backdrop: near-black charcoal, restrained fine grain and thin flowing paths joining into one continuous path, suggesting multiple agents sharing one conversation. Subtle depth, editorial graphic design, ample negative space. Avoid generic neon AI brains, robot mascots, floating UI cards.
Typography: large, exceptionally clear off-white contemporary sans serif, spelling OpenYak exactly (O p e n Y a k). Subheadline equally crisp. Delicate electric-blue and warm pale-yellow accents reflect the existing product palette. Minimal but memorable.
Text verbatim, only these two lines: "OpenYak" and "One chat. Every agent."
Constraints: no fake product UI, no performance claims, no other company logos, no extra text, no watermark. Place all text well within safe margins. Make it legible as a README header at 900px wide.
```
