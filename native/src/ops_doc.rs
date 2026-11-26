use crate::protocol::{
    EffectState, FailureInfo, RetryPolicy, WorkerResult, json_escaped_len, truncate_to_json_budget,
};
use crate::security::{SecurityContext, path_to_display};
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;
use zip::ZipArchive;

const MAX_DOC_BYTES: u64 = 32 * 1024 * 1024;
const MAX_XML_UNCOMPRESSED: u64 = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocArgs {
    pub path: String,
    #[serde(default)]
    pub format: DocFormatArg,
    pub encoding: Option<String>,
    #[serde(default = "default_true")]
    pub header: bool,
    #[serde(default = "default_one")]
    pub offset: usize,
    pub limit: Option<usize>,
}

fn default_true() -> bool {
    true
}

fn default_one() -> usize {
    1
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocFormatArg {
    #[default]
    Auto,
    Table,
    Docx,
    Pdf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocResult {
    pub path: String,
    pub format: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
    pub total_units: usize,
    pub offset: usize,
    pub returned_units: usize,
    pub next_offset: Option<usize>,
    pub complete: bool,
    pub truncated: bool,
    pub content: String,
}

pub fn handle_read_doc(ctx: &SecurityContext, args: Value) -> WorkerResult<Value> {
    let parsed: ReadDocArgs = serde_json::from_value(args)
        .map_err(|e| FailureInfo::invalid_arg(format!("Invalid read_doc args: {e}")))?;

    if parsed.offset == 0 {
        return Err(FailureInfo::invalid_arg(
            "`offset` is 1-based and must be >= 1.",
        ));
    }

    let resolved = ctx.authorize_path(&parsed.path)?;
    let display = path_to_display(&resolved);

    let meta = fs::metadata(&resolved).map_err(|e| {
        FailureInfo::io_error(&format!("Failed to stat {display}"), &e, EffectState::None)
    })?;
    if meta.is_dir() {
        return Err(FailureInfo::custom(
            "IS_DIRECTORY",
            format!("Document path is a directory: {display}"),
            EffectState::None,
            RetryPolicy::AfterInputChange,
            "Provide a CSV, TSV, DOCX, or PDF file path.",
        ));
    }
    if meta.len() > MAX_DOC_BYTES {
        return Err(FailureInfo::custom(
            "FILE_TOO_LARGE",
            format!("Document size ({} bytes) exceeds 32 MiB limit.", meta.len()),
            EffectState::None,
            RetryPolicy::Never,
            "Split the document into smaller parts before reading.",
        ));
    }

    let format = resolve_format(parsed.format, &resolved)?;
    let raw = fs::read(&resolved).map_err(|e| {
        FailureInfo::io_error(&format!("Failed to read {display}"), &e, EffectState::None)
    })?;

    let ipc_budget = ctx.ipc_payload_budget().saturating_sub(512).max(512);
    let result = match format {
        ResolvedFormat::Table => read_table_doc(&display, &resolved, &raw, &parsed, ipc_budget)?,
        ResolvedFormat::Docx => read_docx_doc(&display, &raw, &parsed, ipc_budget)?,
        ResolvedFormat::Pdf => read_pdf_doc(&display, &raw, &parsed, ipc_budget)?,
    };

    serde_json::to_value(result)
        .map_err(|e| FailureInfo::invalid_arg(format!("Failed to serialize read_doc result: {e}")))
}

#[derive(Debug, Clone, Copy)]
enum ResolvedFormat {
    Table,
    Docx,
    Pdf,
}

fn resolve_format(requested: DocFormatArg, path: &Path) -> WorkerResult<ResolvedFormat> {
    match requested {
        DocFormatArg::Table => Ok(ResolvedFormat::Table),
        DocFormatArg::Docx => Ok(ResolvedFormat::Docx),
        DocFormatArg::Pdf => Ok(ResolvedFormat::Pdf),
        DocFormatArg::Auto => {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            match ext.as_str() {
                "csv" | "tsv" => Ok(ResolvedFormat::Table),
                "docx" => Ok(ResolvedFormat::Docx),
                "pdf" => Ok(ResolvedFormat::Pdf),
                _ => Err(FailureInfo::custom(
                    "UNSUPPORTED_DOCUMENT",
                    format!(
                        "Cannot auto-detect document format for extension `.{ext}`. Supported formats: .csv, .tsv, .docx, .pdf."
                    ),
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    "Specify `format` explicitly (\"table\", \"docx\", or \"pdf\") or use pulse_read_files for plain text.",
                )),
            }
        }
    }
}

fn decode_text_bytes(raw: &[u8], explicit_encoding: Option<&str>) -> WorkerResult<String> {
    let enc = explicit_encoding.map(|s| s.trim().to_ascii_lowercase());

    match enc.as_deref() {
        Some("utf-16le") => decode_utf16(raw, true),
        Some("utf-16be") => decode_utf16(raw, false),
        Some("utf-8") | None => {
            if enc.is_none() {
                if raw.starts_with(&[0xFF, 0xFE]) {
                    return decode_utf16(&raw[2..], true);
                }
                if raw.starts_with(&[0xFE, 0xFF]) {
                    return decode_utf16(&raw[2..], false);
                }
            }
            let stripped = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
            String::from_utf8(stripped.to_vec()).map_err(|_| {
                FailureInfo::custom(
                    "ERR_INVALID_ENCODING",
                    "Table file is not valid UTF-8. Try specifying encoding: \"utf-16le\" or \"utf-16be\".",
                    EffectState::None,
                    RetryPolicy::AfterInputChange,
                    "Retry with the appropriate encoding parameter.",
                )
            })
        }
        Some(other) => Err(FailureInfo::invalid_arg(format!(
            "Unsupported encoding `{other}`. Supported: utf-8, utf-16le, utf-16be."
        ))),
    }
}

fn decode_utf16(raw: &[u8], little_endian: bool) -> WorkerResult<String> {
    let payload = if little_endian && raw.starts_with(&[0xFF, 0xFE]) {
        &raw[2..]
    } else if !little_endian && raw.starts_with(&[0xFE, 0xFF]) {
        &raw[2..]
    } else {
        raw
    };

    if payload.len() % 2 != 0 {
        return Err(FailureInfo::custom(
            "ERR_INVALID_ENCODING",
            "UTF-16 byte stream has an odd byte length.",
            EffectState::None,
            RetryPolicy::AfterInputChange,
            "Verify file encoding before retrying.",
        ));
    }

    let units: Vec<u16> = payload
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();

    String::from_utf16(&units).map_err(|_| {
        FailureInfo::custom(
            "ERR_INVALID_ENCODING",
            "Failed to decode UTF-16 table content.",
            EffectState::None,
            RetryPolicy::AfterInputChange,
            "Verify whether the file is UTF-8, UTF-16LE, or UTF-16BE.",
        )
    })
}

fn sanitize_table_cell(cell: &str) -> String {
    cell.replace('\r', "")
        .replace('\n', " ")
        .replace('|', r"\|")
        .trim()
        .to_string()
}

fn read_table_doc(
    display: &str,
    path: &Path,
    raw: &[u8],
    args: &ReadDocArgs,
    max_content_bytes: usize,
) -> WorkerResult<ReadDocResult> {
    let text = decode_text_bytes(raw, args.encoding.as_deref())?;
    let is_tsv = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("tsv"));
    let delimiter = if is_tsv { b'\t' } else { b',' };

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(args.header)
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut columns: Vec<String> = if args.header {
        reader
            .headers()
            .map_err(|e| {
                FailureInfo::custom(
                    "PARSE_ERROR",
                    format!("Failed to parse CSV/TSV header: {e}"),
                    EffectState::None,
                    RetryPolicy::Never,
                    "Verify the file is a valid delimited table.",
                )
            })?
            .iter()
            .map(sanitize_table_cell)
            .collect()
    } else {
        Vec::new()
    };

    let offset = args.offset.max(1);
    let limit = args.limit.unwrap_or(100).clamp(1, 2_000);
    let start_idx = offset - 1;
    let end_idx = start_idx + limit;

    let mut total_units = 0usize;
    let mut rendered_rows = Vec::new();
    let header_line = if columns.is_empty() {
        String::new()
    } else {
        columns.join(" | ")
    };
    let mut used_json_bytes = if header_line.is_empty() {
        0
    } else {
        json_escaped_len(&header_line) + 2
    };
    let mut budget_truncated = false;

    for rec_res in reader.records() {
        let record = rec_res.map_err(|e| {
            FailureInfo::custom(
                "PARSE_ERROR",
                format!("CSV/TSV row parse error at row {}: {e}", total_units + 1),
                EffectState::None,
                RetryPolicy::Never,
                "Check the input file for malformed quoting.",
            )
        })?;

        if columns.is_empty() && !args.header {
            columns = (1..=record.len()).map(|i| format!("col_{i}")).collect();
            let auto_header = columns.join(" | ");
            used_json_bytes = json_escaped_len(&auto_header) + 2;
        }

        if total_units >= start_idx && total_units < end_idx && !budget_truncated {
            let cells: Vec<String> = record.iter().map(sanitize_table_cell).collect();
            let row_line = format!("{}|{}", total_units + 1, cells.join(" | "));
            let sep_cost = if rendered_rows.is_empty() { 0 } else { 2 };
            let row_cost = sep_cost + json_escaped_len(&row_line);
            if used_json_bytes + row_cost > max_content_bytes {
                if rendered_rows.is_empty() {
                    let avail = max_content_bytes.saturating_sub(used_json_bytes).max(128);
                    let (clipped, _) =
                        truncate_to_json_budget(&row_line, avail, "...[row truncated]");
                    rendered_rows.push(clipped);
                }
                budget_truncated = true;
            } else {
                used_json_bytes += row_cost;
                rendered_rows.push(row_line);
            }
        }
        total_units += 1;
    }

    let returned_units = rendered_rows.len();
    let next_offset = if start_idx + returned_units < total_units {
        Some(offset + returned_units)
    } else {
        None
    };

    let mut content = String::new();
    if !columns.is_empty() {
        content.push_str(&columns.join(" | "));
        if !rendered_rows.is_empty() {
            content.push('\n');
        }
    }
    content.push_str(&rendered_rows.join("\n"));

    Ok(ReadDocResult {
        path: display.to_string(),
        format: "table".to_string(),
        bytes: raw.len() as u64,
        columns: Some(columns),
        total_units,
        offset,
        returned_units,
        next_offset,
        complete: next_offset.is_none() && !budget_truncated,
        truncated: budget_truncated,
        content,
    })
}

fn read_docx_doc(
    display: &str,
    raw: &[u8],
    args: &ReadDocArgs,
    max_content_bytes: usize,
) -> WorkerResult<ReadDocResult> {
    let mut archive = ZipArchive::new(Cursor::new(raw)).map_err(|e| {
        FailureInfo::custom(
            "PARSE_ERROR",
            format!("Invalid DOCX ZIP archive: {e}"),
            EffectState::None,
            RetryPolicy::Never,
            "Ensure the target file is a valid .docx document.",
        )
    })?;

    // Reject macro-enabled documents before reading any XML content.
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| {
            FailureInfo::custom(
                "PARSE_ERROR",
                format!("Failed to inspect DOCX entry #{i}: {e}"),
                EffectState::None,
                RetryPolicy::Never,
                "Verify the DOCX archive integrity.",
            )
        })?;
        let lower = entry.name().replace('\\', "/").to_ascii_lowercase();
        if lower == "word/vbaproject.bin" || lower.ends_with("/vbaproject.bin") {
            return Err(FailureInfo::custom(
                "MACRO_DOCUMENT_BLOCKED",
                format!("Macro-enabled DOCX blocked (contains word/vbaProject.bin): {display}"),
                EffectState::None,
                RetryPolicy::Never,
                "Convert the document to a macro-free .docx before reading.",
            ));
        }
    }

    let doc_entry = archive.by_name("word/document.xml").map_err(|_| {
        FailureInfo::custom(
            "PARSE_ERROR",
            "DOCX archive is missing word/document.xml.",
            EffectState::None,
            RetryPolicy::Never,
            "Verify the file is a valid Word OpenXML (.docx) document.",
        )
    })?;

    let mut xml_bytes = Vec::new();
    doc_entry
        .take(MAX_XML_UNCOMPRESSED + 1)
        .read_to_end(&mut xml_bytes)
        .map_err(|e| {
            FailureInfo::io_error("Failed to decompress word/document.xml", &e, EffectState::None)
        })?;

    if xml_bytes.len() as u64 > MAX_XML_UNCOMPRESSED {
        return Err(FailureInfo::custom(
            "FILE_TOO_LARGE",
            "Uncompressed word/document.xml exceeds 32 MiB safety limit.",
            EffectState::None,
            RetryPolicy::Never,
            "Split the DOCX file before reading.",
        ));
    }

    let units = extract_docx_units(&xml_bytes)?;
    let total_units = units.len();
    let offset = args.offset.max(1);
    let limit = args.limit.unwrap_or(150).clamp(1, 2_000);
    let start_idx = (offset - 1).min(total_units);
    let end_idx = (start_idx + limit).min(total_units);

    let mut kept = Vec::with_capacity((end_idx - start_idx).min(256));
    let mut used_json_bytes = 0usize;
    let mut budget_truncated = false;
    for unit in &units[start_idx..end_idx] {
        let sep_cost = if kept.is_empty() { 0 } else { 2 };
        let cost = sep_cost + json_escaped_len(unit);
        if used_json_bytes + cost > max_content_bytes {
            if kept.is_empty() {
                let (clipped, _) =
                    truncate_to_json_budget(unit, max_content_bytes, "...[truncated]");
                kept.push(clipped);
            }
            budget_truncated = true;
            break;
        }
        used_json_bytes += cost;
        kept.push(unit.clone());
    }

    let returned_units = kept.len();
    let delivered_end = start_idx + returned_units;
    let next_offset = if delivered_end < total_units {
        Some(delivered_end + 1)
    } else {
        None
    };

    Ok(ReadDocResult {
        path: display.to_string(),
        format: "docx".to_string(),
        bytes: raw.len() as u64,
        columns: None,
        total_units,
        offset,
        returned_units,
        next_offset,
        complete: next_offset.is_none() && !budget_truncated,
        truncated: budget_truncated,
        content: kept.join("\n"),
    })
}

