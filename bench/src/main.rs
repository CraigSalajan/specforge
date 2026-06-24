//! `specforge-bench` — drives the [`eval-core`] benchmark framework against the
//! real SpecForge AI agentic loop.
//!
//! It loads a RON suite from `cases/`, spawns the Node runner
//! (`dist/bench/harness-runner.mjs`, built by `npm run build:bench`) as the
//! system-under-test, runs every case through it, prints the report, and exits
//! non-zero if any case failed.
//!
//! As of `eval-core` 0.2.0 each run is also **persisted by eval-core**: we opt
//! in via [`RunMeta::persist_to`], and eval-core writes a per-run JSON record to
//! the results dir and (re)generates a self-contained `report.html` there that
//! accumulates runs over time. The results dir defaults to `<crate>/results`
//! (`bench/results`); override it with `SPECFORGE_BENCH_RESULTS`. We do NOT
//! hand-roll any report logic — that lives in eval-core.
//!
//! As of `eval-core` 0.3.0 a run can ALSO be uploaded to the EvalForge dashboard
//! (<https://evalforge.ai>) so results show up online with no manual export. This
//! is opt-in: set `EVALFORGE_PROJECT_ID` (a non-secret project UUID) to enable it,
//! and `EVALFORGE_API_KEY` (the secret `sk-eval-…` key) for auth. With no project
//! id set, nothing is uploaded (the demo/CI path is unaffected). Upload reuses the
//! same record as persistence and is "warn, don't fail" — an upload error never
//! drops the report.
//!
//! Configuration is read from the environment. For convenience, a gitignored
//! `bench/.env` file is loaded at startup (copy `bench/.env.example`); real shell
//! env vars take precedence over it.
//!
//! Configuration (all optional except a model/API key the *runner* needs):
//! - `SPECFORGE_BENCH_RUNNER`  — path to the runner `.mjs` (default:
//!   `<crate>/../dist/bench/harness-runner.mjs`).
//! - `SPECFORGE_BENCH_NODE`    — the `node` binary (default: `node`).
//! - `SPECFORGE_BENCH_CASES`   — the RON cases directory (default: `<crate>/cases`).
//! - `SPECFORGE_BENCH_RESULTS` — where eval-core persists run records + the
//!   `report.html` it generates (default: `<crate>/results`).
//! - `EVALFORGE_PROJECT_ID` — when set, the run is uploaded to EvalForge under this
//!   project UUID (opt-in; unset = no upload).
//! - `EVALFORGE_API_KEY`    — the EvalForge API key used for the upload auth
//!   (read by eval-core's `upload_from_env`). Keep it secret.
//! - `SPECFORGE_BENCH_MODEL` / `SPECFORGE_BENCH_BASE_URL` / `SPECFORGE_BENCH_API_KEY`
//!   are consumed by the runner child; we only echo the non-secret ones in the
//!   banner. `SPECFORGE_BENCH_MODEL` also labels the persisted run.

mod specforge_agent;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, anyhow};
use eval_core::{Expectation, EvalCase, RunMeta, load_cases, run_suite_with_meta};

use specforge_agent::SpecforgeAgent;

