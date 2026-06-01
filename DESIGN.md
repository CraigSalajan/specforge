---
name: SpecForge
description: Local-first markdown workspace for software product planning
colors:
  surface-0: "#0b0d10"
  surface-1: "#11141a"
  surface-2: "#161a22"
  surface-3: "#1e242e"
  border-subtle: "#232a35"
  border-strong: "#2f3744"
  text-primary: "#e6e9ef"
  text-secondary: "#9aa3b2"
  text-muted: "#6b7384"
  accent: "#6366f1"
  accent-hover: "#818cf8"
  danger: "#ef4444"
  syntax-string: "#6ee7a8"
  syntax-number: "#f0a868"
  syntax-title: "#7dd3fc"
  success: "#34d399"
typography:
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
  eyebrow:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
  mono:
    fontFamily: "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  sm: "0.25rem"
  lg: "0.5rem"
  full: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0.375rem 0.75rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "#ffffff"
  button-ghost:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "0.375rem 0.75rem"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
  input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 0.75rem"
  modal:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
  badge:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.5rem"
---

# Design System: SpecForge

> Extracted from the codebase. The token layer lives in `src/styles.css` (`@theme`, Tailwind v4) — the **only** stylesheet. Every component is composed inline from Tailwind utilities bound to those tokens; the only authored CSS beyond the tokens is `.prose-ai` (rendered AI markdown) and the `.cm-editor` block (CodeMirror live-markdown editor theming). Dark theme only (`<html class="dark">`). Where the code is inconsistent, it's flagged rather than codified.

## 1. Overview

**Creative North Star: "The Quiet Workshop"**

SpecForge is a near-black, tool-native workbench where a single practitioner thinks and writes software plans. The interface is the calm frame around the document; depth is built from four stacked blue-gray surface layers and 1px borders, not gradients or ornament. One indigo accent does all the chromatic work — primary actions, focus, current selection, links — and nothing else. The reference point is Obsidian and a code editor, not a marketing site or a consumer app.

It explicitly rejects: generic SaaS marketing chrome (gradient heroes, the hero-metric template, identical card grids, an eyebrow on every section), playful/consumer looks (bubbly rounding, mascots, pastel candy palettes), and loud decorative UI (gratuitous motion, full-saturation accents on idle controls). If it reads as a website rather than a tool, it's wrong.

**Key Characteristics:**
- Dark-only, cool blue-gray neutral ramp, one indigo accent.
- Flat at rest (surface layers + 1px borders); shadow reserved for overlays.
- System sans for UI, JetBrains Mono for the editor, code, and data.
- Tailwind v4 utilities over theme tokens; no component-class library.
- Density without clutter; the chrome stays quiet so the document leads.

## 2. Colors

A cool blue-gray neutral system carrying a single indigo accent, plus Tailwind-derived semantics for diff/state.

### Primary
- **Indigo Accent** (`#6366f1`): primary buttons, focus border, current selection, active state, the `edit` badge. Reserved for action and state — never decoration. Hover lifts to **Indigo Light** (`#818cf8`), which also colors links, citations, and the editor cursor/syntax keywords.

### Neutral (surfaces, darkest → lightest)
- **Ink Black** (`#0b0d10`, `surface-0`): app background and the editor/main column.
- **Panel** (`#11141a`, `surface-1`): top bar, side rails (file tree, AI panel), modal bodies.
- **Raised** (`#161a22`, `surface-2`): inputs, hover fills, code-block widgets, chips.
- **Selected** (`#1e242e`, `surface-3`): active/selected rows, inline-code background, copy buttons.
- **Subtle Border** (`#232a35`): panel dividers, header/footer rules, input borders.
- **Strong Border** (`#2f3744`): modal edges, scrollbar thumb, emphasized outlines.

