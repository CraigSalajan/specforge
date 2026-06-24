/**
 * DEV/DEMO HELPER ONLY — a deterministic, STATELESS, OpenAI-compatible mock
 * model endpoint for the no-API-key end-to-end benchmark demo.
 *
 * Unlike the older `mock-endpoint.mjs` (a fixed two-response script good for a
 * single instruction), this server answers correctly across MANY independent
 * requests/cases/rounds by INSPECTING each request body's `messages` — it holds
 * no per-conversation state, so any number of cases can be interleaved.
 *
 * Decision tree per request (POST /v1/chat/completions or /chat/completions).
 * FIRST match wins; the tree is ORDERED so each authored case routes to exactly
 * one branch.
 *
 *   STEP 1 — the LAST message is role:"tool" (the loop just ran a tool):
 *     • write_file + the user asked to "read" it "back" + no read_file ran yet
 *       → emit ONE `read_file` call for the path in the instruction (the
 *       read-after-write case). finish_reason "tool_calls".
 *     • otherwise → a PLAIN assistant completion (finish_reason "stop") that
 *       closes the turn AND mentions "PRD" (so create-prd's FinalTextContains
 *       still holds).
 *
 *   STEP 2 — the LAST message is a user turn; branch on its content (lowercased)
 *   IN THIS ORDER (first match wins):
 *     (a) "do not create|write|save" → PLAIN answer mentioning PRD (no tools).
 *     (b) "acknowledged"             → PLAIN content exactly `ACKNOWLEDGED`.
 *     (c) "2 + 2"                    → PLAIN content `4`.
 *     (d) "yes or no"               → PLAIN content `Yes`.
 *     (e) "list" + "file"           → ONE `list_files` call.
 *     (f) "search" + "vault"        → ONE `search_vault` call (query "authentication").
 *     (g) "skill"                    → ONE `use_skill` call (name "mermaid-diagrams").
 *     (h) "read" + "back" + create verb → ONE `write_file` call (read-after-write round 1).
 *     (i) "three" + create verb     → THREE `write_file` calls (prd/adr/plan).
 *     (j) create verb + a `.md` path, OR "exactly the vault path"
 *                                    → ONE `write_file` call at that exact path.
 *     (k) create verb + "adr" + ("prd" | "two") → TWO `write_file` calls (prd + adr).
 *     (l) create verb               → ONE `write_file` call (prd/<slug>.md).
 *     (m) else                       → PLAIN one-sentence answer naming PRD and ADR.
 *
 * The response is always a valid OpenAI ChatCompletion JSON object.
 *
 * Usage:
 *   - As a module:  `import { startMockServer } from './mock-server.mjs'`
 *       → `const { port, close } = await startMockServer();`
 *   - Standalone:   `node bench/harness/mock-server.mjs`
 *       Listens on an ephemeral port (or `PORT` env if set) and prints
 *       `PORT=<n>` to stderr once listening.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Create verbs that signal "author a document" intent. */
const CREATE_VERBS = ['create', 'draft', 'write', 'save', 'author', 'generate', 'produce'];

/**
 * Derive a short, filesystem-safe slug from a few salient keywords in the user
 * content. Falls back to "doc" so a path is always producible.
 */
function deriveSlug(userContent) {
  const KEYWORDS = [
    'dark-mode',
    'dark mode',
    'markdown',
    'export',
    'notes',
    'toggle',
    'setting',
    'feature',
    'theme',
    'auth',
    'login',
    'search',
  ];
  const found = [];
  for (const kw of KEYWORDS) {
    if (userContent.includes(kw)) {
      found.push(kw.replace(/\s+/g, '-'));
      if (found.length === 2) break;
    }
  }
  const slug = found.join('-').replace(/[^a-z0-9-]/g, '');
  return slug.length > 0 ? slug : 'doc';
}

/** Title-case a slug into a human-readable document title. */
function slugToTitle(slug) {
  return slug
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Build one OpenAI-shaped `tool_calls` entry invoking `write_file`. */
function writeFileCall(id, relPath, title, content) {
  return {
    id: `call_${id}`,
    type: 'function',
    function: {
      name: 'write_file',
      arguments: JSON.stringify({ path: relPath, title, content }),
    },
  };
}

/** Build one `tool_calls` entry invoking `read_file` on `relPath`. */
function readFileCall(id, relPath) {
  return {
    id: `call_${id}`,
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: relPath }) },
  };
}

