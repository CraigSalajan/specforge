# Product

## Register

product

## Users

Technical power users who live in markdown: solo developers, founders, and product-minded engineers planning software work. They open SpecForge to think and write, not to be onboarded. Comfortable in IDE-grade tools (VS Code, Obsidian), they expect keyboard operability, sensible defaults, and a workspace that holds up across long, deep-focus sessions. Their context is local and offline-first: a vault of planning docs (PRDs, ADRs, implementation plans, design docs) on their own disk, with an AI planning harness available but never in the way.

## Product Purpose

SpecForge is a local-first, Obsidian-flavored markdown workspace tuned for software product planning. It pairs a three-pane workbench (file tree, editor, AI panel) with an AI harness that retrieves from the vault, drafts planning artifacts, and proposes guarded, reversible file changes. It exists so a single practitioner can move from a blank page to a structured, interlinked plan without leaving one calm environment, and without surrendering control of their files. Success looks like the tool disappearing into the work: the user is thinking about their product, not about the editor.

## Brand Personality

Precise, technical, quiet. The voice is that of a sharp colleague who respects your attention: exact, unembellished, never chatty. Restrained chrome, decisive defaults, no marketing gloss inside the app. The experience goal is calm, focused, distraction-free, the document and the thinking stay foreground while the tooling recedes. It should feel like serious software you can trust with your work.

## Anti-references

- Generic SaaS marketing aesthetics: gradient-blob heroes, the hero-metric template, identical three-card feature grids, an eyebrow above every section.
- Playful / consumer-app looks: rounded-bubbly shapes, mascots, pastel candy palettes, oversized friendly illustrations.
- Loud, decorative, attention-seeking UI: gratuitous motion, full-saturation accents on idle controls, over-styled buttons, invented affordances for standard tasks.
- Anything that reads as a website rather than a tool. The reference point is tool-native software (Obsidian, IDEs), dense and dark, not a landing page.

## Design Principles

- **The tool disappears.** Every pixel of chrome competes with the document. Default to less. The user's content and thinking are the interface; the app is the quiet frame around them.
- **Earned familiarity over novelty.** Use the affordances power users already know (standard editor, file tree, panels, shortcuts). Surprise is a cost here, not a feature. Reinvent only when the standard genuinely fails the task.
- **Local-first means in control.** AI proposes, the user disposes. Every change is previewable, confirmable, and reversible. The design must make state, consequence, and undo legible at all times.
- **Density with calm.** Power users want information; serve it without clutter. Achieve density through restraint and rhythm, not by removing what's useful.
- **Quiet by default, clear under pressure.** The interface stays muted in steady state and speaks up precisely when it matters: errors, conflicts, destructive actions, and AI proposals get unmistakable, legible treatment.

## Accessibility & Inclusion

- **WCAG AA baseline.** Body text ≥4.5:1 contrast (large/bold text ≥3:1), visible non-color focus indicators on every interactive element, color never the sole carrier of meaning (pair with icon, label, or shape).
- **Keyboard-first.** Full keyboard operability across the surface, logical focus order, discoverable shortcuts, focus traps handled correctly in modals and the AI proposal flow. Power users should never need the mouse.
- **Reduced motion.** Every animation ships a `prefers-reduced-motion: reduce` alternative (crossfade or instant). Motion conveys state, never decoration, so removing it never costs meaning.
