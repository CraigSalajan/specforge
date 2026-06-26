import { CREATE_PRD_PROMPT } from './create-prd.prompt';
import { CREATE_ADR_PROMPT } from './create-adr.prompt';
import { CREATE_PLAN_PROMPT } from './create-plan.prompt';
import { CREATE_STORIES_PROMPT } from './create-stories.prompt';
import { DECOMPOSE_STORIES_PROMPT } from './decompose-stories.prompt';
import { FIND_RELATED_PROMPT } from './find-related.prompt';
import { OPEN_QUESTIONS_PROMPT } from './open-questions.prompt';
import { SUMMARIZE_FEATURE_PROMPT } from './summarize-feature.prompt';
import { REVIEW_DRAFT_PROMPT } from './review-draft.prompt';
import type { AiMode } from '../../../shared/types';

export type PlanningCommandId =
  | 'create-prd'
  | 'create-adr'
  | 'create-plan'
  | 'create-stories'
  | 'decompose-stories'
  | 'find-related'
  | 'open-questions'
  | 'summarize-feature'
  | 'review-draft';

export interface PlanningCommand {
  id: PlanningCommandId;
  label: string;
  description: string;
  mode: AiMode;
  /** When true, the model is expected to return a JSON file proposal. */
  expectsFileProposal: boolean;
  /** Default target folder (relative to vault root) for create-* commands. */
  defaultFolder: string | null;
  systemPrompt: string;
  /** Default user intent placeholder shown in the input as a hint. */
  defaultUserPrompt: string;
  /**
   * When true, the command forces an in-place EDIT of the active markdown file
   * (any folder, rather than drafting a new document): the orchestrator resolves
   * the active file's vault-rel path, pins it into the turn, and passes it as
   * `forcedEditRelPath` so the model's `content` revises that file. Requires
   * `expectsFileProposal: true`. See `runCommand` in ai-orchestrator.service.ts.
   */
  forceEditActiveFile?: boolean;
}

/**
 * Phase 3 decision: the "create *" commands ask the model to return a single
 * JSON object via `response_format: { type: "json_object" }` rather than a
 * fenced markdown block. JSON parsing is more reliable across providers and
 * lets the harness extract the proposed filename, folder, and content
 * deterministically.
 *
 * "Find / Identify / Summarize / Review" commands stream inline markdown
 * into the chat instead — they don't produce files.
 *
 * User Stories ship into `/prd/` alongside the PRD because, in practice,
 * stories belong with the product spec they refine. Teams that prefer a
 * separate `/stories/` folder can override per-call via the proposal modal.
 */
export const PLANNING_COMMANDS: ReadonlyArray<PlanningCommand> = [
  {
    id: 'create-prd',
    label: 'Create PRD',
    description: 'Draft a new product requirements document',
    mode: 'draft',
    expectsFileProposal: true,
    defaultFolder: '/prd/',
    systemPrompt: CREATE_PRD_PROMPT,
    defaultUserPrompt:
      'Topic of the PRD (one or two sentences):',
  },
  {
    id: 'create-adr',
    label: 'Create ADR',
    description: 'Draft a new architecture decision record',
    mode: 'draft',
    expectsFileProposal: true,
    defaultFolder: '/adr/',
    systemPrompt: CREATE_ADR_PROMPT,
    defaultUserPrompt: 'Decision context and the option you are choosing:',
  },
  {
    id: 'create-plan',
    label: 'Create Implementation Plan',
    description: 'Draft an engineering implementation plan',
    mode: 'draft',
    expectsFileProposal: true,
    defaultFolder: '/implementation-plans/',
    systemPrompt: CREATE_PLAN_PROMPT,
    defaultUserPrompt: 'Feature or scope to plan:',
  },
  {
    id: 'create-stories',
    label: 'Create User Stories',
    description: 'Draft user stories from the active PRD or topic',
    mode: 'draft',
    expectsFileProposal: true,
    defaultFolder: '/prd/',
    systemPrompt: CREATE_STORIES_PROMPT,
    defaultUserPrompt: 'Feature or PRD to generate stories for:',
  },
  {
    id: 'decompose-stories',
    label: 'Decompose & Push this file',
    description:
      'Decompose the active epic into ID-tagged stories, then push them to Linear — one review',
    mode: 'draft',
    // The combined flow (decompose + push behind one review) is owned by
    // AiOrchestratorService.decomposeAndPushActiveFile, dispatched directly from
    // the AI panel — NOT through the generic `runCommand`/proposal pipeline. The
    // registry entry exists so the slash menu still lists + describes it.
    expectsFileProposal: false,
    defaultFolder: null,
    systemPrompt: DECOMPOSE_STORIES_PROMPT,
    defaultUserPrompt: 'Anything to emphasize while decomposing? (optional)',
  },
  {
    id: 'find-related',
    label: 'Find Related Docs',
    description: 'Search the vault for related material',
    mode: 'answer-from-vault',
    expectsFileProposal: false,
    defaultFolder: null,
    systemPrompt: FIND_RELATED_PROMPT,
    defaultUserPrompt: 'What are you looking for?',
  },
  {
    id: 'open-questions',
    label: 'Identify Open Questions',
    description: 'Surface unresolved questions in the active doc',
    mode: 'review',
    expectsFileProposal: false,
    defaultFolder: null,
    systemPrompt: OPEN_QUESTIONS_PROMPT,
    defaultUserPrompt: 'Focus area (or leave blank for the whole document):',
  },
  {
    id: 'summarize-feature',
    label: 'Summarize Current Feature',
    description: 'Summarize the active file using related vault context',
    mode: 'answer-from-vault',
    expectsFileProposal: false,
    defaultFolder: null,
    systemPrompt: SUMMARIZE_FEATURE_PROMPT,
    defaultUserPrompt: 'Anything specific to emphasize? (optional)',
  },
  {
    id: 'review-draft',
    label: 'Review Current Draft',
    description: 'Critique the active document and propose improvements',
    mode: 'review',
    expectsFileProposal: false,
    defaultFolder: null,
    systemPrompt: REVIEW_DRAFT_PROMPT,
    defaultUserPrompt: 'Anything specific you want feedback on? (optional)',
  },
];

export function findCommand(id: PlanningCommandId): PlanningCommand {
  const cmd = PLANNING_COMMANDS.find((c) => c.id === id);
  if (!cmd) throw new Error(`Unknown planning command: ${id}`);
  return cmd;
}

/**
 * Fills `{{placeholder}}` slots in a template string. Unknown placeholders
 * are left in place so prompt authors can spot mistakes during iteration.
 */
export function renderTemplate(
  tpl: string,
  vars: Record<string, string | null | undefined>,
): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = vars[key];
    return v === null || v === undefined ? match : v;
  });
}
