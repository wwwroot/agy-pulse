use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_STDIN_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_MAX_INLINE_BYTES: usize = 65_536;
/// Raw-content IPC payload cap, leaving headroom for JSON escaping under Node's 4 MiB stdout limit.
pub const MAX_IPC_PAYLOAD_BYTES: usize = 1_800_000;
/// Maximum serialized NDJSON response line size, kept below Node's 4 MiB `MAX_STDOUT_BYTES`.
pub const MAX_STDOUT_LINE_BYTES: usize = 3_500_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRequest {
    #[serde(default, alias = "req_id")]
    pub req_id: Option<String>,
    pub op: String,
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default = "default_true")]
    pub credential_fence: bool,
    #[serde(default = "default_max_inline_bytes")]
    pub max_inline_bytes: usize,
    #[serde(default)]
    pub args: Value,
}

fn default_true() -> bool {
    true
}

fn default_max_inline_bytes() -> usize {
    DEFAULT_MAX_INLINE_BYTES
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureInfo {
    pub code: String,
    pub message: String,
    pub effect_state: EffectState,
    pub retry: RetryPolicy,
    pub next_action: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectState {
    None,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum RetryPolicy {
    Never,
    AfterInputChange,
    Safe,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum WorkerResponse {
    Ok {
        #[serde(rename = "reqId", skip_serializing_if = "Option::is_none")]
        req_id: Option<String>,
        ok: bool,
        result: Value,
    },
    Err {
        #[serde(rename = "reqId", skip_serializing_if = "Option::is_none")]
        req_id: Option<String>,
        ok: bool,
        error: FailureInfo,
    },
}

impl WorkerResponse {
    pub fn success(result: Value) -> Self {
        Self::Ok {
            req_id: None,
            ok: true,
            result,
        }
    }

    pub fn failure(error: FailureInfo) -> Self {
        Self::Err {
            req_id: None,
            ok: false,
            error,
        }
    }

    pub fn with_req_id(self, req_id: Option<String>) -> Self {
        match self {
            Self::Ok { ok, result, .. } => Self::Ok { req_id, ok, result },
            Self::Err { ok, error, .. } => Self::Err { req_id, ok, error },
        }
    }

    pub fn req_id(&self) -> Option<&str> {
        match self {
            Self::Ok { req_id, .. } | Self::Err { req_id, .. } => req_id.as_deref(),
        }
    }
}

/// Exact serialized byte length of a string's contents inside JSON quotes (excluding the outer quotes).
pub fn json_escaped_len(s: &str) -> usize {
    let mut len = 0usize;
    for b in s.bytes() {
        len += match b {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 0x08 | 0x0C => 2,
            0x00..=0x1F => 6, // \u00XX
            _ => 1,
        };
    }
    len
}

/// Truncate `s` on a UTF-8 character boundary so that `json_escaped_len(out) <= max_json_bytes`.
/// Appends `suffix` when truncation occurs and space permits.
pub fn truncate_to_json_budget(s: &str, max_json_bytes: usize, suffix: &str) -> (String, bool) {
    if json_escaped_len(s) <= max_json_bytes {
        return (s.to_string(), false);
    }

    let suffix_len = json_escaped_len(suffix);
    let body_budget = max_json_bytes.saturating_sub(suffix_len);
    let mut used = 0usize;
    let mut cut_idx = 0usize;

    for (idx, ch) in s.char_indices() {
        let mut ch_buf = [0u8; 4];
        let ch_str = ch.encode_utf8(&mut ch_buf);
        let ch_cost = json_escaped_len(ch_str);
        if used + ch_cost > body_budget {
            break;
        }
        used += ch_cost;
        cut_idx = idx + ch.len_utf8();
    }

    let mut out = String::with_capacity(cut_idx + suffix.len());
    out.push_str(&s[..cut_idx]);
    if suffix_len <= max_json_bytes {
        out.push_str(suffix);
    }
    (out, true)
}

pub type WorkerResult<T> = Result<T, FailureInfo>;

impl FailureInfo {
    pub fn invalid_arg(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_ARGUMENT".to_string(),
            message: message.into(),
            effect_state: EffectState::None,
            retry: RetryPolicy::AfterInputChange,
            next_action: "Fix the request arguments and retry.".to_string(),
        }
    }

    pub fn outside_workspace(path: &str) -> Self {
        Self {
            code: "WORKDIR_OUTSIDE_WORKSPACE".to_string(),
            message: format!("Path escapes configured workspace roots: {path}"),
            effect_state: EffectState::None,
            retry: RetryPolicy::Never,
            next_action: "Use a path located inside the authorized workspace roots.".to_string(),
        }
    }

    pub fn credential_blocked(path: &str) -> Self {
        Self {
            code: "CREDENTIAL_FENCE_BLOCKED".to_string(),
            message: format!("Access blocked by credential fence: {path}"),
            effect_state: EffectState::None,
            retry: RetryPolicy::Never,
            next_action: "Avoid reading or modifying sensitive credential files.".to_string(),
        }
    }

    pub fn revision_mismatch(path: &str, expected: &str, actual: &str) -> Self {
        Self {
            code: "REVISION_MISMATCH".to_string(),
            message: format!(
                "Revision mismatch for {path}: expected {expected}, actual {actual}"
            ),
            effect_state: EffectState::None,
            retry: RetryPolicy::AfterInputChange,
            next_action: "Re-read the file to obtain the latest SHA-256 revision and retry."
                .to_string(),
        }
    }

    pub fn io_error(context: &str, err: &std::io::Error, effect_state: EffectState) -> Self {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => "NOT_FOUND",
            std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            std::io::ErrorKind::AlreadyExists => "ALREADY_EXISTS",
            _ => "IO_ERROR",
        };
        Self {
            code: code.to_string(),
            message: format!("{context}: {err}"),
            effect_state,
            retry: RetryPolicy::AfterInputChange,
            next_action: "Inspect the file path and permissions before retrying.".to_string(),
        }
    }

    pub fn custom(
        code: impl Into<String>,
        message: impl Into<String>,
        effect_state: EffectState,
        retry: RetryPolicy,
        next_action: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            effect_state,
            retry,
            next_action: next_action.into(),
        }
    }
}

pub fn deserialize_string_or_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }

    match OneOrMany::deserialize(deserializer)? {
        OneOrMany::One(s) => Ok(vec![s]),
        OneOrMany::Many(v) => Ok(v),
    }
}

pub fn deserialize_opt_string_or_vec<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OptOneOrMany {
        One(String),
        Many(Vec<String>),
    }

    let opt = Option::<OptOneOrMany>::deserialize(deserializer)?;
    Ok(opt.map(|v| match v {
        OptOneOrMany::One(s) => vec![s],
        OptOneOrMany::Many(v) => v,
    }))
}
