use crate::ops_read::{escape_line_reversible, split_logical_lines};
use std::path::Path;

const MAX_SIGNATURE_CHARS: usize = 140;
const MAX_SUGGESTED_SYMBOLS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    TypeScript,
    Rust,
    Python,
    Go,
    JavaLike,
    CLike,
    Ruby,
    Php,
    Markdown,
    Json,
    Yaml,
    Css,
    Html,
    Generic,
}

impl Lang {
    pub fn from_path(path: &str) -> Self {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase());
        match ext.as_deref() {
            Some("ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs") => Self::TypeScript,
            Some("rs") => Self::Rust,
            Some("py" | "pyi") => Self::Python,
            Some("go") => Self::Go,
            Some("java" | "kt" | "kts" | "cs") => Self::JavaLike,
            Some("c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx") => Self::CLike,
            Some("rb" | "rake") => Self::Ruby,
            Some("php" | "phtml") => Self::Php,
            Some("md" | "mdx" | "markdown") => Self::Markdown,
            Some("json" | "jsonc") => Self::Json,
            Some("yml" | "yaml") => Self::Yaml,
            Some("css" | "scss" | "sass" | "less") => Self::Css,
            Some("html" | "htm" | "vue" | "svelte" | "xml" | "svg") => Self::Html,
            _ => Self::Generic,
        }
    }

    fn qualified_sep(self) -> &'static str {
        match self {
            Self::Rust | Self::CLike | Self::Php => "::",
            _ => ".",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Interface,
    Type,
    Enum,
    Trait,
    Impl,
    Mod,
    Const,
    Macro,
}

#[allow(dead_code)]
impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Interface => "interface",
            Self::Type => "type",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::Impl => "impl",
            Self::Mod => "mod",
            Self::Const => "const",
            Self::Macro => "macro",
        }
    }

    fn is_container(self) -> bool {
        matches!(
            self,
            Self::Class | Self::Struct | Self::Interface | Self::Enum | Self::Trait | Self::Impl | Self::Mod
        )
    }
}

#[derive(Debug, Clone)]
pub struct OutlineSymbol {
    pub name: String,
    pub container: Option<String>,
    pub kind: SymbolKind,
    pub start_line: usize,
    pub end_line: usize,
    pub doc_start_line: usize,
    pub signature: String,
}

impl OutlineSymbol {
    pub fn display_name(&self, lang: Lang) -> String {
        match &self.container {
            Some(c) => format!("{c}{}{}", lang.qualified_sep(), self.name),
            None => self.name.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImportSpan {
    pub start_line: usize,
    pub end_line: usize,
    pub line_count: usize,
}

#[derive(Debug, Clone)]
pub struct OutlineResult {
    #[cfg_attr(not(test), allow(dead_code))]
    pub imports: Vec<ImportSpan>,
    pub symbols: Vec<OutlineSymbol>,
    pub rendered_lines: Vec<String>,
    pub total_file_lines: usize,
}

#[derive(Debug, Clone)]
pub struct SymbolMatchResult {
    pub offset: usize,
    pub returned_lines: usize,
    pub next_offset: Option<usize>,
    pub eof: bool,
    pub escaped: bool,
    pub content: String,
    pub total_file_lines: usize,
}

pub fn extract_outline(path: &str, text: &str) -> OutlineResult {
    let lang = Lang::from_path(path);
    let lines = split_logical_lines(text);
    let total_file_lines = lines.len();

    let (imports, symbols) = match lang {
        Lang::Python => parse_python(&lines),
        Lang::Ruby => parse_ruby(&lines),
        Lang::Markdown => parse_markdown(&lines),
        Lang::Json => parse_json(&lines),
        Lang::Yaml => parse_yaml(&lines),
        Lang::Css => parse_css(&lines),
        Lang::Html => parse_html(&lines),
        _ => parse_brace_language(&lines, lang),
    };

    let rendered_lines = render_outline_lines(&imports, &symbols);

    OutlineResult {
        imports,
        symbols,
        rendered_lines,
        total_file_lines,
    }
}

/// Extract a targeted symbol body (including contiguous doc comments/attributes above it)
/// formatted with reversible `line|text` numbering.
pub fn extract_symbol(
    path: &str,
    text: &str,
    query: &str,
    limit: usize,
) -> Result<SymbolMatchResult, Vec<String>> {
    let lang = Lang::from_path(path);
    let lines = split_logical_lines(text);
    let total_file_lines = lines.len();
    let outline = extract_outline(path, text);
    let trimmed_query = query.trim();

    let matched = find_matching_symbols(&outline.symbols, trimmed_query);
    if matched.is_empty() {
        let mut suggestions = Vec::new();
        for sym in find_ambiguous_base_candidates(&outline.symbols, trimmed_query) {
            let label = sym.display_name(lang);
            if !suggestions.contains(&label) {
                suggestions.push(label);
                if suggestions.len() >= MAX_SUGGESTED_SYMBOLS {
                    return Err(suggestions);
                }
            }
        }
        for sym in &outline.symbols {
            let label = sym.display_name(lang);
            if !suggestions.contains(&label) {
                suggestions.push(label);
                if suggestions.len() >= MAX_SUGGESTED_SYMBOLS {
                    break;
                }
            }
        }
        return Err(suggestions);
    }

    let first_offset = matched[0].doc_start_line;
    let max_lines = limit.max(1);
    let mut out_lines: Vec<String> = Vec::new();
    let mut emitted_source_lines: usize = 0;
    let mut any_escaped = false;
    let mut truncated = false;
    let mut last_emitted_line: usize = first_offset;

    'outer: for (match_idx, sym) in matched.iter().enumerate() {
        if match_idx > 0 {
            if emitted_source_lines >= max_lines {
                truncated = true;
                break 'outer;
            }
            out_lines.push("---".to_string());
        }

        let start_idx = sym.doc_start_line.saturating_sub(1);
        let end_idx = sym.end_line.min(total_file_lines);
        for (idx, line) in lines.iter().enumerate().take(end_idx).skip(start_idx) {
            if emitted_source_lines >= max_lines {
                truncated = true;
                break 'outer;
            }
            let line_no = idx + 1;
            let (escaped_line, did_escape) = escape_line_reversible(line);
            if did_escape {
                any_escaped = true;
            }
            out_lines.push(format!("{line_no}|{escaped_line}"));
            emitted_source_lines += 1;
            last_emitted_line = line_no;
        }
    }

    let next_offset = if truncated && last_emitted_line < total_file_lines {
        Some(last_emitted_line + 1)
    } else {
        None
    };

    Ok(SymbolMatchResult {
        offset: first_offset,
        returned_lines: emitted_source_lines,
        next_offset,
        eof: !truncated,
        escaped: any_escaped,
        content: out_lines.join("\n"),
        total_file_lines,
    })
}

fn render_outline_lines(imports: &[ImportSpan], symbols: &[OutlineSymbol]) -> Vec<String> {
    let mut out = Vec::with_capacity(imports.len() + symbols.len());

    for imp in imports {
        if imp.start_line == imp.end_line {
            out.push(format!("[imports: L{}]", imp.start_line));
        } else {
            out.push(format!(
                "[imports: L{}-L{} ({} lines)]",
                imp.start_line, imp.end_line, imp.line_count
            ));
        }
    }

    for sym in symbols {
        let indent = if sym.container.is_some() { "  " } else { "" };
        let range = if sym.start_line == sym.end_line {
            format!("L{}", sym.start_line)
        } else {
            format!("L{}-L{}", sym.start_line, sym.end_line)
        };
        out.push(format!("{indent}{range} | {}", sym.signature));
    }

    out
}

fn split_qualified(query: &str) -> Option<(&str, &str)> {
    let bytes = query.as_bytes();
    let mut angle_depth: i32 = 0;
    let mut last_colons: Option<usize> = None;
    let mut last_dot: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'<' => angle_depth += 1,
            b'>' if i == 0 || bytes[i - 1] != b'-' => {
                angle_depth = (angle_depth - 1).max(0);
            }
            b':' if angle_depth == 0 && i + 1 < bytes.len() && bytes[i + 1] == b':' => {
                last_colons = Some(i);
                i += 2;
                continue;
            }
            b'.' if angle_depth == 0 => {
                last_dot = Some(i);
            }
            _ => {}
        }
        i += 1;
    }

    if let Some(pos) = last_colons {
        let c = query[..pos].trim();
        let n = query[pos + 2..].trim();
        if !c.is_empty() && !n.is_empty() {
            return Some((c, n));
        }
    }
    if let Some(pos) = last_dot {
        let c = query[..pos].trim();
        let n = query[pos + 1..].trim();
        if !c.is_empty() && !n.is_empty() {
            return Some((c, n));
        }
    }
    None
}

/// Extracts the bare nominal base type from a normalized container (e.g., `"Box<T>"` -> `"Box"`).
/// Returns `None` for reference/pointer/dyn containers (`"&mut T"`, `"*const T"`, `"dyn Foo"`),
/// so `&mut T` never aliases `T`.
fn container_base_type(container: &str) -> Option<&str> {
    let trimmed = container.trim();
    if trimmed.starts_with('&') || trimmed.starts_with('*') || strip_keyword(trimmed, "dyn").is_some() {
        return None;
    }
    let before_gen = trimmed.split('<').next().unwrap_or(trimmed).trim();
    let last_seg = before_gen.rsplit("::").next().unwrap_or(before_gen).trim();
    extract_ident(last_seg)
}

/// Returns `Some(base)` when `q_container` is a bare type name without generics or ref/ptr/dyn prefixes.
fn bare_query_base_type(q_container: &str) -> Option<&str> {
    let trimmed = q_container.trim();
    if trimmed.contains('<')
        || trimmed.contains('>')
        || trimmed.starts_with('&')
        || trimmed.starts_with('*')
        || strip_keyword(trimmed, "dyn").is_some()
    {
        return None;
    }
    let last_seg = trimmed.rsplit("::").next().unwrap_or(trimmed).trim();
    extract_ident(last_seg).filter(|&id| id == last_seg)
}

fn containers_are_single_target(matches: &[&OutlineSymbol]) -> bool {
    let mut first: Option<&str> = None;
    for sym in matches {
        let cur = sym.container.as_deref().unwrap_or("");
        match first {
            None => first = Some(cur),
            Some(prev) if prev == cur => {}
            Some(_) => return false,
        }
    }
    first.is_some()
}

fn find_ambiguous_base_candidates<'a>(
    symbols: &'a [OutlineSymbol],
    query: &str,
) -> Vec<&'a OutlineSymbol> {
    let Some((q_container, q_name)) = split_qualified(query) else {
        return Vec::new();
    };
    let Some(q_base) = bare_query_base_type(q_container) else {
        return Vec::new();
    };
    symbols
        .iter()
        .filter(|s| {
            s.name.eq_ignore_ascii_case(q_name)
                && s.container
                    .as_deref()
                    .and_then(container_base_type)
                    .is_some_and(|b| b.eq_ignore_ascii_case(q_base))
        })
        .collect()
}

fn find_matching_symbols<'a>(
    symbols: &'a [OutlineSymbol],
    query: &str,
) -> Vec<&'a OutlineSymbol> {
    if query.is_empty() {
        return Vec::new();
    }

    // 1. Exact qualified match (`Container::Name` or `Container.Name`), including normalized Rust targets.
    if let Some((q_container, q_name)) = split_qualified(query) {
        let norm_q = extract_rust_type_name(q_container);
        let exact_qual: Vec<&OutlineSymbol> = symbols
            .iter()
            .filter(|s| {
                s.name == q_name
                    && s.container.as_deref().is_some_and(|c| {
                        c == q_container || norm_q.as_deref().is_some_and(|nq| c == nq)
                    })
            })
            .collect();
        if !exact_qual.is_empty() {
            return exact_qual;
        }

        // 1b. Unambiguous short base-type lookup (e.g., `Box::len` -> `Box<T>::len`).
        if let Some(q_base) = bare_query_base_type(q_container) {
            let base_matches: Vec<&OutlineSymbol> = symbols
                .iter()
                .filter(|s| {
                    s.name == q_name
                        && s.container
                            .as_deref()
                            .and_then(container_base_type)
                            .is_some_and(|b| b == q_base)
                })
                .collect();
            if containers_are_single_target(&base_matches) {
                return base_matches;
            }
            if !base_matches.is_empty() {
                return Vec::new();
            }
        }
    }

    // 2. Exact bare name match (`Name`).
    let exact_bare: Vec<&OutlineSymbol> = symbols.iter().filter(|s| s.name == query).collect();
    if !exact_bare.is_empty() {
        return exact_bare;
    }

    // 2b. Fallback: if querying `Foo` when only `impl Foo` exists.
    let impl_query = format!("impl {query}");
    let exact_impl: Vec<&OutlineSymbol> =
        symbols.iter().filter(|s| s.name == impl_query).collect();
    if !exact_impl.is_empty() {
        return exact_impl;
    }

    // 3. Case-insensitive qualified match.
    if let Some((q_container, q_name)) = split_qualified(query) {
        let norm_q = extract_rust_type_name(q_container);
        let ci_qual: Vec<&OutlineSymbol> = symbols
            .iter()
            .filter(|s| {
                s.name.eq_ignore_ascii_case(q_name)
                    && s.container.as_deref().is_some_and(|c| {
                        c.eq_ignore_ascii_case(q_container)
                            || norm_q
                                .as_deref()
                                .is_some_and(|nq| c.eq_ignore_ascii_case(nq))
                    })
            })
            .collect();
        if !ci_qual.is_empty() {
            return ci_qual;
        }

        // 3b. Case-insensitive unambiguous short base-type lookup.
        if let Some(q_base) = bare_query_base_type(q_container) {
            let ci_base: Vec<&OutlineSymbol> = symbols
                .iter()
                .filter(|s| {
                    s.name.eq_ignore_ascii_case(q_name)
                        && s.container
                            .as_deref()
                            .and_then(container_base_type)
                            .is_some_and(|b| b.eq_ignore_ascii_case(q_base))
                })
                .collect();
            if containers_are_single_target(&ci_base) {
                return ci_base;
            }
            if !ci_base.is_empty() {
                return Vec::new();
            }
        }
    }

    // 4. Case-insensitive bare match.
    let ci_bare: Vec<&OutlineSymbol> = symbols
        .iter()
        .filter(|s| s.name.eq_ignore_ascii_case(query))
        .collect();
    if !ci_bare.is_empty() {
        return ci_bare;
    }

    // 4b. Case-insensitive `impl <query>` fallback.
    symbols
        .iter()
        .filter(|s| s.name.eq_ignore_ascii_case(&impl_query))
        .collect()
}

