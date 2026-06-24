/**
 * DEV/TEST HELPER ONLY — a tiny stand-in OpenAI-compatible endpoint.
 *
 * NOT part of the benchmark runtime. It lets us drive the built harness runner
 * end-to-end without a real API key/model: it answers POST /v1/chat/completions
 * with a scripted sequence of non-streaming completions.
 *
 * Scripted exchange (one full agentic turn):
 *   1st call → a `tool_calls` response invoking `write_file` with
 *              { path: "prd/test.md", content: "# Test\n" }.
 *   2nd call → a plain assistant message "Created the PRD." (no tool calls),
 *              ending the loop.
 * Subsequent calls repeat the plain message so extra turns terminate cleanly.
 *
 * Usage: `node bench/harness/mock-endpoint.mjs [port]` — prints the chosen port
 * as `PORT=<n>` on stdout once listening.
 */

import { createServer } from 'node:http';

let callCount = 0;

function nextCompletion() {
  callCount += 1;
  if (callCount === 1) {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_mock_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'prd/test.md', content: '# Test\n' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
  }
  return {
    choices: [
      {
        message: { role: 'assistant', content: 'Created the PRD.' },
        finish_reason: 'stop',
      },
    ],
  };
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // Body is read to drain the request; the mock is stateful by call count.
    void Buffer.concat(chunks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(nextCompletion()));
  });
});

const port = Number.parseInt(process.argv[2] ?? '0', 10);
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  // Announce readiness + port so a driver script can capture it.
  process.stdout.write(`PORT=${actualPort}\n`);
});