/// Read an env var, returning `None` for unset OR empty so an empty override
/// falls back to the default instead of pointing at "".
fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Resolve `relative` against the crate's manifest dir, then normalize it. Used so
/// `cargo run` from any cwd still finds the sibling `dist/` runner.
fn from_manifest_dir(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

/// Where the Node runner script lives: the env override, else the default sibling
/// path under the repo's `dist/`.
fn resolve_runner_path() -> PathBuf {
    match env_nonempty("SPECFORGE_BENCH_RUNNER") {
        Some(p) => PathBuf::from(p),
        None => from_manifest_dir("../dist/bench/harness-runner.mjs"),
    }
}

/// Where the RON cases live: the env override, else `<crate>/cases`.
fn resolve_cases_dir() -> PathBuf {
    match env_nonempty("SPECFORGE_BENCH_CASES") {
        Some(p) => PathBuf::from(p),
        None => from_manifest_dir("cases"),
    }
}

/// Where eval-core persists run records + the generated `report.html`: the env
/// override, else `<crate>/results`.
fn resolve_results_dir() -> PathBuf {
    match env_nonempty("SPECFORGE_BENCH_RESULTS") {
        Some(p) => PathBuf::from(p),
        None => from_manifest_dir("results"),
    }
}

fn run() -> Result<ExitCode> {
    let runner_path = resolve_runner_path();
    let node_bin = env_nonempty("SPECFORGE_BENCH_NODE").unwrap_or_else(|| "node".to_owned());
    let cases_dir = resolve_cases_dir();

    if !runner_path.exists() {
        return Err(anyhow!(
            "runner not found at {}\n\
             Build it first with:  npm run build:bench\n\
             (or set SPECFORGE_BENCH_RUNNER to the harness-runner.mjs path).",
            runner_path.display()
        ));
    }

    let results_dir = resolve_results_dir();

    // The model label recorded on (and slugged into the filename of) the
    // persisted run. Distinct fallback from the banner: persistence wants a
    // filesystem-friendly `unknown-model`, not the human `<unset>` placeholder.
    let model_label =
        env_nonempty("SPECFORGE_BENCH_MODEL").unwrap_or_else(|| "unknown-model".to_owned());

    // One-line banner on stderr (stdout is reserved for the report). NEVER print
    // the API key — only the non-secret config.
    let model = env_nonempty("SPECFORGE_BENCH_MODEL").unwrap_or_else(|| "<unset>".to_owned());
    let base_url =
        env_nonempty("SPECFORGE_BENCH_BASE_URL").unwrap_or_else(|| "<unset>".to_owned());
    eprintln!(
        "specforge-bench: model={model} base_url={base_url} cases={} runner={}",
        cases_dir.display(),
        runner_path.display()
    );

    let cases: Vec<EvalCase<(), Expectation>> = load_cases(&cases_dir)
        .with_context(|| format!("loading RON cases from {}", cases_dir.display()))?;
    if cases.is_empty() {
        return Err(anyhow!(
            "no cases found in {} (expected one or more *.ron files)",
            cases_dir.display()
        ));
    }
    eprintln!("specforge-bench: loaded {} case(s)", cases.len());

    let agent = SpecforgeAgent::spawn(&runner_path, &node_bin)
        .context("spawning the SpecForge harness runner")?;

    // Opt into eval-core's built-in persistence: it writes a per-run JSON record
    // to `results_dir` and (re)generates `results_dir/report.html` (printing its
    // own `saved run + report: <path>` line to stderr). We do NOT hand-roll any
    // report logic — that lives in eval-core.
    let mut meta = RunMeta::default()
        .persist_to(results_dir, model_label)
        // EvalForge's ingest API rejects an empty backend / cases dir on the
        // uploaded record (the local JSON + report.html tolerate empty, the
        // upload does not). Setting them here also fills the report's Backend
        // and cases columns. The bench always drives a remote OpenAI-compatible
        // endpoint, so the backend kind is "remote".
        .backend_kind("remote")
        .cases_dir(cases_dir.display().to_string());

    // As of eval-core 0.3.0, optionally ALSO upload the run to the EvalForge
    // dashboard (evalforge.ai). Opt-in: only when EVALFORGE_PROJECT_ID is set.
    // The API key is read by eval-core from EVALFORGE_API_KEY; if it's missing
    // eval-core warns and leaves upload disabled (the run still completes). The
    // persisted record's identity (model/timestamp) is reused as the upload's
    // dedup key, so a saved run and its uploaded copy stay in sync.
    if let Some(project_id) = env_nonempty("EVALFORGE_PROJECT_ID") {
        eprintln!("specforge-bench: EvalForge upload target: project {project_id}");
        meta = meta.upload_from_env(project_id);
    }

    let report = run_suite_with_meta(&agent, &cases, meta);
    println!("{report}");

    // Non-zero exit if any case failed, so CI fails on a regression.
    if report.passed() < report.total() {
        Ok(ExitCode::FAILURE)
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

fn main() -> ExitCode {
    // Load the crate-local `.env` (gitignored) before reading any
    // SPECFORGE_BENCH_* var, so `cargo run` works straight from `bench/` without
    // exporting shell vars. Resolve against CARGO_MANIFEST_DIR so it loads
    // regardless of cwd. `from_path` does NOT override existing env vars, so real
    // shell env and the env injected by `run-bench.mjs`/`run-demo.mjs` still win
    // (which is why `npm run bench:demo` keeps using its mock). A missing file is
    // fine — ignore the error.
    let _ = dotenvy::from_path(Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));

    match run() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("specforge-bench: error: {e:#}");
            // Exit 2 for a driver/config failure, distinct from a suite failure (1).
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The authored RON suite parses and yields the expected number of cases.
    /// This guards the case schema without needing the Node runner or a live model.
    #[test]
    fn ron_cases_load() {
        let dir = from_manifest_dir("cases");
        let cases: Vec<EvalCase<(), Expectation>> =
            load_cases(&dir).expect("cases/ must contain valid RON");
        assert_eq!(
            cases.len(),
            13,
            "expected exactly the thirteen authored cases, got: {:?}",
            cases.iter().map(|c| c.name.clone()).collect::<Vec<_>>()
        );

        // Every case must have a name, an instruction, and at least one expectation.
        for case in &cases {
            assert!(!case.name.is_empty(), "case name must not be empty");
            assert!(
                !case.instruction.is_empty(),
                "case {} instruction must not be empty",
                case.name
            );
            assert!(
                !case.expect.is_empty(),
                "case {} must have at least one expectation",
                case.name
            );
        }
    }
}
