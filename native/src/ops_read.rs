use crate::outline::{extract_outline, extract_symbol};
use crate::protocol::{
    EffectState, FailureInfo, RetryPolicy, WorkerResult, json_escaped_len, truncate_to_json_budget,
};
use crate::security::{SecurityContext, path_to_display};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_BATCH_FILES: usize = 32;
const DEFAULT_TEXT_LIMIT: usize = 200;
const DEFAULT_OUTLINE_LIMIT: usize = 400;
const DEFAULT_SYMBOL_LIMIT: usize = 250;
const MAX_TEXT_LIMIT: usize = 10_000;
const DEFAULT_HEX_BYTES: usize = 1_024;
const MAX_HEX_BYTES: usize = 8_192;
const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFilesArgs {
    pub files: Vec<ReadFileSpec>,
    #[serde(default)]
    pub stat_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileSpec {
    pub path: String,
    #[serde(default)]
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub view: ReadView,
    #[serde(default)]
    pub symbol: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReadView {
    #[default]
    Text,
    Hex,
    Outline,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileItemResult {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub bytes: u64,
    pub line_count: Option<usize>,
    pub revision: String,
    pub mtime_ms: u64,
    pub view: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_file_bytes: Option<usize>,
    pub offset: usize,
    pub returned_lines: usize,
    pub next_offset: Option<usize>,
    pub eof: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub escaped: bool,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FailureInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFilesResult {
    pub items: Vec<ReadFileItemResult>,
    pub raw_bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatArgs {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub bytes: u64,
    pub line_count: Option<usize>,
    pub revision: String,
    pub mtime_ms: u64,
    pub readonly: bool,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn metadata_mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Split UTF-8 text into logical lines (stripping `\n` and optional trailing `\r` from CRLF).
pub fn split_logical_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    trimmed
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

pub fn count_logical_lines(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    trimmed.as_bytes().iter().filter(|&&b| b == b'\n').count() + 1
}

/// Reversible line escaping for `\\`, `\t`, `\r`, and control characters `\u{0000}..=\u{001F}`.
pub fn escape_line_reversible(line: &str) -> (String, bool) {
    let mut out = String::with_capacity(line.len());
    let mut escaped = false;
    for ch in line.chars() {
        match ch {
            '\\' => {
                out.push_str(r"\\");
                escaped = true;
            }
            '\t' => {
                out.push_str(r"\t");
                escaped = true;
            }
            '\r' => {
                out.push_str(r"\r");
                escaped = true;
            }
            c if (c as u32) <= 0x1F => {
                use std::fmt::Write;
                let _ = write!(&mut out, "\\x{:02x}", c as u32);
                escaped = true;
            }
            c => out.push(c),
        }
    }
    (out, escaped)
}

/// Reverse the escaping produced by `escape_line_reversible`.
/// Returns `Some(decoded)` if at least one escape sequence was decoded cleanly.
pub fn unescape_reversible(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut changed = false;

    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'\\' => {
                    out.push('\\');
                    i += 2;
                    changed = true;
                }
                b't' => {
                    out.push('\t');
                    i += 2;
                    changed = true;
                }
                b'r' => {
                    out.push('\r');
                    i += 2;
                    changed = true;
                }
                b'x' if i + 3 < bytes.len() => {
                    let hex_str = std::str::from_utf8(&bytes[i + 2..i + 4]).ok()?;
                    let val = u8::from_str_radix(hex_str, 16).ok()?;
                    if val <= 0x1F {
                        out.push(val as char);
                        i += 4;
                        changed = true;
                    } else {
                        out.push('\\');
                        i += 1;
                    }
                }
                _ => {
                    out.push('\\');
                    i += 1;
                }
            }
        } else {
            let ch = input[i..].chars().next()?;
            out.push(ch);
            i += ch.len_utf8();
        }
    }

    if changed { Some(out) } else { None }
}

pub fn handle_read_files(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: ReadFilesArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid read_files args: {e}")))?;

    if parsed.files.is_empty() || parsed.files.len() > MAX_BATCH_FILES {
        return Err(FailureInfo::invalid_arg(format!(
            "`files` must contain between 1 and {MAX_BATCH_FILES} entries."
        )));
    }

    // Fail-closed security check on every requested path before touching disk.
    let mut authorized: Vec<(PathBuf, &ReadFileSpec)> = Vec::with_capacity(parsed.files.len());
    for spec in &parsed.files {
        let has_symbol = spec.symbol.as_deref().is_some_and(|s| !s.trim().is_empty());
        if !parsed.stat_only && !has_symbol && spec.view == ReadView::Text && spec.offset == Some(0) {
            return Err(FailureInfo::invalid_arg(
                "`offset` is 1-based for text view and must be >= 1.",
            ));
        }
        let resolved = ctx.authorize_path(&spec.path)?;
        authorized.push((resolved, spec));
    }

    let stat_only = parsed.stat_only;
    let ipc_budget = ctx.ipc_payload_budget();
    let mut items: Vec<ReadFileItemResult> = authorized
        .par_iter()
        .map(|(resolved, spec)| read_single_file(resolved, spec, stat_only, ipc_budget))
        .collect();

    enforce_batch_ipc_budget(&mut items, ipc_budget);

    let raw_bytes: u64 = items.iter().map(|item| item.bytes).sum();
    let truncated = items.iter().any(|item| item.truncated);

    let result = ReadFilesResult {
        items,
        raw_bytes,
        truncated,
    };
    serde_json::to_value(result)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize read_files result: {e}")))
}

fn water_fill_budgets(lengths: &[usize], total_budget: usize) -> Vec<usize> {
    let n = lengths.len();
    if n == 0 {
        return Vec::new();
    }
    let sum: usize = lengths.iter().sum();
    if sum <= total_budget {
        return lengths.to_vec();
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&i| lengths[i]);
    let mut out = vec![0usize; n];
    let mut remaining_budget = total_budget;
    let mut remaining_count = n;
    for idx in order {
        let fair = remaining_budget / remaining_count;
        let alloc = lengths[idx].min(fair);
        out[idx] = alloc;
        remaining_budget = remaining_budget.saturating_sub(alloc);
        remaining_count -= 1;
    }
    out
}

fn enforce_batch_ipc_budget(items: &mut [ReadFileItemResult], total_budget: usize) {
    let overhead_per_item = 320usize;
    let total_overhead = items.len().saturating_mul(overhead_per_item);
    let content_budget = total_budget.saturating_sub(total_overhead).max(items.len() * 128);

    let lengths: Vec<usize> = items
        .iter()
        .map(|it| json_escaped_len(&it.content))
        .collect();
    let total_content: usize = lengths.iter().sum();
    if total_content <= content_budget {
        return;
    }

    let allocations = water_fill_budgets(&lengths, content_budget);
    for (item, alloc) in items.iter_mut().zip(allocations.into_iter()) {
        if item.content.is_empty() || json_escaped_len(&item.content) <= alloc {
            continue;
        }
        let target = alloc.max(128);
        let orig_lines: Vec<&str> = item.content.split('\n').collect();
        let orig_line_count = orig_lines.len();
        let mut kept: Vec<String> = Vec::new();
        let mut used = 0usize;
        for line in &orig_lines {
            let sep = if kept.is_empty() { 0 } else { 2 };
            let cost = sep + json_escaped_len(line);
            if used + cost > target {
                if kept.is_empty() {
                    let (clipped, _) =
                        truncate_to_json_budget(line, target, "...[line truncated]");
                    kept.push(clipped);
                }
                break;
            }
            used += cost;
            kept.push((*line).to_string());
        }

        let kept_count = kept.len();
        item.content = kept.join("\n");
        item.truncated = true;
        item.eof = false;
        if item.view == "hex" {
            let kept_rows = kept_count.min(item.returned_lines);
            item.returned_lines = kept_rows;
            if kept_rows > 0 {
                let next_byte = item.offset.saturating_add(kept_rows.saturating_mul(16));
                if (next_byte as u64) < item.bytes {
                    item.next_offset = Some(next_byte);
                }
            }
        } else {
            item.returned_lines = kept_count;
            if kept_count < orig_line_count {
                item.next_offset = Some(item.offset.saturating_add(kept_count));
            }
        }
    }
}

fn read_single_file(
    resolved: &Path,
    spec: &ReadFileSpec,
    stat_only: bool,
    max_json_bytes: usize,
) -> ReadFileItemResult {
    let display = path_to_display(resolved);
    let active_symbol = spec
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let view_label = if stat_only {
        "stat".to_string()
    } else if active_symbol.is_some() {
        "symbol".to_string()
    } else {
        match spec.view {
            ReadView::Text => "text".to_string(),
            ReadView::Hex => "hex".to_string(),
            ReadView::Outline => "outline".to_string(),
        }
    };
    let symbol_label = if stat_only {
        None
    } else {
        active_symbol.map(ToString::to_string)
    };

    let effective_offset = match spec.view {
        ReadView::Hex => spec.offset.unwrap_or(0),
        _ => spec.offset.unwrap_or(1).max(1),
    };

    let meta = match fs::metadata(resolved) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ReadFileItemResult {
                path: display,
                exists: false,
                is_dir: false,
                bytes: 0,
                line_count: None,
                revision: "absent".to_string(),
                mtime_ms: 0,
                view: view_label,
                symbol: symbol_label,
                full_file_bytes: None,
                offset: effective_offset,
                returned_lines: 0,
                next_offset: None,
                eof: true,
                truncated: false,
                escaped: false,
                content: String::new(),
                error: Some(FailureInfo::custom(
                    "NOT_FOUND",
                    "File does not exist.",
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    "Verify the file path or create it with pulse_mutate(action=\"write\").",
                )),
            };
        }
        Err(e) => {
            return ReadFileItemResult {
                path: display.clone(),
                exists: false,
                is_dir: false,
                bytes: 0,
                line_count: None,
                revision: "error".to_string(),
                mtime_ms: 0,
                view: view_label,
                symbol: symbol_label,
                full_file_bytes: None,
                offset: effective_offset,
                returned_lines: 0,
                next_offset: None,
                eof: true,
                truncated: false,
                escaped: false,
                content: String::new(),
                error: Some(FailureInfo::io_error(
                    &format!("Failed to stat {display}"),
                    &e,
                    EffectState::None,
                )),
            };
        }
    };

    let mtime_ms = metadata_mtime_ms(&meta);

    if meta.is_dir() {
        return ReadFileItemResult {
            path: display,
            exists: true,
            is_dir: true,
            bytes: 0,
            line_count: None,
            revision: "directory".to_string(),
            mtime_ms,
            view: view_label,
            symbol: symbol_label,
            full_file_bytes: None,
            offset: effective_offset,
            returned_lines: 0,
            next_offset: None,
            eof: true,
            truncated: false,
            escaped: false,
            content: String::new(),
            error: Some(FailureInfo::custom(
                "IS_DIRECTORY",
                "Target path is a directory, not a file.",
                EffectState::None,
                RetryPolicy::AfterInputChange,
                "Use pulse_search(action=\"glob\") to list directory contents.",
            )),
        };
    }

    let bytes_len = meta.len();
    if bytes_len > MAX_READ_BYTES {
        return ReadFileItemResult {
            path: display,
            exists: true,
            is_dir: false,
            bytes: bytes_len,
            line_count: None,
            revision: "oversized".to_string(),
            mtime_ms,
            view: view_label,
            symbol: symbol_label,
            full_file_bytes: None,
            offset: effective_offset,
            returned_lines: 0,
            next_offset: None,
            eof: true,
            truncated: false,
            escaped: false,
            content: String::new(),
            error: Some(FailureInfo::custom(
                "FILE_TOO_LARGE",
                format!("File size ({bytes_len} bytes) exceeds 64 MiB safety limit."),
                EffectState::None,
                RetryPolicy::Never,
                "Inspect the file in smaller chunks or use a streaming tool.",
            )),
        };
    }

    let raw = match fs::read(resolved) {
        Ok(b) => b,
        Err(e) => {
            return ReadFileItemResult {
                path: display.clone(),
                exists: true,
                is_dir: false,
                bytes: bytes_len,
                line_count: None,
                revision: "error".to_string(),
                mtime_ms,
                view: view_label,
                symbol: symbol_label,
                full_file_bytes: None,
                offset: effective_offset,
                returned_lines: 0,
                next_offset: None,
                eof: true,
                truncated: false,
                escaped: false,
                content: String::new(),
                error: Some(FailureInfo::io_error(
                    &format!("Failed to read {display}"),
                    &e,
                    EffectState::None,
                )),
            };
        }
    };

    let revision = sha256_hex(&raw);

    if stat_only {
        let line_count = std::str::from_utf8(&raw).ok().map(count_logical_lines);
        return ReadFileItemResult {
            path: display,
            exists: true,
            is_dir: false,
            bytes: raw.len() as u64,
            line_count,
            revision,
            mtime_ms,
            view: "stat".to_string(),
            symbol: None,
            full_file_bytes: None,
            offset: 1,
            returned_lines: 0,
            next_offset: None,
            eof: true,
            truncated: false,
            escaped: false,
            content: String::new(),
            error: None,
        };
    }

    let content_cap = max_json_bytes.saturating_sub(320).max(512);

    if let Some(query) = active_symbol {
        return render_symbol_view(display, &raw, revision, mtime_ms, spec, query, content_cap);
    }

    match spec.view {
        ReadView::Text => render_text_view(display, &raw, revision, mtime_ms, spec, content_cap),
        ReadView::Hex => render_hex_view(display, &raw, revision, mtime_ms, spec, content_cap),
        ReadView::Outline => {
            render_outline_view(display, &raw, revision, mtime_ms, spec, content_cap)
        }
    }
}

fn invalid_utf8_item(
    display: String,
    raw_len: usize,
    revision: String,
    mtime_ms: u64,
    view: &str,
    symbol: Option<String>,
    offset: usize,
) -> ReadFileItemResult {
    ReadFileItemResult {
        path: display,
        exists: true,
        is_dir: false,
        bytes: raw_len as u64,
        line_count: None,
        revision,
        mtime_ms,
        view: view.to_string(),
        symbol,
        full_file_bytes: None,
        offset,
        returned_lines: 0,
        next_offset: None,
        eof: true,
        truncated: false,
        escaped: false,
        content: String::new(),
        error: Some(FailureInfo::custom(
            "ERR_INVALID_ENCODING",
            "File is not valid UTF-8 (likely binary). Retry with view: \"hex\" or use pulse_read_doc for structured documents.",
            EffectState::None,
            RetryPolicy::AfterInputChange,
            "Retry with view: \"hex\" for binary inspection or pulse_read_doc for CSV/DOCX/PDF files.",
        )),
    }
}

fn render_text_view(
    display: String,
    raw: &[u8],
    revision: String,
    mtime_ms: u64,
    spec: &ReadFileSpec,
    max_content_bytes: usize,
) -> ReadFileItemResult {
    let offset = spec.offset.unwrap_or(1).max(1);
    let text = match std::str::from_utf8(raw) {
        Ok(s) => s,
        Err(_) => {
            return invalid_utf8_item(display, raw.len(), revision, mtime_ms, "text", None, offset);
        }
    };

    let lines = split_logical_lines(text);
    let total_lines = lines.len();
    let limit = spec
        .limit
        .unwrap_or(DEFAULT_TEXT_LIMIT)
        .clamp(1, MAX_TEXT_LIMIT);

    let start_idx = offset - 1;
    if start_idx >= total_lines {
        return ReadFileItemResult {
            path: display,
            exists: true,
            is_dir: false,
            bytes: raw.len() as u64,
            line_count: Some(total_lines),
            revision,
            mtime_ms,
            view: "text".to_string(),
            symbol: None,
            full_file_bytes: None,
            offset,
            returned_lines: 0,
            next_offset: None,
            eof: true,
            truncated: false,
            escaped: false,
            content: String::new(),
            error: None,
        };
    }

    let end_idx = (start_idx + limit).min(total_lines);
    let mut rendered_lines = Vec::with_capacity((end_idx - start_idx).min(1024));
    let mut any_escaped = false;
    let mut used_json_bytes = 0usize;
    let mut budget_truncated = false;

    for (i, line) in lines[start_idx..end_idx].iter().enumerate() {
        let line_no = start_idx + i + 1;
        let (escaped_line, did_escape) = escape_line_reversible(line);
        let formatted = format!("{line_no}|{escaped_line}");
        let sep_cost = if rendered_lines.is_empty() { 0 } else { 2 };
        let line_cost = sep_cost + json_escaped_len(&formatted);
        if used_json_bytes + line_cost > max_content_bytes {
            if rendered_lines.is_empty() {
                if did_escape {
                    any_escaped = true;
                }
                let (clipped, _) = truncate_to_json_budget(
                    &formatted,
                    max_content_bytes,
                    "...[line truncated]",
                );
                rendered_lines.push(clipped);
            }
            budget_truncated = true;
            break;
        }
        if did_escape {
            any_escaped = true;
        }
        used_json_bytes += line_cost;
        rendered_lines.push(formatted);
    }

    let returned_lines = rendered_lines.len();
    let delivered_end = start_idx + returned_lines;
    let next_offset = if delivered_end < total_lines {
        Some(delivered_end + 1)
    } else {
        None
    };

    ReadFileItemResult {
        path: display,
        exists: true,
        is_dir: false,
        bytes: raw.len() as u64,
        line_count: Some(total_lines),
        revision,
        mtime_ms,
        view: "text".to_string(),
        symbol: None,
        full_file_bytes: None,
        offset,
        returned_lines,
        next_offset,
        eof: next_offset.is_none() && !budget_truncated,
        truncated: budget_truncated,
        escaped: any_escaped,
        content: rendered_lines.join("\n"),
        error: None,
    }
}

fn render_outline_view(
    display: String,
    raw: &[u8],
    revision: String,
    mtime_ms: u64,
    spec: &ReadFileSpec,
    max_content_bytes: usize,
) -> ReadFileItemResult {
    let offset = spec.offset.unwrap_or(1).max(1);
    let text = match std::str::from_utf8(raw) {
        Ok(s) => s,
        Err(_) => {
            return invalid_utf8_item(
                display,
                raw.len(),
                revision,
                mtime_ms,
                "outline",
                None,
                offset,
            );
        }
    };

    let full_file_bytes = text.len();
    let outline = extract_outline(&display, text);
    let all_lines = if outline.rendered_lines.is_empty() && outline.total_file_lines > 0 {
        vec![format!(
            "[no structural declarations detected; {} lines]",
            outline.total_file_lines
        )]
    } else {
        outline.rendered_lines
    };

    let total_outline_lines = all_lines.len();
    let limit = spec
        .limit
        .unwrap_or(DEFAULT_OUTLINE_LIMIT)
        .clamp(1, MAX_TEXT_LIMIT);

    let start_idx = offset - 1;
    if start_idx >= total_outline_lines {
        return ReadFileItemResult {
            path: display,
            exists: true,
            is_dir: false,
            bytes: raw.len() as u64,
            line_count: Some(outline.total_file_lines),
            revision,
            mtime_ms,
            view: "outline".to_string(),
            symbol: None,
            full_file_bytes: Some(full_file_bytes),
            offset,
            returned_lines: 0,
            next_offset: None,
            eof: true,
            truncated: false,
            escaped: false,
            content: String::new(),
            error: None,
        };
    }

    let end_idx = (start_idx + limit).min(total_outline_lines);
    let mut kept = Vec::with_capacity((end_idx - start_idx).min(512));
    let mut used_json_bytes = 0usize;
    let mut budget_truncated = false;
    for line in &all_lines[start_idx..end_idx] {
        let sep_cost = if kept.is_empty() { 0 } else { 2 };
        let cost = sep_cost + json_escaped_len(line);
        if used_json_bytes + cost > max_content_bytes {
            if kept.is_empty() {
                let (clipped, _) =
                    truncate_to_json_budget(line, max_content_bytes, "...[line truncated]");
                kept.push(clipped);
            }
            budget_truncated = true;
            break;
        }
        used_json_bytes += cost;
        kept.push(line.clone());
    }

    let returned_lines = kept.len();
    let delivered_end = start_idx + returned_lines;
    let next_offset = if delivered_end < total_outline_lines {
        Some(delivered_end + 1)
    } else {
        None
    };

    ReadFileItemResult {
        path: display,
        exists: true,
        is_dir: false,
        bytes: raw.len() as u64,
        line_count: Some(outline.total_file_lines),
        revision,
        mtime_ms,
        view: "outline".to_string(),
        symbol: None,
        full_file_bytes: Some(full_file_bytes),
        offset,
        returned_lines,
        next_offset,
        eof: next_offset.is_none() && !budget_truncated,
        truncated: budget_truncated,
        escaped: false,
        content: kept.join("\n"),
        error: None,
    }
}

fn render_symbol_view(
    display: String,
    raw: &[u8],
    revision: String,
    mtime_ms: u64,
    spec: &ReadFileSpec,
    query: &str,
    max_content_bytes: usize,
) -> ReadFileItemResult {
    let text = match std::str::from_utf8(raw) {
        Ok(s) => s,
        Err(_) => {
            return invalid_utf8_item(
                display,
                raw.len(),
                revision,
                mtime_ms,
                "symbol",
                Some(query.to_string()),
                spec.offset.unwrap_or(1).max(1),
            );
        }
    };

    let full_file_bytes = text.len();
    let limit = spec
        .limit
        .unwrap_or(DEFAULT_SYMBOL_LIMIT)
        .clamp(1, MAX_TEXT_LIMIT);

    match extract_symbol(&display, text, query, limit) {
        Ok(matched) => {
            let mut content = matched.content;
            let mut returned_lines = matched.returned_lines;
            let mut next_offset = matched.next_offset;
            let mut eof = matched.eof;
            let mut budget_truncated = false;

            if json_escaped_len(&content) > max_content_bytes {
                let orig_lines: Vec<&str> = content.split('\n').collect();
                let orig_line_count = orig_lines.len();
                let mut kept = Vec::new();
                let mut used = 0usize;
                for line in &orig_lines {
                    let sep = if kept.is_empty() { 0 } else { 2 };
                    let cost = sep + json_escaped_len(line);
                    if used + cost > max_content_bytes {
                        if kept.is_empty() {
                            let (clipped, _) = truncate_to_json_budget(
                                line,
                                max_content_bytes,
                                "...[line truncated]",
                            );
                            kept.push(clipped);
                        }
                        break;
                    }
                    used += cost;
                    kept.push((*line).to_string());
                }
                let kept_count = kept.len();
                content = kept.join("\n");
                returned_lines = kept_count;
                if kept_count < orig_line_count {
                    next_offset = Some(matched.offset.saturating_add(kept_count));
                }
                eof = false;
                budget_truncated = true;
            }

            ReadFileItemResult {
                path: display,
                exists: true,
                is_dir: false,
                bytes: raw.len() as u64,
                line_count: Some(matched.total_file_lines),
                revision,
                mtime_ms,
                view: "symbol".to_string(),
                symbol: Some(query.to_string()),
                full_file_bytes: Some(full_file_bytes),
                offset: matched.offset,
                returned_lines,
                next_offset,
                eof,
                truncated: budget_truncated,
                escaped: matched.escaped,
                content,
                error: None,
            }
        }
        Err(available) => {
            let line_count = count_logical_lines(text);
            let message = if available.is_empty() {
                format!(
                    "Symbol `{query}` was not found in {display} (no declarations detected in file)."
                )
            } else {
                format!(
                    "Symbol `{query}` was not found in {display}. Available symbols (up to 20): {}",
                    available.join(", ")
                )
            };
            let next_action = if available.is_empty() {
                "Retry with view: \"text\" to inspect the file directly.".to_string()
            } else {
                "Retry with one of the available symbol names or inspect the file with view: \"outline\"."
                    .to_string()
            };
            ReadFileItemResult {
                path: display,
                exists: true,
                is_dir: false,
                bytes: raw.len() as u64,
                line_count: Some(line_count),
                revision,
                mtime_ms,
                view: "symbol".to_string(),
                symbol: Some(query.to_string()),
                full_file_bytes: None,
                offset: 1,
                returned_lines: 0,
                next_offset: None,
                eof: true,
                truncated: false,
                escaped: false,
                content: String::new(),
                error: Some(FailureInfo::custom(
                    "SYMBOL_NOT_FOUND",
                    message,
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    next_action,
                )),
            }
        }
    }
}

fn render_hex_view(
    display: String,
    raw: &[u8],
    revision: String,
    mtime_ms: u64,
    spec: &ReadFileSpec,
    max_content_bytes: usize,
) -> ReadFileItemResult {
    let total_rows = raw.len().div_ceil(16);
    let start_byte = spec.offset.unwrap_or(0);
    let limit_bytes = spec
        .limit
        .unwrap_or(DEFAULT_HEX_BYTES)
        .clamp(1, MAX_HEX_BYTES);

    if start_byte >= raw.len() {
        return ReadFileItemResult {
            path: display,
            exists: true,
            is_dir: false,
            bytes: raw.len() as u64,
            line_count: Some(total_rows),
            revision,
            mtime_ms,
            view: "hex".to_string(),
            symbol: None,
            full_file_bytes: None,
            offset: start_byte,
            returned_lines: 0,
            next_offset: None,
            eof: true,
            truncated: false,
            escaped: false,
            content: String::new(),
            error: None,
        };
    }

    let end_byte = (start_byte + limit_bytes).min(raw.len());
    let slice = &raw[start_byte..end_byte];
    let mut rows = Vec::with_capacity(slice.len().div_ceil(16));
    let mut used_json_bytes = 0usize;
    let mut delivered_bytes = 0usize;
    let mut budget_truncated = false;

    for (row_idx, chunk) in slice.chunks(16).enumerate() {
        let byte_start = start_byte + row_idx * 16;

        let mut hex_part = String::with_capacity(49);
        let mut ascii_part = String::with_capacity(16);

        for idx in 0..16 {
            if idx == 8 {
                hex_part.push(' ');
            }
            if let Some(&b) = chunk.get(idx) {
                use std::fmt::Write;
                let _ = write!(&mut hex_part, "{b:02x} ");
                if (0x20..=0x7E).contains(&b) {
                    ascii_part.push(b as char);
                } else {
                    ascii_part.push('.');
                }
            } else {
                hex_part.push_str("   ");
            }
        }

        let row_line = format!("{byte_start:08x}  {hex_part} |{ascii_part}|");
        let sep_cost = if rows.is_empty() { 0 } else { 2 };
        let cost = sep_cost + json_escaped_len(&row_line);
        if used_json_bytes + cost > max_content_bytes && !rows.is_empty() {
            budget_truncated = true;
            break;
        }
        used_json_bytes += cost;
        delivered_bytes += chunk.len();
        rows.push(row_line);
    }

    let returned_lines = rows.len();
    let final_end_byte = start_byte + delivered_bytes;
    let next_offset = if final_end_byte < raw.len() {
        Some(final_end_byte)
    } else {
        None
    };

    ReadFileItemResult {
        path: display,
        exists: true,
        is_dir: false,
        bytes: raw.len() as u64,
        line_count: Some(total_rows),
        revision,
        mtime_ms,
        view: "hex".to_string(),
        symbol: None,
        full_file_bytes: None,
        offset: start_byte,
        returned_lines,
        next_offset,
        eof: next_offset.is_none() && !budget_truncated,
        truncated: budget_truncated,
        escaped: false,
        content: rows.join("\n"),
        error: None,
    }
}

pub fn handle_stat(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: StatArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid stat args: {e}")))?;

    let resolved = ctx.authorize_path(&parsed.path)?;
    let display = path_to_display(&resolved);

    let meta = match fs::metadata(&resolved) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let res = StatResult {
                path: display,
                exists: false,
                is_dir: false,
                bytes: 0,
                line_count: None,
                revision: "absent".to_string(),
                mtime_ms: 0,
                readonly: false,
            };
            return serde_json::to_value(res).map_err(|e| {
                FailureInfo::invalid_arg(format!("Failed to serialize stat result: {e}"))
            });
        }
        Err(e) => {
            return Err(FailureInfo::io_error(
                &format!("Failed to stat {display}"),
                &e,
                EffectState::None,
            ));
        }
    };

    let mtime_ms = metadata_mtime_ms(&meta);
    let readonly = meta.permissions().readonly();

    if meta.is_dir() {
        let res = StatResult {
            path: display,
            exists: true,
            is_dir: true,
            bytes: 0,
            line_count: None,
            revision: "directory".to_string(),
            mtime_ms,
            readonly,
        };
        return serde_json::to_value(res)
            .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize stat result: {e}")));
    }

    let bytes = meta.len();
    let (revision, line_count) = if bytes <= MAX_READ_BYTES {
        let raw = fs::read(&resolved).map_err(|e| {
            FailureInfo::io_error(&format!("Failed to read {display}"), &e, EffectState::None)
        })?;
        let rev = sha256_hex(&raw);
        let lc = std::str::from_utf8(&raw).ok().map(count_logical_lines);
        (rev, lc)
    } else {
        ("oversized".to_string(), None)
    };

    let res = StatResult {
        path: display,
        exists: true,
        is_dir: false,
        bytes,
        line_count,
        revision,
        mtime_ms,
        readonly,
    };
    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize stat result: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_temp_dir(label: &str) -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "agy-pulse-read-{label}-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_files_honors_ipc_budget_and_preserves_spillover_headroom() {
        let root = make_temp_dir("budget");
        let big_content: String = (1..=400)
            .map(|i| format!("line {i}: {}\n", "x".repeat(120)))
            .collect();
        fs::write(root.join("big.txt"), &big_content).unwrap();

        let med_content: String = (1..=30)
            .map(|i| format!("med {i}: {}\n", "y".repeat(140)))
            .collect();
        fs::write(root.join("med.txt"), &med_content).unwrap();

        // max_inline_bytes=2048 -> IPC budget=16384 (8x spillover headroom).
        let ctx = SecurityContext::new(&[root.to_string_lossy().into_owned()], true, 2_048).unwrap();

        // 1. Oversized single file must cap cleanly with truncated=true and valid nextOffset.
        let big_res = handle_read_files(
            &ctx,
            serde_json::json!({
                "files": [{ "path": "big.txt", "offset": 1, "limit": 400 }]
            }),
        )
        .unwrap();
        let big_bytes = serde_json::to_vec(&big_res).unwrap().len();
        assert_eq!(big_res["truncated"], true);
        let item0 = &big_res["items"][0];
        assert_eq!(item0["truncated"], true);
        assert_eq!(item0["eof"], false);
        assert!(item0["nextOffset"].as_u64().is_some());
        assert!(
            big_bytes < 24_000,
            "Expected serialized read_files response near IPC budget, got {big_bytes} bytes"
        );

        // 2. Medium file (~4.5 KB > max_inline_bytes=2048, < 8x budget) passes through intact for Node spillover.
        let med_res = handle_read_files(
            &ctx,
            serde_json::json!({
                "files": [{ "path": "med.txt", "offset": 1, "limit": 100 }]
            }),
        )
        .unwrap();
        assert_eq!(med_res["truncated"], false);
        assert_eq!(med_res["items"][0]["eof"], true);
        assert_eq!(med_res["items"][0]["returnedLines"], 30);

        // 3. Batch of 2 large files enforces aggregate batch ceiling.
        let batch_res = handle_read_files(
            &ctx,
            serde_json::json!({
                "files": [
                    { "path": "big.txt", "offset": 1, "limit": 400 },
                    { "path": "big.txt", "offset": 100, "limit": 400 }
                ]
            }),
        )
        .unwrap();
        let batch_bytes = serde_json::to_vec(&batch_res).unwrap().len();
        assert_eq!(batch_res["truncated"], true);
        assert!(
            batch_bytes < 26_000,
            "Expected batch response bounded by aggregate IPC budget, got {batch_bytes} bytes"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
