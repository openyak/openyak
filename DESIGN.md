---
# OpenYak Design System — Single Source of Truth
# Read this file before generating UI. Token *values* live in globals.css; this
# file indexes them, codifies rules, and explains the *why*.

product: OpenYak Desktop
implementation_source_of_truth: frontend/src/app/globals.css
component_root: frontend/src/components
ui_primitives: frontend/src/components/ui          # shadcn/ui — do not bypass
styling_engine: tailwindcss@4                      # CSS-first config; no tailwind.config.js
themes: [light, dark]                              # toggled via next-themes; .dark class on <html>
font_base_px: 13                                   # information-dense; see Philosophy §1

# Token index — names only. Resolve values in globals.css.
tokens:
  surface:
    purpose: Layered backgrounds (lower index = more prominent / closer to user)
    names: [--surface-primary, --surface-secondary, --surface-tertiary, --surface-chat]
    source: globals.css:7-10, 105-108
  text:
    purpose: Three-tier text hierarchy
    names: [--text-primary, --text-secondary, --text-tertiary]
    source: globals.css:13-15, 111-113
  border:
    purpose: Dividers, hairlines, subtle separations
    names: [--border-default, --border-heavy, --border-subtle]
    source: globals.css:18-20, 116-118
  brand:
    purpose: Primary brand actions and focus
    names: [--brand-primary, --brand-primary-hover, --brand-primary-text, --ring]
    source: globals.css:31-33, 54, 128-131, 151
  semantic:
    purpose: Outcome / state communication (non-AI)
    names: [--color-success, --color-warning, --color-destructive]
    source: globals.css:36-38, 134-136
  ai_status:
    purpose: AI tool-call lifecycle. See "AI-Native UI Guidelines"
    names: [--tool-pending, --tool-running, --tool-completed, --tool-error]
    source: globals.css:67-71
  sidebar:
    purpose: Sidebar surfaces, vibrancy/glass effect on macOS
    names: [--sidebar-bg, --sidebar-translucent-bg, --sidebar-hover, --sidebar-active, --sidebar-active-shadow, --sidebar-active-border]
    source: globals.css:41-48, 138-145
  bubble:
    purpose: User message bubble background
    names: [--user-bubble-bg]
    source: globals.css:51, 148
  code_block:
    purpose: Code surfaces (intentionally dark in both themes — see Philosophy §3)
    names: [--code-block-bg, --code-block-header, --code-block-border, --code-block-text, --code-block-text-hover, --code-block-success]
    source: globals.css:23-28, 121-126
  syntax:
    purpose: Highlight.js token colors (VS Code Dark+ palette, identical light/dark)
    names: [--code-bg, --code-text, --code-comment, --code-keyword, --code-string, --code-function, --code-variable, --code-number, --code-operator, --code-class, --code-tag, --code-attr-name, --code-attr-value, --code-builtin, --code-regex, --code-deleted, --code-inserted]
    source: globals.css:434-471
  prose:
    purpose: Long-form markdown rendering inside assistant messages
    names: [--prose-body, --prose-link, --prose-accent, --prose-blockquote-bg, --prose-marker]
    source: globals.css:74-78, 161-166
  typography:
    purpose: UI font scale. Base 13px, derived sizes use max() so they never collapse below legible
    base: --ui-font-size-base
    code_base: --ui-code-font-size-base
    sizes: [--ui-size-3xs, --ui-size-2xs, --ui-size-xs, --ui-size-sm, --ui-size-md, --ui-size-lg, --ui-size-xl, --ui-size-qr]
    line_heights: [--ui-line-tight, --ui-line-snug, --ui-line-normal, --ui-line-qr]
    semantic: [--ui-font-overline, --ui-font-caption, --ui-font-body, --ui-font-title-sm, --ui-font-title, --ui-font-title-lg]
    utilities: [text-ui-3xs, text-ui-2xs, text-ui-xs, text-ui-sm, text-ui-md, text-ui-lg, text-ui-xl, text-ui-code, text-ui-qr, text-ui-overline, text-ui-caption, text-ui-body, text-ui-title-sm, text-ui-title, text-ui-title-lg]
    source: globals.css:81-101, 312-412
  shadow:
    names: [--shadow-sm, --shadow-md, --shadow-lg]
    source: globals.css:60-62, 156-159
  radius:
    names: [--radius]                 # 0.625rem (10px) default
    source: globals.css:57
  switch:
    names: [--switch-checked]
    source: globals.css:65, 154