fn local_xml_name(raw: &[u8]) -> &[u8] {
    match raw.iter().rposition(|&b| b == b':') {
        Some(pos) => &raw[pos + 1..],
        None => raw,
    }
}

fn extract_docx_units(xml: &[u8]) -> WorkerResult<Vec<String>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);

    let mut units = Vec::new();
    let mut buf = Vec::new();

    let mut in_table_row = false;
    let mut in_table_cell = false;
    let mut in_paragraph = false;
    let mut in_text = false;

    let mut current_para = String::new();
    let mut current_cell_paras: Vec<String> = Vec::new();
    let mut current_row_cells: Vec<String> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let qname = e.name();
                let name = local_xml_name(qname.as_ref());
                match name {
                    b"tr" => {
                        in_table_row = true;
                        current_row_cells.clear();
                    }
                    b"tc" if in_table_row => {
                        in_table_cell = true;
                        current_cell_paras.clear();
                    }
                    b"p" => {
                        in_paragraph = true;
                        current_para.clear();
                    }
                    b"t" if in_paragraph => {
                        in_text = true;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let qname = e.name();
                let name = local_xml_name(qname.as_ref());
                if in_paragraph {
                    match name {
                        b"tab" => current_para.push('\t'),
                        b"br" | b"cr" => current_para.push('\n'),
                        _ => {}
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_text {
                    let unescaped = e.unescape().map_err(|err| {
                        FailureInfo::custom(
                            "PARSE_ERROR",
                            format!("Invalid XML text entity in DOCX: {err}"),
                            EffectState::None,
                            RetryPolicy::Never,
                            "Verify the DOCX document XML is well-formed.",
                        )
                    })?;
                    current_para.push_str(&unescaped);
                }
            }
            Ok(Event::End(e)) => {
                let qname = e.name();
                let name = local_xml_name(qname.as_ref());
                match name {
                    b"t" => {
                        in_text = false;
                    }
                    b"p" => {
                        in_paragraph = false;
                        let trimmed = current_para.trim();
                        if !trimmed.is_empty() {
                            if in_table_cell {
                                current_cell_paras.push(trimmed.to_string());
                            } else {
                                units.push(trimmed.to_string());
                            }
                        }
                        current_para.clear();
                    }
                    b"tc" if in_table_cell => {
                        in_table_cell = false;
                        let cell_text = current_cell_paras.join(" ");
                        current_row_cells.push(sanitize_table_cell(&cell_text));
                        current_cell_paras.clear();
                    }
                    b"tr" if in_table_row => {
                        in_table_row = false;
                        if current_row_cells.iter().any(|c| !c.is_empty()) {
                            units.push(current_row_cells.join(" | "));
                        }
                        current_row_cells.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => {
                return Err(FailureInfo::custom(
                    "PARSE_ERROR",
                    format!("XML parse error in DOCX: {err}"),
                    EffectState::None,
                    RetryPolicy::Never,
                    "Verify the DOCX file is not corrupted.",
                ));
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(units)
}

fn read_pdf_doc(
    display: &str,
    raw: &[u8],
    args: &ReadDocArgs,
    max_content_bytes: usize,
) -> WorkerResult<ReadDocResult> {
    let doc = lopdf::Document::load_mem(raw).map_err(|e| {
        FailureInfo::custom(
            "PARSE_ERROR",
            format!("Failed to parse PDF document: {e}"),
            EffectState::None,
            RetryPolicy::Never,
            "Ensure the file is a valid, unencrypted PDF document.",
        )
    })?;

    if doc.is_encrypted() {
        return Err(FailureInfo::custom(
            "UNSUPPORTED_DOCUMENT",
            "Encrypted PDF documents are not supported.",
            EffectState::None,
            RetryPolicy::Never,
            "Decrypt the PDF before reading.",
        ));
    }

    let pages = doc.get_pages();
    let page_numbers: Vec<u32> = pages.keys().copied().collect();
    let total_units = page_numbers.len();

    let offset = args.offset.max(1);
    let limit = args.limit.unwrap_or(10).clamp(1, 100);
    let start_idx = (offset - 1).min(total_units);
    let end_idx = (start_idx + limit).min(total_units);

    let mut sections = Vec::with_capacity(end_idx - start_idx);
    let mut used_json_bytes = 0usize;
    let mut budget_truncated = false;
    for &page_num in &page_numbers[start_idx..end_idx] {
        let extracted = doc
            .extract_text(&[page_num])
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| fallback_extract_pdf_page(&doc, pages[&page_num]));

        let cleaned = clean_pdf_page_text(&extracted);
        let section = format!("--- Page {page_num} ---\n{cleaned}");
        let sep_cost = if sections.is_empty() { 0 } else { 4 };
        let cost = sep_cost + json_escaped_len(&section);
        if used_json_bytes + cost > max_content_bytes {
            if sections.is_empty() {
                let (clipped, _) =
                    truncate_to_json_budget(&section, max_content_bytes, "\n...[page truncated]");
                sections.push(clipped);
            }
            budget_truncated = true;
            break;
        }
        used_json_bytes += cost;
        sections.push(section);
    }

    let returned_units = sections.len();
    let delivered_end = start_idx + returned_units;
    let next_offset = if delivered_end < total_units {
        Some(delivered_end + 1)
    } else {
        None
    };

    Ok(ReadDocResult {
        path: display.to_string(),
        format: "pdf".to_string(),
        bytes: raw.len() as u64,
        columns: None,
        total_units,
        offset,
        returned_units,
        next_offset,
        complete: next_offset.is_none() && !budget_truncated,
        truncated: budget_truncated,
        content: sections.join("\n\n"),
    })
}

/// Fallback extractor reading decoded content stream `Tj`/`TJ` operators directly when font maps are absent.
fn fallback_extract_pdf_page(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> String {
    let Ok(content_bytes) = doc.get_page_content(page_id) else {
        return String::new();
    };
    let Ok(content) = lopdf::content::Content::decode(&content_bytes) else {
        return String::new();
    };

    let mut out = String::new();
    for op in content.operations {
        match op.operator.as_str() {
            "Tj" | "'" | "\"" => {
                for operand in op.operands {
                    if let lopdf::Object::String(bytes, _) = operand {
                        append_pdf_string_bytes(&mut out, &bytes);
                    }
                }
            }
            "TJ" => {
                for operand in op.operands {
                    if let lopdf::Object::Array(items) = operand {
                        for item in items {
                            if let lopdf::Object::String(bytes, _) = item {
                                append_pdf_string_bytes(&mut out, &bytes);
                            }
                        }
                    }
                }
            }
            "T*" | "Td" | "TD" | "ET" => {
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
    out
}

fn append_pdf_string_bytes(out: &mut String, bytes: &[u8]) {
    if bytes.starts_with(&[0xFE, 0xFF]) && bytes.len() % 2 == 0 {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|p| u16::from_be_bytes([p[0], p[1]]))
            .collect();
        out.push_str(&String::from_utf16_lossy(&units));
    } else {
        for &b in bytes {
            if b == b'\t' || b == b'\n' || (0x20..=0x7E).contains(&b) {
                out.push(b as char);
            } else if b >= 0xA0 {
                out.push(b as char);
            }
        }
    }
}

fn clean_pdf_page_text(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_temp_dir(label: &str) -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "agy-pulse-doc-{label}-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_doc_table_honors_ipc_payload_budget() {
        let root = make_temp_dir("table-budget");
        let mut csv = String::from("id,payload\n");
        for i in 1..=300 {
            csv.push_str(&format!("{i},{}\n", "z".repeat(120)));
        }
        fs::write(root.join("big.csv"), &csv).unwrap();

        let ctx = SecurityContext::new(&[root.to_string_lossy().into_owned()], true, 1_024).unwrap();
        let res = handle_read_doc(
            &ctx,
            serde_json::json!({
                "path": "big.csv",
                "format": "table",
                "offset": 1,
                "limit": 300
            }),
        )
        .unwrap();
        let bytes = serde_json::to_vec(&res).unwrap().len();
        assert_eq!(res["totalUnits"], 300);
        assert_eq!(res["truncated"], true);
        assert_eq!(res["complete"], false);
        assert!(res["returnedUnits"].as_u64().unwrap() < 300);
        assert!(res["nextOffset"].as_u64().is_some());
        assert!(
            bytes < 14_000,
            "Expected read_doc table response capped near IPC budget, got {bytes} bytes"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