#[derive(Debug, Clone)]
struct LineLex {
    depth_before: i32,
    depth_after: i32,
    paren_before: i32,
    paren_after: i32,
    bracket_after: i32,
    opened_brace: bool,
    starts_in_multiline: bool,
    code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexState {
    Normal,
    BlockComment(usize), // nesting depth (Rust supports nested /* /* */ */)
    BacktickString,      // JS/TS template literal or Go raw string
    RustRawString(usize),
    VerbatimDoubleQuote, // C# @"..."
}

fn lex_brace_lines(lines: &[&str], lang: Lang) -> Vec<LineLex> {
    let mut result = Vec::with_capacity(lines.len());
    let mut state = LexState::Normal;
    let mut brace_depth: i32 = 0;
    let mut paren_depth: i32 = 0;
    let mut bracket_depth: i32 = 0;
    // Stack of brace depths for JS/TS `${...}` inside template literals.
    let mut template_expr_stack: Vec<i32> = Vec::new();

    for &line in lines {
        let depth_before = brace_depth;
        let paren_before = paren_depth;
        let starts_in_multiline = state != LexState::Normal;
        let mut opened_brace = false;
        let mut code = String::with_capacity(line.len());

        let bytes = line.as_bytes();
        let len = bytes.len();
        let mut i = 0;
        let mut last_sig_byte: Option<u8> = None;

        while i < len {
            match state {
                LexState::BlockComment(nest) => {
                    if lang == Lang::Rust && i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*'
                    {
                        state = LexState::BlockComment(nest + 1);
                        i += 2;
                    } else if i + 1 < len && bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        if nest <= 1 {
                            state = LexState::Normal;
                        } else {
                            state = LexState::BlockComment(nest - 1);
                        }
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                LexState::BacktickString => {
                    if lang == Lang::TypeScript && bytes[i] == b'\\' && i + 1 < len {
                        i += 2;
                    } else if lang == Lang::TypeScript
                        && i + 1 < len
                        && bytes[i] == b'$'
                        && bytes[i + 1] == b'{'
                    {
                        template_expr_stack.push(brace_depth);
                        brace_depth += 1;
                        state = LexState::Normal;
                        i += 2;
                    } else if bytes[i] == b'`' {
                        state = LexState::Normal;
                        i += 1;
                    } else {
                        i += 1;
                    }
                }
                LexState::RustRawString(hashes) => {
                    if bytes[i] == b'"' {
                        let mut matched = 0;
                        while matched < hashes
                            && i + 1 + matched < len
                            && bytes[i + 1 + matched] == b'#'
                        {
                            matched += 1;
                        }
                        if matched == hashes {
                            state = LexState::Normal;
                            i += 1 + hashes;
                            continue;
                        }
                    }
                    i += 1;
                }
                LexState::VerbatimDoubleQuote => {
                    if bytes[i] == b'"' {
                        if i + 1 < len && bytes[i + 1] == b'"' {
                            i += 2;
                        } else {
                            state = LexState::Normal;
                            i += 1;
                        }
                    } else {
                        i += 1;
                    }
                }
                LexState::Normal => {
                    let b = bytes[i];

                    if b == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
                        break;
                    }

                    // Exclude PHP 8 `#[Attribute]` from `#` line comments.
                    if lang == Lang::Php && b == b'#' && !(i + 1 < len && bytes[i + 1] == b'[') {
                        break;
                    }

                    if b == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
                        state = LexState::BlockComment(1);
                        i += 2;
                        continue;
                    }

                    // Rust raw strings: `r"..."`, `r#"..."#`, `br#"..."#`, `cr#"..."#`
                    if lang == Lang::Rust && b == b'r' {
                        let prev_ok = i == 0
                            || !is_ident_byte(bytes[i - 1])
                            || ((bytes[i - 1] == b'b' || bytes[i - 1] == b'c')
                                && (i == 1 || !is_ident_byte(bytes[i - 2])));
                        if prev_ok {
                            let mut j = i + 1;
                            while j < len && bytes[j] == b'#' {
                                j += 1;
                            }
                            if j < len && bytes[j] == b'"' {
                                let hashes = j - (i + 1);
                                state = LexState::RustRawString(hashes);
                                i = j + 1;
                                last_sig_byte = Some(b'"');
                                continue;
                            }
                        }
                    }

                    // C# verbatim string `@"..."`
                    if lang == Lang::JavaLike && b == b'@' && i + 1 < len && bytes[i + 1] == b'"' {
                        state = LexState::VerbatimDoubleQuote;
                        i += 2;
                        last_sig_byte = Some(b'"');
                        continue;
                    }

                    if b == b'"' {
                        i += 1;
                        while i < len {
                            if bytes[i] == b'\\' && i + 1 < len {
                                i += 2;
                            } else if bytes[i] == b'"' {
                                i += 1;
                                break;
                            } else {
                                i += 1;
                            }
                        }
                        last_sig_byte = Some(b'"');
                        continue;
                    }

                    // Single-quoted string or char literal; Rust lifetimes like `'a` are preserved.
                    if b == b'\'' {
                        if lang == Lang::Rust {
                            if let Some(next_i) = try_skip_rust_char_literal(line, i) {
                                i = next_i;
                                last_sig_byte = Some(b'\'');
                                continue;
                            }
                            code.push('\'');
                            last_sig_byte = Some(b'\'');
                            i += 1;
                            continue;
                        } else {
                            i += 1;
                            while i < len {
                                if bytes[i] == b'\\' && i + 1 < len {
                                    i += 2;
                                } else if bytes[i] == b'\'' {
                                    i += 1;
                                    break;
                                } else {
                                    i += 1;
                                }
                            }
                            last_sig_byte = Some(b'\'');
                            continue;
                        }
                    }

                    if b == b'`' && matches!(lang, Lang::TypeScript | Lang::Go) {
                        state = LexState::BacktickString;
                        i += 1;
                        last_sig_byte = Some(b'`');
                        continue;
                    }

                    // Skip JS/TS regex literals so quotes/braces inside patterns do not skew brace depth.
                    if lang == Lang::TypeScript
                        && b == b'/'
                        && can_start_js_regex(last_sig_byte, &code)
                    {
                        if let Some(next_i) = try_skip_js_regex(bytes, i) {
                            i = next_i;
                            last_sig_byte = Some(b'/');
                            continue;
                        }
                    }

                    match b {
                        b'{' => {
                            brace_depth += 1;
                            opened_brace = true;
                        }
                        b'}' => {
                            if let Some(&saved) = template_expr_stack.last() {
                                if brace_depth - 1 == saved {
                                    template_expr_stack.pop();
                                    brace_depth = saved;
                                    state = LexState::BacktickString;
                                    i += 1;
                                    continue;
                                }
                            }
                            brace_depth = (brace_depth - 1).max(0);
                        }
                        b'(' => paren_depth += 1,
                        b')' => paren_depth = (paren_depth - 1).max(0),
                        b'[' => bracket_depth += 1,
                        b']' => bracket_depth = (bracket_depth - 1).max(0),
                        _ => {}
                    }

                    let ch = line[i..].chars().next().unwrap_or(' ');
                    code.push(ch);
                    if !ch.is_ascii_whitespace() {
                        last_sig_byte = Some(b);
                    }
                    i += ch.len_utf8();
                }
            }
        }

        result.push(LineLex {
            depth_before,
            depth_after: brace_depth,
            paren_before,
            paren_after: paren_depth,
            bracket_after: bracket_depth,
            opened_brace,
            starts_in_multiline,
            code,
        });
    }

    result
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn try_skip_rust_char_literal(line: &str, quote_pos: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let len = bytes.len();
    if quote_pos + 2 >= len {
        return None;
    }
    if bytes[quote_pos + 1] == b'\\' {
        let mut j = quote_pos + 2;
        if j >= len {
            return None;
        }
        match bytes[j] {
            b'n' | b'r' | b't' | b'\\' | b'0' | b'\'' | b'"' => {
                j += 1;
            }
            b'x' => {
                j += 3;
            }
            b'u' if j + 1 < len && bytes[j + 1] == b'{' => {
                j += 2;
                while j < len && bytes[j] != b'}' {
                    j += 1;
                }
                j += 1;
            }
            _ => return None,
        }
        if j < len && bytes[j] == b'\'' {
            return Some(j + 1);
        }
        return None;
    }

    let rest = &line[quote_pos + 1..];
    let ch = rest.chars().next()?;
    if ch == '\'' || ch == '\n' || ch == '\r' {
        return None;
    }
    let after = quote_pos + 1 + ch.len_utf8();
    if after < len && bytes[after] == b'\'' {
        Some(after + 1)
    } else {
        None
    }
}

fn can_start_js_regex(last_sig: Option<u8>, code_so_far: &str) -> bool {
    match last_sig {
        None => true,
        Some(
            b'(' | b'[' | b'{' | b',' | b';' | b':' | b'=' | b'!' | b'&' | b'|' | b'?' | b'+'
            | b'-' | b'*' | b'%' | b'^' | b'~' | b'<' | b'>',
        ) => true,
        Some(b) if b.is_ascii_alphabetic() => {
            let trimmed = code_so_far.trim_end();
            matches!(
                trimmed.rsplit(|c: char| !c.is_ascii_alphanumeric() && c != '_').next(),
                Some("return" | "case" | "throw" | "in" | "of" | "typeof" | "void" | "delete" | "await" | "yield")
            )
        }
        _ => false,
    }
}

fn try_skip_js_regex(bytes: &[u8], start: usize) -> Option<usize> {
    let len = bytes.len();
    let mut i = start + 1;
    if i >= len || bytes[i] == b'/' || bytes[i] == b'*' {
        return None;
    }
    let mut in_class = false;
    while i < len {
        match bytes[i] {
            b'\\' if i + 1 < len => i += 2,
            b'[' => {
                in_class = true;
                i += 1;
            }
            b']' if in_class => {
                in_class = false;
                i += 1;
            }
            b'/' if !in_class => {
                i += 1;
                while i < len && bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
                return Some(i);
            }
            _ => i += 1,
        }
    }
    None
}

#[derive(Debug, Clone)]
struct ActiveContainer {
    name: String,
    body_depth: i32,
    header_end_idx: usize,
    end_idx: usize,
}

#[derive(Debug)]
struct CandidateDecl {
    name: String,
    kind: SymbolKind,
    /// Optional container name exposed for children inside this declaration's body.
    body_container: Option<String>,
}

fn parse_brace_language(lines: &[&str], lang: Lang) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let lex = lex_brace_lines(lines, lang);
    let imports = extract_leading_imports(lines, &lex, lang);

    let mut symbols: Vec<OutlineSymbol> = Vec::new();
    let mut containers: Vec<ActiveContainer> = Vec::new();
    let mut idx = 0;

