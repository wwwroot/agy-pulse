#![forbid(unsafe_code)]

mod ops_doc;
mod pulse_mutate;
mod ops_read;
mod pulse_search;
mod outline;
mod protocol;
mod security;

use crate::protocol::{
    EffectState, FailureInfo, MAX_STDIN_BYTES, MAX_STDOUT_LINE_BYTES, RetryPolicy, WorkerRequest,
    WorkerResponse,
};
use crate::security::SecurityContext;
use serde::Deserialize;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

const DAEMON_MAX_CONCURRENCY: usize = 8;
const DAEMON_MAX_QUEUED: usize = 32;

fn main() {
    let daemon_mode = std::env::args().any(|arg| arg == "--daemon");
    if daemon_mode {
        run_daemon();
        return;
    }

    let response = run_oneshot();
    let mut stdout = io::stdout().lock();
    write_response_line(&mut stdout, &response);
}

fn serialize_response_line(response: &WorkerResponse) -> Vec<u8> {
    let req_id = response.req_id().map(ToString::to_string);
    match serde_json::to_vec(response) {
        Ok(mut buf) => {
            if buf.len() <= MAX_STDOUT_LINE_BYTES {
                buf.push(b'\n');
                return buf;
            }
            let fallback = WorkerResponse::failure(FailureInfo::custom(
                "RESPONSE_TOO_LARGE",
                format!(
                    "Serialized worker response ({} bytes) exceeded the {MAX_STDOUT_LINE_BYTES}-byte IPC safety ceiling.",
                    buf.len()
                ),
                EffectState::None,
                RetryPolicy::AfterInputChange,
                "Request smaller line ranges, tighter glob filters, or a more compact output mode.",
            ))
            .with_req_id(req_id);
            let mut fb = serde_json::to_vec(&fallback).unwrap_or_else(|_| {
                br#"{"ok":false,"error":{"code":"RESPONSE_TOO_LARGE","message":"Response exceeded IPC ceiling","effectState":"none","retry":"after-input-change","nextAction":"Reduce request scope."}}"#.to_vec()
            });
            fb.push(b'\n');
            fb
        }
        Err(err) => {
            let fallback = WorkerResponse::failure(FailureInfo::custom(
                "SERIALIZE_ERROR",
                format!("Failed to serialize worker response: {err}"),
                EffectState::Unknown,
                RetryPolicy::Never,
                "Inspect worker logs and retry.",
            ))
            .with_req_id(req_id);
            let mut fb = serde_json::to_vec(&fallback).unwrap_or_else(|_| {
                br#"{"ok":false,"error":{"code":"SERIALIZE_ERROR","message":"Failed to serialize worker response","effectState":"unknown","retry":"never","nextAction":"Inspect worker logs."}}"#.to_vec()
            });
            fb.push(b'\n');
            fb
        }
    }
}

fn write_response_line(stdout: &mut impl Write, response: &WorkerResponse) {
    let line = serialize_response_line(response);
    let _ = stdout.write_all(&line);
    let _ = stdout.flush();
}

fn write_response_shared(stdout: &Mutex<io::Stdout>, response: &WorkerResponse) {
    let line = serialize_response_line(response);
    let mut guard = stdout.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = guard.write_all(&line);
    let _ = guard.flush();
}

struct DaemonQueue {
    pending: VecDeque<Vec<u8>>,
    in_flight: usize,
    closed: bool,
}

fn extract_req_id(input: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct ReqIdOnly {
        #[serde(default, rename = "reqId", alias = "req_id")]
        req_id: Option<String>,
    }
    serde_json::from_slice::<ReqIdOnly>(input)
        .ok()
        .and_then(|r| r.req_id)
}

fn execute_payload_safe(input: &[u8]) -> WorkerResponse {
    let fallback_req_id = extract_req_id(input);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch_request_with_id(input)
    }));
    match result {
        Ok(resp) => resp,
        Err(_) => WorkerResponse::failure(FailureInfo::custom(
            "WORKER_PANIC",
            "Native worker panicked while executing request.",
            EffectState::Unknown,
            RetryPolicy::AfterInputChange,
            "Inspect input parameters and retry.",
        ))
        .with_req_id(fallback_req_id),
    }
}

