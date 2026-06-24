/**
 * No-API-key end-to-end benchmark demo.
 *
 * Runs the WHOLE pipeline against a local deterministic mock model so you can
 * see the wiring + a real eval-core report WITHOUT spending any tokens:
 *
 *   1. `npm run build:bench`  → rebuild dist/bench/harness-runner.mjs fresh.
 *   2. Start the in-process mock model (bench/harness/mock-server.mjs).
 *   3. Spawn `cargo run` (cwd = bench/) wired to the mock via env, stdio
 *      inherited so eval-core's EvalReport prints straight to the console.
 *   4. On cargo exit, shut the mock down and exit with cargo's code.
 *
 * Cross-platform: `npm`/`cargo` are launched via the platform-appropriate
 * binary so this works on win32 as well as posix.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { startMockServer } from './harness/mock-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const benchDir = __dirname;

const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';
const cargoBin = isWin ? 'cargo.exe' : 'cargo';

/**
 * Run a child to completion; resolve with its exit code.
 *
 * On Windows, launching a `.cmd`/`.bat` (e.g. `npm.cmd`) requires `shell: true`
 * since Node 18.20/20.12 (the CVE-2024-27980 spawn hardening) — without it the
 * spawn fails with EINVAL. When `shell` is set we fold the fixed-literal args
 * into the command string and pass NO args array, which both satisfies the
 * shell and avoids Node's DEP0190 "args with shell" deprecation warning. Only
 * the npm launch needs this; cargo is a real `.exe` and spawns directly.
 */
function run(cmd, args, options = {}) {
  const { shell, ...rest } = options;
  const command = shell ? [cmd, ...args].join(' ') : cmd;
  const spawnArgs = shell ? [] : args;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, spawnArgs, { stdio: 'inherit', shell: !!shell, ...rest });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // A signal-killed child (code === null) is a failure, not a success —
      // don't let an OOM/Ctrl-C masquerade as exit 0.
      if (signal) {
        reject(new Error(`${cmd} exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

async function main() {
  // (1) Rebuild the runner so the demo always exercises current source.
  console.error('[demo] building harness runner (npm run build:bench)…');
  const buildCode = await run(npmBin, ['run', 'build:bench'], { cwd: repoRoot, shell: isWin });
  if (buildCode !== 0) {
    console.error(`[demo] build:bench failed (exit ${buildCode}). Aborting.`);
    process.exit(buildCode);
  }

  // (2) Start the in-process mock model on an ephemeral port.
  const mock = await startMockServer();
  console.error(`[demo] mock model listening on http://127.0.0.1:${mock.port}`);

  // (3) Fresh temp vault so auto-accepted writes land somewhere disposable.
  const vault = mkdtempSync(join(tmpdir(), 'specforge-bench-demo-'));
  console.error(`[demo] temp vault: ${vault}`);

  // Fresh temp results dir so eval-core's persisted run + report.html stay
  // hermetic and never pollute bench/results/.
  const resultsDir = mkdtempSync(join(tmpdir(), 'specforge-bench-results-'));
  console.error(`[demo] temp results dir: ${resultsDir}`);

  const env = {
    ...process.env,
    SPECFORGE_BENCH_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
    SPECFORGE_BENCH_API_KEY: 'mock-key',
    SPECFORGE_BENCH_MODEL: 'mock-model',
    SPECFORGE_BENCH_VAULT: vault,
    SPECFORGE_BENCH_RESULTS: resultsDir,
    // Never upload the hermetic mock run to EvalForge, even if the developer has
    // EVALFORGE_* set in their shell or bench/.env — mock results aren't real
    // signal. Empty values disable the opt-in upload gate in the Rust driver.
    EVALFORGE_PROJECT_ID: '',
    EVALFORGE_API_KEY: '',
  };

  console.error('[demo] running eval-core suite (cargo run)…\n');

  // (4) Drive the Rust eval-core driver. cwd = bench/ so its default runner path
  // (../dist/bench/harness-runner.mjs) and cases/ resolve.
  let cargoCode = 1;
  try {
    cargoCode = await run(cargoBin, ['run', '--quiet'], { cwd: benchDir, env });
  } catch (err) {
    console.error(`[demo] failed to launch cargo: ${err?.message ?? err}`);
    console.error('[demo] is the Rust toolchain installed and on PATH?');
    await mock.close();
    process.exit(127);
  }

  // (5) Tear the mock down and propagate cargo's exit code.
  await mock.close();
  if (cargoCode === 0) {
    console.error(`[demo] report: ${join(resultsDir, 'report.html')}`);
  }
  console.error(`\n[demo] done — eval-core exited ${cargoCode}.`);
  process.exit(cargoCode);
}

main().catch((err) => {
  console.error('[demo] unexpected error:', err);
  process.exit(1);
});