    while idx < lines.len() {
        while containers.last().is_some_and(|c| idx > c.end_idx) {
            containers.pop();
        }

        let info = &lex[idx];
        if info.starts_in_multiline || info.paren_before > 0 {
            idx += 1;
            continue;
        }

        let trimmed = info.code.trim();
        if trimmed.is_empty() {
            idx += 1;
            continue;
        }

        let current_container = containers
            .last()
            .filter(|c| info.depth_before == c.body_depth);

        // Only inspect top-level (depth 0) or direct children of an active container.
        let is_top_level = info.depth_before == 0;
        if !is_top_level && current_container.is_none() {
            idx += 1;
            continue;
        }

        let container_name = current_container.map(|c| c.name.as_str());
        let candidate = match lang {
            Lang::Rust => match_rust_decl(trimmed, container_name.is_some()),
            Lang::TypeScript => match_ts_decl(trimmed, lines, &lex, idx, container_name.is_some()),
            Lang::Go => match_go_decl(trimmed, container_name.is_some()),
            Lang::JavaLike => match_javalike_decl(trimmed, lines, &lex, idx, container_name),
            Lang::CLike => match_clike_decl(trimmed, lines, &lex, idx, container_name),
            Lang::Php => match_php_decl(trimmed, container_name.is_some()),
            Lang::Generic => match_generic_decl(trimmed, container_name.is_some()),
            Lang::Python
            | Lang::Ruby
            | Lang::Markdown
            | Lang::Json
            | Lang::Yaml
            | Lang::Css
            | Lang::Html => None,
        };

        if let Some(cand) = candidate {
            let end_idx = find_brace_block_end(lines, &lex, idx, lang, cand.kind);
            let prev_boundary_line = symbols
                .iter()
                .rev()
                .find(|s| s.end_line <= idx)
                .map(|s| s.end_line)
                .unwrap_or(0);
            let container_boundary_line = containers
                .last()
                .map(|c| c.header_end_idx + 1)
                .unwrap_or(0);
            let min_doc_line = prev_boundary_line.max(container_boundary_line);
            let doc_start_idx = find_doc_start(lines, &lex, idx, lang, min_doc_line);
            let signature = build_brace_signature(lines, &lex, idx, end_idx, lang, cand.kind);

            // Go receiver methods and C++ out-of-line methods encode `Container::method` in `cand.name`.
            let (final_container, final_name) = if container_name.is_none()
                && matches!(lang, Lang::Go | Lang::CLike)
                && cand.kind == SymbolKind::Method
            {
                if let Some((c, n)) = cand.name.split_once("::") {
                    (Some(c.to_string()), n.to_string())
                } else {
                    (None, cand.name.clone())
                }
            } else {
                (container_name.map(ToString::to_string), cand.name.clone())
            };

            let sym = OutlineSymbol {
                name: final_name,
                container: final_container,
                kind: cand.kind,
                start_line: idx + 1,
                end_line: end_idx + 1,
                doc_start_line: doc_start_idx + 1,
                signature,
            };

            let body_container = cand.body_container.clone();
            let is_container = cand.kind.is_container() && body_container.is_some();
            symbols.push(sym);

            if is_container && end_idx > idx {
                let header_end = find_header_end_idx(&lex, idx, end_idx);
                if let Some(cname) = body_container {
                    containers.push(ActiveContainer {
                        name: cname,
                        body_depth: info.depth_before + 1,
                        header_end_idx: header_end,
                        end_idx,
                    });
                }
                // Advance past the container header so its members are scanned.
                idx = header_end + 1;
            } else {
                idx = end_idx + 1;
            }
            continue;
        }

        idx += 1;
    }

    (imports, symbols)
}

fn find_header_end_idx(lex: &[LineLex], start_idx: usize, end_idx: usize) -> usize {
    let base_depth = lex[start_idx].depth_before;
    for (j, item) in lex.iter().enumerate().take(end_idx + 1).skip(start_idx) {
        if item.opened_brace || item.depth_after > base_depth {
            return j;
        }
    }
    start_idx
}

fn find_brace_block_end(
    lines: &[&str],
    lex: &[LineLex],
    start_idx: usize,
    lang: Lang,
    kind: SymbolKind,
) -> usize {
    let base_depth = lex[start_idx].depth_before;

    // Preprocessor macros in C/C++: follow trailing `\` continuations.
    if lang == Lang::CLike && kind == SymbolKind::Macro {
        let mut j = start_idx;
        while j + 1 < lines.len() && lines[j].trim_end().ends_with('\\') {
            j += 1;
        }
        return j;
    }

    let mut opened_body = false;
    let mut j = start_idx;

    while j < lex.len() {
        let info = &lex[j];
        let trimmed = info.code.trim();

        if !opened_body {
            if info.paren_after > 0 || info.bracket_after > 0 {
                if info.depth_after > base_depth {
                    opened_body = true;
                }
                j += 1;
                continue;
            }

            if info.depth_after > base_depth {
                opened_body = true;
                j += 1;
                continue;
            }

            // Opened and closed on the same line (e.g. `fn foo() { bar(); }` or `interface X {}`).
            if info.opened_brace && info.depth_after == base_depth {
                // Check if next non-blank line is an Allman-style `{` (e.g. return type `{ a: number }` followed by `{`).
                if !trimmed.ends_with(';') && !trimmed.ends_with('}') {
                    j += 1;
                    continue;
                }
                if let Some(next_j) = next_non_blank_code_idx(lex, j + 1) {
                    if lex[next_j].code.trim_start().starts_with('{')
                        && lex[next_j].depth_before == base_depth
                        && matches!(kind, SymbolKind::Function | SymbolKind::Method)
                    {
                        j += 1;
                        continue;
                    }
                }
                return j;
            }

            if trimmed.ends_with(';') && info.depth_after == base_depth {
                return j;
            }

            // TypeScript/JavaScript/Go declarations without semicolons (ASI).
            if matches!(lang, Lang::TypeScript | Lang::Go)
                && info.depth_after == base_depth
                && matches!(kind, SymbolKind::Type | SymbolKind::Const)
            {
                if !continues_expression(trimmed) {
                    if let Some(next_j) = next_non_blank_code_idx(lex, j + 1) {
                        let next_trim = lex[next_j].code.trim();
                        if !starts_continuation(next_trim) {
                            return j;
                        }
                    } else {
                        return j;
                    }
                }
            }

            // Safety cap: if we scanned 20 lines looking for a `{` or `;` without opening a block,
            // stop so malformed/interface signatures don't consume the entire file.
            if j - start_idx >= 20 && info.depth_after == base_depth {
                return j;
            }
        } else if info.depth_after <= base_depth {
            return j;
        }

        j += 1;
    }

    lex.len().saturating_sub(1)
}

fn next_non_blank_code_idx(lex: &[LineLex], from: usize) -> Option<usize> {
    (from..lex.len()).find(|&k| !lex[k].code.trim().is_empty())
}

fn continues_expression(trimmed: &str) -> bool {
    trimmed.ends_with('=')
        || trimmed.ends_with('|')
        || trimmed.ends_with('&')
        || trimmed.ends_with(',')
        || trimmed.ends_with('(')
        || trimmed.ends_with('[')
        || trimmed.ends_with('{')
        || trimmed.ends_with('?')
        || trimmed.ends_with(':')
        || trimmed.ends_with("=>")
        || trimmed.ends_with('+')
        || trimmed.ends_with('-')
}

fn starts_continuation(next_trimmed: &str) -> bool {
    next_trimmed.starts_with('|')
        || next_trimmed.starts_with('&')
        || next_trimmed.starts_with('?')
        || next_trimmed.starts_with(':')
        || next_trimmed.starts_with('.')
        || next_trimmed.starts_with('{')
}

fn strip_trailing_line_comment(line: &str, lang: Lang) -> &str {
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        match bytes[i] {
            b'/' if i + 1 < len && bytes[i + 1] == b'/' => return &line[..i],
            b'#' if lang == Lang::Php && !(i + 1 < len && bytes[i + 1] == b'[') => {
                return &line[..i];
            }
            b'"' | b'`' => {
                let q = bytes[i];
                i += 1;
                while i < len {
                    if bytes[i] == b'\\' && i + 1 < len {
                        i += 2;
                    } else if bytes[i] == q {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            b'\'' => {
                if lang == Lang::Rust {
                    if let Some(next_i) = try_skip_rust_char_literal(line, i) {
                        i = next_i;
                    } else {
                        i += 1;
                    }
                } else {
                    i += 1;
                    while i < len {
                        if bytes[i] == b'\\' && i + 1 < len {
                            i += 2;
                        } else if bytes[i] == b'\'' {
                            i += 1;
                            break;
                        } else {
                            i += 1;
                        }
                    }
                }
            }
            _ => i += 1,
        }
    }
    line
}

fn build_brace_signature(
    lines: &[&str],
    lex: &[LineLex],
    start_idx: usize,
    end_idx: usize,
    lang: Lang,
    kind: SymbolKind,
) -> String {
    if lang == Lang::CLike && kind == SymbolKind::Macro {
        return truncate_signature(collapse_whitespace(lines[start_idx].trim()));
    }

    let base_depth = lex[start_idx].depth_before;
    let mut parts: Vec<&str> = Vec::new();
    let max_header = end_idx.min(start_idx + 12);

    for j in start_idx..=max_header {
        let piece = strip_trailing_line_comment(lines[j], lang).trim();
        if piece.is_empty() {
            continue;
        }

        // If this line opens the body block, keep only the portion before the body `{`.
        if lex[j].depth_after > base_depth
            || (lex[j].opened_brace && lex[j].depth_after == base_depth && lex[j].paren_after == 0)
        {
            if let Some(before_brace) = strip_body_brace(piece, lang, kind) {
                if !before_brace.is_empty() {
                    parts.push(before_brace);
                }
            }
            break;
        }

        parts.push(piece);
        if lex[j].code.trim_end().ends_with(';') && lex[j].paren_after == 0 {
            break;
        }
    }

    let joined = collapse_whitespace(&parts.join(" "));
    let cleaned = joined
        .trim_end_matches('{')
        .trim_end_matches("where")
        .trim();
    truncate_signature(cleaned.to_string())
}

fn strip_body_brace(piece: &str, _lang: Lang, kind: SymbolKind) -> Option<&str> {
    // Strip trailing object or type literal `{...}` from `const`/`type` headers.
    if matches!(kind, SymbolKind::Const | SymbolKind::Type) {
        if let Some(pos) = piece.rfind('{') {
            return Some(piece[..pos].trim_end());
        }
    }
    if let Some(pos) = piece.rfind('{') {
        let before = piece[..pos].trim_end();
        if !before.is_empty() {
            return Some(before);
        }
        return None;
    }
    Some(piece)
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    // Tidy spaces and trailing commas inside parens: `( a, b, )` -> `(a, b)`
    out.replace("( ", "(")
        .replace(", )", ")")
        .replace(",)", ")")
        .replace(" )", ")")
}

fn truncate_signature(sig: String) -> String {
    if sig.chars().count() <= MAX_SIGNATURE_CHARS {
        return sig;
    }
    let mut truncated: String = sig.chars().take(MAX_SIGNATURE_CHARS - 3).collect();
    while truncated.ends_with(' ') {
        truncated.pop();
    }
    truncated.push_str("...");
    truncated
}

fn extract_leading_imports(lines: &[&str], lex: &[LineLex], lang: Lang) -> Vec<ImportSpan> {
    let mut start_line: Option<usize> = None;
    let mut end_line: usize = 0;
    let mut count: usize = 0;

    let mut i = 0;
    while i < lines.len() {
        let raw_trim = lines[i].trim();
        let code_trim = lex[i].code.trim();

        if raw_trim.is_empty()
            || lex[i].starts_in_multiline
            || code_trim.is_empty()
            || raw_trim.starts_with("//")
            || raw_trim.starts_with("/*")
            || raw_trim.starts_with('*')
            || raw_trim.starts_with("#!")
            || raw_trim == "<?php"
            || (lang == Lang::TypeScript && (raw_trim == "'use strict';" || raw_trim == "\"use strict\";" || raw_trim == "'use strict'" || raw_trim == "\"use strict\""))
            || (lang == Lang::Go && code_trim.starts_with("package "))
            || (lang == Lang::JavaLike && code_trim.starts_with("package "))
            || (lang == Lang::Php && code_trim.starts_with("declare("))
            || (lang == Lang::Rust && raw_trim.starts_with("#!["))
        {
            i += 1;
            continue;
        }

        if is_import_line(code_trim, raw_trim, lang) {
            let imp_start = i;
            let imp_end = find_import_stmt_end(lines, lex, i, lang);
            if start_line.is_none() {
                start_line = Some(imp_start + 1);
            }
            end_line = imp_end + 1;
            count += imp_end - imp_start + 1;
            i = imp_end + 1;
            continue;
        }

        break;
    }

    match start_line {
        Some(s) => vec![ImportSpan {
            start_line: s,
            end_line,
            line_count: count,
        }],
        None => Vec::new(),
    }
}

fn is_import_line(code_trim: &str, raw_trim: &str, lang: Lang) -> bool {
    match lang {
        Lang::TypeScript => {
            code_trim.starts_with("import ")
                || code_trim.starts_with("import{")
                || code_trim.starts_with("import\"")
                || code_trim.starts_with("import'")
                || (code_trim.starts_with("export ") && code_trim.contains(" from "))
        }
        Lang::Rust => {
            code_trim.starts_with("use ")
                || code_trim.starts_with("pub use ")
                || code_trim.starts_with("pub(crate) use ")
                || code_trim.starts_with("pub(super) use ")
                || code_trim.starts_with("extern crate ")
        }
        Lang::Go => code_trim.starts_with("import ") || code_trim.starts_with("import("),
        Lang::JavaLike => code_trim.starts_with("import ") || code_trim.starts_with("using "),
        Lang::CLike => raw_trim.starts_with("#include"),
        Lang::Php => {
            code_trim.starts_with("use ")
                || code_trim.starts_with("require ")
                || code_trim.starts_with("require_once ")
                || code_trim.starts_with("include ")
                || code_trim.starts_with("include_once ")
        }
        Lang::Generic => {
            code_trim.starts_with("import ")
                || code_trim.starts_with("use ")
                || raw_trim.starts_with("#include")
        }
        Lang::Python
        | Lang::Ruby
        | Lang::Markdown
        | Lang::Json
        | Lang::Yaml
        | Lang::Css
        | Lang::Html => false,
    }
}

fn find_import_stmt_end(lines: &[&str], lex: &[LineLex], start_idx: usize, lang: Lang) -> usize {
    match lang {
        Lang::CLike => start_idx,
        Lang::Go => {
            if lex[start_idx].paren_after > 0 {
                for (j, item) in lex.iter().enumerate().skip(start_idx + 1) {
                    if item.paren_after == 0 {
                        return j;
                    }
                }
            }
            start_idx
        }
        Lang::Rust => {
            for (j, item) in lex.iter().enumerate().skip(start_idx) {
                if item.code.trim_end().ends_with(';') && item.depth_after == 0 {
                    return j;
                }
            }
            start_idx
        }
        Lang::TypeScript => {
            let mut j = start_idx;
            let mut brace_open = lex[start_idx].depth_after > 0;
            while j < lines.len() {
                let raw = lines[j].trim();
                let c = lex[j].code.trim();
                if lex[j].depth_after > 0 {
                    brace_open = true;
                }
                if !brace_open
                    && (c.ends_with(';')
                        || raw.contains(" from ")
                        || raw.starts_with("import '")
                        || raw.starts_with("import \""))
                {
                    return j;
                }
                if brace_open && lex[j].depth_after == 0 {
                    return j;
                }
                if j - start_idx >= 30 {
                    return j;
                }
                j += 1;
            }
            start_idx
        }
        _ => start_idx,
    }
}

fn find_doc_start(
    lines: &[&str],
    lex: &[LineLex],
    start_idx: usize,
    lang: Lang,
    prev_end_line: usize,
) -> usize {
    let min_idx = prev_end_line; // 1-based prev_end_line == first 0-based line strictly after it
    let mut doc_idx = start_idx;

    while doc_idx > min_idx {
        let prev = lines[doc_idx - 1].trim();
        if prev.is_empty() {
            break;
        }

        if lang == Lang::Rust {
            if prev.starts_with("///") {
                doc_idx -= 1;
                continue;
            }
            if prev.starts_with("#[") && !prev.starts_with("#![") {
                doc_idx -= 1;
                continue;
            }
            // End of multi-line attribute `)]`
            if prev.ends_with(']') && !prev.ends_with(';') && !prev.ends_with('{') && !prev.ends_with('}') {
                if let Some(attr_start) = find_multiline_attr_start(lines, doc_idx - 1, min_idx) {
                    doc_idx = attr_start;
                    continue;
                }
            }
            if prev.ends_with("*/") {
                if let Some(block_start) = find_block_comment_start(lines, doc_idx - 1, min_idx) {
                    doc_idx = block_start;
                    continue;
                }
            }
            break;
        }

        if prev.starts_with("//") {
            doc_idx -= 1;
            continue;
        }

        if prev.ends_with("*/") {
            if let Some(block_start) = find_block_comment_start(lines, doc_idx - 1, min_idx) {
                doc_idx = block_start;
                continue;
            }
        }

        // Decorators / Annotations (`@Decorator`, C# `[Attr]`, PHP `#[Attr]`, C++ `template<...>`)
        let is_decorator = match lang {
            Lang::TypeScript | Lang::JavaLike => prev.starts_with('@') || (lang == Lang::JavaLike && prev.starts_with('[') && prev.ends_with(']')),
            Lang::Php => prev.starts_with("#["),
            Lang::CLike => prev.starts_with("template"),
            _ => false,
        };
        if is_decorator && lex[doc_idx - 1].depth_before == lex[start_idx].depth_before {
            doc_idx -= 1;
            continue;
        }

        break;
    }

    doc_idx
}

fn find_block_comment_start(lines: &[&str], end_idx: usize, min_idx: usize) -> Option<usize> {
    let mut k = end_idx;
    loop {
        let t = lines[k].trim();
        if t.starts_with("/*") {
            return Some(k);
        }
        if k == min_idx || end_idx - k > 60 {
            return None;
        }
        k -= 1;
    }
}

fn find_multiline_attr_start(lines: &[&str], end_idx: usize, min_idx: usize) -> Option<usize> {
    let mut k = end_idx;
    loop {
        let t = lines[k].trim();
        if t.starts_with("#[") && !t.starts_with("#![") {
            return Some(k);
        }
        if t.ends_with(';') || t.ends_with('{') || t.ends_with('}') {
            return None;
        }
        if k == min_idx || end_idx - k > 25 {
            return None;
        }
        k -= 1;
    }
}

fn extract_ident(s: &str) -> Option<&str> {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let first = bytes[0];
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b'$' || first == b'#') {
        return None;
    }
    let mut end = 1;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'$') {
        end += 1;
    }
    Some(&s[..end])
}

