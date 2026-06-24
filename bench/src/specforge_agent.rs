//! The system-under-test adapter: an [`Agent`] that drives the real SpecForge
//! agentic loop by spawning the long-lived Node "runner" child process and
//! trading one JSON line per case over its stdio.
//!
//! The wire protocol (implemented by `bench/harness/runner.ts`, built to
//! `dist/bench/harness-runner.mjs`) is:
//!
//! - The child's **stdout is a pure JSON-lines stream**; its stderr carries logs.
//! - On startup the child prints exactly one line:
//!   `{"ready":true}` (or `{"ready":false,"error":"…"}` then exits non-zero).
//! - Per case the parent writes ONE line: `{"instruction":"<text>"}\n`.
//! - The child replies with exactly ONE line:
//!   `{"toolCalls":[{"name":"…","args":{…}}…],"finalText":"…",`
//!   `"error":<string|null>,"rounds":<int>,"exhaustedToolRounds":<bool>,`
//!   `"transcript":[<message>…]}`. The `transcript` is the case's full
//!   conversation (system message excluded) and populates the per-case
//!   transcript in eval-core's report.
//! - On EOF of its stdin the child exits 0.
//!
//! `Agent::run` takes `&self`, but we need `&mut` access to the child's piped
//! stdin/stdout, so the child I/O lives behind a [`Mutex`]. A failure talking to
//! the child for a single case is folded into `RunArtifacts::with_error(…)` and
//! returned as `Ok(…)` so one bad case is scored as a failure (via the `NoError`
//! expectation) rather than aborting the whole suite.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use anyhow::{Context, Result, anyhow};
use eval_core::{Agent, EvalError, RunArtifacts, ToolCall};
use serde::{Deserialize, Serialize};

/// The startup handshake line the child prints exactly once on stdout.
#[derive(Debug, Deserialize)]
struct Ready {
    ready: bool,
    #[serde(default)]
    error: Option<String>,
}

/// The per-case request line written to the child's stdin.
#[derive(Debug, Serialize)]
struct Request<'a> {
    instruction: &'a str,
}

/// One tool call as reported by the child (camelCase on the wire).
#[derive(Debug, Deserialize)]
struct WireToolCall {
    name: String,
    /// Opaque JSON — handed straight to `ToolCall::new`, which the built-in
    /// expectations subset-match against.
    #[serde(default)]
    args: serde_json::Value,
}

/// The per-case response line the child writes to stdout.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    #[serde(default)]
    tool_calls: Vec<WireToolCall>,
    #[serde(default)]
    final_text: Option<String>,
    /// `null` on success; a non-empty string on a run-level failure.
    #[serde(default)]
    error: Option<String>,
    /// The full per-case conversation (user/assistant/tool messages, system
    /// message excluded by the runner). Handed straight to eval-core's
    /// `RunArtifacts::with_transcript`, which the HTML report renders. Defaulted
    /// so older runner lines that omit it still parse.
    #[serde(default)]
    transcript: Vec<serde_json::Value>,
    /// Completion tokens for the case, summed across the model turns by the
    /// runner. `null`/absent when the backend reported no `usage`. Forwarded to
    /// eval-core via `RunArtifacts::with_tokens`. Defaulted so older runner
    /// lines that omit it still parse.
    #[serde(default)]
    tokens: Option<u32>,
}

/// The owned, mutable child I/O guarded by the agent's mutex.
///
/// `stdin` is an `Option` so [`Drop`] can `take()` it and drop it FIRST: closing
/// the write end makes the runner reach EOF on stdin and exit 0 cleanly, after
/// which we reap it.
struct Inner {
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    child: Child,
}

/// An [`Agent`] backed by the spawned Node runner child process.
pub struct SpecforgeAgent {
    inner: Mutex<Inner>,
}