/// Persistent NDJSON daemon mode: reads one JSON `WorkerRequest` line per operation
/// from stdin, dispatches `reqId`-tagged requests concurrently across a bounded worker
/// thread pool with a `Mutex<Stdout>` writer, and keeps the Rayon pool warm across
/// requests. Requests omitting `reqId` drain in-flight work and execute sequentially
/// to preserve FIFO order. Exits on stdin EOF after draining all in-flight work.
fn run_daemon() {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let queue = Arc::new((
        Mutex::new(DaemonQueue {
            pending: VecDeque::new(),
            in_flight: 0,
            closed: false,
        }),
        Condvar::new(),
    ));

    let mut workers = Vec::with_capacity(DAEMON_MAX_CONCURRENCY);
    for idx in 0..DAEMON_MAX_CONCURRENCY {
        let q = Arc::clone(&queue);
        let out = Arc::clone(&stdout);
        let handle = thread::Builder::new()
            .name(format!("pulse-worker-{idx}"))
            .spawn(move || {
                let (lock, cvar) = &*q;
                loop {
                    let payload = {
                        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
                        while guard.pending.is_empty() && !guard.closed {
                            guard = cvar.wait(guard).unwrap_or_else(|p| p.into_inner());
                        }
                        if let Some(job) = guard.pending.pop_front() {
                            guard.in_flight += 1;
                            // Wake producer if it was waiting on queue backpressure.
                            cvar.notify_all();
                            job
                        } else {
                            break;
                        }
                    };

                    let response = execute_payload_safe(&payload);
                    write_response_shared(&out, &response);

                    let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
                    guard.in_flight = guard.in_flight.saturating_sub(1);
                    if guard.in_flight == 0 && guard.pending.is_empty() {
                        cvar.notify_all();
                    }
                }
            });
        if let Ok(h) = handle {
            workers.push(h);
        }
    }

    let mut buf: Vec<u8> = Vec::with_capacity(8192);

    loop {
        buf.clear();
        let mut exceeded = false;

        loop {
            let available = match reader.fill_buf() {
                Ok(slice) => slice,
                Err(err) => {
                    let resp = WorkerResponse::failure(FailureInfo::io_error(
                        "Failed to read stdin line in daemon mode",
                        &err,
                        EffectState::None,
                    ));
                    write_response_shared(&stdout, &resp);
                    shutdown_daemon_workers(&queue, workers);
                    return;
                }
            };

            if available.is_empty() {
                if !buf.is_empty() || exceeded {
                    break;
                }
                shutdown_daemon_workers(&queue, workers);
                return;
            }

            if let Some(nl_pos) = available.iter().position(|&b| b == b'\n') {
                let chunk = &available[..nl_pos];
                if !exceeded {
                    if buf.len() + chunk.len() > MAX_STDIN_BYTES {
                        exceeded = true;
                        buf.clear();
                    } else {
                        buf.extend_from_slice(chunk);
                    }
                }
                reader.consume(nl_pos + 1);
                break;
            } else {
                let len = available.len();
                if !exceeded {
                    if buf.len() + len > MAX_STDIN_BYTES {
                        exceeded = true;
                        buf.clear();
                    } else {
                        buf.extend_from_slice(available);
                    }
                }
                reader.consume(len);
            }
        }

        if exceeded {
            let resp = WorkerResponse::failure(FailureInfo::custom(
                "REQUEST_TOO_LARGE",
                format!("Stdin request exceeds maximum size of {MAX_STDIN_BYTES} bytes (8 MiB)."),
                EffectState::None,
                RetryPolicy::AfterInputChange,
                "Reduce request payload size and retry.",
            ));
            write_response_shared(&stdout, &resp);
            continue;
        }

        let trimmed = trim_ascii_bytes(&buf);
        if trimmed.is_empty() {
            continue;
        }

        let has_req_id = extract_req_id(trimmed).is_some();
        if has_req_id && !workers.is_empty() {
            let (lock, cvar) = &*queue;
            let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            while guard.pending.len() >= DAEMON_MAX_QUEUED {
                guard = cvar.wait(guard).unwrap_or_else(|p| p.into_inner());
            }
            guard.pending.push_back(trimmed.to_vec());
            cvar.notify_one();
        } else {
            // Requests without reqId drain in-flight work first to preserve FIFO order.
            let (lock, cvar) = &*queue;
            {
                let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
                while !guard.pending.is_empty() || guard.in_flight > 0 {
                    guard = cvar.wait(guard).unwrap_or_else(|p| p.into_inner());
                }
            }
            let response = execute_payload_safe(trimmed);
            write_response_shared(&stdout, &response);
        }
    }
}

fn shutdown_daemon_workers(
    queue: &Arc<(Mutex<DaemonQueue>, Condvar)>,
    workers: Vec<thread::JoinHandle<()>>,
) {
    let (lock, cvar) = &**queue;
    {
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.closed = true;
        cvar.notify_all();
    }
    for handle in workers {
        let _ = handle.join();
    }
}

fn trim_ascii_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map(|i| i + 1)
        .unwrap_or(start);
    &bytes[start..end]
}