fn strip_keyword<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    let rest = s.strip_prefix(kw)?;
    match rest.as_bytes().first() {
        None => Some(""),
        Some(&b) if !is_ident_byte(b) => Some(rest.trim_start()),
        _ => None,
    }
}

fn strip_rust_visibility(mut s: &str) -> &str {
    if let Some(after_pub) = s.strip_prefix("pub") {
        let first = after_pub.as_bytes().first().copied();
        if first == Some(b'(') {
            if let Some(close) = after_pub.find(')') {
                s = after_pub[close + 1..].trim_start();
            }
        } else if first.is_some_and(|b| b.is_ascii_whitespace()) {
            s = after_pub.trim_start();
        }
    }
    s
}

fn match_rust_decl(trimmed: &str, in_container: bool) -> Option<CandidateDecl> {
    if trimmed.starts_with("macro_rules!") {
        let rest = trimmed["macro_rules!".len()..].trim_start();
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Macro,
            body_container: None,
        });
    }

    let mut s = strip_rust_visibility(trimmed);

    loop {
        if let Some(r) = strip_keyword(s, "default")
            .or_else(|| strip_keyword(s, "const"))
            .or_else(|| strip_keyword(s, "async"))
            .or_else(|| strip_keyword(s, "unsafe"))
        {
            // `const NAME: Type = ...;` is a const item, not `const fn`.
            if s.starts_with("const") && !r.starts_with("fn") && !r.starts_with("unsafe") && !r.starts_with("extern") {
                break;
            }
            s = r;
            continue;
        }
        if let Some(r) = strip_keyword(s, "extern") {
            // Skip optional ABI string (already stripped in `code`, may leave whitespace)
            s = r;
            continue;
        }
        break;
    }

    if let Some(rest) = strip_keyword(s, "fn") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: if in_container {
                SymbolKind::Method
            } else {
                SymbolKind::Function
            },
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "struct") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Struct,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "enum") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Enum,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "trait") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Trait,
            body_container: Some(name.to_string()),
        });
    }

    if let Some(rest) = strip_keyword(s, "impl") {
        let (impl_label, target_type) = parse_rust_impl_target(rest)?;
        return Some(CandidateDecl {
            name: impl_label,
            kind: SymbolKind::Impl,
            body_container: Some(target_type),
        });
    }

    if let Some(rest) = strip_keyword(s, "mod") {
        let name = extract_ident(rest)?;
        // Inline `mod foo { ... }` is a container; `mod foo;` is a declaration only.
        let is_inline = !trimmed.ends_with(';');
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Mod,
            body_container: if is_inline {
                Some(name.to_string())
            } else {
                None
            },
        });
    }

    if let Some(rest) = strip_keyword(s, "type") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Type,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "const") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Const,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "static") {
        let rest = strip_keyword(rest, "mut").unwrap_or(rest);
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Const,
            body_container: None,
        });
    }

    None
}

/// Parses `impl[<T>] [Trait for] TargetType[<T>] [where ...] {` into
/// `(display_name, container_type_name)`.
fn parse_rust_impl_target(rest: &str) -> Option<(String, String)> {
    let mut s = rest.trim_start();
    if s.starts_with('<') {
        s = skip_angle_brackets(s).trim_start();
    }
    if let Some(pos) = s.find('{') {
        s = &s[..pos];
    }
    if let Some(pos) = find_word_boundary(s, "where") {
        s = &s[..pos];
    }
    let header = s.trim();
    if header.is_empty() {
        return None;
    }

    if let Some(for_pos) = find_word_boundary(header, "for") {
        let trait_part = strip_generics_for_name(header[..for_pos].trim());
        let target_raw = header[for_pos + 3..].trim();
        let target_type = extract_rust_type_name(target_raw)?;
        let label = format!("impl {trait_part} for {target_type}");
        Some((label, target_type))
    } else {
        let target_type = extract_rust_type_name(header)?;
        let label = format!("impl {target_type}");
        Some((label, target_type))
    }
}

fn skip_angle_brackets(s: &str) -> &str {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    return &s[idx + 1..];
                }
            }
            _ => {}
        }
    }
    ""
}

fn find_word_boundary(haystack: &str, word: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let wlen = word.len();
    let mut angle_depth = 0i32;
    let mut i = 0;
    while i + wlen <= bytes.len() {
        match bytes[i] {
            b'<' => angle_depth += 1,
            b'>' => angle_depth = (angle_depth - 1).max(0),
            _ => {}
        }
        if angle_depth == 0 && &haystack[i..i + wlen] == word {
            let before_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let after_ok = i + wlen == bytes.len() || !is_ident_byte(bytes[i + wlen]);
            if before_ok && after_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn strip_generics_for_name(raw: &str) -> String {
    let before_gen = raw.split('<').next().unwrap_or(raw).trim();
    before_gen
        .rsplit("::")
        .next()
        .unwrap_or(before_gen)
        .trim()
        .to_string()
}

fn extract_rust_type_name(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }

    if let Some(rest) = s.strip_prefix('&') {
        let mut r = rest.trim_start();
        let mut prefix = String::from("&");
        if r.starts_with('\'') {
            let lt_end = r
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '\'')
                .unwrap_or(r.len());
            let lt = &r[..lt_end];
            if lt.len() > 1 {
                prefix.push_str(lt);
                r = r[lt_end..].trim_start();
            }
        }
        if let Some(after_mut) = strip_keyword(r, "mut") {
            if prefix.len() > 1 {
                prefix.push(' ');
            }
            prefix.push_str("mut ");
            let inner = extract_rust_type_name(after_mut)?;
            return Some(format!("{prefix}{inner}"));
        }
        if prefix.len() > 1 {
            prefix.push(' ');
        }
        let inner = extract_rust_type_name(r)?;
        return Some(format!("{prefix}{inner}"));
    }

    if let Some(rest) = strip_keyword(s, "dyn") {
        let inner = extract_rust_type_name(rest)?;
        return Some(format!("dyn {inner}"));
    }

    if let Some(rest) = s.strip_prefix('*') {
        let r = rest.trim_start();
        if let Some(after) = strip_keyword(r, "mut") {
            let inner = extract_rust_type_name(after)?;
            return Some(format!("*mut {inner}"));
        }
        if let Some(after) = strip_keyword(r, "const") {
            let inner = extract_rust_type_name(after)?;
            return Some(format!("*const {inner}"));
        }
    }

    let (head, tail) = split_top_level_generics(s);
    let last_seg = head.rsplit("::").next().unwrap_or(head).trim();
    let ident = extract_ident(last_seg)?;
    match tail {
        Some(gen_args) => {
            let norm_args = normalize_generic_args(gen_args);
            if norm_args.is_empty() {
                Some(ident.to_string())
            } else {
                Some(format!("{ident}<{norm_args}>"))
            }
        }
        None => Some(ident.to_string()),
    }
}

fn split_top_level_generics(s: &str) -> (&str, Option<&str>) {
    let Some(lt_pos) = s.find('<') else {
        return (s, None);
    };
    let mut depth: i32 = 0;
    for (idx, ch) in s[lt_pos..].char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    let end = lt_pos + idx;
                    return (&s[..lt_pos], Some(&s[lt_pos + 1..end]));
                }
            }
            _ => {}
        }
    }
    (s, None)
}

fn normalize_generic_args(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut pending_space = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        match ch {
            '<' => {
                pending_space = false;
                out.push('<');
            }
            '>' => {
                pending_space = false;
                while out.ends_with(' ') {
                    out.pop();
                }
                out.push('>');
            }
            ',' => {
                while out.ends_with(' ') {
                    out.pop();
                }
                out.push(',');
                pending_space = true;
            }
            _ => {
                if pending_space && !out.ends_with('<') && !out.ends_with('&') {
                    out.push(' ');
                }
                pending_space = false;
                out.push(ch);
            }
        }
    }
    out.trim().to_string()
}