impl SpecforgeAgent {
    /// Spawn the Node runner at `runner_path` using `node_bin`, complete the
    /// readiness handshake, and return the ready-to-drive agent.
    ///
    /// stdin/stdout are piped (the protocol channels); stderr is inherited so the
    /// child's `[bench]` diagnostics surface live. The parent's environment —
    /// including the `SPECFORGE_BENCH_*` vars — flows to the child automatically.
    pub fn spawn(runner_path: &Path, node_bin: &str) -> Result<Self> {
        let mut child = Command::new(node_bin)
            .arg(runner_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| {
                format!(
                    "failed to spawn runner: {node_bin} {}",
                    runner_path.display()
                )
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("child stdin was not piped"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("child stdout was not piped"))?;
        let mut stdout = BufReader::new(stdout);

        // Read the single startup handshake line and validate it before we let
        // any case run.
        let mut line = String::new();
        let read = stdout
            .read_line(&mut line)
            .context("failed reading the runner readiness line")?;
        if read == 0 {
            // EOF before the handshake — the child died on startup.
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!(
                "runner exited before printing its readiness line (check stderr above)"
            ));
        }

        let ready: Ready = serde_json::from_str(line.trim()).with_context(|| {
            format!("runner readiness line was not valid JSON: {:?}", line.trim())
        })?;
        if !ready.ready {
            let msg = ready
                .error
                .unwrap_or_else(|| "runner reported not-ready with no error message".to_owned());
            let _ = child.wait();
            return Err(anyhow!("runner failed to start: {msg}"));
        }

        Ok(Self {
            inner: Mutex::new(Inner {
                stdin: Some(stdin),
                stdout,
                child,
            }),
        })
    }

    /// Send one instruction and read exactly one response line. Returns a parsed
    /// [`Response`] or an error describing the I/O / parse failure.
    fn exchange(inner: &mut Inner, instruction: &str) -> Result<Response> {
        let stdin = inner
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("runner stdin already closed"))?;

        let mut request =
            serde_json::to_string(&Request { instruction }).context("serializing request")?;
        request.push('\n');
        stdin
            .write_all(request.as_bytes())
            .context("writing request to runner stdin")?;
        stdin.flush().context("flushing runner stdin")?;

        let mut line = String::new();
        let read = inner
            .stdout
            .read_line(&mut line)
            .context("reading response from runner stdout")?;
        if read == 0 {
            return Err(anyhow!("runner closed stdout before answering (it likely crashed)"));
        }

        let response: Response = serde_json::from_str(line.trim())
            .with_context(|| format!("runner response was not valid JSON: {:?}", line.trim()))?;
        Ok(response)
    }
}

impl Agent for SpecforgeAgent {
    fn run(&self, instruction: &str) -> Result<RunArtifacts, EvalError> {
        // Lock failures (a poisoned mutex from a panicked prior run) are an
        // unrecoverable driver fault, not a per-case failure: surface as Err.
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| EvalError::agent(format!("agent mutex poisoned: {e}")))?;

        match Self::exchange(&mut inner, instruction) {
            Ok(response) => {
                let tool_calls = response
                    .tool_calls
                    .into_iter()
                    .map(|c| ToolCall::new(c.name, c.args))
                    .collect::<Vec<_>>();

                let mut artifacts = RunArtifacts::new().with_tool_calls(tool_calls);
                if let Some(text) = response.final_text {
                    artifacts = artifacts.with_final_text(text);
                }
                // Carry the runner's conversation across the bridge so eval-core
                // populates the per-case transcript in its report. An empty vec
                // (e.g. an older runner) is harmless.
                artifacts = artifacts.with_transcript(response.transcript);
                // Forward the runner's completion-token count so eval-core's
                // report (summary line, HTML heatmap) shows tokens instead of
                // "unavailable". Absent → leaves RunArtifacts.tokens at None.
                if let Some(tokens) = response.tokens {
                    artifacts = artifacts.with_tokens(tokens);
                }
                // Only treat a non-null, non-empty error string as a run error.
                if let Some(err) = response.error.filter(|e| !e.is_empty()) {
                    artifacts = artifacts.with_error(err);
                }
                Ok(artifacts)
            }
            // A driver-level I/O/parse failure for THIS case: fold into a failed
            // run (scored against `NoError`) so the rest of the suite still runs.
            Err(e) => Ok(RunArtifacts::new().with_error(format!("driver: {e}"))),
        }
    }
}

impl Drop for SpecforgeAgent {
    fn drop(&mut self) {
        // Closing the child's stdin (by dropping it) makes the runner reach EOF
        // and exit 0 on its own. If the lock is poisoned we still own the data.
        let inner = match self.inner.get_mut() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };

        // Close stdin FIRST (drop the write end): the runner reaches EOF and exits
        // 0 on its own. Then reap it. If it somehow lingers, kill is a harmless
        // no-op once it has already exited.
        drop(inner.stdin.take());
        let _ = inner.child.wait();
        let _ = inner.child.kill();
    }
}