/** Build one `tool_calls` entry invoking `list_files` (no args). */
function listFilesCall(id) {
  return {
    id: `call_${id}`,
    type: 'function',
    function: { name: 'list_files', arguments: JSON.stringify({}) },
  };
}

/** Build one `tool_calls` entry invoking `search_vault` with `query`. */
function searchVaultCall(id, query) {
  return {
    id: `call_${id}`,
    type: 'function',
    function: { name: 'search_vault', arguments: JSON.stringify({ query }) },
  };
}

/** Build one `tool_calls` entry invoking `use_skill` by `name`. */
function useSkillCall(id, name) {
  return {
    id: `call_${id}`,
    type: 'function',
    function: { name: 'use_skill', arguments: JSON.stringify({ name }) },
  };
}

/** Return the first `<...>.md` path token found in `text`, or null. */
function firstMdPath(text) {
  const m = /[\w./-]+\.md/.exec(text);
  return m ? m[0] : null;
}

/** Wrap an assistant message into a complete ChatCompletion response object. */
function completion(model, message, finishReason) {
  return {
    id: `chatcmpl-mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'mock-model',
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
}

/** Find the last message with a given role, or undefined. */
function lastMessageOfRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === role) return messages[i];
  }
  return undefined;
}

/**
 * Core stateless decision: given a parsed request body, return the
 * ChatCompletion response object. Exported for unit testing.
 */
export function buildResponse(body) {
  const model = typeof body?.model === 'string' ? body.model : 'mock-model';
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];

  const userMsg = lastMessageOfRole(messages, 'user');
  const userContent = typeof userMsg?.content === 'string' ? userMsg.content.toLowerCase() : '';

  // A small "plain reply" helper: a finished assistant turn, no tool calls.
  const plain = (content) =>
    completion(model, { role: 'assistant', content }, 'stop');

  // ─── STEP 1 — the loop just ran a tool (last message is a tool result) ────
  if (last && last.role === 'tool') {
    const toolName = last.name;
    const ranReadFile = messages.some((m) => m && m.role === 'tool' && m.name === 'read_file');

    // read-after-write: the write just landed and the user wants it read back.
    if (
      toolName === 'write_file' &&
      userContent.includes('read') &&
      userContent.includes('back') &&
      !ranReadFile
    ) {
      const readPath = firstMdPath(userContent) || 'prd/spec.md';
      return completion(
        model,
        { role: 'assistant', content: null, tool_calls: [readFileCall('1', readPath)] },
        'tool_calls',
      );
    }

    // Otherwise close the turn. Mention "PRD" so create-prd's FinalTextContains
    // ("prd") still holds.
    return plain('Done — the requested PRD/ADR work is complete.');
  }

  // ─── STEP 2 — the last message is a user turn ─────────────────────────────
  const u = userContent;
  const hasCreateVerb = CREATE_VERBS.some((v) => u.includes(v));
  const mdPath = firstMdPath(u);

  // (a) Explicitly told NOT to author files → plain answer mentioning PRD.
  if (u.includes('do not create') || u.includes('do not write') || u.includes('do not save')) {
    return plain(
      'A PRD documents the problem, the target users, the proposed solution, and how success is measured.',
    );
  }

  // (b) Exact-text echo.
  if (u.includes('acknowledged')) {
    return plain('ACKNOWLEDGED');
  }

  // (c) Arithmetic.
  if (u.includes('2 + 2')) {
    return plain('4');
  }

  // (d) Single-word yes/no.
  if (u.includes('yes or no')) {
    return plain('Yes');
  }

  // (e) List the vault files.
  if (u.includes('list') && u.includes('file')) {
    return completion(
      model,
      { role: 'assistant', content: null, tool_calls: [listFilesCall('1')] },
      'tool_calls',
    );
  }

  // (f) Search the vault.
  if (u.includes('search') && u.includes('vault')) {
    return completion(
      model,
      { role: 'assistant', content: null, tool_calls: [searchVaultCall('1', 'authentication')] },
      'tool_calls',
    );
  }

  // (g) Use a skill.
  if (u.includes('skill')) {
    return completion(
      model,
      { role: 'assistant', content: null, tool_calls: [useSkillCall('1', 'mermaid-diagrams')] },
      'tool_calls',
    );
  }

  const slug = deriveSlug(u);
  const title = slugToTitle(slug);

  // (h) read-after-write round 1: create the file the user will ask to read back.
  if (u.includes('read') && u.includes('back') && hasCreateVerb) {
    const writePath = mdPath || 'prd/spec.md';
    const content = `# ${title}\n\nA one-line summary of the feature.\n`;
    return completion(
      model,
      {
        role: 'assistant',
        content: null,
        tool_calls: [writeFileCall('1', writePath, title, content)],
      },
      'tool_calls',
    );
  }

  // (i) Create THREE separate documents (PRD + ADR + plan).
  if (u.includes('three') && hasCreateVerb) {
    const base = slug === 'doc' ? 'feature' : slug;
    const baseTitle = slugToTitle(base);
    const body3 = (kind) =>
      `# ${baseTitle} — ${kind}\n\n## Summary\n\nDescribe the ${kind.toLowerCase()}.\n`;
    return completion(
      model,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeFileCall('1', `prd/${base}.md`, `${baseTitle} PRD`, body3('PRD')),
          writeFileCall('2', `adr/${base}.md`, `${baseTitle} ADR`, body3('ADR')),
          writeFileCall('3', `plan/${base}.md`, `${baseTitle} Plan`, body3('Plan')),
        ],
      },
      'tool_calls',
    );
  }

  // (j) Author at an EXACT vault path the instruction pins.
  if ((hasCreateVerb && mdPath) || u.includes('exactly the vault path')) {
    const writePath = mdPath || 'doc.md';
    const content = `# ${title}\n\n## Summary\n\nRecorded at ${writePath}.\n`;
    return completion(
      model,
      {
        role: 'assistant',
        content: null,
        tool_calls: [writeFileCall('1', writePath, title, content)],
      },
      'tool_calls',
    );
  }

  // (k) Create BOTH a PRD and an ADR → two write_file calls in one message.
  if (hasCreateVerb && u.includes('adr') && (u.includes('prd') || u.includes('two'))) {
    const prdContent = `# ${title} — PRD\n\n## Problem\n\nDescribe the problem.\n\n## Proposal\n\nDescribe the proposed behavior.\n\n## Success metric\n\nDescribe how success is measured.\n`;
    const adrContent = `# ${title} — ADR\n\n## Status\n\nAccepted\n\n## Context\n\nWhy a decision is needed.\n\n## Decision\n\nThe decision recorded here.\n`;
    return completion(
      model,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeFileCall('1', `prd/${slug}.md`, `${title} PRD`, prdContent),
          writeFileCall('2', `adr/${slug}.md`, `${title} ADR`, adrContent),
        ],
      },
      'tool_calls',
    );
  }

  // (l) Create a single document → one write_file call. Require an explicit
  // create/draft/write/save verb: merely MENTIONING "prd" (e.g. in a question
  // like "what is a PRD?") must NOT trigger a write — that falls through to (m).
  if (hasCreateVerb) {
    const prdContent = `# ${title}\n\n## Problem\n\nDescribe the problem.\n\n## Proposed behavior\n\nDescribe the proposed behavior.\n\n## Success metric\n\nDescribe how success is measured.\n`;
    return completion(
      model,
      {
        role: 'assistant',
        content: null,
        tool_calls: [writeFileCall('1', `prd/${slug}.md`, title, prdContent)],
      },
      'tool_calls',
    );
  }

  // (m) Plain conceptual question → a one-sentence answer naming PRD and ADR.
  return plain(
    'A PRD captures the product requirements — the problem, users, and what to build — while an ADR records a single architectural decision and the rationale behind it.',
  );
}

/** Read the full request body and JSON-parse it (tolerant of empty/invalid). */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Start the mock server. Resolves once it is listening.
 *
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {Promise<{ port: number, host: string, server: import('node:http').Server, close: () => Promise<void> }>}
 */
export function startMockServer(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;

  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
      return;
    }
    readJsonBody(req)
      .then((body) => {
        const payload = JSON.stringify(buildResponse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: 'mock failure', type: 'server_error' } }),
        );
      });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        host,
        server,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// Standalone entrypoint: run directly with `node mock-server.mjs`. Detect by
// comparing this module's URL to the invoked script path (win32 + posix safe).
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const envPort = Number.parseInt(process.env.PORT ?? '', 10);
  startMockServer({ port: Number.isFinite(envPort) ? envPort : 0 })
    .then(({ port }) => {
      // Announce on stderr so a parent can capture the port while stdout stays
      // free (this script has no stdout protocol of its own).
      process.stderr.write(`PORT=${port}\n`);
    })
    .catch((err) => {
      process.stderr.write(`mock-server failed to start: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
