use crate::ops_read::{sha256_hex, unescape_reversible};
use crate::pulse_search::{GlobFilter, collect_candidate_files, is_likely_binary};
use crate::protocol::{
    EffectState, FailureInfo, RetryPolicy, WorkerResult, deserialize_opt_string_or_vec,
};
use crate::security::{
    SecurityContext, canonicalize_with_ancestor, normalized_path_key, path_starts_with_normalized,
    path_to_display, paths_equal_normalized,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use similar::{ChangeTag, TextDiff};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_EDITS_PER_CALL: usize = 100;
const MAX_BATCH_OPS: usize = 512;
const DEFAULT_MAX_REPLACEMENTS: usize = 500;
const MAX_ALLOWED_REPLACEMENTS: usize = 50_000;
const MAX_MUTATE_FILE_BYTES: u64 = 16 * 1024 * 1024;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffArgs {
    pub path: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub edits: Option<Vec<EditSpec>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub path: String,
    pub before_revision: String,
    pub after_revision: String,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub diff: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArgs {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteEditResult {
    pub path: String,
    pub dry_run: bool,
    pub before_revision: String,
    pub after_revision: String,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub diff: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSpec {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditArgs {
    pub path: String,
    #[serde(default)]
    pub expected_revision: Option<String>,
    pub edits: Vec<EditSpec>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceArgs {
    pub path: Option<String>,
    pub pattern: String,
    pub replacement: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default, deserialize_with = "deserialize_opt_string_or_vec")]
    pub glob: Option<Vec<String>>,
    pub max_replacements: Option<usize>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub include_hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub root: String,
    pub dry_run: bool,
    pub files_changed: usize,
    pub total_replacements: usize,
    pub changed_paths: Vec<String>,
    pub skipped_files: Vec<String>,
    pub diff: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BatchOpKind {
    Copy,
    Move,
    Remove,
}

impl BatchOpKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Move => "move",
            Self::Remove => "remove",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOpSpec {
    pub op: BatchOpKind,
    pub path: String,
    pub to: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchArgs {
    pub operations: Vec<BatchOpSpec>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOpResult {
    pub op: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub dry_run: bool,
    pub batch_results: Vec<BatchOpResult>,
}

fn compute_unified_diff(path_label: &str, before: &str, after: &str) -> (String, usize, usize) {
    let text_diff = TextDiff::from_lines(before, after);
    let mut added = 0usize;
    let mut removed = 0usize;
    for change in text_diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    let unified = text_diff
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path_label}"), &format!("b/{path_label}"))
        .to_string();
    (unified, added, removed)
}

/// Write `bytes` atomically using a sibling temporary file in the same directory + rename.
fn atomic_write_file(target: &Path, bytes: &[u8]) -> WorkerResult<()> {
    let parent = target.parent().ok_or_else(|| {
        FailureInfo::invalid_arg(format!(
            "Target path has no parent directory: {}",
            path_to_display(target)
        ))
    })?;

    fs::create_dir_all(parent).map_err(|e| {
        FailureInfo::io_error(
            &format!("Failed to create parent directories for {}", path_to_display(target)),
            &e,
            EffectState::None,
        )
    })?;

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(".agy-ops-tmp-{pid}-{nanos}-{seq}");
    let tmp_path = parent.join(tmp_name);

    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
            .map_err(|e| {
                FailureInfo::io_error(
                    &format!("Failed to create temporary file {}", path_to_display(&tmp_path)),
                    &e,
                    EffectState::None,
                )
            })?;

        if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            let _ = fs::remove_file(&tmp_path);
            return Err(FailureInfo::io_error(
                &format!("Failed to write temporary file {}", path_to_display(&tmp_path)),
                &e,
                EffectState::None,
            ));
        }
    }

    if let Err(e) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(FailureInfo::io_error(
            &format!(
                "Failed to atomically replace {} from temporary file",
                path_to_display(target)
            ),
            &e,
            EffectState::None,
        ));
    }

    Ok(())
}

fn read_existing_utf8_or_absent(path: &Path) -> WorkerResult<(String, String, bool)> {
    let display = path_to_display(path);
    match fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                return Err(FailureInfo::custom(
                    "IS_DIRECTORY",
                    format!("Target path is a directory: {display}"),
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    "Specify a file path rather than a directory.",
                ));
            }
            if meta.len() > MAX_MUTATE_FILE_BYTES {
                return Err(FailureInfo::custom(
                    "FILE_TOO_LARGE",
                    format!("File exceeds 16 MiB mutation safety limit: {display}"),
                    EffectState::None,
                    RetryPolicy::Never,
                    "Use a specialized tool for very large files.",
                ));
            }
            let raw = fs::read(path).map_err(|e| {
                FailureInfo::io_error(&format!("Failed to read {display}"), &e, EffectState::None)
            })?;
            let rev = sha256_hex(&raw);
            let text = String::from_utf8(raw).map_err(|_| {
                FailureInfo::custom(
                    "ERR_INVALID_ENCODING",
                    format!("Existing file is not valid UTF-8: {display}"),
                    EffectState::None,
                    RetryPolicy::Never,
                    "Do not apply text mutations to binary files.",
                )
            })?;
            Ok((text, rev, true))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok((String::new(), "absent".to_string(), false))
        }
        Err(e) => Err(FailureInfo::io_error(
            &format!("Failed to stat {display}"),
            &e,
            EffectState::None,
        )),
    }
}