fn match_ts_decl(
    trimmed: &str,
    _lines: &[&str],
    lex: &[LineLex],
    idx: usize,
    in_container: bool,
) -> Option<CandidateDecl> {
    if in_container {
        return match_ts_class_member(trimmed, lex, idx);
    }

    let mut s = trimmed;
    let mut is_exported = false;
    loop {
        if let Some(r) = strip_keyword(s, "export") {
            is_exported = true;
            s = r;
            continue;
        }
        if let Some(r) = strip_keyword(s, "default")
            .or_else(|| strip_keyword(s, "declare"))
            .or_else(|| strip_keyword(s, "abstract"))
        {
            s = r;
            continue;
        }
        break;
    }

    if let Some(rest) = strip_keyword(s, "class") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Class,
            body_container: Some(name.to_string()),
        });
    }

    if let Some(rest) = strip_keyword(s, "interface") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Interface,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "type") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Type,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "const") {
        if let Some(after_enum) = strip_keyword(rest, "enum") {
            let name = extract_ident(after_enum)?;
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Enum,
                body_container: None,
            });
        }
    }

    if let Some(rest) = strip_keyword(s, "enum") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Enum,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "namespace").or_else(|| strip_keyword(s, "module")) {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Mod,
            body_container: Some(name.to_string()),
        });
    }

    let fn_s = strip_keyword(s, "async").unwrap_or(s);
    if let Some(mut rest) = strip_keyword(fn_s, "function") {
        if let Some(after_star) = rest.strip_prefix('*') {
            rest = after_star.trim_start();
        }
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Function,
            body_container: None,
        });
    }

    // `export const/let/var` or top-level arrow/function `const Foo = (...) =>` / `const Foo = function`
    if let Some(rest) = strip_keyword(s, "const")
        .or_else(|| if is_exported { strip_keyword(s, "let").or_else(|| strip_keyword(s, "var")) } else { None })
    {
        let name = extract_ident(rest)?;
        let rhs = &rest[name.len()..];
        let is_fn_expr = rhs.contains("=>")
            || rhs.contains("function(")
            || rhs.contains("function (")
            || (rhs.contains("= async") && rhs.contains('('));
        if is_exported || is_fn_expr {
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: if is_fn_expr {
                    SymbolKind::Function
                } else {
                    SymbolKind::Const
                },
                body_container: None,
            });
        }
    }

    None
}

fn match_ts_class_member(trimmed: &str, lex: &[LineLex], idx: usize) -> Option<CandidateDecl> {
    let mut s = trimmed;
    loop {
        if let Some(r) = strip_keyword(s, "public")
            .or_else(|| strip_keyword(s, "private"))
            .or_else(|| strip_keyword(s, "protected"))
            .or_else(|| strip_keyword(s, "static"))
            .or_else(|| strip_keyword(s, "readonly"))
            .or_else(|| strip_keyword(s, "abstract"))
            .or_else(|| strip_keyword(s, "override"))
            .or_else(|| strip_keyword(s, "declare"))
            .or_else(|| strip_keyword(s, "async"))
            .or_else(|| strip_keyword(s, "get"))
            .or_else(|| strip_keyword(s, "set"))
        {
            s = r;
            continue;
        }
        if let Some(r) = s.strip_prefix('*') {
            s = r.trim_start();
            continue;
        }
        break;
    }

    let name = extract_ident(s)?;
    if is_control_flow_keyword(name) {
        return None;
    }

    let after = s[name.len()..].trim_start();

    if after.starts_with('=') && (after.contains("=>") || after.contains("function")) {
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Method,
            body_container: None,
        });
    }

    let after_generics = if after.starts_with('<') {
        skip_angle_brackets(after).trim_start()
    } else {
        after
    };

    if after_generics.starts_with('(') {
        // Ensure this actually opens a body `{` (on this line or a nearby signature continuation)
        // or is an abstract/ambient signature.
        let base_depth = lex[idx].depth_before;
        let has_body_soon = (idx..lex.len().min(idx + 15)).any(|k| {
            lex[k].opened_brace
                || lex[k].depth_after > base_depth
                || (trimmed.contains("abstract ") && lex[k].code.trim_end().ends_with(';'))
        });
        if has_body_soon {
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Method,
                body_container: None,
            });
        }
    }

    None
}

fn match_go_decl(trimmed: &str, _in_container: bool) -> Option<CandidateDecl> {
    if let Some(rest) = strip_keyword(trimmed, "func") {
        if rest.starts_with('(') {
            let close = rest.find(')')?;
            let recv = rest[1..close].trim();
            let recv_type = recv
                .split_whitespace()
                .last()
                .unwrap_or(recv)
                .trim_start_matches('*')
                .split('[')
                .next()
                .unwrap_or("")
                .trim();
            let after_recv = rest[close + 1..].trim_start();
            let method_name = extract_ident(after_recv)?;
            if !recv_type.is_empty() {
                return Some(CandidateDecl {
                    name: format!("{recv_type}::{method_name}"),
                    kind: SymbolKind::Method,
                    body_container: None,
                });
            }
            return Some(CandidateDecl {
                name: method_name.to_string(),
                kind: SymbolKind::Function,
                body_container: None,
            });
        }

        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Function,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(trimmed, "type") {
        let name = extract_ident(rest)?;
        let after = rest[name.len()..].trim_start();
        let after = if after.starts_with('[') {
            after.find(']').map(|p| after[p + 1..].trim_start()).unwrap_or(after)
        } else {
            after
        };
        let kind = if strip_keyword(after, "struct").is_some() {
            SymbolKind::Struct
        } else if strip_keyword(after, "interface").is_some() {
            SymbolKind::Interface
        } else {
            SymbolKind::Type
        };
        return Some(CandidateDecl {
            name: name.to_string(),
            kind,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(trimmed, "const") {
        if !rest.starts_with('(') {
            let name = extract_ident(rest)?;
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Const,
                body_container: None,
            });
        }
    }

    None
}

fn match_javalike_decl(
    trimmed: &str,
    _lines: &[&str],
    lex: &[LineLex],
    idx: usize,
    container_name: Option<&str>,
) -> Option<CandidateDecl> {
    let mut s = trimmed;
    loop {
        if let Some(r) = strip_keyword(s, "public")
            .or_else(|| strip_keyword(s, "private"))
            .or_else(|| strip_keyword(s, "protected"))
            .or_else(|| strip_keyword(s, "internal"))
            .or_else(|| strip_keyword(s, "static"))
            .or_else(|| strip_keyword(s, "final"))
            .or_else(|| strip_keyword(s, "abstract"))
            .or_else(|| strip_keyword(s, "sealed"))
            .or_else(|| strip_keyword(s, "open"))
            .or_else(|| strip_keyword(s, "data"))
            .or_else(|| strip_keyword(s, "override"))
            .or_else(|| strip_keyword(s, "virtual"))
            .or_else(|| strip_keyword(s, "async"))
            .or_else(|| strip_keyword(s, "suspend"))
            .or_else(|| strip_keyword(s, "inline"))
            .or_else(|| strip_keyword(s, "readonly"))
            .or_else(|| strip_keyword(s, "partial"))
            .or_else(|| strip_keyword(s, "synchronized"))
        {
            s = r;
            continue;
        }
        break;
    }

    if let Some(rest) = strip_keyword(s, "class").or_else(|| strip_keyword(s, "record")).or_else(|| strip_keyword(s, "object")) {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Class,
            body_container: Some(name.to_string()),
        });
    }

    if let Some(rest) = strip_keyword(s, "interface") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Interface,
            body_container: Some(name.to_string()),
        });
    }

    if let Some(rest) = strip_keyword(s, "struct") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Struct,
            body_container: Some(name.to_string()),
        });
    }

    if let Some(rest) = strip_keyword(s, "enum") {
        let rest = strip_keyword(rest, "class").unwrap_or(rest);
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Enum,
            body_container: None,
        });
    }

    if let Some(rest) = strip_keyword(s, "namespace") {
        let name = rest.split(|c: char| c.is_whitespace() || c == '{' || c == ';').next()?;
        if !name.is_empty() {
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Mod,
                body_container: if trimmed.contains('{') {
                    Some(name.to_string())
                } else {
                    None
                },
            });
        }
    }

    // Kotlin `fun [<T>] [Receiver.]name(...)`
    if let Some(mut rest) = strip_keyword(s, "fun") {
        if rest.starts_with('<') {
            rest = skip_angle_brackets(rest).trim_start();
        }
        let before_paren = rest.split('(').next()?.trim();
        let name = before_paren.rsplit('.').next()?.trim();
        let name = extract_ident(name)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: if container_name.is_some() {
                SymbolKind::Method
            } else {
                SymbolKind::Function
            },
            body_container: None,
        });
    }

    if container_name.is_some() {
        if let Some(paren_pos) = s.find('(') {
            let before_paren = s[..paren_pos].trim_end();
            // Reject assignments/calls (`foo = bar(...)`, `return foo(...)`, `if (...)`)
            if !before_paren.contains('=') && !before_paren.contains('.') {
                let candidate_name = before_paren
                    .split_whitespace()
                    .last()
                    .map(|tok| tok.split('<').next().unwrap_or(tok))?;
                if let Some(name) = extract_ident(candidate_name) {
                    if !is_control_flow_keyword(name) {
                        let base_depth = lex[idx].depth_before;
                        let has_body = (idx..lex.len().min(idx + 8)).any(|k| {
                            lex[k].opened_brace
                                || lex[k].depth_after > base_depth
                                || lex[k].code.trim_end().ends_with(';')
                        });
                        if has_body {
                            return Some(CandidateDecl {
                                name: name.to_string(),
                                kind: SymbolKind::Method,
                                body_container: None,
                            });
                        }
                    }
                }
            }
        }
    }

    None
}

fn match_clike_decl(
    trimmed: &str,
    lines: &[&str],
    lex: &[LineLex],
    idx: usize,
    container_name: Option<&str>,
) -> Option<CandidateDecl> {
    let raw_trim = lines[idx].trim();
    if let Some(rest) = raw_trim.strip_prefix("#define") {
        if rest.starts_with(|c: char| c.is_whitespace()) {
            let name = extract_ident(rest.trim_start())?;
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Macro,
                body_container: None,
            });
        }
    }

    if trimmed.starts_with('#') {
        return None;
    }

    if let Some(rest) = strip_keyword(trimmed, "namespace") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Mod,
            body_container: Some(name.to_string()),
        });
    }

    if let Some(rest) = strip_keyword(trimmed, "class") {
        let name = extract_ident(rest)?;
        if !trimmed.ends_with(';') {
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Class,
                body_container: Some(name.to_string()),
            });
        }
    }

    if let Some(rest) = strip_keyword(trimmed, "struct") {
        let name = extract_ident(rest)?;
        if !trimmed.ends_with(';') {
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Struct,
                body_container: Some(name.to_string()),
            });
        }
    }

    if let Some(rest) = strip_keyword(trimmed, "enum") {
        let rest = strip_keyword(rest, "class").or_else(|| strip_keyword(rest, "struct")).unwrap_or(rest);
        let name = extract_ident(rest)?;
        if !trimmed.ends_with(';') {
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Enum,
                body_container: None,
            });
        }
    }

    if let Some(rest) = strip_keyword(trimmed, "using") {
        if rest.contains('=') {
            let name = extract_ident(rest)?;
            return Some(CandidateDecl {
                name: name.to_string(),
                kind: SymbolKind::Type,
                body_container: None,
            });
        }
    }

    // C / C++ function or method definition (must open a `{` block soon)
    if let Some(paren_pos) = trimmed.find('(') {
        let before_paren = trimmed[..paren_pos].trim_end();
        if !before_paren.contains('=') && !before_paren.is_empty() {
            let token = before_paren
                .split_whitespace()
                .last()?
                .trim_start_matches('*')
                .trim_start_matches('&');
            let base_depth = lex[idx].depth_before;
            let opens_body = (idx..lex.len().min(idx + 8)).any(|k| {
                lex[k].opened_brace || lex[k].depth_after > base_depth
            });
            if opens_body {
                if let Some((cls, method)) = token.rsplit_once("::") {
                    let cls_clean = cls.split('<').next().unwrap_or(cls);
                    let method_clean = method.trim_start_matches('~');
                    if extract_ident(cls_clean).is_some()
                        && extract_ident(method_clean).is_some()
                        && !is_control_flow_keyword(method_clean)
                    {
                        return Some(CandidateDecl {
                            name: format!("{cls_clean}::{method}"),
                            kind: SymbolKind::Method,
                            body_container: None,
                        });
                    }
                } else {
                    let clean = token.trim_start_matches('~');
                    if let Some(name) = extract_ident(clean) {
                        if !is_control_flow_keyword(name) && name != "typedef" && name != "return" {
                            return Some(CandidateDecl {
                                name: token.to_string(),
                                kind: if container_name.is_some() {
                                    SymbolKind::Method
                                } else {
                                    SymbolKind::Function
                                },
                                body_container: None,
                            });
                        }
                    }
                }
            }
        }
    }

    None
}

