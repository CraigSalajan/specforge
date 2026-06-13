import type { Citation, IndexSearchHit, SkillMeta } from '../../../shared/types';
import type { ChatMessage } from '../providers/chat.provider';

/**
 * Phase 3 decision: the system message is recomposed on every call rather
 * than persisted to chat_messages. This avoids drift between the stored
 * context and the current vault state (a follow-up question would otherwise
 * be answered against a stale retrieval snapshot), and keeps the token
 * budget under our control without having to surgically rewrite history.
 *
 * Persisted messages are user + assistant turns only.
 */
const BASE_SYSTEM = `You are SpecForge, an assistant specialized in software product planning.
Your job is to help the user write and refine PRDs, ADRs, implementation plans,
user stories, and review existing planning documents.

Be concise, direct, and structured. Prefer markdown. Use headings and bullet
lists. When you cite vault content, format citations as [<rel_path> :: <heading_path>]
and place them inline at the end of the sentence they support.

If the provided VAULT CONTEXT is insufficient to answer with confidence, say so
explicitly and ask a targeted clarifying question.`;

/**
 * Appended (via `additionalInstructions`) only on tool-enabled Ask-mode turns.
 * Tells the model when and how to use the `write_file` tool. Confirmation is
 * handled by the app's modal, so the model must not ask for permission.
 */
export const TOOL_USAGE_PROMPT = `You can create markdown files in the user's vault with the \`write_file\` tool.
Use it whenever the user asks you to create, draft, write, or save a document
(e.g. a PRD, ADR, plan, or notes). Provide the COMPLETE markdown as \`content\`,
not a snippet. Paths are vault-relative and must end in \`.md\`. The user reviews
and confirms every save in a dialog, so do NOT ask permission in chat — just call
the tool. For plain questions or explanations, answer directly without calling
any tool.

You also have three read-only tools for retrieving vault content. They run
immediately with no confirmation:
- \`read_file(path, offset?)\` — read the full contents of a vault-relative \`.md\`
  file. Returns up to a character cap; if truncated it reports the next \`offset\`
  to continue paging.
- \`search_vault(query, limit?)\` — find relevant excerpts (with their source
  paths) when you do not know which file holds the answer.
- \`list_files(subpath?)\` — list the markdown files that exist in the vault.

The VAULT CONTEXT below already contains relevant excerpts with their source
paths. Prefer the context you already have. If an excerpt is insufficient, call
\`read_file\` for the full document; use \`search_vault\` to find content you don't
have, and \`list_files\` to discover what exists. Don't read files you don't need.`;

export interface ContextAssembly {
  systemMessage: ChatMessage;
  citations: Citation[];
}

export interface PinnedFile {
  /** Vault-relative path, used as both the header and the citation relPath. */
  title: string;
  content: string;
}

/**
 * The user's editor selection for this turn. Rendered directly after the
 * matching PINNED FILE block so the model sees the selection in context.
 */
export interface SelectionContext {
  /** Vault-relative path of the pinned file the selection belongs to. */
  relPath: string;
  /** The selected text, verbatim. */
  text: string;
  /** 1-based first selected line. */
  startLine: number;
  /** 1-based last selected line (inclusive). */
  endLine: number;
}

const TRUNCATION_MARKER = '\n…(truncated)';

/** Trailing instruction of every SELECTION block. */
const SELECTION_FOCUS_NOTE = `The user's request concerns this selected text specifically. Focus your
response on the selection; the full PINNED FILE above is provided for
surrounding context.`;

/** Human range label: `line 4` for one line, `lines 4–9` otherwise. */
export function selectionRangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
}

/**
 * Renders the SELECTION block within `allowance` chars, truncating the
 * selected text like pinned files are. Returns null when the allowance
 * cannot even fit the block frame.
 */
function selectionBlock(selection: SelectionContext, allowance: number): string | null {
  const label = selectionRangeLabel(selection.startLine, selection.endLine);
  const header = `SELECTION (${label} of ${selection.relPath}):\n---\n`;
  const footer = `\n---\n${SELECTION_FOCUS_NOTE}`;
  const contentAllowance = Math.max(0, allowance - header.length - footer.length);
  if (contentAllowance <= 0) return null;

  let body = selection.text;
  if (body.length > contentAllowance) {
    const sliceLen = Math.max(0, contentAllowance - TRUNCATION_MARKER.length);
    body = body.slice(0, sliceLen) + TRUNCATION_MARKER;
  }
  return `${header}${body}${footer}`;
}

/**
 * Fraction of the total budget reserved for pinned files when both pinned
 * files and retrieval hits are present. Pinned files are user-selected and
 * verbatim, so they get the larger share; retrieval keeps a meaningful slice.
 */
const PINNED_BUDGET_FRACTION = 0.6;

/** Never let a single pinned file consume the whole pinned budget alone. */
function perFileCap(pinnedBudget: number, count: number): number {
  if (count <= 0) return 0;
  // Even split, but allow a little headroom so a single big file isn't starved
  // when the others are small. Hard upper bound stays at the pinned budget.
  return Math.max(500, Math.floor(pinnedBudget / count));
}