pub fn handle_diff(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: DiffArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid diff args: {e}")))?;

    let has_content = parsed.content.is_some();
    let has_edits = parsed.edits.as_ref().is_some_and(|e| !e.is_empty());
    if has_content == has_edits {
        return Err(FailureInfo::invalid_arg(
            "Action `diff` requires exactly one of `content` (string) or non-empty `edits` array.",
        ));
    }

    let resolved = ctx.authorize_path(&parsed.path)?;
    let display = path_to_display(&resolved);
    let (before, before_revision, existed) = read_existing_utf8_or_absent(&resolved)?;

    let after = if let Some(content) = parsed.content {
        content
    } else {
        let edits = parsed.edits.as_deref().unwrap_or(&[]);
        if !existed {
            return Err(FailureInfo::custom(
                "NOT_FOUND",
                format!("Cannot preview edits against non-existent file: {display}"),
                EffectState::None,
                RetryPolicy::AfterInputChange,
                "Pass `content` instead of `edits` to diff against a new file.",
            ));
        }
        apply_edits_in_memory(&before, &display, edits)?
    };

    let after_revision = sha256_hex(after.as_bytes());
    let file_label = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display.clone());
    let (diff, added_lines, removed_lines) = compute_unified_diff(&file_label, &before, &after);

    let res = DiffResult {
        path: display,
        before_revision,
        after_revision,
        added_lines,
        removed_lines,
        diff,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize diff result: {e}")))
}

pub fn handle_write(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: WriteArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid write args: {e}")))?;

    let expected = parsed
        .expected_revision
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let resolved = ctx.authorize_path(&parsed.path)?;
    let display = path_to_display(&resolved);
    let (before, before_revision, _existed) = read_existing_utf8_or_absent(&resolved)?;

    if let Some(exp) = expected {
        if !exp.eq_ignore_ascii_case(&before_revision) {
            return Err(FailureInfo::revision_mismatch(
                &display,
                exp,
                &before_revision,
            ));
        }
    }

    let after_revision = sha256_hex(parsed.content.as_bytes());
    let file_label = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display.clone());
    let (diff, added_lines, removed_lines) =
        compute_unified_diff(&file_label, &before, &parsed.content);

    if !parsed.dry_run {
        atomic_write_file(&resolved, parsed.content.as_bytes())?;
    }

    let res = WriteEditResult {
        path: display,
        dry_run: parsed.dry_run,
        before_revision,
        after_revision,
        added_lines,
        removed_lines,
        diff,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize write result: {e}")))
}

enum UniqueMatch {
    None,
    Unique(usize, usize),
    Ambiguous(usize),
}

fn find_unique_span(haystack: &str, needle: &str) -> UniqueMatch {
    let mut iter = haystack.match_indices(needle);
    let Some((first_start, first_str)) = iter.next() else {
        return UniqueMatch::None;
    };
    let mut count = 1usize;
    while iter.next().is_some() {
        count += 1;
    }
    if count > 1 {
        UniqueMatch::Ambiguous(count)
    } else {
        UniqueMatch::Unique(first_start, first_start + first_str.len())
    }
}