### Text (ink ramp)
- **Primary Ink** (`#e6e9ef`): body, headings, active items (~14:1 on `surface-0`).
- **Secondary Ink** (`#9aa3b2`): labels, idle controls, secondary copy (~6.5:1, AA).
- **Muted Ink** (`#6b7384`): hints, captions, eyebrows, idle icons (~3.7:1 — large/non-essential text only; below AA for body).

### Semantic (Tailwind palette literals, used directly in templates)
- **Danger** (`--color-danger` `#ef4444`): destructive intent — delete/stop buttons (`bg-danger`), error text (`text-danger`).
- **Diff add** (`bg-emerald-900` + `text-emerald-300`): added lines in the proposal diff.
- **Diff remove** (`bg-red-900` + `text-red-300`): removed lines in the proposal diff.
- **Create badge** (`bg-emerald-600`, white text); **Edit badge / convert action** (`bg-amber-600` / `bg-amber-700`, white text); **collision warning** (`text-amber-400`).
- **Editor syntax** (authored hex): strings `#6ee7a8`, numbers/meta `#f0a868`, titles/functions `#7dd3fc`, success/copy-done `#34d399`, keywords → Indigo Light.
- **Selection** (`rgba(99,102,241,0.18)`), **modal scrim** (`bg-black/60` + `backdrop-blur-sm`).

**The One Accent Rule.** Indigo is the only hue with intent. If a control is indigo, it is actionable, selected, or focused. Everything decorative stays neutral.

> **Inconsistencies to resolve:** success/warning/info have no theme tokens (diff/syntax colors are hard-coded or Tailwind palette literals); the editor hard-codes the accent as `rgba(99,102,241,…)` instead of `var(--color-accent)`; the scrollbar hover uses a one-off `#3a4453`.

## 3. Typography

**UI Font:** system sans — `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`. No web font.
**Mono Font:** `ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace` (`--font-mono`).

**Character:** Invisible, system-native sans for all UI so the app reads as part of the OS; a single mono family carries the editor, code, diffs, and paths where character-grid alignment matters. Root size 16px; UI sized in a **fixed rem scale** (no fluid `clamp`), appropriate to a desktop product.

### Hierarchy
- **Title** (600, `0.875rem`/`text-sm`): modal and panel titles, app name. The largest UI text — this product has no display tier.
- **Eyebrow** (600, `0.75rem`/`text-xs`, `uppercase`, `tracking-wide`, muted): section grouping labels *inside* panels (e.g. settings sections) only — not a per-section marketing kicker.
- **Body / Control** (400–500, `0.8125–0.875rem`): inputs, buttons, labels, list rows, chat copy.
- **Editor** (mono, ~`0.875rem`, line-height 1.7, content capped ~900px): headings render relative (h1 1.6em/700, h2 1.35em/700, h3 1.18em/600).
- **Rendered AI markdown** (`.prose-ai`): h1 1.25em, h2 1.1em, h3 1.0em, weight 600.
- **Weights:** 400 body · 500 medium (buttons, folder rows, tabs) · 600 headings/eyebrows · 700 editor headings & bold.

**The No-Display Rule.** The biggest text on any screen is `text-sm` semibold. Hierarchy comes from weight, color, and spacing, not size. Don't introduce display-scale headings into the app shell.

## 4. Elevation

Flat by default. At rest, depth is conveyed entirely by the four-step surface ramp plus 1px borders — there are no resting shadows, no gradients, no glow. The one exception is **overlays**: modals and dialogs use a heavy `shadow-2xl` over a `bg-black/60` scrim to lift clearly off the workspace.

**The Flat-At-Rest Rule.** Panels, rows, inputs, and cards are flat. A shadow means "this floats above everything" — reserved for modal/dialog overlays only. If a resting surface needs separation, step it one level on the surface ramp or add a 1px border; never reach for a shadow.

## 5. Components

There is no component-class library. Components are Angular standalone templates composed from Tailwind utilities over the theme tokens. The recurring vocabulary:

### Buttons
- **Shape:** `rounded` (4px). Compact padding `px-3 py-1.5` (or `p-1.5` for icon-only).
- **Primary:** `bg-accent hover:bg-accent-hover text-white font-medium`. White text on indigo.
- **Ghost / Secondary:** `text-text-secondary hover:text-text-primary hover:bg-surface-2` on a transparent fill — the default for toolbar and dialog-cancel actions.
- **Icon:** `text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded p-1.5`, holding a 16px (`w-4 h-4`) inline SVG, `stroke-width="2"`, `currentColor`.
- **Hover / focus:** `transition-colors`; interactive color shifts only.

### Inputs / Fields / Selects
- **Style:** `bg-surface-2 text-text-primary rounded px-3 py-2 border border-border-subtle`. Selects run tighter (`text-xs px-2 py-1`).
- **Focus:** `focus:border-accent focus:outline-none` — the accent border *is* the focus indicator (verify it stays visible everywhere; AA depends on it).
- **Label:** `text-text-secondary text-xs` above the field.

### Badges / Chips
- **Style:** `text-xs px-2 py-0.5 rounded-full` (pill) with a semantic tint pair (`bg-*/15 text-*-300`), or neutral `bg-surface-2 text-text-secondary`.

### Modals / Dialogs
- **Scrim:** `fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm`.
- **Panel:** `bg-surface-1 border border-border-subtle rounded-lg shadow-2xl` at `max-w-2xl`–`max-w-3xl`, `max-h-[90vh]`, with a scrolling `flex-col` body.
- **Chrome:** header `bg-surface-2 border-b border-border-subtle px-4 py-2.5` (title `text-sm font-semibold`, `×` close at `text-text-muted`); footer `bg-surface-2 border-t border-border-subtle px-4 py-2.5` with actions right-aligned (`gap-2`). Click-scrim-to-dismiss with `stopPropagation` on the panel.

### Diff (signature)
- Each line is monospace `whitespace-pre-wrap` inside a `max-h-[40vh] overflow-y-auto rounded border border-border-subtle bg-surface-2 font-mono text-sm` block; add = `bg-emerald-900 text-emerald-300`, remove = `bg-red-900 text-red-300`, context = primary ink, with a low-opacity `+`/`-`/` ` gutter glyph.

### File tree / list rows
- Rows are compact, `rounded`, secondary ink; hover `bg-surface-2`, selected `bg-surface-3` + primary ink; folder rows medium weight; 16px icons at ~0.7 opacity.

### Custom scrollbar
- 10px, transparent track, `border-strong` thumb, `#3a4453` on hover.

## 6. Do's and Don'ts

### Do:
- **Do** compose from Tailwind utilities bound to the theme tokens (`bg-surface-2`, `text-text-secondary`, `border-border-subtle`); add authored CSS only for the editor and `.prose-ai`.
- **Do** keep indigo for action, focus, and selection only — neutral everywhere else (The One Accent Rule).
- **Do** build depth from the surface ramp + 1px borders; reserve `shadow-2xl` for modal/dialog overlays (The Flat-At-Rest Rule).
- **Do** size UI on the fixed rem scale; `text-sm` semibold is the ceiling (The No-Display Rule).
- **Do** keep `text-muted` (#6b7384) out of essential body copy and placeholders; use secondary ink to hold AA.
- **Do** give every control default / hover / focus, with `focus:border-accent` visible against its background.

### Don't:
- **Don't** add gradient heroes, the hero-metric template, identical card grids, or an eyebrow above every section — this is a tool, not a SaaS landing page.
- **Don't** introduce playful/consumer styling: bubbly rounding, mascots, pastel candy palettes.
- **Don't** add gratuitous motion or full-saturation accents on idle controls; motion conveys state, not decoration.
- **Don't** invent a display/heading scale or a second accent hue.
- **Don't** reach for a resting shadow when a surface step or 1px border will separate the element.
- **Don't** ship motion without a `prefers-reduced-motion: reduce` alternative (PRODUCT.md requires it; none exist in the code yet).