export function assembleSystemMessage(
  hits: IndexSearchHit[],
  options: {
    maxContextChars: number;
    additionalInstructions?: string;
    pinnedFiles?: PinnedFile[];
    availableSkills?: SkillMeta[];
    /** Editor selection to focus on; must reference a pinned file's title. */
    selection?: SelectionContext;
  },
): ContextAssembly {
  const sections: string[] = [BASE_SYSTEM];
  if (options.additionalInstructions) sections.push(options.additionalInstructions.trim());

  // Skill metadata is cheap (name + one-line description). The full
  // instructions are loaded on demand via the `use_skill` tool, so this block
  // stays small regardless of how many skills exist.
  const skills = options.availableSkills ?? [];
  if (skills.length > 0) {
    const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
    sections.push(
      [
        'AVAILABLE SKILLS:',
        'Before doing a task that matches one of these, call `use_skill({ name })`',
        "to load that skill's full instructions and follow them. To read one of a",
        'skill\'s bundled resource files, call `use_skill({ name, resource })`.',
        '',
        ...lines,
      ].join('\n'),
    );
  }

  const maxChars = Math.max(0, options.maxContextChars);
  const pinned = (options.pinnedFiles ?? []).filter((p) => p.title && p.content !== undefined);
  const citations: Citation[] = [];

  // 1. Budget allocation. Reserve a share for pinned files (proportional to
  //    count via the per-file cap); the remainder goes to retrieval hits. If
  //    there are no hits, pinned files may use the whole budget.
  const pinnedBudget = pinned.length === 0
    ? 0
    : hits.length === 0
      ? maxChars
      : Math.floor(maxChars * PINNED_BUDGET_FRACTION);

  let pinnedUsed = 0;
  if (pinned.length > 0) {
    // The selection (when it targets a pinned file) gets its own budget slot,
    // so a huge pinned file can never starve the SELECTION block out of the
    // context entirely — the case where the selection matters most.
    const requested = options.selection;
    const selection =
      requested && pinned.some((p) => p.title === requested.relPath)
        ? requested
        : undefined;
    const cap = perFileCap(pinnedBudget, pinned.length + (selection ? 1 : 0));
    for (const file of pinned) {
      const remaining = pinnedBudget - pinnedUsed;
      if (remaining <= 0) break;
      const header = `PINNED FILE: ${file.title}\n---\n`;
      const footer = '\n---';
      const overhead = header.length + footer.length;
      // Per-file content allowance: the smaller of the per-file cap and what
      // remains of the pinned budget, minus block overhead.
      const contentAllowance = Math.max(0, Math.min(cap, remaining) - overhead);
      if (contentAllowance <= 0) break;

      let body = file.content;
      if (body.length > contentAllowance) {
        const sliceLen = Math.max(0, contentAllowance - TRUNCATION_MARKER.length);
        body = body.slice(0, sliceLen) + TRUNCATION_MARKER;
      }

      const block = `${header}${body}${footer}`;
      sections.push(block);
      citations.push({ relPath: file.title, headingPath: '' });
      pinnedUsed += block.length;

      // Selection focus renders immediately after its pinned file so the
      // model reads it as "this range of the file above".
      if (selection && selection.relPath === file.title) {
        const selBlock = selectionBlock(
          selection,
          Math.min(cap, pinnedBudget - pinnedUsed),
        );
        if (selBlock) {
          sections.push(selBlock);
          pinnedUsed += selBlock.length;
        }
      }
    }
  }

  // 2. Retrieval hits get whatever budget pinned files did not consume.
  if (hits.length > 0) {
    const budget = Math.max(1000, maxChars - pinnedUsed);
    const perHitBudget = Math.max(400, Math.floor(budget / hits.length));
    const ctxLines: string[] = [];
    let used = 0;
    for (const hit of hits) {
      const excerpt = hit.excerpt.length > perHitBudget
        ? hit.excerpt.slice(0, perHitBudget) + '…'
        : hit.excerpt;
      const block = `---\n[${hit.relPath} :: ${hit.headingPath || '(file)'}]\n${excerpt}`;
      if (used + block.length > budget) break;
      ctxLines.push(block);
      // `startLine` is added only when the hit carries one, so citation
      // objects from line-less hits stay shape-identical to legacy citations.
      const citation: Citation = { relPath: hit.relPath, headingPath: hit.headingPath };
      if (typeof hit.startLine === 'number') citation.startLine = hit.startLine;
      citations.push(citation);
      used += block.length;
    }
    // Only add the VAULT CONTEXT section if at least one hit block was actually added
    if (ctxLines.length > 0) {
      ctxLines.unshift('VAULT CONTEXT:');
      ctxLines.push('---');
      sections.push(ctxLines.join('\n'));
    }
  }

  return {
    systemMessage: { role: 'system', content: sections.join('\n\n') },
    citations,
  };
}