# Animation primitives. Use existing keyframes; do not invent ad-hoc easings.
motion:
  enter_easing: "cubic-bezier(0.16, 1, 0.3, 1)"   # spring-like; used for slide-up / slide-in-right
  fade_easing: "ease-out"
  durations_ms: { micro: 150, fast: 300, base: 350 }
  keyframes: [fade-in, slide-up, slide-in-right, pulse-dot, blink-cursor, shimmer, shimmer-opacity, progress-slide, scroll-text]
  utilities: [animate-fade-in, animate-slide-up, animate-slide-in-right, shimmer-text, shimmer-icon, animate-scroll-text]
  reduced_motion: globals.css:1103-1119            # all animations collapse to ~0ms

# Breakpoints — Tailwind defaults, used as documented below
breakpoints:
  sm: 640
  md: 768
  lg: 1024
  xl: 1280

# AI-native conventions (see corresponding section)
ai_patterns:
  tool_states: [pending, running, completed, error]
  user_content_marker: --user-bubble-bg            # filled bubble, right-aligned
  assistant_content_marker: --surface-chat         # no bubble, full-width prose
  reasoning_marker: shimmer-text                   # animated subtle gradient while streaming
  streaming_marker: streaming-cursor               # blinking 2px cursor at end of last block
---

# OpenYak Design System

> **This file is the SSOT.** Every token name, component rule, and motion primitive an agent needs to ship correct UI lives here or is referenced from here. Token *values* are intentionally not duplicated — they live in [`frontend/src/app/globals.css`](frontend/src/app/globals.css). When values change, only that file changes; this document stays current because it indexes by name.

---

## 1. Design Philosophy — The "Why"

The defaults below are deliberate. Future contributors should change them only with intent, not by accident.

### 1.1 13 px UI base font — information density for professionals

`--ui-font-size-base: 13px` is unusually small for a 2026 web app (most products use 14–16 px). This is intentional.

OpenYak is a **local desktop workbench** for office workflows: tool-call traces, reasoning steps, file artifacts, multi-step automations. Users keep dozens of message parts on screen simultaneously. A 13 px base lets us:

- Show ~25% more vertical content per viewport vs. a 16 px base.
- Match the density expectations of professional creative/IDE tools (Figma, VS Code, Linear, ChatGPT desktop).
- Preserve the `letter-spacing: -0.012em` micro-tracking that makes SF Pro at small sizes look intentional rather than cramped.

The size scale uses `max(Npx, calc(...))` ([`globals.css:83-91`](frontend/src/app/globals.css:83)) so derived sizes (`--ui-size-3xs` ... `--ui-size-xl`) **never collapse below legibility floors** even if a future change to the base shrinks them.

**Implication for agents:** prefer the `text-ui-*` utility classes over raw Tailwind `text-xs`/`text-sm` when building chat content — they map to the semantic scale and resize together.

### 1.2 macOS vibrancy / sidebar glass

The Tauri shell applies `NSVisualEffectView` natively (window-vibrancy crate). The web layer cooperates with three rules:

1. When the `<html>` element has class `macos-vibrancy`, the document body becomes **transparent** so the native blur shows through ([`globals.css:204-208`](frontend/src/app/globals.css:204)).
2. The sidebar uses `--sidebar-translucent-bg` — **high alpha (0.88) in light mode** so dark text remains readable over arbitrary wallpapers, **low alpha (0.20) in dark mode** to keep the wallpaper-aware aesthetic ([`globals.css:42-44, 140-141`](frontend/src/app/globals.css:42)).
3. CSS `backdrop-filter: blur(...)` is **explicitly disabled on macOS** when combined with the native material — the extra Chromium compositor layer fights with NSVisualEffectView during window drag and produces a visible flicker. Windows/Linux keep the CSS blur ([`globals.css:218-222`](frontend/src/app/globals.css:218)).

The main content area opts back into an opaque surface via `.vibrancy-opaque` ([`globals.css:210-212`](frontend/src/app/globals.css:210)) so chat content has stable contrast.

**Implication for agents:** new full-bleed surfaces inside the main area should use `--surface-primary` / `--surface-chat`, not transparent backgrounds. New sidebar-adjacent panels should use `--sidebar-bg` / `--sidebar-translucent-bg` and inherit the existing alpha discipline.

### 1.3 Code blocks stay dark in both themes

Light theme uses **dark code blocks** ([`globals.css:23-28`](frontend/src/app/globals.css:23)). This is not a bug.

OpenYak's audience writes and reads code daily. Dark code surfaces with the VS Code Dark+ palette (`--code-keyword: #569CD6`, `--code-string: #CE9178`, etc., identical between `:root` and `.dark`) deliver:

- **Higher token contrast** — syntax colors were designed for dark backgrounds; on light surfaces they wash out.
- **Visual continuity** with the user's IDE.
- **Reduced eye strain** in the most-scanned regions of long assistant messages.

The `--code-block-*` tokens stay close in light/dark but shift slightly so the dark code block doesn't punch a hole in a light page — the dark-mode code block is one shade lighter than its dark-mode background.

**Implication for agents:** never override `pre` / `code` backgrounds in light mode to match the page surface. If you need a light code surface (e.g., inline metadata), use `--surface-tertiary` and the inline-code style at [`globals.css:718-723`](frontend/src/app/globals.css:718).

### 1.4 Other principles worth knowing

- **Monochrome + one accent.** UI chrome is grayscale; brand blue (`#339CFF`) appears only on primary actions and focus rings. Resist coloring chrome.
- **Border-by-default.** `* { border-color: var(--border-default); }` ([`globals.css:172-174`](frontend/src/app/globals.css:172)) — any element using `border` Tailwind utility picks up the theme border without extra plumbing.
- **`overflow: hidden` on `html` and `body`.** OpenYak is a desktop shell, not a scrolling document. Layout owns scroll; never add page-level scroll.

---

## 2. Component System

### 2.1 Library

| Layer | Source | Modify? |
|---|---|---|
| Primitives | [`frontend/src/components/ui/`](frontend/src/components/ui) (shadcn/ui over Radix) | Carefully — these are shared across every feature |
| Feature components | [`frontend/src/components/{feature}/`](frontend/src/components) | Freely, within the feature |
| Icons | `lucide-react` | Use existing icons; do not add icon libraries |

### 2.2 Hard rules (from [`.dev/CONVENTIONS.md`](.dev/CONVENTIONS.md))

1. **Tailwind utilities only.** No inline `style={{}}` props except for dynamic values that cannot be expressed as classes (e.g., a computed `transform`).
2. **No CSS modules.** No `*.module.css`. Component-scoped styles belong in Tailwind classes or, if structural and reusable, in a `@layer utilities` block in [`globals.css`](frontend/src/app/globals.css).
3. **Direction: `feature/` imports from `ui/`, never the reverse.** A primitive must not know about a feature.
4. **Token references via `var(--token)` in CVA strings**, e.g. `bg-[var(--surface-secondary)]` (see [`button.tsx`](frontend/src/components/ui/button.tsx) for the canonical pattern). Do not hardcode hex values in components.
5. **CVA for variants.** New primitives with state/size variants use `class-variance-authority` like [`button.tsx:6-35`](frontend/src/components/ui/button.tsx:6).
6. **`cn()` for class composition.** Import from `@/lib/utils`. Never concatenate class strings manually.
7. **Named exports preferred.** Default exports only for Next.js page routes.

### 2.3 Component anatomy template (for new primitives)

```tsx
const fooVariants = cva(
  "inline-flex items-center rounded-[var(--radius)] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-[var(--brand-primary)] text-[var(--brand-primary-text)] hover:bg-[var(--brand-primary-hover)]",
        ghost:   "hover:bg-[var(--surface-secondary)] text-[var(--text-primary)]",
      },
      size: { sm: "h-8 px-3 text-ui-xs", md: "h-9 px-4 text-ui-sm" },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);
```

Every interactive primitive must include: focus-visible ring, `disabled:opacity-35 disabled:pointer-events-none`, `active:scale-[0.97]` (the standard tactile feedback), and `transition-all duration-150`.

### 2.4 Spacing & radius

Use Tailwind defaults (`space-y-2`, `gap-3`, `p-4`). Custom radii reference `--radius` (`rounded-[var(--radius)]`) or use Tailwind's `rounded-md` / `rounded-lg`. Avoid arbitrary `rounded-[7px]`.

---

## 3. Motion & Animation

### 3.1 Philosophy

Motion in OpenYak is **functional, not decorative**. Every animation either:

- Acknowledges an action (button press → `active:scale-[0.97]`).
- Reveals new state (message arrival → `slide-up`).
- Communicates ongoing work (reasoning → `shimmer-text`, streaming → `streaming-cursor`).

Anti-patterns: long fades on layout changes (jank), parallax (visual noise), bouncy spring overshoot (juvenile in a pro tool), animating layout properties that cause reflow (use `transform` and `opacity`).

### 3.2 Easing & duration

