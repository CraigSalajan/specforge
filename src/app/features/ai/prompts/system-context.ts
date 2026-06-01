import type { IndexSearchHit } from '../../../shared/types';
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

export interface ContextAssembly {
  systemMessage: ChatMessage;
  citations: Array<{ relPath: string; headingPath: string }>;
}

export interface PinnedFile {
  /** Vault-relative path, used as both the header and the citation relPath. */
  title: string;
  content: string;
}

const TRUNCATION_MARKER = '\n…(truncated)';

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
  },
): ContextAssembly {
  const sections: string[] = [BASE_SYSTEM];
  if (options.additionalInstructions) sections.push(options.additionalInstructions.trim());

  const maxChars = Math.max(0, options.maxContextChars);
  const pinned = (options.pinnedFiles ?? []).filter((p) => p.title && p.content !== undefined);
  const citations: Array<{ relPath: string; headingPath: string }> = [];

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
    const cap = perFileCap(pinnedBudget, pinned.length);
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
      citations.push({ relPath: hit.relPath, headingPath: hit.headingPath });
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