fn run_oneshot() -> WorkerResponse {
    let mut input = Vec::new();
    if let Err(e) = io::stdin()
        .take((MAX_STDIN_BYTES + 1) as u64)
        .read_to_end(&mut input)
    {
        return WorkerResponse::failure(FailureInfo::io_error(
            "Failed to read stdin request",
            &e,
            EffectState::None,
        ));
    }

    if input.len() > MAX_STDIN_BYTES {
        return WorkerResponse::failure(FailureInfo::custom(
            "REQUEST_TOO_LARGE",
            format!("Stdin request exceeds maximum size of {MAX_STDIN_BYTES} bytes (8 MiB)."),
            EffectState::None,
            RetryPolicy::AfterInputChange,
            "Reduce request payload size and retry.",
        ));
    }

    if input.is_empty() {
        return WorkerResponse::failure(FailureInfo::invalid_arg(
            "Empty stdin payload; expected a single JSON WorkerRequest object.",
        ));
    }

    dispatch_request_with_id(&input)
}

fn dispatch_request_with_id(input: &[u8]) -> WorkerResponse {
    let fallback_req_id = extract_req_id(input);
    let req: WorkerRequest = match serde_json::from_slice(input) {
        Ok(r) => r,
        Err(e) => {
            return WorkerResponse::failure(FailureInfo::invalid_arg(format!(
                "Invalid JSON WorkerRequest: {e}"
            )))
            .with_req_id(fallback_req_id);
        }
    };

    let req_id = req.req_id.clone();
    match dispatch_parsed_request(req) {
        Ok(value) => WorkerResponse::success(value).with_req_id(req_id),
        Err(error) => WorkerResponse::failure(error).with_req_id(req_id),
    }
}

fn dispatch_parsed_request(req: WorkerRequest) -> Result<serde_json::Value, FailureInfo> {
    let ctx = SecurityContext::new(&req.roots, req.credential_fence, req.max_inline_bytes)?;

    match req.op.as_str() {
        "read_files" => ops_read::handle_read_files(&ctx, req.args),
        "stat" => ops_read::handle_stat(&ctx, req.args),
        "glob" => pulse_search::handle_glob(&ctx, req.args),
        "fuzzy" => pulse_search::handle_fuzzy(&ctx, req.args),
        "grep" => pulse_search::handle_grep(&ctx, req.args),
        "diff" => pulse_mutate::handle_diff(&ctx, req.args),
        "write" => pulse_mutate::handle_write(&ctx, req.args),
        "edit" => pulse_mutate::handle_edit(&ctx, req.args),
        "replace" => pulse_mutate::handle_replace(&ctx, req.args),
        "batch" => pulse_mutate::handle_batch(&ctx, req.args),
        "read_doc" => ops_doc::handle_read_doc(&ctx, req.args),
        unknown => Err(FailureInfo::invalid_arg(format!(
            "Unsupported worker operation `{unknown}`."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn req_id_is_echoed_when_present_and_omitted_when_absent() {
        let with_camel = br#"{"reqId":"r-42","op":"unsupported","roots":[],"args":{}}"#;
        let resp = dispatch_request_with_id(with_camel);
        let json: serde_json::Value =
            serde_json::from_slice(&serialize_response_line(&resp)).unwrap();
        assert_eq!(json["reqId"], "r-42");
        assert_eq!(json["ok"], false);

        let with_snake = br#"{"req_id":"r-99","op":"unsupported","roots":[],"args":{}}"#;
        let resp_snake = dispatch_request_with_id(with_snake);
        let json_snake: serde_json::Value =
            serde_json::from_slice(&serialize_response_line(&resp_snake)).unwrap();
        assert_eq!(json_snake["reqId"], "r-99");

        let without_id = br#"{"op":"unsupported","roots":[],"args":{}}"#;
        let resp_none = dispatch_request_with_id(without_id);
        let json_none: serde_json::Value =
            serde_json::from_slice(&serialize_response_line(&resp_none)).unwrap();
        assert!(json_none.get("reqId").is_none());
        assert_eq!(json_none["ok"], false);
    }

    #[test]
    fn serialize_response_line_enforces_hard_stdout_ceiling() {
        let huge = "x".repeat(MAX_STDOUT_LINE_BYTES + 10_000);
        let resp = WorkerResponse::success(serde_json::json!({ "blob": huge }))
            .with_req_id(Some("big-1".to_string()));
        let line = serialize_response_line(&resp);
        assert!(line.len() <= MAX_STDOUT_LINE_BYTES);
        let parsed: serde_json::Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["reqId"], "big-1");
        assert_eq!(parsed["error"]["code"], "RESPONSE_TOO_LARGE");
    }
}