| Use | Easing | Duration |
|---|---|---|
| Hover/active feedback | `transition-all duration-150` | 150 ms |
| Fade-in (new content) | `ease-out` | 300 ms |
| Slide enter (panels, messages) | `cubic-bezier(0.16, 1, 0.3, 1)` (spring-out) | 300–350 ms |
| Streaming indicators | linear / `ease-in-out` | continuous |

The spring-out curve `(0.16, 1, 0.3, 1)` is the project's signature ease — assertive arrival without overshoot. **Use it for any slide-in.**

### 3.3 Keyframes available (do not invent new ones without justification)

| Keyframe | Use | Source |
|---|---|---|
| `fade-in` | Generic appear | [`globals.css:886-889`](frontend/src/app/globals.css:886) |
| `slide-up` | Message arrival, modal/sheet enter | [`globals.css:891-894`](frontend/src/app/globals.css:891) |
| `slide-in-right` | Right-side panels, toasts | [`globals.css:896-899`](frontend/src/app/globals.css:896) |
| `pulse-dot` | Loading dots | [`globals.css:901-904`](frontend/src/app/globals.css:901) |
| `blink-cursor` | Streaming text cursor | [`globals.css:918-921`](frontend/src/app/globals.css:918) |
| `shimmer` | Reasoning/thinking indicator | [`globals.css:944-947`](frontend/src/app/globals.css:944) |
| `shimmer-opacity` | Icon thinking indicator | [`globals.css:968-971`](frontend/src/app/globals.css:968) |
| `progress-slide` | Indeterminate progress bars | [`globals.css:938-942`](frontend/src/app/globals.css:938) |
| `scroll-text` | Sidebar title overflow scroll | [`globals.css:1092-1098`](frontend/src/app/globals.css:1092) |

Helper classes: `.animate-fade-in`, `.animate-slide-up`, `.animate-slide-in-right`, `.shimmer-text`, `.shimmer-icon`, `.animate-scroll-text`.

---

## 4. AI-Native UI Guidelines

OpenYak is an agent runtime. Its UI must communicate **what the AI is doing** at every moment. These rules are non-negotiable.

### 4.1 Tool-call lifecycle — `--tool-*` tokens

Every tool call passes through four states. The token, icon treatment, and copy must agree.