fn tokenize_for_hint(text: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            cur.push(ch.to_ascii_lowercase());
        } else if !cur.is_empty() {
            if cur.len() >= 2 {
                tokens.insert(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        tokens.insert(cur);
    }
    tokens
}

/// Token-scored sliding-window search returning the closest matching line region
/// in `before` when an edit's `oldText` fails to match verbatim.
fn find_closest_region_hint(before: &str, needle: &str) -> Option<String> {
    let needle_tokens = tokenize_for_hint(needle);
    if needle_tokens.is_empty() {
        return None;
    }

    let lines: Vec<&str> = before.lines().collect();
    if lines.is_empty() {
        return None;
    }

    let needle_line_count = needle.lines().count().clamp(1, 12);
    let win_size = needle_line_count.min(lines.len());
    let line_tokens: Vec<HashSet<String>> = lines.iter().map(|l| tokenize_for_hint(l)).collect();

    let mut best_score = 0.0f64;
    let mut best_start = 0usize;

    for start in 0..=lines.len().saturating_sub(win_size) {
        let mut window_tokens: HashSet<&str> = HashSet::new();
        for toks in &line_tokens[start..start + win_size] {
            for t in toks {
                window_tokens.insert(t.as_str());
            }
        }
        if window_tokens.is_empty() {
            continue;
        }
        let overlap = needle_tokens
            .iter()
            .filter(|t| window_tokens.contains(t.as_str()))
            .count();
        if overlap == 0 {
            continue;
        }
        let recall = overlap as f64 / needle_tokens.len() as f64;
        let union = needle_tokens.len() + window_tokens.len() - overlap;
        let jaccard = overlap as f64 / union.max(1) as f64;
        let score = recall * 0.7 + jaccard * 0.3;
        if score > best_score {
            best_score = score;
            best_start = start;
        }
    }

    if best_score < 0.25 {
        return None;
    }

    let preview_end = (best_start + win_size.min(6)).min(lines.len());
    let mut out = format!(
        "Closest match near L{}-L{}:",
        best_start + 1,
        preview_end
    );
    let mut used = out.len();
    for (offset, line) in lines[best_start..preview_end].iter().enumerate() {
        let trimmed = if line.len() > 120 {
            &line[..line.floor_char_boundary(120)]
        } else {
            line
        };
        let row = format!("\n{}|{trimmed}", best_start + offset + 1);
        if used + row.len() > 420 {
            break;
        }
        out.push_str(&row);
        used += row.len();
    }
    Some(out)
}

fn apply_edits_in_memory(before: &str, display: &str, edits: &[EditSpec]) -> WorkerResult<String> {
    if edits.is_empty() || edits.len() > MAX_EDITS_PER_CALL {
        return Err(FailureInfo::invalid_arg(format!(
            "`edits` must contain between 1 and {MAX_EDITS_PER_CALL} entries."
        )));
    }

    let file_uses_crlf = before.contains("\r\n");
    let mut spans: Vec<(usize, usize, String, usize)> = Vec::with_capacity(edits.len());

    for (idx, edit) in edits.iter().enumerate() {
        if edit.old_text.is_empty() {
            return Err(FailureInfo::invalid_arg(format!(
                "Edit #{idx} has an empty `oldText`."
            )));
        }

        let resolved_match = match find_unique_span(before, &edit.old_text) {
            UniqueMatch::Unique(s, e) => Some((s, e, edit.new_text.clone())),
            UniqueMatch::Ambiguous(count) => {
                return Err(FailureInfo::custom(
                    "EDIT_AMBIGUOUS",
                    format!(
                        "Edit #{idx} matched {count} times in {display}; provide more surrounding context so it matches uniquely."
                    ),
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    "Include additional context lines in `oldText` to disambiguate the match.",
                ));
            }
            UniqueMatch::None => None,
        };

        // Fallback 1: decode reversible escapes (\\, \t, \r, \xNN).
        let resolved_match = if let Some(m) = resolved_match {
            Some(m)
        } else if let Some(decoded_old) = unescape_reversible(&edit.old_text) {
            match find_unique_span(before, &decoded_old) {
                UniqueMatch::Unique(s, e) => {
                    let decoded_new = unescape_reversible(&edit.new_text)
                        .unwrap_or_else(|| edit.new_text.clone());
                    Some((s, e, decoded_new))
                }
                UniqueMatch::Ambiguous(count) => {
                    return Err(FailureInfo::custom(
                        "EDIT_AMBIGUOUS",
                        format!(
                            "Edit #{idx} (after decoding escapes) matched {count} times in {display}."
                        ),
                        EffectState::None,
                        RetryPolicy::AfterInputChange,
                        "Include additional context lines in `oldText`.",
                    ));
                }
                UniqueMatch::None => None,
            }
        } else {
            None
        };

        // Fallback 2: adapt LF `oldText` to CRLF files.
        let resolved_match = if let Some(m) = resolved_match {
            Some(m)
        } else if file_uses_crlf
            && !edit.old_text.contains("\r\n")
            && edit.old_text.contains('\n')
        {
            let crlf_old = edit.old_text.replace('\n', "\r\n");
            match find_unique_span(before, &crlf_old) {
                UniqueMatch::Unique(s, e) => {
                    let crlf_new = edit.new_text.replace("\r\n", "\n").replace('\n', "\r\n");
                    Some((s, e, crlf_new))
                }
                UniqueMatch::Ambiguous(count) => {
                    return Err(FailureInfo::custom(
                        "EDIT_AMBIGUOUS",
                        format!(
                            "Edit #{idx} (CRLF-adapted) matched {count} times in {display}."
                        ),
                        EffectState::None,
                        RetryPolicy::AfterInputChange,
                        "Include additional context lines in `oldText`.",
                    ));
                }
                UniqueMatch::None => None,
            }
        } else {
            None
        };

        match resolved_match {
            Some((s, e, repl)) => spans.push((s, e, repl, idx)),
            None => {
                let hint = find_closest_region_hint(before, &edit.old_text);
                let message = match hint {
                    Some(snippet) => {
                        format!("Edit #{idx} did not match any text in {display}. {snippet}")
                    }
                    None => format!("Edit #{idx} did not match any text in {display}."),
                };
                return Err(FailureInfo::custom(
                    "EDIT_NOT_FOUND",
                    message,
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    "Compare `oldText` with the closest-match snippet or re-read the target range with pulse_read_files.",
                ));
            }
        }
    }

    spans.sort_by_key(|(start, end, _, _)| (*start, *end));
    for pair in spans.windows(2) {
        let (_, prev_end, _, prev_idx) = &pair[0];
        let (curr_start, _, _, curr_idx) = &pair[1];
        if prev_end > curr_start {
            return Err(FailureInfo::custom(
                "EDIT_OVERLAP",
                format!(
                    "Edits #{prev_idx} and #{curr_idx} overlap in {display}; edits must be non-overlapping."
                ),
                EffectState::None,
                RetryPolicy::AfterInputChange,
                "Merge overlapping edits into a single edit block.",
            ));
        }
    }

    let mut after = String::with_capacity(before.len());
    let mut cursor = 0usize;
    for (start, end, repl, _) in spans {
        after.push_str(&before[cursor..start]);
        after.push_str(&repl);
        cursor = end;
    }
    after.push_str(&before[cursor..]);
    Ok(after)
}

pub fn handle_edit(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: EditArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid edit args: {e}")))?;

    if parsed.edits.is_empty() || parsed.edits.len() > MAX_EDITS_PER_CALL {
        return Err(FailureInfo::invalid_arg(format!(
            "`edits` must contain between 1 and {MAX_EDITS_PER_CALL} entries."
        )));
    }
    let expected = parsed
        .expected_revision
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let resolved = ctx.authorize_path(&parsed.path)?;
    let display = path_to_display(&resolved);
    let (before, before_revision, existed) = read_existing_utf8_or_absent(&resolved)?;

    if !existed {
        return Err(FailureInfo::custom(
            "NOT_FOUND",
            format!("Cannot edit non-existent file: {display}"),
            EffectState::None,
            RetryPolicy::AfterInputChange,
            "Create the file with action=\"write\".",
        ));
    }

    if let Some(exp) = expected {
        if !exp.eq_ignore_ascii_case(&before_revision) {
            return Err(FailureInfo::revision_mismatch(
                &display,
                exp,
                &before_revision,
            ));
        }
    }

    let after = apply_edits_in_memory(&before, &display, &parsed.edits)?;

    let after_revision = sha256_hex(after.as_bytes());
    let file_label = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display.clone());
    let (diff, added_lines, removed_lines) = compute_unified_diff(&file_label, &before, &after);

    if !parsed.dry_run {
        atomic_write_file(&resolved, after.as_bytes())?;
    }

    let res = WriteEditResult {
        path: display,
        dry_run: parsed.dry_run,
        before_revision,
        after_revision,
        added_lines,
        removed_lines,
        diff,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize edit result: {e}")))
}

fn replace_literal_bounded(input: &str, pattern: &str, replacement: &str, max_count: usize) -> (String, usize) {
    if max_count == 0 || pattern.is_empty() {
        return (input.to_string(), 0);
    }
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    let mut count = 0usize;

    for (start, matched) in input.match_indices(pattern) {
        if count >= max_count {
            break;
        }
        out.push_str(&input[cursor..start]);
        out.push_str(replacement);
        cursor = start + matched.len();
        count += 1;
    }

    out.push_str(&input[cursor..]);
    (out, count)
}

fn replace_regex_bounded(input: &str, re: &Regex, replacement: &str, max_count: usize) -> (String, usize) {
    if max_count == 0 {
        return (input.to_string(), 0);
    }
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    let mut count = 0usize;

    for caps in re.captures_iter(input) {
        if count >= max_count {
            break;
        }
        let Some(m) = caps.get(0) else {
            continue;
        };
        out.push_str(&input[cursor..m.start()]);
        caps.expand(replacement, &mut out);
        cursor = m.end();
        count += 1;
    }

    out.push_str(&input[cursor..]);
    (out, count)
}

pub fn handle_replace(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: ReplaceArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid replace args: {e}")))?;

    if parsed.pattern.is_empty() {
        return Err(FailureInfo::invalid_arg("`pattern` cannot be empty."));
    }

    let compiled_regex = if parsed.regex {
        Some(
            Regex::new(&parsed.pattern)
                .map_err(|e| FailureInfo::invalid_arg(format!("Invalid regex pattern: {e}")))?,
        )
    } else {
        None
    };

    let root = ctx.authorize_optional_root(parsed.path.as_deref())?;
    let glob_filter = match parsed.glob.as_deref() {
        Some(pats) if !pats.is_empty() => Some(GlobFilter::compile(pats)?),
        _ => None,
    };

    let max_replacements = parsed
        .max_replacements
        .unwrap_or(DEFAULT_MAX_REPLACEMENTS)
        .clamp(1, MAX_ALLOWED_REPLACEMENTS);

    let (candidates, _, _) =
        collect_candidate_files(ctx, &root, glob_filter.as_ref(), parsed.include_hidden)?;

    let mut skipped_files: Vec<String> = Vec::new();
    let mut planned_writes: Vec<(PathBuf, String, String, usize)> = Vec::new();
    let mut total_replacements = 0usize;
    let mut diff_summary = String::new();
    let diff_budget = ctx.max_inline_bytes.max(16_384);
    let mut diff_truncated = false;

    for file_path in candidates {
        let remaining = max_replacements.saturating_sub(total_replacements);
        if remaining == 0 {
            break;
        }

        let display = path_to_display(&file_path);
        let meta = match fs::metadata(&file_path) {
            Ok(m) => m,
            Err(_) => {
                skipped_files.push(display);
                continue;
            }
        };
        if meta.len() > MAX_MUTATE_FILE_BYTES {
            skipped_files.push(display);
            continue;
        }

        let raw = match fs::read(&file_path) {
            Ok(b) => b,
            Err(_) => {
                skipped_files.push(display);
                continue;
            }
        };

        if is_likely_binary(&raw) {
            skipped_files.push(display);
            continue;
        }

        let Ok(before) = String::from_utf8(raw) else {
            skipped_files.push(display);
            continue;
        };

        let (after, count) = match &compiled_regex {
            Some(re) => replace_regex_bounded(&before, re, &parsed.replacement, remaining),
            None => replace_literal_bounded(&before, &parsed.pattern, &parsed.replacement, remaining),
        };

        if count == 0 || after == before {
            continue;
        }

        total_replacements += count;

        if !diff_truncated {
            let (file_diff, _, _) = compute_unified_diff(&display, &before, &after);
            if diff_summary.len() + file_diff.len() <= diff_budget {
                diff_summary.push_str(&file_diff);
            } else {
                diff_truncated = true;
                diff_summary.push_str("\n... [diff summary truncated]\n");
            }
        }

        planned_writes.push((file_path, display, after, count));
    }

    let mut changed_paths = Vec::with_capacity(planned_writes.len());
    let mut written = 0usize;

    for (path, display, new_content, _) in &planned_writes {
        if !parsed.dry_run {
            atomic_write_file(path, new_content.as_bytes()).map_err(|mut err| {
                if written > 0 {
                    err.effect_state = EffectState::Partial;
                }
                err
            })?;
            written += 1;
        }
        changed_paths.push(display.clone());
    }

    let res = ReplaceResult {
        root: path_to_display(&root),
        dry_run: parsed.dry_run,
        files_changed: changed_paths.len(),
        total_replacements,
        changed_paths,
        skipped_files,
        diff: diff_summary,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize replace result: {e}")))
}

struct ValidatedBatchOp {
    op: BatchOpKind,
    src: PathBuf,
    dst: Option<PathBuf>,
    src_is_dir: bool,
}

const MAX_COPY_DEPTH: usize = 64;

fn check_nested_entry_security(
    ctx: &SecurityContext,
    from: &Path,
    to: &Path,
    is_symlink: bool,
    effect_on_err: EffectState,
) -> WorkerResult<()> {
    if ctx.is_blocked_by_fence(from) {
        let mut err = FailureInfo::credential_blocked(&path_to_display(from));
        err.effect_state = effect_on_err;
        return Err(err);
    }
    if ctx.is_blocked_by_fence(to) {
        let mut err = FailureInfo::credential_blocked(&path_to_display(to));
        err.effect_state = effect_on_err;
        return Err(err);
    }
    if is_symlink {
        let canonical = canonicalize_with_ancestor(from).map_err(|mut err| {
            err.effect_state = effect_on_err;
            err
        })?;
        if !ctx.is_within_roots(&canonical) {
            let mut err = FailureInfo::outside_workspace(&path_to_display(&canonical));
            err.effect_state = effect_on_err;
            return Err(err);
        }
        if ctx.is_blocked_by_fence(&canonical) {
            let mut err = FailureInfo::credential_blocked(&path_to_display(&canonical));
            err.effect_state = effect_on_err;
            return Err(err);
        }
    }
    Ok(())
}

/// Preflight walk over a source directory tree before executing any copy/move so
/// nested credential-fenced files or workspace-escaping symlinks fail with effectState="none".
fn validate_dir_tree_for_copy(
    ctx: &SecurityContext,
    src: &Path,
    dst: &Path,
    depth: usize,
) -> WorkerResult<()> {
    if depth > MAX_COPY_DEPTH {
        return Err(FailureInfo::custom(
            "COPY_DEPTH_EXCEEDED",
            format!(
                "Directory copy exceeded maximum recursion depth ({MAX_COPY_DEPTH}) at {}",
                path_to_display(src)
            ),
            EffectState::None,
            RetryPolicy::Never,
            "Check for cyclic symlinks or deeply nested directories.",
        ));
    }

    let entries = fs::read_dir(src).map_err(|e| {
        FailureInfo::io_error(
            &format!("Failed to read directory {}", path_to_display(src)),
            &e,
            EffectState::None,
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            FailureInfo::io_error(
                &format!("Failed to inspect directory entry in {}", path_to_display(src)),
                &e,
                EffectState::None,
            )
        })?;
        let file_type = entry.file_type().map_err(|e| {
            FailureInfo::io_error(
                &format!("Failed to stat directory entry {}", path_to_display(&entry.path())),
                &e,
                EffectState::None,
            )
        })?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let is_symlink = file_type.is_symlink();

        check_nested_entry_security(ctx, &from, &to, is_symlink, EffectState::None)?;

        if is_symlink {
            if let Ok(meta) = fs::metadata(&from)
                && meta.is_dir()
            {
                validate_dir_tree_for_copy(ctx, &from, &to, depth + 1)?;
            }
        } else if file_type.is_dir() {
            validate_dir_tree_for_copy(ctx, &from, &to, depth + 1)?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(
    ctx: &SecurityContext,
    src: &Path,
    dst: &Path,
    effect_on_err: EffectState,
    depth: usize,
) -> WorkerResult<()> {
    if depth > MAX_COPY_DEPTH {
        return Err(FailureInfo::custom(
            "COPY_DEPTH_EXCEEDED",
            format!(
                "Directory copy exceeded maximum recursion depth ({MAX_COPY_DEPTH}) at {}",
                path_to_display(src)
            ),
            effect_on_err,
            RetryPolicy::Never,
            "Check for cyclic symlinks or deeply nested directories.",
        ));
    }

    fs::create_dir_all(dst).map_err(|e| {
        FailureInfo::io_error(
            &format!("Failed creating destination directory {}", path_to_display(dst)),
            &e,
            effect_on_err,
        )
    })?;

    let entries = fs::read_dir(src).map_err(|e| {
        FailureInfo::io_error(
            &format!("Failed reading source directory {}", path_to_display(src)),
            &e,
            effect_on_err,
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            FailureInfo::io_error(
                &format!("Failed reading directory entry in {}", path_to_display(src)),
                &e,
                effect_on_err,
            )
        })?;
        let file_type = entry.file_type().map_err(|e| {
            FailureInfo::io_error(
                &format!("Failed reading file type for {}", path_to_display(&entry.path())),
                &e,
                effect_on_err,
            )
        })?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let is_symlink = file_type.is_symlink();

        check_nested_entry_security(ctx, &from, &to, is_symlink, effect_on_err)?;

        let target_is_dir = if is_symlink {
            fs::metadata(&from)
                .map_err(|e| {
                    FailureInfo::io_error(
                        &format!("Failed resolving symlink target {}", path_to_display(&from)),
                        &e,
                        effect_on_err,
                    )
                })?
                .is_dir()
        } else {
            file_type.is_dir()
        };

        if target_is_dir {
            copy_dir_recursive(ctx, &from, &to, effect_on_err, depth + 1)?;
        } else {
            fs::copy(&from, &to).map_err(|e| {
                FailureInfo::io_error(
                    &format!("Failed copying {} to {}", path_to_display(&from), path_to_display(&to)),
                    &e,
                    effect_on_err,
                )
            })?;
        }
    }
    Ok(())
}

pub fn handle_batch(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: BatchArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid batch args: {e}")))?;

    if parsed.operations.is_empty() || parsed.operations.len() > MAX_BATCH_OPS {
        return Err(FailureInfo::invalid_arg(format!(
            "`operations` must contain between 1 and {MAX_BATCH_OPS} entries."
        )));
    }

    // Preflight-validate all operations before touching the filesystem.
    let mut validated: Vec<ValidatedBatchOp> = Vec::with_capacity(parsed.operations.len());
    let mut seen_destinations: HashSet<String> = HashSet::new();
    let mut seen_destructive_sources: HashSet<String> = HashSet::new();

    for (idx, spec) in parsed.operations.iter().enumerate() {
        let src = ctx.authorize_path(&spec.path)?;
        let src_display = path_to_display(&src);

        let meta = fs::metadata(&src).map_err(|e| {
            FailureInfo::io_error(
                &format!("Batch op #{idx} source not accessible: {src_display}"),
                &e,
                EffectState::None,
            )
        })?;
        let src_is_dir = meta.is_dir();

        if matches!(spec.op, BatchOpKind::Move | BatchOpKind::Remove)
            && ctx.is_workspace_root(&src)
        {
            return Err(FailureInfo::custom(
                "WORKSPACE_ROOT_PROTECTED",
                format!("Batch op #{idx} cannot move or remove workspace root: {src_display}"),
                EffectState::None,
                RetryPolicy::Never,
                "Operate on files or subdirectories inside the workspace root.",
            ));
        }

        let dst = match spec.op {
            BatchOpKind::Copy | BatchOpKind::Move => {
                let raw_to = spec.to.as_deref().ok_or_else(|| {
                    FailureInfo::invalid_arg(format!(
                        "Batch op #{idx} (`{}`) requires `to` destination path.",
                        spec.op.as_str()
                    ))
                })?;
                let resolved_to = ctx.authorize_path(raw_to)?;
                let dst_display = path_to_display(&resolved_to);

                if resolved_to.exists() {
                    return Err(FailureInfo::custom(
                        "DESTINATION_EXISTS",
                        format!(
                            "Batch op #{idx} destination already exists (no-clobber): {dst_display}"
                        ),
                        EffectState::None,
                        RetryPolicy::AfterInputChange,
                        "Choose a non-existent destination path or remove it first.",
                    ));
                }

                if paths_equal_normalized(&src, &resolved_to)
                    || path_starts_with_normalized(&resolved_to, &src)
                {
                    return Err(FailureInfo::custom(
                        "CYCLIC_OPERATION",
                        format!(
                            "Batch op #{idx} target {dst_display} equals or lies inside source {src_display}."
                        ),
                        EffectState::None,
                        RetryPolicy::AfterInputChange,
                        "Use a destination outside the source directory.",
                    ));
                }

                let dst_key = normalized_path_key(&resolved_to);
                if !seen_destinations.insert(dst_key) {
                    return Err(FailureInfo::custom(
                        "DUPLICATE_DESTINATION",
                        format!("Batch op #{idx} duplicates destination path: {dst_display}"),
                        EffectState::None,
                        RetryPolicy::AfterInputChange,
                        "Ensure each batch destination path is unique.",
                    ));
                }
                if src_is_dir {
                    validate_dir_tree_for_copy(ctx, &src, &resolved_to, 0)?;
                }
                Some(resolved_to)
            }
            BatchOpKind::Remove => {
                if spec.to.is_some() {
                    return Err(FailureInfo::invalid_arg(format!(
                        "Batch op #{idx} (`remove`) must not specify `to`."
                    )));
                }
                None
            }
        };

        if matches!(spec.op, BatchOpKind::Move | BatchOpKind::Remove) {
            let src_key = normalized_path_key(&src);
            if !seen_destructive_sources.insert(src_key) {
                return Err(FailureInfo::custom(
                    "DUPLICATE_SOURCE",
                    format!(
                        "Batch op #{idx} moves or removes the same source twice: {src_display}"
                    ),
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    "Remove duplicate move/remove entries targeting the same source.",
                ));
            }
        }

        validated.push(ValidatedBatchOp {
            op: spec.op,
            src,
            dst,
            src_is_dir,
        });
    }

    for i in 0..validated.len() {
        for j in (i + 1)..validated.len() {
            let a = &validated[i];
            let b = &validated[j];

            let a_destructive = matches!(a.op, BatchOpKind::Move | BatchOpKind::Remove);
            let b_destructive = matches!(b.op, BatchOpKind::Move | BatchOpKind::Remove);

            if a_destructive && overlaps(&a.src, &b.src) {
                return Err(overlap_err(i, j, &a.src, &b.src));
            }
            if b_destructive && overlaps(&b.src, &a.src) {
                return Err(overlap_err(i, j, &b.src, &a.src));
            }
            if let Some(b_dst) = &b.dst
                && (overlaps(&a.src, b_dst)
                    || a.dst.as_ref().is_some_and(|a_dst| overlaps(a_dst, b_dst)))
            {
                return Err(overlap_err(i, j, &a.src, b_dst));
            }
            if let Some(a_dst) = &a.dst
                && overlaps(&b.src, a_dst)
            {
                return Err(overlap_err(i, j, a_dst, &b.src));
            }
        }
    }

    let mut results = Vec::with_capacity(validated.len());
    for (idx, item) in validated.iter().enumerate() {
        let effect_on_err = if idx == 0 {
            EffectState::None
        } else {
            EffectState::Partial
        };

        if !parsed.dry_run {
            match item.op {
                BatchOpKind::Copy => {
                    let dst = item.dst.as_ref().expect("validated copy destination");
                    if let Some(parent) = dst.parent() {
                        fs::create_dir_all(parent).map_err(|e| {
                            FailureInfo::io_error(
                                &format!("Batch op #{idx} failed creating parent directory"),
                                &e,
                                effect_on_err,
                            )
                        })?;
                    }
                    if item.src_is_dir {
                        copy_dir_recursive(ctx, &item.src, dst, effect_on_err, 0)?;
                    } else {
                        fs::copy(&item.src, dst).map_err(|e| {
                            FailureInfo::io_error(
                                &format!("Batch op #{idx} failed copying file"),
                                &e,
                                effect_on_err,
                            )
                        })?;
                    }
                }
                BatchOpKind::Move => {
                    let dst = item.dst.as_ref().expect("validated move destination");
                    if let Some(parent) = dst.parent() {
                        fs::create_dir_all(parent).map_err(|e| {
                            FailureInfo::io_error(
                                &format!("Batch op #{idx} failed creating parent directory"),
                                &e,
                                effect_on_err,
                            )
                        })?;
                    }
                    if let Err(_rename_err) = fs::rename(&item.src, dst) {
                        // Cross-device fallback: copy then remove.
                        if item.src_is_dir {
                            copy_dir_recursive(ctx, &item.src, dst, effect_on_err, 0)?;
                            fs::remove_dir_all(&item.src).map_err(|e| {
                                FailureInfo::io_error(
                                    &format!("Batch op #{idx} copied directory but failed removing source"),
                                    &e,
                                    EffectState::Partial,
                                )
                            })?;
                        } else {
                            fs::copy(&item.src, dst).map_err(|e| {
                                FailureInfo::io_error(
                                    &format!("Batch op #{idx} failed moving file"),
                                    &e,
                                    effect_on_err,
                                )
                            })?;
                            fs::remove_file(&item.src).map_err(|e| {
                                FailureInfo::io_error(
                                    &format!("Batch op #{idx} copied file but failed removing source"),
                                    &e,
                                    EffectState::Partial,
                                )
                            })?;
                        }
                    }
                }
                BatchOpKind::Remove => {
                    if item.src_is_dir {
                        fs::remove_dir_all(&item.src).map_err(|e| {
                            FailureInfo::io_error(
                                &format!("Batch op #{idx} failed removing directory"),
                                &e,
                                effect_on_err,
                            )
                        })?;
                    } else {
                        fs::remove_file(&item.src).map_err(|e| {
                            FailureInfo::io_error(
                                &format!("Batch op #{idx} failed removing file"),
                                &e,
                                effect_on_err,
                            )
                        })?;
                    }
                }
            }
        }

        results.push(BatchOpResult {
            op: item.op.as_str().to_string(),
            path: path_to_display(&item.src),
            to: item.dst.as_deref().map(path_to_display),
            status: if parsed.dry_run {
                "planned".to_string()
            } else {
                "completed".to_string()
            },
        });
    }

    let res = BatchResult {
        dry_run: parsed.dry_run,
        batch_results: results,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize batch result: {e}")))
}

fn overlaps(a: &Path, b: &Path) -> bool {
    paths_equal_normalized(a, b)
        || path_starts_with_normalized(a, b)
        || path_starts_with_normalized(b, a)
}

fn overlap_err(i: usize, j: usize, p1: &Path, p2: &Path) -> FailureInfo {
    FailureInfo::custom(
        "OVERLAPPING_BATCH_TARGETS",
        format!(
            "Batch operations #{i} and #{j} have overlapping or nested paths: {} and {}.",
            path_to_display(p1),
            path_to_display(p2)
        ),
        EffectState::None,
        RetryPolicy::AfterInputChange,
        "Split dependent or overlapping file operations into separate sequential batch calls.",
    )
}
