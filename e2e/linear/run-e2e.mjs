/**
 * Live-sandbox E2E run driver for the Linear push pipeline (TER-25).
 *
 * Reads the two required env vars (from a gitignored `e2e/linear/.env`, loaded at
 * startup, or from real shell env vars which take precedence):
 *   LINEAR_E2E_PAT       — a Linear Personal API key (Settings → API)
 *   LINEAR_E2E_TEAM_ID   — the sandbox team that will own created issues
 * and one optional var:
 *   LINEAR_E2E_PROJECT_ID — group created issues under this project (optional)
 *
 * Then it:
 *   1. Builds the harness bundle (`npm run build:e2e:linear`).
 *   2. Runs `node dist/e2e/linear-e2e.mjs`, forwarding the current process env,
 *      so the harness assembles the real pipeline against the live sandbox and
 *      prints its PASS/FAIL report.
 *
 * If the two required vars are not set it prints guidance and exits 2 BEFORE
 * building, so a misconfiguration fails fast (and so this can be run with no
 * credentials to verify the gating without touching Linear or burning a build).
 *
 * ⚠️  This run CREATES and then DELETES real data in the target workspace — point
 * it at a THROWAWAY Linear sandbox, never a real project.
 *
 * Cross-platform: launches `npm`/`node` via the platform-appropriate binary.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const e2eDir = __dirname;

// Load `e2e/linear/.env` (gitignored) into process.env BEFORE any LINEAR_E2E_*
// var is read/validated below, so the file can supply the required config.
// `process.loadEnvFile` does NOT override already-set vars, so a real shell env
// var still wins — letting users override the file ad-hoc.
const envPath = join(e2eDir, '.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
    console.error('[e2e] loaded e2e/linear/.env');
  } catch (err) {
    console.error(`[e2e] failed to load e2e/linear/.env: ${err?.message ?? err}`);
  }
}

const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';
const nodeBin = isWin ? 'node.exe' : 'node';

const REQUIRED = ['LINEAR_E2E_PAT', 'LINEAR_E2E_TEAM_ID'];

/**
 * Run a child to completion; resolve with its exit code.
 *
 * On Windows, launching a `.cmd`/`.bat` (e.g. `npm.cmd`) requires `shell: true`
 * since Node 18.20/20.12 (the CVE-2024-27980 spawn hardening) — without it the
 * spawn fails with EINVAL. When `shell` is set we fold the fixed-literal args
 * into the command string and pass NO args array, which both satisfies the
 * shell and avoids Node's DEP0190 "args with shell" deprecation warning. Only
 * the npm launch needs this; node is a real `.exe` and spawns directly.
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
    console.error('Set both, then re-run `npm run e2e:linear`. PowerShell example:');
    console.error('  $env:LINEAR_E2E_PAT     = "lin_api_..."');
    console.error('  $env:LINEAR_E2E_TEAM_ID = "<sandbox team id>"');
    console.error('');
    console.error('⚠️  This run CREATES then DELETES real data — point it at a throwaway sandbox.');
    console.error('See e2e/linear/README.md and e2e/linear/.env.example for details.');
    process.exit(2);
  }

  // (1) Build the harness bundle fresh.
  console.error('[e2e] building harness bundle (npm run build:e2e:linear)…');
  const buildCode = await run(npmBin, ['run', 'build:e2e:linear'], {
    cwd: repoRoot,
    shell: isWin,
  });
  if (buildCode !== 0) {
    console.error(`[e2e] build:e2e:linear failed (exit ${buildCode}). Aborting.`);
    process.exit(buildCode);
  }

  // (2) Run the harness against the live sandbox; forward the full env (incl. the
  // PAT). The bundle decides the exit code from its PASS/FAIL report.
  console.error('[e2e] running Linear E2E harness (node dist/e2e/linear-e2e.mjs)…\n');
  const bundlePath = resolve(repoRoot, 'dist/e2e/linear-e2e.mjs');
  let harnessCode = 1;
  try {
    harnessCode = await run(nodeBin, [bundlePath], { cwd: repoRoot, env: process.env });
  } catch (err) {
    console.error(`[e2e] failed to launch the harness: ${err?.message ?? err}`);
    process.exit(127);
  }

  process.exit(harnessCode);
}

main().catch((err) => {
  console.error('[e2e] unexpected error:', err);
  process.exit(1);
});