| State | Token | Visual treatment | When it applies |
|---|---|---|---|
| `pending` | `--tool-pending` (#EAB308 / amber) | Static icon at full opacity; no animation | Tool queued, awaiting permission, or argument validation |
| `running` | `--tool-running` (#171717 / near-black, `#339CFF` in dark) | `shimmer-icon` animation on icon; "Running…" copy | Tool executing |
| `completed` | `--tool-completed` (#22C55E / green) | Static check icon; collapsible result panel below | Tool returned successfully |
| `error` | `--tool-error` (#EF4444 / red) | Static X-circle icon; expanded error message persists | Tool raised, timed out, or returned an error result |

**Rule:** A tool part **must persist a terminal state** (`completed` or `error`) — never leave the icon in `running` after the part settles. This rule is enforced backend-side via `update_part_data()` ([`CLAUDE.md` Known Gotchas #1](CLAUDE.md)) but the UI must respect the data.

**Rule:** Use `--tool-*` for AI tool calls only. For human-facing form validation, use `--color-success` / `--color-warning` / `--color-destructive` instead. The two scales are visually similar but **semantically distinct** — conflating them blurs the human/AI boundary.

### 4.2 User vs. AI-generated content

OpenYak does not use chat-bubble-on-both-sides styling (which makes assistant text feel cramped and second-class). Instead:

| Author | Container | Background | Width |
|---|---|---|---|
| **User** | Message bubble | `--user-bubble-bg` (filled) | Right-aligned, max ~70% of column |
| **Assistant** | Bare prose block (no bubble) | inherits `--surface-chat` | Full column width, uses `.prose` typography ([`globals.css:578-882`](frontend/src/app/globals.css:578)) |
| **Tool call** | Card with rounded `var(--radius)`, `--border-default` | `--surface-secondary` | Full width, indented one step from assistant prose |
| **Reasoning** | Collapsible block, dimmer text (`--text-secondary`) | inherits surface | Full width; collapsed by default once streaming completes |
| **Step indicator** | Thin horizontal divider with caption | `--border-default` line + `text-ui-caption` | Full width |

**Rule:** never put assistant text in a bubble; never put user text outside a bubble. The visual asymmetry is the cue.

### 4.3 Streaming & in-progress indicators

| Signal | Implementation |
|---|---|
| Text actively streaming | Append `.streaming-cursor` to the last block ([`globals.css:923-936`](frontend/src/app/globals.css:923)) |
| Reasoning streaming | Apply `.shimmer-text` to the reasoning content while open |
| Tool icon working | Apply `.shimmer-icon` (`animation: shimmer-opacity 2s ease-in-out infinite`) |
| Indeterminate progress | `progress-slide` keyframe on a thin bar |
| Content arriving (post-stream) | `.animate-slide-up` on the new part wrapper |

**Rule:** when streaming ends, **remove** the streaming class — do not let `shimmer` or `streaming-cursor` persist into the resting state.

### 4.4 Density expectations

Long agent traces (10+ tool calls, multi-thousand-token reasoning blocks) are normal. Every AI-content surface must:

- Default to a **collapsed** state for content over ~400 px tall (reasoning, tool input/output, sub-tasks).
- Use `text-ui-caption` / `text-ui-2xs` for metadata (duration, token count, cost).
- Show timestamps in monospace tabular numerals (`font-variant-numeric: tabular-nums`) for stable column alignment.

---

## 5. Responsive Design

Tailwind defaults; layout shifts at `lg` and `md`.

| Breakpoint | Behavior |
|---|---|
| `≥1024px` (`lg`) | Sidebar pinned 260 px wide; main content offset `ml-[260px]` |
| `768–1023px` (`md`) | Sidebar collapsible (toggleable, overlays main) |
| `<768px` (`sm`) | Sidebar hidden by default; opens as a `Sheet` drawer; mobile composer takes precedence |

Touch-coarse pointers (`@media (pointer: coarse)`) hide custom scrollbars entirely ([`globals.css:288-296`](frontend/src/app/globals.css:288)).

**Rule:** never assume sidebar visibility. Use the layout containers in [`frontend/src/app/(main)/`](frontend/src/app/(main)) and [`frontend/src/app/(mobile)/`](frontend/src/app/(mobile)) — they handle the breakpoint switch.

---

## 6. Accessibility

### 6.1 Focus rings (mandatory)

Every interactive element receives a 2 px solid ring on `:focus-visible`, offset 2 px, color `--ring`. Implemented globally for `button`, `[role="button"]`, `a`, `input`, `textarea`, `select` ([`globals.css:301-309`](frontend/src/app/globals.css:301)).

**Rule:** never write `outline: none` without immediately providing a replacement focus indicator. If a primitive needs a custom ring (e.g., inside a CVA), include `focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2` in the base classes.

### 6.2 Reduced motion

Users with `prefers-reduced-motion: reduce` get all animations collapsed to ~0 ms ([`globals.css:1103-1119`](frontend/src/app/globals.css:1103)). Specifically:

- `streaming-cursor::after` animation is set to `none` (cursor remains visible, no blink).
- `shimmer-text` becomes static, fills with `--text-secondary`.

**Rule:** any custom animation an agent adds must be respectful of this query. The simplest path is to use `@layer utilities` and let the global `prefers-reduced-motion` block override it — do **not** define animations in `style={{}}` props that bypass the cascade.

### 6.3 Color & contrast

- Text on every surface meets **WCAG AA 4.5:1** at 13 px. The token pairs were chosen with this constraint; do not pair `--text-tertiary` with `--surface-tertiary`.
- Brand blue (`#339CFF`) is used **only on filled buttons with white text or as a focus ring** — it does not pass AA as text on white. Do not use it for body text or links in light mode (use `--prose-link` instead).
- Tool-status colors are paired with both an icon shape **and** copy, never color alone.

### 6.4 Keyboard

- All Radix primitives in [`components/ui/`](frontend/src/components/ui) inherit Radix's keyboard behavior. Do not replace them with custom popovers/menus that lose this.
- Modals and sheets must restore focus to their trigger on close (Radix default — preserve it).

---

## 7. How to use this document

When asked to build or modify UI:

1. **Pick tokens, not values.** If you need a background, the answer is one of the names in `tokens.surface` or `tokens.sidebar` — never a hex code.
2. **Find the closest existing primitive** in [`components/ui/`](frontend/src/components/ui). Compose, don't fork.
3. **Match the motion vocabulary.** New transitions use `duration-150` for feedback, the spring-out curve for entries, existing keyframes for everything else.
4. **For AI-related UI**, reread §4. Tool status, streaming, and content authorship cues are part of the product's identity, not styling choices.
5. **For accessibility**, the focus ring and reduced-motion guarantees are global — preserve them. Never opt out.

When token *values* need to change, edit [`globals.css`](frontend/src/app/globals.css) only. This document does not need to follow because it indexes by name.