fn match_php_decl(trimmed: &str, in_container: bool) -> Option<CandidateDecl> {
    let mut s = trimmed;
    loop {
        if let Some(r) = strip_keyword(s, "public")
            .or_else(|| strip_keyword(s, "protected"))
            .or_else(|| strip_keyword(s, "private"))
            .or_else(|| strip_keyword(s, "static"))
            .or_else(|| strip_keyword(s, "abstract"))
            .or_else(|| strip_keyword(s, "final"))
            .or_else(|| strip_keyword(s, "readonly"))
        {
            s = r;
            continue;
        }
        break;
    }

    if let Some(rest) = strip_keyword(s, "class") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Class,
            body_container: Some(name.to_string()),
        });
    }
    if let Some(rest) = strip_keyword(s, "interface") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Interface,
            body_container: Some(name.to_string()),
        });
    }
    if let Some(rest) = strip_keyword(s, "trait") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Trait,
            body_container: Some(name.to_string()),
        });
    }
    if let Some(rest) = strip_keyword(s, "enum") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Enum,
            body_container: Some(name.to_string()),
        });
    }
    if let Some(rest) = strip_keyword(s, "function") {
        let rest = rest.trim_start_matches('&').trim_start();
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: if in_container {
                SymbolKind::Method
            } else {
                SymbolKind::Function
            },
            body_container: None,
        });
    }
    None
}

fn match_generic_decl(trimmed: &str, in_container: bool) -> Option<CandidateDecl> {
    if let Some(rest) = strip_keyword(trimmed, "class") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Class,
            body_container: Some(name.to_string()),
        });
    }
    if let Some(rest) = strip_keyword(trimmed, "struct") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Struct,
            body_container: Some(name.to_string()),
        });
    }
    if let Some(rest) = strip_keyword(trimmed, "interface") {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: SymbolKind::Interface,
            body_container: None,
        });
    }
    if let Some(rest) = strip_keyword(trimmed, "function")
        .or_else(|| strip_keyword(trimmed, "fn"))
        .or_else(|| strip_keyword(trimmed, "func"))
    {
        let name = extract_ident(rest)?;
        return Some(CandidateDecl {
            name: name.to_string(),
            kind: if in_container {
                SymbolKind::Method
            } else {
                SymbolKind::Function
            },
            body_container: None,
        });
    }
    None
}

fn is_control_flow_keyword(name: &str) -> bool {
    matches!(
        name,
        "if" | "else"
            | "for"
            | "foreach"
            | "while"
            | "do"
            | "switch"
            | "case"
            | "catch"
            | "try"
            | "finally"
            | "with"
            | "using"
            | "lock"
            | "return"
            | "throw"
            | "new"
            | "typeof"
            | "sizeof"
            | "await"
            | "yield"
            | "delete"
            | "super"
            | "this"
    )
}

fn leading_indent(line: &str) -> usize {
    let mut width = 0;
    for ch in line.chars() {
        match ch {
            ' ' => width += 1,
            '\t' => width += 4,
            _ => break,
        }
    }
    width
}

fn compute_python_multiline_mask(lines: &[&str]) -> Vec<bool> {
    let mut starts_in_str = Vec::with_capacity(lines.len());
    let mut delim: Option<&[u8; 3]> = None;

    for &line in lines {
        starts_in_str.push(delim.is_some());
        let bytes = line.as_bytes();
        let len = bytes.len();
        let mut i = 0;

        while i < len {
            if let Some(d) = delim {
                if bytes[i] == b'\\' && i + 1 < len {
                    i += 2;
                } else if i + 3 <= len && &bytes[i..i + 3] == d {
                    delim = None;
                    i += 3;
                } else {
                    i += 1;
                }
            } else {
                match bytes[i] {
                    b'#' => break,
                    b'"' if i + 3 <= len && &bytes[i..i + 3] == b"\"\"\"" => {
                        delim = Some(b"\"\"\"");
                        i += 3;
                    }
                    b'\'' if i + 3 <= len && &bytes[i..i + 3] == b"'''" => {
                        delim = Some(b"'''");
                        i += 3;
                    }
                    b'"' | b'\'' => {
                        let q = bytes[i];
                        i += 1;
                        while i < len {
                            if bytes[i] == b'\\' && i + 1 < len {
                                i += 2;
                            } else if bytes[i] == q {
                                i += 1;
                                break;
                            } else {
                                i += 1;
                            }
                        }
                    }
                    _ => i += 1,
                }
            }
        }
    }

    starts_in_str
}

fn parse_python(lines: &[&str]) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let in_triple = compute_python_multiline_mask(lines);

    let mut imp_start: Option<usize> = None;
    let mut imp_end: usize = 0;
    let mut imp_count: usize = 0;

    let mut i = 0;
    while i < lines.len() {
        let trim = lines[i].trim();
        if trim.is_empty()
            || trim.starts_with('#')
            || in_triple[i]
            || trim.starts_with("\"\"\"")
            || trim.starts_with("'''")
        {
            i += 1;
            continue;
        }
        if trim.starts_with("import ") || trim.starts_with("from ") {
            let start = i;
            let mut end = i;
            let mut paren = count_py_parens(lines[i]);
            while paren > 0 && end + 1 < lines.len() {
                end += 1;
                paren += count_py_parens(lines[end]);
            }
            if imp_start.is_none() {
                imp_start = Some(start + 1);
            }
            imp_end = end + 1;
            imp_count += end - start + 1;
            i = end + 1;
            continue;
        }
        break;
    }

    let imports = match imp_start {
        Some(s) => vec![ImportSpan {
            start_line: s,
            end_line: imp_end,
            line_count: imp_count,
        }],
        None => Vec::new(),
    };

    let mut symbols: Vec<OutlineSymbol> = Vec::new();
    let mut class_stack: Vec<(String, usize, usize, usize)> = Vec::new(); // (name, class_indent, header_end_idx, end_idx)

    for idx in 0..lines.len() {
        while class_stack.last().is_some_and(|c| idx > c.3) {
            class_stack.pop();
        }

        if in_triple[idx] {
            continue;
        }
        let line = lines[idx];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let indent = leading_indent(line);
        let active_class = class_stack.last().filter(|c| indent > c.1);

        let is_top = indent == 0;
        let in_class = active_class.is_some();
        if !is_top && !in_class {
            continue;
        }
        // Skip nested functions inside methods (indent deeper than class's first child method).
        if let Some(last_sym) = symbols.last() {
            if matches!(last_sym.kind, SymbolKind::Function | SymbolKind::Method)
                && idx + 1 <= last_sym.end_line
            {
                continue;
            }
        }

        let parsed = if let Some(rest) = strip_keyword(trimmed, "class") {
            extract_ident(rest).map(|n| (n.to_string(), SymbolKind::Class))
        } else {
            let fn_s = strip_keyword(trimmed, "async").unwrap_or(trimmed);
            strip_keyword(fn_s, "def")
                .and_then(extract_ident)
                .map(|n| {
                    (
                        n.to_string(),
                        if in_class {
                            SymbolKind::Method
                        } else {
                            SymbolKind::Function
                        },
                    )
                })
        };

        if let Some((name, kind)) = parsed {
            let header_end = find_py_header_end(lines, idx);
            let end_idx = find_py_block_end(lines, &in_triple, header_end, indent);
            let prev_boundary = symbols
                .iter()
                .rev()
                .find(|s| s.end_line <= idx)
                .map(|s| s.end_line)
                .unwrap_or(0);
            let class_boundary = class_stack.last().map(|c| c.2 + 1).unwrap_or(0);
            let doc_start = find_py_doc_start(lines, idx, indent, prev_boundary.max(class_boundary));
            let sig = build_py_signature(lines, idx, header_end);
            let container = active_class.map(|c| c.0.clone());

            symbols.push(OutlineSymbol {
                name: name.clone(),
                container,
                kind,
                start_line: idx + 1,
                end_line: end_idx + 1,
                doc_start_line: doc_start + 1,
                signature: sig,
            });

            if kind == SymbolKind::Class && end_idx > idx {
                class_stack.push((name, indent, header_end, end_idx));
            }
        }
    }

    (imports, symbols)
}

fn count_py_parens(line: &str) -> i32 {
    let mut delta = 0i32;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'#' => break,
            b'"' | b'\'' => {
                let q = bytes[i];
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        i += 2;
                    } else if bytes[i] == q {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            b'(' | b'[' | b'{' => {
                delta += 1;
                i += 1;
            }
            b')' | b']' | b'}' => {
                delta -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    delta
}

fn find_py_header_end(lines: &[&str], start_idx: usize) -> usize {
    let mut paren = 0i32;
    for j in start_idx..lines.len().min(start_idx + 20) {
        paren += count_py_parens(lines[j]);
        let code_part = strip_py_inline_comment(lines[j]).trim_end();
        if paren <= 0 && code_part.ends_with(':') {
            return j;
        }
    }
    start_idx
}

fn strip_py_inline_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'#' => return &line[..i],
            b'"' | b'\'' => {
                let q = bytes[i];
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        i += 2;
                    } else if bytes[i] == q {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            _ => i += 1,
        }
    }
    line
}

fn find_py_block_end(
    lines: &[&str],
    in_triple: &[bool],
    header_end: usize,
    base_indent: usize,
) -> usize {
    // Check for inline body on the header line (e.g. `def foo(): return 1`).
    let header_code = strip_py_inline_comment(lines[header_end]).trim_end();
    if !header_code.ends_with(':') {
        return header_end;
    }

    let mut last_body_idx = header_end;
    for j in (header_end + 1)..lines.len() {
        if in_triple[j] {
            last_body_idx = j;
            continue;
        }
        let trimmed = lines[j].trim();
        if trimmed.is_empty() {
            continue;
        }
        let ind = leading_indent(lines[j]);
        if trimmed.starts_with('#') {
            if ind > base_indent {
                last_body_idx = j;
                continue;
            } else {
                // Comment at outer/same indent likely documents the next declaration.
                break;
            }
        }
        if ind <= base_indent {
            break;
        }
        last_body_idx = j;
    }

    last_body_idx
}

fn find_py_doc_start(lines: &[&str], start_idx: usize, indent: usize, prev_end_line: usize) -> usize {
    let min_idx = prev_end_line;
    let mut doc_idx = start_idx;
    while doc_idx > min_idx {
        let prev = lines[doc_idx - 1];
        let trimmed = prev.trim();
        if trimmed.is_empty() {
            break;
        }
        let prev_indent = leading_indent(prev);
        if prev_indent == indent && (trimmed.starts_with('@') || trimmed.starts_with('#')) {
            doc_idx -= 1;
            continue;
        }
        break;
    }
    doc_idx
}

fn build_py_signature(lines: &[&str], start_idx: usize, header_end: usize) -> String {
    let mut parts = Vec::new();
    for line in &lines[start_idx..=header_end] {
        let code = strip_py_inline_comment(line).trim();
        if !code.is_empty() {
            parts.push(code);
        }
    }
    let joined = collapse_whitespace(&parts.join(" "));
    let cleaned = joined.trim_end_matches(':').trim().to_string();
    truncate_signature(cleaned)
}

fn parse_ruby(lines: &[&str]) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let mut imp_start: Option<usize> = None;
    let mut imp_end: usize = 0;
    let mut imp_count: usize = 0;

    for (i, line) in lines.iter().enumerate() {
        let trim = line.trim();
        if trim.is_empty() || trim.starts_with('#') {
            continue;
        }
        if trim.starts_with("require ") || trim.starts_with("require_relative ") {
            if imp_start.is_none() {
                imp_start = Some(i + 1);
            }
            imp_end = i + 1;
            imp_count += 1;
            continue;
        }
        break;
    }

    let imports = match imp_start {
        Some(s) => vec![ImportSpan {
            start_line: s,
            end_line: imp_end,
            line_count: imp_count,
        }],
        None => Vec::new(),
    };

    let mut symbols: Vec<OutlineSymbol> = Vec::new();
    let mut containers: Vec<(String, usize, usize, usize)> = Vec::new(); // (name, indent, header_idx, end_idx)

    for idx in 0..lines.len() {
        while containers.last().is_some_and(|c| idx > c.3) {
            containers.pop();
        }
        let line = lines[idx];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = leading_indent(line);
        let active_container = containers.last().filter(|c| indent > c.1);

        let parsed = if let Some(rest) = strip_keyword(trimmed, "class") {
            extract_ident(rest).map(|n| (n.to_string(), SymbolKind::Class))
        } else if let Some(rest) = strip_keyword(trimmed, "module") {
            extract_ident(rest).map(|n| (n.to_string(), SymbolKind::Mod))
        } else if let Some(rest) = strip_keyword(trimmed, "def") {
            let rest = rest.strip_prefix("self.").unwrap_or(rest);
            extract_ident(rest).map(|n| {
                (
                    n.to_string(),
                    if active_container.is_some() {
                        SymbolKind::Method
                    } else {
                        SymbolKind::Function
                    },
                )
            })
        } else {
            None
        };

        if let Some((name, kind)) = parsed {
            let end_idx = find_ruby_block_end(lines, idx, indent);
            let prev_boundary = symbols
                .iter()
                .rev()
                .find(|s| s.end_line <= idx)
                .map(|s| s.end_line)
                .unwrap_or(0);
            let container_boundary = containers.last().map(|c| c.2 + 1).unwrap_or(0);
            let doc_start =
                find_py_doc_start(lines, idx, indent, prev_boundary.max(container_boundary));
            let sig = truncate_signature(collapse_whitespace(trimmed));
            let container = active_container.map(|c| c.0.clone());

            symbols.push(OutlineSymbol {
                name: name.clone(),
                container,
                kind,
                start_line: idx + 1,
                end_line: end_idx + 1,
                doc_start_line: doc_start + 1,
                signature: sig,
            });

            if matches!(kind, SymbolKind::Class | SymbolKind::Mod) && end_idx > idx {
                containers.push((name, indent, idx, end_idx));
            }
        }
    }

    (imports, symbols)
}

