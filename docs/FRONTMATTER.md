# Frontmatter Properties

A SpecForge document can carry a leading **YAML frontmatter** block — a `---` …
`---` fence at the very top of the file holding document properties (status,
owner, dates, tags). When the cursor is outside the block it renders as an
inline **property editor**: a compact form of typed controls instead of raw
YAML. Click into the block and it falls back to ordinary editable YAML text.

> These conventions are **not a formal standard** — they are just the editor's
> affordances. Any valid YAML works; the rules below only decide which keys and
> values get a richer control instead of a plain text box. Nothing here is
> enforced, and free-text values are always preserved.

---

## Which control you get

The editor inspects each key/value pair and picks the most specific control that
can faithfully hold the value. Order of precedence:

| Condition | Control |
| --- | --- |
| Key is `status` (case-insensitive) | **Dropdown**: `draft`, `review`, `approved`, `published` |
| Date-like key (`created`, `updated`, `modified`, `date`, `due`) with an **empty** or ISO `YYYY-MM-DD` value | **Date picker** |
| Any value that is itself an ISO `YYYY-MM-DD` string | **Date picker** |
| Boolean value (`true` / `false`) | **Checkbox** |
| Number value | **Number input** |
| Array / list value | **Editable chips** (one pill per item, with an inline *add item* field) |
| Nested map (object) value | **Indented sub-group** of editable child rows |
| Everything else | **Plain text input** |

Notes on the edge cases:

- **Status** offers a fixed lifecycle vocabulary. If the current value is outside
  that set (e.g. `status: blocked`), it is **preserved as an extra leading
  option** so a custom status is never silently dropped.
- **Date-like keys with free text** fall back to a text input. A value like
  `created: last Tuesday` is non-empty and non-ISO, so it does *not* get a date
  picker (which would render blank and drop the text on the next edit) — it
  shows and preserves the free text instead.
- **Lists** render as **editable chips** — one compact pill per item. Edit an
  item in place, remove it with the chip's `×`, or append a new one with the
  trailing *add item* field (commit with **Enter** or **Tab**). List items are
  **edited as text**, so a number typed into a list is stored as a string.
- **Nested maps** render as an **indented sub-group**: each child key is its own
  editable row (edit the value, rename the child key, remove it with `×`), and
  the group has its own `+ add property` row so you can add keys *inside* the
  map. Maps and lists nest recursively to any depth.

---

## Editing the block

- **Add a property** — the `+ add property` row at the bottom reveals an inline
  key input. **Enter or Tab** commits the key with an empty value; the form
  rebuilds and focus lands in the new property's value control, so you can flow
  straight from naming the property into typing its value. (Naming a key that
  already exists focuses that existing row's value instead of adding a duplicate.)
- **Rename a property** — the property **name** is editable: click the key, type
  a new name, and blur or press Enter to commit. Renaming **preserves the key's
  position, its value and any comments** (it is mutated in place, not moved to
  the end). An **empty** name or one that **duplicates an existing key** is
  rejected and the original name is restored.
- **Remove a property** — the `×` button at the end of each row drops that key.
  Removing the last (top-level) key removes the whole `---` block.
- **Edit a list** — list values show as **chips**. Type into a chip to change
  that item, click its `×` to drop it, or use the trailing *add item* field
  (**Enter**/**Tab**) to append. Items are edited as text.
- **Edit a nested map** — an object value expands to an **indented sub-group**.
  Inside it you can edit each child value, rename a child key, remove a child
  with `×`, and add a new child key via the group's own `+ add property` row —
  the same affordances as the top level, scoped to that map.
- **Autocomplete** — text value fields and list/tag items suggest values you
  have **already used for the same property in other files**. Suggestions are
  **vault-scoped and per-property**, so editing `tags` suggests tags used
  elsewhere while never offering `author` or `name` values, and a list's
  *add item* field hides values already in that list. The suggestions are
  fetched lazily the first time you focus a field and shown as a native
  type-ahead list (filtered as you type); they are purely additive — you can
  always type a brand-new value. Fields with their own control (`status`,
  dates, numbers, checkboxes) use that control instead and have no list.
- **Round-trips YAML** — every edit routes through a YAML parse/serialize that
  **preserves comments, blank lines, and key order**. The block is always
  re-detected against the live document before writing, so offsets never go
  stale.
- **Collapsible** — the block renders as a compact single-line summary bar by
  default (a chevron, the **Properties** label, a key count, the `status` value
  as a pill, and — when present — the first few `tags` as small read-only chips
  with a `+N` overflow). Click it (or press Enter) to expand the full form; the
  header chevron collapses it again. **Every file opens collapsed.**
- **Malformed YAML degrades to source** — if the block is present but
  unparseable, the editor shows a quiet *"Invalid frontmatter — click to edit"*
  line rather than an empty form, so the raw text is always one click away.

Keyboard: **Tab** / **Shift+Tab** moves between the form's controls. Tab on the
last control (or Shift+Tab on the first) hands focus back to the document, so
you can Tab cleanly out of the block into the text.

---

## Seeding on new files

New documents created from the file tree are seeded with a default block:

```yaml
---
status: draft
owner:
created: 2026-06-14
---
```

so every spec starts as a `draft` with a creation date, feeding the property
index from the moment it exists.

---

## Querying

Property values are indexed, so the **Docs sidebar filter** can show every
document with a given property — e.g. *"show all approved specs"* (it opens on
`status: approved` by default). Set a document's `status` here and it flows
straight into that filter.

---

See also: the "Document properties/status" roadmap item in
[`ROADMAP.md`](./ROADMAP.md).
