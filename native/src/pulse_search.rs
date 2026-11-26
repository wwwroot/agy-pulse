use crate::ops_read::{metadata_mtime_ms, split_logical_lines};
use crate::protocol::{
    FailureInfo, WorkerResult, deserialize_opt_string_or_vec, deserialize_string_or_vec,
    json_escaped_len, truncate_to_json_budget,
};
use crate::security::{
    SecurityContext, path_to_display, relative_posix_path, should_skip_walk_entry,
};
use globset::{GlobBuilder, GlobMatcher, GlobSet, GlobSetBuilder};
use rayon::prelude::*;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const MAX_WALK_ENTRIES: usize = 25_000;
pub const MAX_WALK_DEPTH: usize = 64;
const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 2_000;
const MAX_GREP_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobArgs {
    pub path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_vec")]
    pub pattern: Vec<String>,
    #[serde(default)]
    pub kind: EntryKindFilter,
    #[serde(default)]
    pub sort: SortOrder,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKindFilter {
    All,
    #[default]
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    #[default]
    Path,
    Modified,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobEntry {
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobResult {
    pub root: String,
    pub total_matched: usize,
    pub files_scanned: usize,
    pub scan_complete: bool,
    pub truncated: bool,
    pub next_offset: Option<usize>,
    pub entries: Vec<GlobEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepArgs {
    pub path: Option<String>,
    pub pattern: String,
    #[serde(default, deserialize_with = "deserialize_opt_string_or_vec")]
    pub glob: Option<Vec<String>>,
    #[serde(default)]
    pub output_mode: GrepOutputMode,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default)]
    pub before_context: usize,
    #[serde(default)]
    pub after_context: usize,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrepOutputMode {
    Summary,
    Count,
    FilesWithMatches,
    Definitions,
    #[default]
    Content,
}

impl GrepOutputMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Count => "count",
            Self::FilesWithMatches => "files_with_matches",
            Self::Definitions => "definitions",
            Self::Content => "content",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decl_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResult {
    pub root: String,
    pub output_mode: String,
    pub total_matched: usize,
    pub total_files_matched: usize,
    pub files_scanned: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_matches: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub implied_references: Option<usize>,
    pub scan_complete: bool,
    pub truncated: bool,
    pub next_offset: Option<usize>,
    pub raw_bytes: u64,
    pub entries: Vec<GrepEntry>,
}

pub struct GlobFilter {
    include: Option<GlobSet>,
    exclude: Option<GlobSet>,
}

impl GlobFilter {
    pub fn compile(patterns: &[String]) -> WorkerResult<Self> {
        let mut inc_builder = GlobSetBuilder::new();
        let mut exc_builder = GlobSetBuilder::new();
        let mut has_inc = false;
        let mut has_exc = false;

        for raw in patterns {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let (is_neg, body) = match trimmed.strip_prefix('!') {
                Some(rest) => (true, rest.trim()),
                None => (false, trimmed),
            };
            if body.is_empty() {
                continue;
            }
            let normalized = body.replace('\\', "/");
            let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);

            let mut variants = vec![normalized.to_string()];
            if !normalized.contains('/') {
                variants.push(format!("**/{normalized}"));
            }

            for pat in variants {
                let glob = GlobBuilder::new(&pat)
                    .literal_separator(false)
                    .build()
                    .map_err(|e| {
                        FailureInfo::invalid_arg(format!("Invalid glob pattern `{raw}`: {e}"))
                    })?;
                if is_neg {
                    exc_builder.add(glob);
                    has_exc = true;
                } else {
                    inc_builder.add(glob);
                    has_inc = true;
                }
            }
        }

        let include = if has_inc {
            Some(
                inc_builder
                    .build()
                    .map_err(|e| FailureInfo::invalid_arg(format!("Glob build error: {e}")))?,
            )
        } else {
            None
        };

        let exclude = if has_exc {
            Some(
                exc_builder
                    .build()
                    .map_err(|e| FailureInfo::invalid_arg(format!("Exclude glob build error: {e}")))?,
            )
        } else {
            None
        };

        Ok(Self { include, exclude })
    }

    pub fn is_match(&self, rel_posix: &str) -> bool {
        if let Some(exc) = &self.exclude
            && exc.is_match(rel_posix)
        {
            return false;
        }
        match &self.include {
            Some(inc) => inc.is_match(rel_posix),
            None => true,
        }
    }
}

struct GitignoreRule {
    matcher: GlobMatcher,
    negated: bool,
    requires_dir: bool,
}

struct GitignoreLayer {
    base_dir: PathBuf,
    rules: Vec<GitignoreRule>,
}

/// `.gitignore` and `.git/info/exclude` matcher built on `globset`.
/// Tracks each ignore file's owning directory so anchored rules resolve relative
/// to that directory, and stacks nested `.gitignore` files during traversal.
pub struct GitignoreMatcher {
    ancestor_layers: Vec<GitignoreLayer>,
    nested_stack: Vec<(usize, GitignoreLayer)>,
}

impl GitignoreMatcher {
    pub fn load(ctx: &SecurityContext, search_root: &Path) -> Self {
        let mut ancestor_layers = Vec::new();

        // Collect ancestors from workspace root down to search_root so parent
        // ignore rules apply in order against their declaring base directory.
        let mut ancestors: Vec<PathBuf> = Vec::new();
        let mut cur = Some(search_root.to_path_buf());
        while let Some(dir) = cur {
            if !ctx.is_within_roots(&dir) {
                break;
            }
            ancestors.push(dir.clone());
            if ctx.is_workspace_root(&dir) {
                break;
            }
            cur = dir.parent().map(Path::to_path_buf);
        }
        ancestors.reverse();

        for dir in &ancestors {
            let exclude_file = dir.join(".git").join("info").join("exclude");
            if let Ok(text) = fs::read_to_string(&exclude_file) {
                let mut rules = Vec::new();
                Self::parse_file_into(&text, &mut rules);
                if !rules.is_empty() {
                    ancestor_layers.push(GitignoreLayer {
                        base_dir: dir.clone(),
                        rules,
                    });
                }
            }
            let gi_file = dir.join(".gitignore");
            if let Ok(text) = fs::read_to_string(&gi_file) {
                let mut rules = Vec::new();
                Self::parse_file_into(&text, &mut rules);
                if !rules.is_empty() {
                    ancestor_layers.push(GitignoreLayer {
                        base_dir: dir.clone(),
                        rules,
                    });
                }
            }
        }

        Self {
            ancestor_layers,
            nested_stack: Vec::new(),
        }
    }

    fn parse_file_into(content: &str, out: &mut Vec<GitignoreRule>) {
        for raw_line in content.lines() {
            let line = raw_line.trim_end_matches('\r');
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let (negated, rest) = if let Some(r) = trimmed.strip_prefix('!') {
                (true, r)
            } else if let Some(r) = trimmed.strip_prefix(r"\#") {
                (false, r)
            } else if let Some(r) = trimmed.strip_prefix(r"\!") {
                (false, r)
            } else {
                (false, trimmed)
            };

            let (dir_only, rest) = match rest.strip_suffix('/') {
                Some(r) => (true, r),
                None => (false, rest),
            };

            let rest = rest.trim();
            if rest.is_empty() {
                continue;
            }

            let anchored = rest.starts_with('/') || rest.contains('/');
            let clean = rest.trim_start_matches('/');
            if clean.is_empty() {
                continue;
            }

            let pattern_specs: Vec<(String, bool)> = if anchored {
                let mut v = vec![(clean.to_string(), dir_only)];
                if !clean.ends_with("/**") {
                    v.push((format!("{clean}/**"), false));
                }
                v
            } else {
                vec![
                    (clean.to_string(), dir_only),
                    (format!("**/{clean}"), dir_only),
                    (format!("{clean}/**"), false),
                    (format!("**/{clean}/**"), false),
                ]
            };

            for (pat, requires_dir) in pattern_specs {
                if let Ok(glob) = GlobBuilder::new(&pat).literal_separator(true).build() {
                    out.push(GitignoreRule {
                        matcher: glob.compile_matcher(),
                        negated,
                        requires_dir,
                    });
                }
            }
        }
    }

    /// Pop nested `.gitignore` layers from directories we have already exited.
    pub fn pop_to_depth(&mut self, entry_depth: usize) {
        while self
            .nested_stack
            .last()
            .is_some_and(|(layer_depth, _)| *layer_depth >= entry_depth)
        {
            self.nested_stack.pop();
        }
    }

    pub fn enter_dir(&mut self, dir_path: &Path, dir_depth: usize) {
        let gi_file = dir_path.join(".gitignore");
        if let Ok(text) = fs::read_to_string(&gi_file) {
            let mut rules = Vec::new();
            Self::parse_file_into(&text, &mut rules);
            if !rules.is_empty() {
                self.nested_stack.push((
                    dir_depth,
                    GitignoreLayer {
                        base_dir: dir_path.to_path_buf(),
                        rules,
                    },
                ));
            }
        }
    }

    pub fn is_ignored_path(&self, entry_path: &Path, is_dir: bool) -> bool {
        if self.ancestor_layers.is_empty() && self.nested_stack.is_empty() {
            return false;
        }
        let mut ignored = false;
        let all_layers = self
            .ancestor_layers
            .iter()
            .chain(self.nested_stack.iter().map(|(_, layer)| layer));

        for layer in all_layers {
            let Ok(rel) = entry_path.strip_prefix(&layer.base_dir) else {
                continue;
            };
            let rel_posix = rel.to_string_lossy().replace('\\', "/");
            if rel_posix.is_empty() {
                continue;
            }
            for rule in &layer.rules {
                if rule.requires_dir && !is_dir {
                    continue;
                }
                if rule.matcher.is_match(&rel_posix) {
                    ignored = !rule.negated;
                }
            }
        }
        ignored
    }
}

fn filter_walk_entry(
    ctx: &SecurityContext,
    gitignore: Option<&RefCell<GitignoreMatcher>>,
    entry: &walkdir::DirEntry,
    include_hidden: bool,
) -> bool {
    let depth = entry.depth();
    if depth == 0 {
        return true;
    }
    if let Some(gi_cell) = gitignore {
        gi_cell.borrow_mut().pop_to_depth(depth);
    }
    let name = entry.file_name().to_string_lossy();
    let is_dir = entry.file_type().is_dir();
    if should_skip_walk_entry(&name, is_dir, include_hidden) {
        return false;
    }
    if ctx.is_blocked_by_fence(entry.path()) {
        return false;
    }
    if let Some(gi_cell) = gitignore {
        if gi_cell.borrow().is_ignored_path(entry.path(), is_dir) {
            return false;
        }
        if is_dir && depth < MAX_WALK_DEPTH {
            gi_cell.borrow_mut().enter_dir(entry.path(), depth);
        }
    }
    true
}

/// Collect candidate files under `root` (or `[root]` if `root` is a file) with deterministic ordering.
pub fn collect_candidate_files(
    ctx: &SecurityContext,
    root: &Path,
    glob_filter: Option<&GlobFilter>,
    include_hidden: bool,
) -> WorkerResult<(Vec<PathBuf>, usize, bool)> {
    let meta = fs::metadata(root).map_err(|e| {
        FailureInfo::io_error(
            &format!("Cannot access search root {}", path_to_display(root)),
            &e,
            crate::protocol::EffectState::None,
        )
    })?;

    if meta.is_file() {
        if ctx.is_blocked_by_fence(root) {
            return Ok((Vec::new(), 1, true));
        }
        return Ok((vec![root.to_path_buf()], 1, true));
    }

    let gitignore = if include_hidden {
        None
    } else {
        Some(RefCell::new(GitignoreMatcher::load(ctx, root)))
    };

    let mut files = Vec::new();
    let mut scanned = 0usize;
    let mut scan_complete = true;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_WALK_DEPTH)
        .into_iter()
        .filter_entry(|entry| filter_walk_entry(ctx, gitignore.as_ref(), entry, include_hidden));

    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        scanned += 1;
        if scanned > MAX_WALK_ENTRIES {
            scan_complete = false;
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(filter) = glob_filter {
            let rel = relative_posix_path(root, entry.path());
            if !filter.is_match(&rel) {
                continue;
            }
        }
        files.push(entry.into_path());
    }

    files.sort_by(|a, b| path_to_display(a).cmp(&path_to_display(b)));
    Ok((files, scanned.min(MAX_WALK_ENTRIES), scan_complete))
}

pub fn handle_glob(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: GlobArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid glob args: {e}")))?;

    let root = ctx.authorize_optional_root(parsed.path.as_deref())?;
    let filter = GlobFilter::compile(&parsed.pattern)?;
    let limit = parsed.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let gitignore = if parsed.include_hidden {
        None
    } else {
        Some(RefCell::new(GitignoreMatcher::load(ctx, &root)))
    };

    let mut matched = Vec::new();
    let mut scanned = 0usize;
    let mut scan_complete = true;

    let walker = WalkDir::new(&root)
        .follow_links(false)
        .max_depth(MAX_WALK_DEPTH)
        .into_iter()
        .filter_entry(|entry| {
            filter_walk_entry(ctx, gitignore.as_ref(), entry, parsed.include_hidden)
        });

    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        scanned += 1;
        if scanned > MAX_WALK_ENTRIES {
            scan_complete = false;
            break;
        }

        let is_dir = entry.file_type().is_dir();
        let is_file = entry.file_type().is_file();

        match parsed.kind {
            EntryKindFilter::File if !is_file => continue,
            EntryKindFilter::Directory if !is_dir => continue,
            EntryKindFilter::All if !is_file && !is_dir => continue,
            _ => {}
        }

        let rel = relative_posix_path(&root, entry.path());
        if !filter.is_match(&rel) {
            continue;
        }

        let meta = entry.metadata().ok();
        let bytes = meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()).unwrap_or(0);
        let modified_ms = meta.as_ref().map(metadata_mtime_ms).unwrap_or(0);

        matched.push(GlobEntry {
            path: path_to_display(entry.path()),
            kind: if is_dir {
                "directory".to_string()
            } else {
                "file".to_string()
            },
            bytes,
            modified_ms,
        });
    }

    match parsed.sort {
        SortOrder::Path => matched.sort_by(|a, b| a.path.cmp(&b.path)),
        SortOrder::Modified => matched.sort_by(|a, b| {
            b.modified_ms
                .cmp(&a.modified_ms)
                .then_with(|| a.path.cmp(&b.path))
        }),
    }

    let total_matched = matched.len();
    let offset = parsed.offset.min(total_matched);
    let end = (offset + limit).min(total_matched);
    let ipc_budget = ctx.ipc_payload_budget();
    let mut used_bytes = 256usize;
    let mut entries: Vec<GlobEntry> = Vec::with_capacity(end - offset);
    let mut budget_truncated = false;
    for item in matched.into_iter().skip(offset).take(end - offset) {
        let item_cost = json_escaped_len(&item.path) + 96;
        if used_bytes + item_cost > ipc_budget && !entries.is_empty() {
            budget_truncated = true;
            break;
        }
        used_bytes += item_cost;
        entries.push(item);
    }
    let delivered_end = offset + entries.len();
    let next_offset = if delivered_end < total_matched {
        Some(delivered_end)
    } else {
        None
    };
    let truncated = next_offset.is_some() || !scan_complete || budget_truncated;

    let res = GlobResult {
        root: path_to_display(&root),
        total_matched,
        files_scanned: scanned.min(MAX_WALK_ENTRIES),
        scan_complete,
        truncated,
        next_offset,
        entries,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize glob result: {e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyArgs {
    pub path: Option<String>,
    pub pattern: String,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_hidden: bool,
}

fn fuzzy_subsequence_score(query_lower: &[u8], target: &str) -> Option<i64> {
    if query_lower.is_empty() {
        return None;
    }
    let target_bytes = target.as_bytes();
    let mut qi = 0usize;
    let mut score = 0i64;
    let mut consecutive = 0i64;
    let basename_start = target.rfind('/').map(|i| i + 1).unwrap_or(0);

    for (ti, &tb) in target_bytes.iter().enumerate() {
        if qi >= query_lower.len() {
            break;
        }
        if tb.to_ascii_lowercase() == query_lower[qi] {
            score += 10;
            consecutive += 1;
            score += consecutive * 4;
            if ti >= basename_start {
                score += 12;
            }
            if ti == 0 || ti == basename_start {
                score += 24;
            } else {
                let prev = target_bytes[ti - 1];
                if prev == b'/' || prev == b'_' || prev == b'-' || prev == b'.' {
                    score += 18;
                } else if prev.is_ascii_lowercase() && tb.is_ascii_uppercase() {
                    score += 14;
                }
            }
            qi += 1;
        } else {
            consecutive = 0;
        }
    }

    if qi < query_lower.len() {
        return None;
    }

    let basename = &target[basename_start..];
    let basename_lower = basename.to_ascii_lowercase();
    let query_str = std::str::from_utf8(query_lower).unwrap_or("");
    if basename_lower == query_str {
        score += 200;
    } else if basename_lower.starts_with(query_str) {
        score += 100;
    } else if basename_lower.contains(query_str) {
        score += 50;
    }

    // Prefer shorter paths on ties.
    score -= (target.len() as i64) / 2;
    Some(score)
}

pub fn handle_fuzzy(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: FuzzyArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid fuzzy args: {e}")))?;

    let query = parsed.pattern.trim();
    if query.is_empty() {
        return Err(FailureInfo::invalid_arg("`pattern` cannot be empty for fuzzy search."));
    }

    let root = ctx.authorize_optional_root(parsed.path.as_deref())?;
    let limit = parsed.limit.unwrap_or(30).clamp(1, MAX_LIMIT);
    let (candidates, scanned, scan_complete) =
        collect_candidate_files(ctx, &root, None, parsed.include_hidden)?;

    let query_lower = query.to_ascii_lowercase();
    let query_bytes = query_lower.as_bytes();

    let mut scored: Vec<(i64, String, PathBuf)> = candidates
        .into_iter()
        .filter_map(|file_path| {
            let rel = relative_posix_path(&root, &file_path);
            let score = fuzzy_subsequence_score(query_bytes, &rel)?;
            Some((score, rel, file_path))
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    let total_matched = scored.len();
    let offset = parsed.offset.min(total_matched);
    let end = (offset + limit).min(total_matched);
    let ipc_budget = ctx.ipc_payload_budget();
    let mut used_bytes = 256usize;
    let mut entries: Vec<GlobEntry> = Vec::with_capacity(end - offset);
    let mut budget_truncated = false;

    for (_, _, file_path) in scored.into_iter().skip(offset).take(end - offset) {
        let display = path_to_display(&file_path);
        let item_cost = json_escaped_len(&display) + 96;
        if used_bytes + item_cost > ipc_budget && !entries.is_empty() {
            budget_truncated = true;
            break;
        }
        used_bytes += item_cost;
        let meta = fs::metadata(&file_path).ok();
        entries.push(GlobEntry {
            path: display,
            kind: "file".to_string(),
            bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_ms: meta.as_ref().map(metadata_mtime_ms).unwrap_or(0),
        });
    }

    let delivered_end = offset + entries.len();
    let next_offset = if delivered_end < total_matched {
        Some(delivered_end)
    } else {
        None
    };
    let truncated = next_offset.is_some() || !scan_complete || budget_truncated;

    let res = GlobResult {
        root: path_to_display(&root),
        total_matched,
        files_scanned: scanned,
        scan_complete,
        truncated,
        next_offset,
        entries,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize fuzzy result: {e}")))
}

struct FileGrepHit {
    path: String,
    total_matches: usize,
    raw_bytes: u64,
    matches: Vec<LineMatch>,
}

struct LineMatch {
    line: usize,
    text: String,
    decl_kind: Option<&'static str>,
    before: Option<Vec<String>>,
    after: Option<Vec<String>>,
}

pub fn is_likely_binary(bytes: &[u8]) -> bool {
    let check_len = bytes.len().min(8192);
    bytes[..check_len].contains(&0)
}

pub fn handle_grep(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: GrepArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid grep args: {e}")))?;

    if parsed.pattern.is_empty() {
        return Err(FailureInfo::invalid_arg("`pattern` cannot be empty."));
    }

    let regex = RegexBuilder::new(&parsed.pattern)
        .case_insensitive(parsed.case_insensitive)
        .build()
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid regex pattern: {e}")))?;

    let root = ctx.authorize_optional_root(parsed.path.as_deref())?;
    let glob_filter = match parsed.glob.as_deref() {
        Some(pats) if !pats.is_empty() => Some(GlobFilter::compile(pats)?),
        _ => None,
    };

    let (candidates, _walk_scanned, scan_complete) =
        collect_candidate_files(ctx, &root, glob_filter.as_ref(), parsed.include_hidden)?;

    let files_scanned = candidates.len();
    let before_ctx = parsed.before_context.min(10);
    let after_ctx = parsed.after_context.min(10);
    let mode = parsed.output_mode;
    let need_lines = matches!(mode, GrepOutputMode::Content | GrepOutputMode::Definitions);

    // Parallel search preserving deterministic path order.
    let per_file: Vec<Option<FileGrepHit>> = candidates
        .par_iter()
        .map(|file_path| {
            let meta = fs::metadata(file_path).ok()?;
            if meta.len() > MAX_GREP_FILE_BYTES {
                return None;
            }
            let bytes = fs::read(file_path).ok()?;
            if is_likely_binary(&bytes) {
                return None;
            }
            let text = std::str::from_utf8(&bytes).ok()?;
            let lines = split_logical_lines(text);
            let display = path_to_display(file_path);

            let mut total_matches = 0usize;
            let mut raw_bytes = 0u64;
            let mut matches = Vec::new();

            for (idx, line) in lines.iter().enumerate() {
                if !regex.is_match(line) {
                    continue;
                }
                total_matches += 1;
                let line_no = idx + 1;
                // Estimate raw uncompressed match line bytes: "path:line:text\n"
                raw_bytes += (display.len() + 1 + 6 + 1 + line.len() + 1) as u64;

                if need_lines {
                    let decl_kind = if mode == GrepOutputMode::Definitions {
                        classify_declaration(line, &regex)
                    } else {
                        None
                    };
                    if mode == GrepOutputMode::Definitions && decl_kind.is_none() {
                        continue;
                    }

                    let before = if mode == GrepOutputMode::Content && before_ctx > 0 {
                        let start = idx.saturating_sub(before_ctx);
                        Some(lines[start..idx].iter().map(|s| (*s).to_string()).collect())
                    } else {
                        None
                    };
                    let after = if mode == GrepOutputMode::Content && after_ctx > 0 {
                        let end = (idx + 1 + after_ctx).min(lines.len());
                        Some(
                            lines[idx + 1..end]
                                .iter()
                                .map(|s| (*s).to_string())
                                .collect(),
                        )
                    } else {
                        None
                    };

                    matches.push(LineMatch {
                        line: line_no,
                        text: (*line).to_string(),
                        decl_kind,
                        before,
                        after,
                    });
                }
            }

            if total_matches == 0 {
                return None;
            }

            Some(FileGrepHit {
                path: display,
                total_matches,
                raw_bytes,
                matches,
            })
        })
        .collect();

    let hits: Vec<FileGrepHit> = per_file.into_iter().flatten().collect();
    let total_files_matched = hits.len();
    let total_matched: usize = hits.iter().map(|h| h.total_matches).sum();
    let raw_bytes: u64 = hits.iter().map(|h| h.raw_bytes).sum();

    let limit = parsed.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut definition_matches: Option<usize> = None;
    let mut implied_references: Option<usize> = None;

    let all_entries: Vec<GrepEntry> = match mode {
        GrepOutputMode::Summary => Vec::new(),
        GrepOutputMode::Count => hits
            .into_iter()
            .map(|h| GrepEntry {
                path: h.path,
                count: Some(h.total_matches),
                line: None,
                text: None,
                decl_kind: None,
                before: None,
                after: None,
            })
            .collect(),
        GrepOutputMode::FilesWithMatches => hits
            .into_iter()
            .map(|h| GrepEntry {
                path: h.path,
                count: None,
                line: None,
                text: None,
                decl_kind: None,
                before: None,
                after: None,
            })
            .collect(),
        GrepOutputMode::Definitions => {
            let mut defs = Vec::new();
            for h in hits {
                for m in h.matches {
                    defs.push(GrepEntry {
                        path: h.path.clone(),
                        count: None,
                        line: Some(m.line),
                        text: Some(m.text),
                        decl_kind: m.decl_kind.map(str::to_string),
                        before: None,
                        after: None,
                    });
                }
            }
            let def_count = defs.len();
            definition_matches = Some(def_count);
            implied_references = Some(total_matched.saturating_sub(def_count));
            defs
        }
        GrepOutputMode::Content => {
            let mut content_entries = Vec::new();
            for h in hits {
                for m in h.matches {
                    content_entries.push(GrepEntry {
                        path: h.path.clone(),
                        count: None,
                        line: Some(m.line),
                        text: Some(m.text),
                        decl_kind: None,
                        before: m.before,
                        after: m.after,
                    });
                }
            }
            content_entries
        }
    };

    let ipc_budget = ctx.ipc_payload_budget();
    let per_line_cap = (ipc_budget / 2).clamp(2_048, 131_072);
    let mut budget_truncated = false;

    let (entries, next_offset) = if mode == GrepOutputMode::Summary {
        (Vec::new(), None)
    } else {
        let total_items = all_entries.len();
        let offset = parsed.offset.min(total_items);
        let end = (offset + limit).min(total_items);
        let mut paged: Vec<GrepEntry> = Vec::with_capacity(end - offset);
        let mut used_bytes = 384usize;

        for mut entry in all_entries.into_iter().skip(offset).take(end - offset) {
            if let Some(text) = entry.text.as_mut() {
                let (clipped, did_clip) =
                    truncate_to_json_budget(text, per_line_cap, "...[truncated]");
                if did_clip {
                    *text = clipped;
                    budget_truncated = true;
                }
            }
            if let Some(before) = entry.before.as_mut() {
                for line in before.iter_mut() {
                    let (clipped, did_clip) =
                        truncate_to_json_budget(line, per_line_cap, "...[truncated]");
                    if did_clip {
                        *line = clipped;
                        budget_truncated = true;
                    }
                }
            }
            if let Some(after) = entry.after.as_mut() {
                for line in after.iter_mut() {
                    let (clipped, did_clip) =
                        truncate_to_json_budget(line, per_line_cap, "...[truncated]");
                    if did_clip {
                        *line = clipped;
                        budget_truncated = true;
                    }
                }
            }

            let entry_cost = estimate_grep_entry_json_bytes(&entry);
            if used_bytes + entry_cost > ipc_budget {
                if paged.is_empty() {
                    // Ensure at least one entry fits inside the IPC ceiling.
                    let remaining = ipc_budget.saturating_sub(used_bytes + json_escaped_len(&entry.path) + 128);
                    if let Some(text) = entry.text.as_mut() {
                        let (clipped, did_clip) =
                            truncate_to_json_budget(text, remaining.max(256), "...[truncated]");
                        if did_clip {
                            *text = clipped;
                        }
                    }
                    entry.before = None;
                    entry.after = None;
                    paged.push(entry);
                    budget_truncated = true;
                    break;
                }
                budget_truncated = true;
                break;
            }

            used_bytes += entry_cost;
            paged.push(entry);
        }

        let delivered_end = offset + paged.len();
        let next = if delivered_end < total_items {
            Some(delivered_end)
        } else {
            None
        };
        (paged, next)
    };

    let truncated = next_offset.is_some() || !scan_complete || budget_truncated;

    let res = GrepResult {
        root: path_to_display(&root),
        output_mode: mode.as_str().to_string(),
        total_matched,
        total_files_matched,
        files_scanned,
        definition_matches,
        implied_references,
        scan_complete,
        truncated,
        next_offset,
        raw_bytes,
        entries,
    };

    serde_json::to_value(res)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize grep result: {e}")))
}

fn estimate_grep_entry_json_bytes(entry: &GrepEntry) -> usize {
    let mut cost = 96 + json_escaped_len(&entry.path);
    if let Some(t) = &entry.text {
        cost += json_escaped_len(t) + 12;
    }
    if let Some(dk) = &entry.decl_kind {
        cost += dk.len() + 16;
    }
    if let Some(before) = &entry.before {
        cost += 16;
        for line in before {
            cost += json_escaped_len(line) + 4;
        }
    }
    if let Some(after) = &entry.after {
        cost += 16;
        for line in after {
            cost += json_escaped_len(line) + 4;
        }
    }
    cost
}

/// Lexical declaration matcher recognizing definitions across TS/JS/TSX, Rust, Python,
/// Go, Java/Kotlin/C#, C/C++, Ruby, and PHP.
/// Verifies that the regex match hits the declaration target (not a RHS call or inline body).
pub fn classify_declaration(raw_line: &str, regex: &regex::Regex) -> Option<&'static str> {
    let trimmed = raw_line.trim_start();
    if trimmed.is_empty() {
        return None;
    }

    // Reject comments immediately (keep `#define` for C/C++).
    if trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
        || trimmed.starts_with("*/")
        || trimmed.starts_with("--")
    {
        return None;
    }
    if trimmed.starts_with('#') {
        if let Some(after) = strip_keyword(trimmed, "#define") {
            let ident = after.split(|c: char| c.is_whitespace() || c == '(').next().unwrap_or("");
            if regex.is_match(ident) {
                return Some("macro");
            }
        }
        return None;
    }

    let is_export_default =
        has_keyword_prefix(trimmed, "export default") || trimmed == "export default";
    let mut had_visibility_or_export = false;
    let mut rest = trimmed;

    loop {
        let before = rest;
        if let Some(after) = strip_keyword(rest, "export") {
            had_visibility_or_export = true;
            rest = after;
        } else if let Some(after) = strip_pub_modifier(rest) {
            had_visibility_or_export = true;
            rest = after;
        } else if let Some(after) = strip_keyword(rest, "default") {
            rest = after;
        } else if let Some(after) = strip_keyword(rest, "declare") {
            had_visibility_or_export = true;
            rest = after;
        } else if let Some(after) = strip_keyword(rest, "public")
            .or_else(|| strip_keyword(rest, "private"))
            .or_else(|| strip_keyword(rest, "protected"))
            .or_else(|| strip_keyword(rest, "internal"))
        {
            had_visibility_or_export = true;
            rest = after;
        } else if let Some(after) = strip_keyword(rest, "static")
            .or_else(|| strip_keyword(rest, "final"))
            .or_else(|| strip_keyword(rest, "abstract"))
            .or_else(|| strip_keyword(rest, "override"))
            .or_else(|| strip_keyword(rest, "virtual"))
            .or_else(|| strip_keyword(rest, "inline"))
            .or_else(|| strip_keyword(rest, "unsafe"))
            .or_else(|| strip_keyword(rest, "async"))
            .or_else(|| strip_keyword(rest, "sealed"))
            .or_else(|| strip_keyword(rest, "data"))
            .or_else(|| strip_keyword(rest, "open"))
            .or_else(|| strip_keyword(rest, "suspend"))
            .or_else(|| strip_keyword(rest, "readonly"))
            .or_else(|| strip_keyword(rest, "constexpr"))
        {
            rest = after;
        } else if let Some(after) = strip_extern_modifier(rest) {
            rest = after;
        } else if let Some(after) = strip_keyword(rest, "const")
            && (has_keyword_prefix(after, "fn")
                || has_keyword_prefix(after, "unsafe")
                || has_keyword_prefix(after, "extern"))
        {
            // Rust `pub const fn` / `const unsafe fn` is a function declaration, not a `const` item.
            rest = after;
        }
        if rest == before {
            break;
        }
    }

    if let Some(after) = rest.strip_prefix("macro_rules!") {
        let header = before_delimiters(rest, &['{', '(']);
        let name_header = before_delimiters(after.trim_start(), &['{', '(']);
        return (regex.is_match(header) || regex.is_match(name_header)).then_some("macro");
    }

    if let Some(after) = strip_keyword(rest, "function")
        .or_else(|| rest.strip_prefix("function*").map(str::trim_start))
        .or_else(|| strip_keyword(rest, "fn"))
        .or_else(|| strip_keyword(rest, "def"))
        .or_else(|| strip_keyword(rest, "func"))
        .or_else(|| strip_keyword(rest, "fun"))
    {
        // Match against declaration header including the keyword (so patterns like `fn ` or `fn [a-z_]+` match)
        // as well as Go receiver `(r *Recv) MethodName(`.
        let header_with_kw = if after.starts_with('(') {
            if let Some(close) = rest.find(')') {
                let after_recv = &rest[close + 1..];
                let end = after_recv
                    .find(['(', '<', '{'])
                    .map_or(rest.len(), |idx| close + 1 + idx);
                &rest[..end]
            } else {
                before_delimiters(rest, &['{'])
            }
        } else {
            before_delimiters(rest, &['(', '<', '{'])
        };
        if regex.is_match(header_with_kw) {
            return Some("function");
        }
        return None;
    }

    if strip_keyword(rest, "class")
        .or_else(|| strip_keyword(rest, "record"))
        .is_some()
    {
        let header = before_delimiters(rest, &['{', '(', '<', ':']);
        return regex.is_match(header).then_some("class");
    }

    if strip_keyword(rest, "interface")
        .or_else(|| strip_keyword(rest, "protocol"))
        .is_some()
    {
        let header = before_delimiters(rest, &['{', '<', ':']);
        return regex.is_match(header).then_some("interface");
    }

    if strip_keyword(rest, "type")
        .or_else(|| strip_keyword(rest, "typedef"))
        .is_some()
    {
        let header = before_delimiters(rest, &['=', '{', '<']);
        return regex.is_match(header).then_some("type");
    }

    if strip_keyword(rest, "enum").is_some() {
        let header = before_delimiters(rest, &['{', '<', ':']);
        return regex.is_match(header).then_some("enum");
    }

    if strip_keyword(rest, "struct").is_some() {
        let header = before_delimiters(rest, &['{', '<', '(', ';']);
        return regex.is_match(header).then_some("struct");
    }

    if strip_keyword(rest, "trait").is_some() {
        let header = before_delimiters(rest, &['{', '<', ':']);
        return regex.is_match(header).then_some("trait");
    }

    if has_keyword_prefix(rest, "impl") || rest.starts_with("impl<") {
        let header = before_delimiters(rest, &['{']);
        return regex.is_match(header).then_some("impl");
    }

    if strip_keyword(rest, "mod")
        .or_else(|| strip_keyword(rest, "module"))
        .or_else(|| strip_keyword(rest, "namespace"))
        .is_some()
    {
        let header = before_delimiters(rest, &['{', ';']);
        return regex.is_match(header).then_some("module");
    }

    // `const` / `let` / `var` / `val` declarations: pattern MUST match on the LHS (before `=`).
    if let Some(after) = strip_keyword(rest, "const")
        .or_else(|| strip_keyword(rest, "let"))
        .or_else(|| strip_keyword(rest, "var"))
        .or_else(|| strip_keyword(rest, "val"))
    {
        let lhs = before_delimiters(after, &['=', ';']);
        let lhs_name = before_delimiters(lhs, &[':']);
        if !regex.is_match(lhs_name) {
            return None;
        }
        if rest.contains("=>")
            || rest.contains("= function")
            || rest.contains("= async ")
            || rest.contains("= async(")
        {
            return Some("function");
        }
        if rest.contains("= class") {
            return Some("class");
        }
        if had_visibility_or_export
            || rest.contains("= {")
            || rest.contains("={")
            || rest.contains("= [")
            || (has_keyword_prefix(rest, "const") && rest.contains('='))
        {
            return Some("const");
        }
        return None;
    }

    if is_export_default {
        let header = before_delimiters(trimmed, &['{']);
        return regex.is_match(header).then_some("export");
    }

    None
}

fn before_delimiters<'a>(s: &'a str, delims: &[char]) -> &'a str {
    match s.find(delims) {
        Some(idx) => &s[..idx],
        None => s,
    }
}

fn has_keyword_prefix(s: &str, kw: &str) -> bool {
    if let Some(after) = s.strip_prefix(kw) {
        after
            .chars()
            .next()
            .is_some_and(|c| c.is_whitespace() || c == '(' || c == '<')
    } else {
        false
    }
}

fn strip_keyword<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    let after = s.strip_prefix(kw)?;
    let first = after.chars().next()?;
    if first.is_whitespace() {
        Some(after.trim_start())
    } else {
        None
    }
}

fn strip_pub_modifier(s: &str) -> Option<&str> {
    let after = s.strip_prefix("pub")?;
    if let Some(inner) = after.strip_prefix('(') {
        let close = inner.find(')')?;
        let remainder = &inner[close + 1..];
        if remainder.chars().next().is_some_and(char::is_whitespace) {
            return Some(remainder.trim_start());
        }
        return None;
    }
    if after.chars().next().is_some_and(char::is_whitespace) {
        Some(after.trim_start())
    } else {
        None
    }
}

fn strip_extern_modifier(s: &str) -> Option<&str> {
    let after = strip_keyword(s, "extern")?;
    if let Some(quoted) = after.strip_prefix('"')
        && let Some(end_quote) = quoted.find('"')
    {
        return Some(quoted[end_quote + 1..].trim_start());
    }
    Some(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_temp_dir(label: &str) -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "agy-pulse-search-{label}-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parent_anchored_gitignore_applies_relative_to_declaring_dir() {
        let root = make_temp_dir("parent-anchor");
        fs::create_dir_all(root.join("apps/web/sub/build")).unwrap();
        fs::write(
            root.join(".gitignore"),
            "/root_only.txt\n/apps/web/exact_sub.txt\nbuild/\n",
        )
        .unwrap();
        fs::write(root.join("root_only.txt"), "ignore at root\n").unwrap();
        fs::write(root.join("apps/web/root_only.txt"), "keep in subdir\n").unwrap();
        fs::write(root.join("apps/web/exact_sub.txt"), "ignore via parent anchor\n").unwrap();
        fs::write(root.join("apps/web/keep.ts"), "export const ok = 1;\n").unwrap();
        // Regular file named `build` must NOT be ignored by dir-only `build/`.
        fs::write(root.join("apps/web/build"), "file named build\n").unwrap();
        // Directory `build/` and its contents MUST be ignored.
        fs::write(root.join("apps/web/sub/build/out.txt"), "ignored dir content\n").unwrap();

        let ctx = SecurityContext::new(&[root.to_string_lossy().into_owned()], true, 65_536).unwrap();

        // Searching from subdirectory `apps/web` must respect parent `.gitignore` relative to `root`.
        let sub_root = ctx.authorize_path("apps/web").unwrap();
        let (files, _, _) = collect_candidate_files(&ctx, &sub_root, None, false).unwrap();
        let rels: Vec<String> = files
            .iter()
            .map(|p| relative_posix_path(&sub_root, p))
            .collect();

        assert!(
            rels.contains(&"root_only.txt".to_string()),
            "Anchored /root_only.txt in parent .gitignore must NOT ignore apps/web/root_only.txt: {rels:?}"
        );
        assert!(
            !rels.contains(&"exact_sub.txt".to_string()),
            "Anchored /apps/web/exact_sub.txt in parent .gitignore MUST ignore apps/web/exact_sub.txt: {rels:?}"
        );
        assert!(
            rels.contains(&"build".to_string()),
            "Dir-only build/ rule must NOT ignore regular file apps/web/build: {rels:?}"
        );
        assert!(
            !rels.iter().any(|r| r.contains("sub/build/")),
            "Dir-only build/ rule MUST ignore directory sub/build/: {rels:?}"
        );

        // Searching from workspace root ignores /root_only.txt at root while keeping apps/web/root_only.txt.
        let top_root = ctx.primary_root().to_path_buf();
        let (top_files, _, _) = collect_candidate_files(&ctx, &top_root, None, false).unwrap();
        let top_rels: Vec<String> = top_files
            .iter()
            .map(|p| relative_posix_path(&top_root, p))
            .collect();
        assert!(!top_rels.contains(&"root_only.txt".to_string()));
        assert!(top_rels.contains(&"apps/web/root_only.txt".to_string()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_gitignore_stacks_with_negation_and_sibling_isolation() {
        let root = make_temp_dir("nested-gi");
        fs::create_dir_all(root.join("pkg_a/deep")).unwrap();
        fs::create_dir_all(root.join("pkg_b")).unwrap();

        fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        fs::write(
            root.join("pkg_a/.gitignore"),
            "/local_only.txt\n*.tmp\n!keep.log\n",
        )
        .unwrap();

        fs::write(root.join("root.log"), "ignored\n").unwrap();
        fs::write(root.join("pkg_a/drop.log"), "ignored\n").unwrap();
        fs::write(root.join("pkg_a/keep.log"), "unignored by nested negation\n").unwrap();
        fs::write(root.join("pkg_a/local_only.txt"), "ignored at pkg_a\n").unwrap();
        fs::write(root.join("pkg_a/deep/local_only.txt"), "kept in pkg_a/deep\n").unwrap();
        fs::write(root.join("pkg_a/deep/scratch.tmp"), "ignored by pkg_a *.tmp\n").unwrap();
        fs::write(root.join("pkg_b/scratch.tmp"), "kept in sibling pkg_b\n").unwrap();

        let ctx = SecurityContext::new(&[root.to_string_lossy().into_owned()], true, 65_536).unwrap();
        let top = ctx.primary_root().to_path_buf();
        let (files, _, _) = collect_candidate_files(&ctx, &top, None, false).unwrap();
        let rels: Vec<String> = files.iter().map(|p| relative_posix_path(&top, p)).collect();

        assert!(!rels.contains(&"root.log".to_string()));
        assert!(!rels.contains(&"pkg_a/drop.log".to_string()));
        assert!(
            rels.contains(&"pkg_a/keep.log".to_string()),
            "Nested !keep.log must override root *.log: {rels:?}"
        );
        assert!(
            !rels.contains(&"pkg_a/local_only.txt".to_string()),
            "Nested anchored /local_only.txt must ignore pkg_a/local_only.txt: {rels:?}"
        );
        assert!(
            rels.contains(&"pkg_a/deep/local_only.txt".to_string()),
            "Nested anchored /local_only.txt must NOT ignore pkg_a/deep/local_only.txt: {rels:?}"
        );
        assert!(
            !rels.contains(&"pkg_a/deep/scratch.tmp".to_string()),
            "Nested *.tmp must ignore pkg_a/deep/scratch.tmp: {rels:?}"
        );
        assert!(
            rels.contains(&"pkg_b/scratch.tmp".to_string()),
            "pkg_a/.gitignore must NOT bleed into sibling pkg_b/: {rels:?}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn grep_honors_ipc_payload_budget_and_preserves_spillover_headroom() {
        let root = make_temp_dir("grep-budget");
        let payload_line = format!("MATCH_TOKEN {}", "a".repeat(380));
        let mut big = String::new();
        for i in 0..200 {
            big.push_str(&format!("{i}:{payload_line}\n"));
        }
        fs::write(root.join("big.txt"), &big).unwrap();

        // Medium file (~5 KB) exceeds max_inline_bytes=2048 but stays below 8x IPC budget (16 KB)
        // so Node's SpillStore still receives the complete output.
        let mut medium = String::new();
        for i in 0..25 {
            medium.push_str(&format!("MED_TOKEN {i} {}\n", "b".repeat(180)));
        }
        fs::write(root.join("medium.txt"), &medium).unwrap();

        let ctx = SecurityContext::new(&[root.to_string_lossy().into_owned()], true, 2_048).unwrap();

        let big_val = handle_grep(
            &ctx,
            serde_json::json!({
                "path": "big.txt",
                "pattern": "MATCH_TOKEN",
                "outputMode": "content",
                "limit": 200
            }),
        )
        .unwrap();
        let big_json = serde_json::to_vec(&big_val).unwrap();
        assert_eq!(big_val["truncated"], true);
        assert!(big_val["nextOffset"].as_u64().is_some());
        assert!(big_val["entries"].as_array().unwrap().len() < 200);
        assert!(
            big_json.len() < 24_000,
            "Expected serialized grep payload capped near IPC budget, got {} bytes",
            big_json.len()
        );

        let med_val = handle_grep(
            &ctx,
            serde_json::json!({
                "path": "medium.txt",
                "pattern": "MED_TOKEN",
                "outputMode": "content",
                "limit": 100
            }),
        )
        .unwrap();
        assert_eq!(med_val["truncated"], false);
        assert_eq!(med_val["entries"].as_array().unwrap().len(), 25);

        let _ = fs::remove_dir_all(&root);
    }
}