fn find_ruby_block_end(lines: &[&str], start_idx: usize, base_indent: usize) -> usize {
    let trimmed_start = lines[start_idx].trim();
    if trimmed_start.ends_with("; end") || trimmed_start.contains(" = ") {
        return start_idx;
    }

    for (j, line) in lines.iter().enumerate().skip(start_idx + 1) {
        let trim = line.trim();
        if trim == "end" && leading_indent(line) == base_indent {
            return j;
        }
    }
    start_idx
}

fn truncate_outline_sig(raw: &str) -> String {
    let clean = raw.trim();
    if clean.chars().count() <= MAX_SIGNATURE_CHARS {
        return clean.to_string();
    }
    let prefix: String = clean.chars().take(MAX_SIGNATURE_CHARS - 3).collect();
    format!("{prefix}...")
}

/// Fenced-code-aware Markdown heading scanner (`#`..`######`) with section line spans.
fn parse_markdown(lines: &[&str]) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let mut headings: Vec<(usize, usize, String)> = Vec::new(); // (line_no, level, title)
    let mut in_fence: Option<(char, usize)> = None;

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if let Some((fence_ch, fence_len)) = in_fence {
            let run = trimmed.chars().take_while(|&c| c == fence_ch).count();
            if run >= fence_len && trimmed[run..].trim().is_empty() {
                in_fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let fence_ch = trimmed.chars().next().unwrap();
            let fence_len = trimmed.chars().take_while(|&c| c == fence_ch).count();
            in_fence = Some((fence_ch, fence_len));
            continue;
        }

        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|&c| c == '#').count();
            if (1..=6).contains(&level) {
                let rest = &trimmed[level..];
                if rest.starts_with(' ') || rest.starts_with('\t') {
                    let title = rest.trim().trim_end_matches('#').trim();
                    if !title.is_empty() {
                        headings.push((idx + 1, level, title.to_string()));
                    }
                }
            }
        }
    }

    let total_lines = lines.len().max(1);
    let mut symbols = Vec::with_capacity(headings.len());
    for i in 0..headings.len() {
        let (start_line, level, ref title) = headings[i];
        let mut end_line = total_lines;
        for &(next_line, next_level, _) in &headings[(i + 1)..] {
            if next_level <= level {
                end_line = next_line.saturating_sub(1).max(start_line);
                break;
            }
        }
        let hashes = "#".repeat(level);
        symbols.push(OutlineSymbol {
            name: title.clone(),
            container: None,
            kind: SymbolKind::Mod,
            start_line,
            end_line,
            doc_start_line: start_line,
            signature: truncate_outline_sig(&format!("{hashes} {title}")),
        });
    }

    (Vec::new(), symbols)
}

