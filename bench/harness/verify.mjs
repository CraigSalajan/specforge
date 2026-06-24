/**
 * DEV/TEST HELPER ONLY — end-to-end verification of the built harness runner.
 *
 * Starts the mock endpoint, spawns `dist/bench/harness-runner.mjs` against it
 * with a fresh temp vault, sends one instruction, and asserts the full contract:
 *   • runner prints {"ready":true}
 *   • runner emits exactly one result line whose toolCalls[0] is write_file
 *     with args.path === "prd/test.md", finalText contains "Created", error null
 *   • prd/test.md was actually written into the temp vault
 *   • runner exits cleanly (code 0) on stdin close.
 *
 * Exits 0 on success, non-zero on any failed assertion. Run after build:
 *   node bench/harness/build.mjs && node bench/harness/verify.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

function fail(msg) {
  console.error('VERIFY FAIL:', msg);
  process.exit(1);
}

/** Spawn the mock and resolve once it announces its port. */
function startMock() {
  return new Promise((resolveMock) => {
    const proc = spawn('node', [join(__dirname, 'mock-endpoint.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const m = /^PORT=(\d+)$/.exec(line.trim());
      if (m) resolveMock({ proc, port: Number.parseInt(m[1], 10) });
    });
  });
}

const { proc: mock, port } = await startMock();
console.error(`[verify] mock listening on ${port}`);

const vault = mkdtempSync(join(tmpdir(), 'specforge-bench-verify-'));
console.error(`[verify] temp vault: ${vault}`);

const runner = spawn('node', [resolve(root, 'dist/bench/harness-runner.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    SPECFORGE_BENCH_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SPECFORGE_BENCH_API_KEY: 'dummy-key',
    SPECFORGE_BENCH_MODEL: 'mock-model',
    SPECFORGE_BENCH_VAULT: vault,
  },
});

const outLines = [];
const rl = readline.createInterface({ input: runner.stdout });

let sawReady = false;
let resultLine = null;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  outLines.push(trimmed);
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    fail(`non-JSON stdout line: ${trimmed}`);
    return;
  }
  if (obj.ready === true && !sawReady) {
    sawReady = true;
    console.error('[verify] runner ready; sending instruction');
    runner.stdin.write(JSON.stringify({ instruction: 'Create a PRD for a test feature' }) + '\n');
    return;
  }
  if (obj.ready === false) {
    fail(`runner reported not ready: ${obj.error}`);
    return;
  }
  // First non-ready protocol line is the turn result.
  if (resultLine === null) {
    resultLine = obj;
    console.error('[verify] result line received; closing stdin');
    runner.stdin.end();
  }
});

runner.on('close', (code) => {
  mock.kill();

  // --- Assertions -------------------------------------------------------
  if (!sawReady) fail('runner never printed {"ready":true}');
  if (resultLine === null) fail('runner never emitted a result line');

  const tc = resultLine.toolCalls;
  if (!Array.isArray(tc) || tc.length === 0) fail(`expected toolCalls, got: ${JSON.stringify(tc)}`);
  if (tc[0].name !== 'write_file') fail(`toolCalls[0].name !== write_file: ${tc[0].name}`);
  if (tc[0].args?.path !== 'prd/test.md') fail(`toolCalls[0].args.path !== prd/test.md: ${JSON.stringify(tc[0].args)}`);
  if (typeof resultLine.finalText !== 'string' || !resultLine.finalText.includes('Created')) {
    fail(`finalText does not contain "Created": ${JSON.stringify(resultLine.finalText)}`);
  }
  if (resultLine.error !== null) fail(`error is not null: ${JSON.stringify(resultLine.error)}`);

  const written = join(vault, 'prd', 'test.md');
  if (!existsSync(written)) fail(`expected file not written: ${written}`);
  const body = readFileSync(written, 'utf8');
  if (body !== '# Test\n') fail(`written content mismatch: ${JSON.stringify(body)}`);

  if (code !== 0) fail(`runner exited with non-zero code: ${code}`);

  console.error('[verify] all assertions passed');
  console.error('[verify] result line:', JSON.stringify(resultLine));
  console.error('[verify] written file content:', JSON.stringify(body));
  process.exit(0);
});
