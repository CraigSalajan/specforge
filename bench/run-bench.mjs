/**
 * Real benchmark run against a live OpenAI-compatible endpoint.
 *
 * Reads the three required env vars (from a gitignored `bench/.env`, loaded at
 * startup, or from real shell env vars which take precedence):
 *   SPECFORGE_BENCH_BASE_URL  (e.g. https://api.openai.com/v1)
 *   SPECFORGE_BENCH_API_KEY
 *   SPECFORGE_BENCH_MODEL     (e.g. gpt-4o-mini)
 *
 * Then it:
 *   1. Builds the harness runner (`npm run build:bench`).
 *   2. Spawns `cargo run` (cwd = bench/), forwarding the current process env,
 *      so eval-core drives the real agentic loop against your model and prints
 *      its EvalReport.
 *
 * If the three required vars are not set it prints guidance and exits 2 BEFORE
 * building, so you don't burn a build on a misconfiguration.
 *
 * Cross-platform: launches `npm`/`cargo` via the platform-appropriate binary.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const benchDir = __dirname;

// Load `bench/.env` (gitignored) into process.env BEFORE any SPECFORGE_BENCH_*
// var is read/validated below, so the file can supply the required config.
// `process.loadEnvFile` does NOT override already-set vars, so a real shell env
// var still wins — letting users override the file ad-hoc.
const envPath = join(benchDir, '.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
    console.error('[bench] loaded bench/.env');
  } catch (err) {
    console.error(`[bench] failed to load bench/.env: ${err?.message ?? err}`);
  }
}

const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';
const cargoBin = isWin ? 'cargo.exe' : 'cargo';

const REQUIRED = ['SPECFORGE_BENCH_BASE_URL', 'SPECFORGE_BENCH_API_KEY', 'SPECFORGE_BENCH_MODEL'];

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
  // Validate config BEFORE building so a misconfig fails fast.
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0);
  if (missing.length > 0) {
    console.error('Missing required environment variable(s):');
    for (const k of missing) console.error(`  - ${k}`);
    console.error('');
    console.error('Set all three, then re-run `npm run bench`. PowerShell example:');
    console.error('  $env:SPECFORGE_BENCH_BASE_URL = "https://api.openai.com/v1"');
    console.error('  $env:SPECFORGE_BENCH_API_KEY  = "sk-..."');
    console.error('  $env:SPECFORGE_BENCH_MODEL    = "gpt-4o-mini"');
    console.error('');
    console.error('No key? Try the no-cost wiring demo instead:  npm run bench:demo');
    console.error('See bench/README.md for details.');
    process.exit(2);
  }

  // (1) Build the runner fresh.
  console.error('[bench] building harness runner (npm run build:bench)…');
  const buildCode = await run(npmBin, ['run', 'build:bench'], { cwd: repoRoot, shell: isWin });
  if (buildCode !== 0) {
    console.error(`[bench] build:bench failed (exit ${buildCode}). Aborting.`);
    process.exit(buildCode);
  }

  // (2) Drive eval-core against the live endpoint. cwd = bench/ so the default
  // runner path and cases/ resolve; forward the full env (incl. the secrets).
  console.error('[bench] running eval-core suite (cargo run)…\n');
  let cargoCode = 1;
  try {
    cargoCode = await run(cargoBin, ['run', '--quiet'], { cwd: benchDir, env: process.env });
  } catch (err) {
    console.error(`[bench] failed to launch cargo: ${err?.message ?? err}`);
    console.error('[bench] is the Rust toolchain installed and on PATH?');
    process.exit(127);
  }

  process.exit(cargoCode);
}

main().catch((err) => {
  console.error('[bench] unexpected error:', err);
  process.exit(1);
});