/// Top-level and 2nd-level JSON/JSONC key outline scanner.
fn parse_json(lines: &[&str]) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let mut symbols: Vec<OutlineSymbol> = Vec::new();
    let mut depth: i32 = 0;
    let mut open_stack: Vec<(usize, i32)> = Vec::new(); // (symbol_idx, depth_at_key)
    let mut current_top_key: Option<String> = None;

    for (idx, line) in lines.iter().enumerate() {
        let line_no = idx + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }

        let depth_before = depth;

        if (depth_before == 1 || depth_before == 2) && trimmed.starts_with('"') {
            if let Some(close_quote) = trimmed[1..].find('"') {
                let key = &trimmed[1..1 + close_quote];
                let after_key = trimmed[2 + close_quote..].trim_start();
                if let Some(val_part) = after_key.strip_prefix(':') {
                    let val_trim = val_part.trim();
                    let container = if depth_before == 2 {
                        current_top_key.clone()
                    } else {
                        None
                    };
                    if depth_before == 1 {
                        current_top_key = Some(key.to_string());
                    }
                    let sig = if val_trim.starts_with('{') {
                        format!("\"{key}\": {{...}}")
                    } else if val_trim.starts_with('[') {
                        format!("\"{key}\": [...]")
                    } else {
                        format!("\"{key}\": {}", val_trim.trim_end_matches(','))
                    };
                    let sym_idx = symbols.len();
                    symbols.push(OutlineSymbol {
                        name: key.to_string(),
                        container,
                        kind: SymbolKind::Const,
                        start_line: line_no,
                        end_line: line_no,
                        doc_start_line: line_no,
                        signature: truncate_outline_sig(&sig),
                    });
                    if val_trim.ends_with('{') || val_trim.ends_with('[') {
                        open_stack.push((sym_idx, depth_before));
                    }
                }
            }
        }

        let mut in_str = false;
        let mut escape = false;
        for ch in trimmed.chars() {
            if in_str {
                if escape {
                    escape = false;
                } else if ch == '\\' {
                    escape = true;
                } else if ch == '"' {
                    in_str = false;
                }
                continue;
            }
            match ch {
                '"' => in_str = true,
                '{' | '[' => depth += 1,
                '}' | ']' => {
                    depth = (depth - 1).max(0);
                    while let Some(&(sym_idx, target_depth)) = open_stack.last() {
                        if depth <= target_depth {
                            symbols[sym_idx].end_line = line_no;
                            open_stack.pop();
                            if target_depth == 1 {
                                current_top_key = None;
                            }
                        } else {
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    (Vec::new(), symbols)
}

/// Indentation-based YAML key scanner (top-level & 1st-nested mapping keys).
fn parse_yaml(lines: &[&str]) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let mut raw_keys: Vec<(usize, usize, String, String, Option<String>)> = Vec::new();
    let mut block_scalar_indent: Option<usize> = None;
    let mut current_top: Option<String> = None;

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "---" || trimmed == "..." {
            continue;
        }
        let indent = leading_indent(line);
        if let Some(bs_indent) = block_scalar_indent {
            if indent > bs_indent {
                continue;
            }
            block_scalar_indent = None;
        }
        if trimmed.starts_with("- ") || trimmed == "-" {
            continue;
        }

        if let Some(colon_pos) = trimmed.find(':') {
            let key_raw = trimmed[..colon_pos].trim();
            let after_colon = trimmed[colon_pos + 1..].trim();
            let valid_key = !key_raw.is_empty()
                && !key_raw.contains(' ')
                && (after_colon.is_empty()
                    || trimmed.as_bytes().get(colon_pos + 1).is_some_and(|&b| b == b' ' || b == b'\t'));
            if valid_key {
                let key = key_raw.trim_matches('"').trim_matches('\'').to_string();
                if indent == 0 {
                    current_top = Some(key.clone());
                    raw_keys.push((idx + 1, indent, key, trimmed.to_string(), None));
                } else if indent <= 4 && current_top.is_some() {
                    raw_keys.push((idx + 1, indent, key, trimmed.to_string(), current_top.clone()));
                }
                if after_colon.starts_with('|') || after_colon.starts_with('>') {
                    block_scalar_indent = Some(indent);
                }
            }
        }
    }

    let total_lines = lines.len().max(1);
    let mut symbols = Vec::with_capacity(raw_keys.len());
    for i in 0..raw_keys.len() {
        let (start_line, indent, ref key, ref sig, ref container) = raw_keys[i];
        let mut end_line = total_lines;
        for &(next_line, next_indent, _, _, _) in &raw_keys[(i + 1)..] {
            if next_indent <= indent {
                end_line = next_line.saturating_sub(1).max(start_line);
                break;
            }
        }
        symbols.push(OutlineSymbol {
            name: key.clone(),
            container: container.clone(),
            kind: SymbolKind::Const,
            start_line,
            end_line,
            doc_start_line: start_line,
            signature: truncate_outline_sig(sig),
        });
    }

    (Vec::new(), symbols)
}

/// Comment-aware CSS/SCSS/Less rule & at-rule scanner.
fn parse_css(lines: &[&str]) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let mut symbols: Vec<OutlineSymbol> = Vec::new();
    let mut in_block_comment = false;
    let mut brace_depth: i32 = 0;
    let mut open_stack: Vec<(usize, i32)> = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let line_no = idx + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut clean = String::with_capacity(trimmed.len());
        let bytes = trimmed.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if in_block_comment {
                if i + 1 < bytes.len() && bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    in_block_comment = false;
                    i += 2;
                } else {
                    i += 1;
                }
            } else if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
                in_block_comment = true;
                i += 2;
            } else if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'/' {
                break;
            } else {
                clean.push(bytes[i] as char);
                i += 1;
            }
        }

        let clean_trim = clean.trim();
        if clean_trim.is_empty() {
            continue;
        }

        let depth_before = brace_depth;
        if let Some(open_pos) = clean_trim.find('{') {
            let selector = clean_trim[..open_pos].trim();
            if !selector.is_empty() && depth_before <= 1 {
                let kind = if selector.starts_with('@') {
                    SymbolKind::Mod
                } else {
                    SymbolKind::Class
                };
                let sym_idx = symbols.len();
                symbols.push(OutlineSymbol {
                    name: selector.to_string(),
                    container: None,
                    kind,
                    start_line: line_no,
                    end_line: line_no,
                    doc_start_line: line_no,
                    signature: truncate_outline_sig(selector),
                });
                open_stack.push((sym_idx, depth_before));
            }
        }

        for ch in clean_trim.chars() {
            match ch {
                '{' => brace_depth += 1,
                '}' => {
                    brace_depth = (brace_depth - 1).max(0);
                    while let Some(&(sym_idx, target_depth)) = open_stack.last() {
                        if brace_depth <= target_depth {
                            symbols[sym_idx].end_line = line_no;
                            open_stack.pop();
                        } else {
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    (Vec::new(), symbols)
}

/// HTML / Vue / Svelte SFC structural outline scanner.
/// Surfaces `<template>`, `<script>`, `<style>`, landmark tags, `id="..."` elements,
/// and delegates `<script>` bodies to the TypeScript/JS scanner.
fn parse_html(lines: &[&str]) -> (Vec<ImportSpan>, Vec<OutlineSymbol>) {
    let mut symbols: Vec<OutlineSymbol> = Vec::new();
    let mut imports: Vec<ImportSpan> = Vec::new();
    let mut i = 0usize;

    'lines: while i < lines.len() {
        let trimmed = lines[i].trim();
        let lower = trimmed.to_ascii_lowercase();

        for tag in ["script", "style", "template"] {
            let prefix_open = format!("<{tag}");
            if lower.starts_with(&prefix_open)
                && lower
                    .as_bytes()
                    .get(prefix_open.len())
                    .is_some_and(|&b| b == b'>' || b == b' ' || b == b'\t')
            {
                let start_line = i + 1;
                let close_tag = format!("</{tag}>");
                let mut end_idx = i;
                if !lower.contains(&close_tag) {
                    for (j, cand) in lines.iter().enumerate().skip(i + 1) {
                        if cand.to_ascii_lowercase().contains(&close_tag) {
                            end_idx = j;
                            break;
                        }
                    }
                }
                symbols.push(OutlineSymbol {
                    name: format!("<{tag}>"),
                    container: None,
                    kind: SymbolKind::Mod,
                    start_line,
                    end_line: end_idx + 1,
                    doc_start_line: start_line,
                    signature: truncate_outline_sig(trimmed),
                });

                if tag == "script" && end_idx > i + 1 {
                    let body_slice = &lines[i + 1..end_idx];
                    let (mut script_imports, mut script_syms) =
                        parse_brace_language(body_slice, Lang::TypeScript);
                    let line_shift = i + 1;
                    for imp in &mut script_imports {
                        imp.start_line += line_shift;
                        imp.end_line += line_shift;
                    }
                    for sym in &mut script_syms {
                        sym.start_line += line_shift;
                        sym.end_line += line_shift;
                        sym.doc_start_line += line_shift;
                        if sym.container.is_none() {
                            sym.container = Some("script".to_string());
                        }
                    }
                    imports.extend(script_imports);
                    symbols.extend(script_syms);
                }

                i = end_idx + 1;
                continue 'lines;
            }
        }

        if trimmed.starts_with('<') && !trimmed.starts_with("</") && !trimmed.starts_with("<!") {
            let tag_end = trimmed[1..]
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                .map(|p| p + 1)
                .unwrap_or(trimmed.len());
            let tag_name = trimmed[1..tag_end].to_ascii_lowercase();
            let is_landmark = matches!(
                tag_name.as_str(),
                "head" | "body" | "header" | "nav" | "main" | "section" | "article" | "footer" | "form"
            );
            let id_attr = extract_html_id_attr(trimmed);
            if is_landmark || id_attr.is_some() {
                let name = match id_attr {
                    Some(id_val) => format!("{tag_name}#{id_val}"),
                    None => tag_name,
                };
                symbols.push(OutlineSymbol {
                    name,
                    container: None,
                    kind: SymbolKind::Class,
                    start_line: i + 1,
                    end_line: i + 1,
                    doc_start_line: i + 1,
                    signature: truncate_outline_sig(trimmed),
                });
            }
        }

        i += 1;
    }

    (imports, symbols)
}

fn extract_html_id_attr(tag_line: &str) -> Option<String> {
    let lower = tag_line.to_ascii_lowercase();
    let idx = lower.find("id=")?;
    let rest = &tag_line[idx + 3..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let inner = &rest[1..];
    let end = inner.find(quote)?;
    let val = inner[..end].trim();
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_typescript_outline_and_symbols() {
        let src = r#"import fs from 'node:fs'
import type {
  Foo,
  Bar,
} from './types'

/** Summary interface */
export interface SessionSummary {
  id: string
  tokens: number
}

export class SessionManager {
  private readonly map = new Map<string, number>()

  /**
   * Look up or create a session.
   */
  async getOrCreate(
    sessionId: string,
  ): Promise<{ id: string; fresh: boolean }> {
    const re = /^[a-z]{2,4}$/
    if (re.test(sessionId)) {
      return { id: sessionId, fresh: true }
    }
    return { id: 'default', fresh: false }
  }

  pruneExpired(): number {
    return 0
  }
}

export const helper = (x: number): number => {
  return x + 1
}
"#;

        let outline = extract_outline("session.ts", src);
        assert_eq!(outline.imports.len(), 1);
        assert_eq!(outline.imports[0].start_line, 1);
        assert_eq!(outline.imports[0].end_line, 5);
        assert_eq!(outline.symbols.len(), 5);

        assert_eq!(outline.symbols[0].name, "SessionSummary");
        assert_eq!(outline.symbols[0].doc_start_line, 7);
        assert_eq!(outline.symbols[0].start_line, 8);
        assert_eq!(outline.symbols[0].end_line, 11);

        assert_eq!(outline.symbols[1].name, "SessionManager");
        assert_eq!(outline.symbols[1].start_line, 13);
        assert_eq!(outline.symbols[1].end_line, 32);

        assert_eq!(outline.symbols[2].name, "getOrCreate");
        assert_eq!(outline.symbols[2].container.as_deref(), Some("SessionManager"));
        assert_eq!(outline.symbols[2].doc_start_line, 16);
        assert_eq!(outline.symbols[2].start_line, 19);
        assert_eq!(outline.symbols[2].end_line, 27);

        let sym = extract_symbol("session.ts", src, "SessionManager.getOrCreate", 250)
            .expect("should find qualified TS method");
        assert_eq!(sym.offset, 16);
        assert_eq!(sym.returned_lines, 12);
        assert!(sym.eof);
        assert!(sym.content.contains("16|  /**"));
        assert!(sym.content.contains("27|  }"));
    }

    #[test]
    fn extracts_rust_impl_methods_lifetimes_and_raw_strings() {
        let src = r##"use std::fmt;
use std::collections::{
    BTreeMap,
    BTreeSet,
};

/// State container.
#[derive(Debug)]
pub struct SessionState<'a> {
    name: &'a str,
}

impl<'a> SessionState<'a> {
    /// Relinks RAM base safely.
    #[must_use]
    pub fn relink_ram_base(&mut self, new_base: u64) -> &'a str {
        let raw = r#"not a brace { or } inside raw string"#;
        let ch = '}';
        let _ = (raw, ch, new_base);
        self.name
    }
}
"##;

        let outline = extract_outline("runtime.rs", src);
        assert_eq!(outline.imports.len(), 1);
        assert_eq!(outline.imports[0].start_line, 1);
        assert_eq!(outline.imports[0].end_line, 5);

        let sym = extract_symbol("runtime.rs", src, "SessionState::relink_ram_base", 250)
            .expect("should find Rust qualified method");
        assert_eq!(sym.offset, 14);
        assert!(sym.content.contains("14|    /// Relinks RAM base safely."));
        assert!(sym.content.contains("15|    #[must_use]"));
        assert!(sym.content.contains("21|    }"));

        // Missing symbol returns actionable suggestions.
        let err = extract_symbol("runtime.rs", src, "nonexistent", 250).unwrap_err();
        assert!(err.contains(&"SessionState".to_string()));
        assert!(err.contains(&"SessionState<'a>::relink_ram_base".to_string()));
    }

    #[test]
    fn preserves_rust_impl_target_types_and_avoids_collisions() {
        let src = r#"pub trait DiscSource {
    fn len(&self) -> u64;
}

pub struct T;

impl T {
    pub fn len(&self) -> u64 {
        101
    }
}

impl<T: DiscSource + ?Sized> DiscSource for &mut T {
    fn len(&self) -> u64 {
        202
    }
}

impl<T: DiscSource + ?Sized> DiscSource for Box<T> {
    fn len(&self) -> u64 {
        303
    }
}

pub struct RawPatchDiscSource<S>(S);

impl<S: DiscSource> DiscSource for RawPatchDiscSource<S> {
    fn len(&self) -> u64 {
        404
    }
}

pub struct A;
pub struct B;
pub struct Box<X>(X);

impl Box<A> {
    pub fn new(a: A) -> Self {
        Self(a)
    }

    pub fn only_a(&self) {}
}

impl Box<B> {
    pub fn new(b: B) -> Self {
        Self(b)
    }
}
"#;

        let outline = extract_outline("disc.rs", src);
        let containers: Vec<(&str, Option<&str>)> = outline
            .symbols
            .iter()
            .map(|s| (s.name.as_str(), s.container.as_deref()))
            .collect();
        assert!(containers.contains(&("len", Some("T"))));
        assert!(containers.contains(&("len", Some("&mut T"))));
        assert!(containers.contains(&("len", Some("Box<T>"))));
        assert!(containers.contains(&("len", Some("RawPatchDiscSource<S>"))));
        assert!(containers.contains(&("new", Some("Box<A>"))));
        assert!(containers.contains(&("new", Some("Box<B>"))));

        // `T::len` must resolve ONLY to `impl T`, NOT `&mut T::len`.
        let t_len = extract_symbol("disc.rs", src, "T::len", 250)
            .expect("should resolve T::len without &mut T collision");
        assert!(t_len.content.contains("101"));
        assert!(!t_len.content.contains("202"));

        // `&mut T::len` resolves to the `&mut T` impl block.
        let mut_t_len = extract_symbol("disc.rs", src, "&mut T::len", 250)
            .expect("should resolve &mut T::len");
        assert!(mut_t_len.content.contains("202"));
        assert!(!mut_t_len.content.contains("101"));

        // `Box<T>::len` and `RawPatchDiscSource<S>::len` resolve to exact generic impls.
        let box_t_len = extract_symbol("disc.rs", src, "Box<T>::len", 250)
            .expect("should resolve Box<T>::len");
        assert!(box_t_len.content.contains("303"));
        assert!(!box_t_len.content.contains("404"));

        let raw_s_len = extract_symbol("disc.rs", src, "RawPatchDiscSource<S>::len", 250)
            .expect("should resolve RawPatchDiscSource<S>::len");
        assert!(raw_s_len.content.contains("404"));

        // Short base-type lookup works when unambiguous (`RawPatchDiscSource::len`, `Box::only_a`).
        let raw_base_len = extract_symbol("disc.rs", src, "RawPatchDiscSource::len", 250)
            .expect("should resolve unambiguous short base-type RawPatchDiscSource::len");
        assert!(raw_base_len.content.contains("404"));

        let box_only_a = extract_symbol("disc.rs", src, "Box::only_a", 250)
            .expect("should resolve unambiguous Box::only_a");
        assert!(box_only_a.content.contains("only_a"));

        // `impl Box<A>` vs `impl Box<B>` are disambiguated by exact generic args,
        // while ambiguous `Box::new` returns suggestions instead of colliding.
        let box_a_new = extract_symbol("disc.rs", src, "Box<A>::new", 250)
            .expect("should resolve Box<A>::new");
        assert!(box_a_new.content.contains("Self(a)"));
        assert!(!box_a_new.content.contains("Self(b)"));

        let box_b_new = extract_symbol("disc.rs", src, "Box<B>::new", 250)
            .expect("should resolve Box<B>::new");
        assert!(box_b_new.content.contains("Self(b)"));
        assert!(!box_b_new.content.contains("Self(a)"));

        let err_ambig = extract_symbol("disc.rs", src, "Box::new", 250)
            .expect_err("ambiguous Box::new should not collide");
        assert!(err_ambig.contains(&"Box<A>::new".to_string()));
        assert!(err_ambig.contains(&"Box<B>::new".to_string()));
    }

    #[test]
    fn extracts_python_classes_and_methods() {
        let src = r#"import os
from typing import (
    List,
    Optional,
)

class Engine:
    # Build summary
    @staticmethod
    def build(
        items: List[str],
    ) -> Optional[str]:
        """Docstring with fake def inside:
        def not_a_func():
            pass
        """
        if items:
            return items[0]
        return None

def top_helper(x: int) -> int:
    return x * 2
"#;

        let outline = extract_outline("engine.py", src);
        assert_eq!(outline.imports.len(), 1);
        assert_eq!(outline.imports[0].start_line, 1);
        assert_eq!(outline.imports[0].end_line, 5);
        assert_eq!(outline.symbols.len(), 3);
        assert_eq!(outline.symbols[1].container.as_deref(), Some("Engine"));
        assert_eq!(outline.symbols[1].name, "build");
        assert_eq!(outline.symbols[1].doc_start_line, 8);
        assert_eq!(outline.symbols[1].end_line, 19);

        let sym = extract_symbol("engine.py", src, "Engine.build", 250)
            .expect("should find Python method");
        assert_eq!(sym.offset, 8);
        assert!(sym.content.contains("9|    @staticmethod"));
        assert!(sym.content.contains("19|        return None"));
    }

    #[test]
    fn extracts_multiple_same_name_methods_separated() {
        let src = r#"struct A;
struct B;

impl A {
    pub fn new() -> Self { Self }
}

impl B {
    pub fn new() -> Self { Self }
}
"#;
        let sym = extract_symbol("multi.rs", src, "new", 250).expect("should match both new()");
        assert!(sym.content.contains("\n---\n"));
        assert_eq!(sym.returned_lines, 2);
        assert!(sym.eof);
    }

    #[test]
    fn extracts_markdown_json_yaml_css_and_vue_outlines() {
        let md = "# Intro\nText\n```md\n# Fake Heading\n```\n## Details\nMore text\n";
        let md_out = extract_outline("README.md", md);
        assert_eq!(md_out.symbols.len(), 2);
        assert_eq!(md_out.symbols[0].name, "Intro");
        assert_eq!(md_out.symbols[1].name, "Details");

        let json = "{\n  \"name\": \"demo\",\n  \"scripts\": {\n    \"build\": \"tsc\"\n  }\n}\n";
        let json_out = extract_outline("package.json", json);
        assert!(json_out.symbols.iter().any(|s| s.name == "name"));
        assert!(json_out.symbols.iter().any(|s| s.name == "scripts"));
        assert!(json_out.symbols.iter().any(|s| s.name == "build" && s.container.as_deref() == Some("scripts")));

        let yaml = "server:\n  port: 8080\n  host: localhost\ndatabase:\n  url: sqlite://db\n";
        let yaml_out = extract_outline("config.yaml", yaml);
        assert!(yaml_out.symbols.iter().any(|s| s.name == "server"));
        assert!(yaml_out.symbols.iter().any(|s| s.name == "port" && s.container.as_deref() == Some("server")));

        let css = "/* comment */\n.card {\n  color: red;\n}\n@media (min-width: 600px) {\n  .card { width: 50%; }\n}\n";
        let css_out = extract_outline("styles.css", css);
        assert!(css_out.symbols.iter().any(|s| s.name == ".card"));
        assert!(css_out.symbols.iter().any(|s| s.name.starts_with("@media")));

        let vue = "<template>\n  <main id=\"app\">Hello</main>\n</template>\n<script setup lang=\"ts\">\nexport function greet(name: string) {\n  return name\n}\n</script>\n<style scoped>\n.btn { color: blue; }\n</style>\n";
        let vue_out = extract_outline("App.vue", vue);
        assert!(vue_out.symbols.iter().any(|s| s.name == "<template>"));
        assert!(vue_out.symbols.iter().any(|s| s.name == "<script>"));
        assert!(vue_out.symbols.iter().any(|s| s.name == "greet"));
        assert!(vue_out.symbols.iter().any(|s| s.name == "<style>"));
    }
}
