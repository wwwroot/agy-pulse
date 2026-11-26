use crate::protocol::{FailureInfo, WorkerResult};
use std::path::{Component, Path, PathBuf};

/// Pre-validated workspace security context used across all native operations.
#[derive(Debug, Clone)]
pub struct SecurityContext {
    pub roots: Vec<PathBuf>,
    pub credential_fence: bool,
    pub max_inline_bytes: usize,
}

/// Reserved directories skipped during recursive workspace walks unless `includeHidden` is true.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "__pycache__",
    ".next",
    "dist",
];

/// Safe `.env.*` template suffixes allowed even when the credential fence is enabled.
const ALLOWED_ENV_TEMPLATES: &[&str] = &[
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".env.schema",
];

impl SecurityContext {
    pub fn new(
        raw_roots: &[String],
        credential_fence: bool,
        max_inline_bytes: usize,
    ) -> WorkerResult<Self> {
        if raw_roots.is_empty() {
            return Err(FailureInfo::invalid_arg(
                "At least one workspace root must be provided in `roots`.",
            ));
        }

        let mut roots = Vec::with_capacity(raw_roots.len());
        for raw in raw_roots {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let p = PathBuf::from(trimmed);
            let canonical = canonicalize_with_ancestor(&p)?;
            roots.push(canonical);
        }

        if roots.is_empty() {
            return Err(FailureInfo::invalid_arg(
                "No valid workspace roots were provided in `roots`.",
            ));
        }

        Ok(Self {
            roots,
            credential_fence,
            max_inline_bytes,
        })
    }

    pub fn primary_root(&self) -> &Path {
        &self.roots[0]
    }

    /// Resolve a user-supplied path (relative paths resolve against primary root),
    /// canonicalize via existing ancestor fallback, and enforce workspace jail + credential fence.
    pub fn authorize_path(&self, raw_path: &str) -> WorkerResult<PathBuf> {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err(FailureInfo::invalid_arg("Path cannot be empty."));
        }

        let candidate = PathBuf::from(trimmed);
        let joined = if candidate.is_absolute() {
            candidate
        } else {
            self.primary_root().join(candidate)
        };

        let resolved = canonicalize_with_ancestor(&joined)?;

        if !self.is_within_roots(&resolved) {
            return Err(FailureInfo::outside_workspace(&path_to_display(&resolved)));
        }

        if self.credential_fence && is_credential_path(&resolved) {
            return Err(FailureInfo::credential_blocked(&path_to_display(&resolved)));
        }

        Ok(resolved)
    }

    pub fn authorize_optional_root(&self, raw_path: Option<&str>) -> WorkerResult<PathBuf> {
        match raw_path.map(str::trim).filter(|s| !s.is_empty()) {
            Some(p) => self.authorize_path(p),
            None => Ok(self.primary_root().to_path_buf()),
        }
    }

    pub fn is_within_roots(&self, candidate: &Path) -> bool {
        self.roots
            .iter()
            .any(|root| path_starts_with_normalized(candidate, root))
    }

    pub fn is_workspace_root(&self, candidate: &Path) -> bool {
        self.roots
            .iter()
            .any(|root| paths_equal_normalized(candidate, root))
    }

    pub fn is_blocked_by_fence(&self, candidate: &Path) -> bool {
        self.credential_fence && is_credential_path(candidate)
    }

    /// Returns the IPC payload cap (8x `max_inline_bytes`, clamped to `MAX_IPC_PAYLOAD_BYTES`)
    /// so Node's `SpillStore` captures spillover output without exceeding the 4 MiB stdout limit.
    pub fn ipc_payload_budget(&self) -> usize {
        let desired = self.max_inline_bytes.saturating_mul(8);
        if desired == 0 {
            crate::protocol::MAX_IPC_PAYLOAD_BYTES
        } else {
            desired.clamp(
                self.max_inline_bytes.max(1024),
                crate::protocol::MAX_IPC_PAYLOAD_BYTES,
            )
        }
    }
}

/// Strip Windows verbatim prefix (`\\?\` or `\\?\UNC\`) to produce clean display paths.
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

pub fn path_to_display(path: &Path) -> String {
    strip_verbatim_prefix(path).to_string_lossy().into_owned()
}

/// Normalize a path lexically (resolving `.` and `..` without touching the filesystem).
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(comp.as_os_str());
                }
            }
            Component::Normal(seg) => out.push(seg),
        }
    }
    out
}

/// Canonicalize `path`. If `path` does not exist yet, canonicalize its nearest
/// existing ancestor and re-attach the normalized trailing components.
pub fn canonicalize_with_ancestor(path: &Path) -> WorkerResult<PathBuf> {
    if let Ok(canon) = std::fs::canonicalize(path) {
        return Ok(strip_verbatim_prefix(&canon));
    }
    let lexical = normalize_lexical(path);
    if let Ok(canon) = std::fs::canonicalize(&lexical) {
        return Ok(strip_verbatim_prefix(&canon));
    }

    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut current = lexical.as_path();

    loop {
        if let Some(parent) = current.parent() {
            if let Some(name) = current.file_name() {
                tail.push(name.to_os_string());
            } else {
                // Reached root without existing ancestor
                return Ok(strip_verbatim_prefix(&lexical));
            }
            if parent.as_os_str().is_empty() {
                return Ok(strip_verbatim_prefix(&lexical));
            }
            if parent.exists() {
                let canon_parent = std::fs::canonicalize(parent).map_err(|e| {
                    FailureInfo::io_error(
                        &format!("Failed to canonicalize ancestor {}", parent.display()),
                        &e,
                        crate::protocol::EffectState::None,
                    )
                })?;
                let mut rebuilt = strip_verbatim_prefix(&canon_parent);
                for seg in tail.into_iter().rev() {
                    rebuilt.push(seg);
                }
                return Ok(normalize_lexical(&rebuilt));
            }
            current = parent;
        } else {
            return Ok(strip_verbatim_prefix(&lexical));
        }
    }
}

/// Component-aware prefix comparison (case-insensitive on Windows).
pub fn path_starts_with_normalized(candidate: &Path, root: &Path) -> bool {
    let cand_comps = normalized_components(candidate);
    let root_comps = normalized_components(root);
    if root_comps.is_empty() || cand_comps.len() < root_comps.len() {
        return false;
    }
    cand_comps
        .iter()
        .zip(root_comps.iter())
        .all(|(a, b)| a == b)
}

pub fn paths_equal_normalized(a: &Path, b: &Path) -> bool {
    normalized_components(a) == normalized_components(b)
}

pub fn normalized_path_key(path: &Path) -> String {
    normalized_components(path).join("/")
}

fn normalized_components(path: &Path) -> Vec<String> {
    let clean = strip_verbatim_prefix(path);
    clean
        .components()
        .filter_map(|c| match c {
            Component::CurDir => None,
            other => {
                let s = other.as_os_str().to_string_lossy().into_owned();
                if cfg!(windows) {
                    Some(s.to_ascii_lowercase())
                } else {
                    Some(s)
                }
            }
        })
        .collect()
}

/// Returns true if `path` matches a blocked credential directory or filename.
pub fn is_credential_path(path: &Path) -> bool {
    let clean = strip_verbatim_prefix(path);
    let segments: Vec<String> = clean
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();

    if segments.is_empty() {
        return false;
    }

    // Kept in sync with Node `src/shared/guards.ts`.
    for seg in &segments {
        match seg.as_str() {
            ".ssh" | ".aws" | ".azure" | ".kube" | ".gnupg" | ".netrc" | ".git-credentials"
            | ".npmrc" | ".pypirc" | "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa" => {
                return true;
            }
            _ => {}
        }
    }

    for pair in segments.windows(2) {
        if (pair[0] == ".config" && pair[1] == "gcloud")
            || (pair[0] == ".docker" && pair[1] == "config.json")
        {
            return true;
        }
    }

    if let Some(file_name) = segments.last() {
        if (file_name.ends_with(".pem") && file_name.len() > 4)
            || (file_name.ends_with(".key") && file_name.len() > 4)
            || (file_name.ends_with(".p12") && file_name.len() > 4)
            || (file_name.ends_with(".pfx") && file_name.len() > 4)
        {
            return true;
        }

        if (file_name.starts_with("service-account")
            || file_name.starts_with("service_account")
            || file_name.starts_with("serviceaccount"))
            && file_name.ends_with(".json")
        {
            return true;
        }

        if file_name.contains("credentials")
            && (file_name.ends_with(".json")
                || file_name.ends_with(".yaml")
                || file_name.ends_with(".yml")
                || file_name.ends_with(".ini"))
        {
            return true;
        }

        if file_name == ".env" {
            return true;
        }
        if file_name.starts_with(".env.")
            && !ALLOWED_ENV_TEMPLATES.contains(&file_name.as_str())
        {
            return true;
        }
    }

    false
}

pub fn should_skip_walk_entry(name: &str, is_dir: bool, include_hidden: bool) -> bool {
    if include_hidden {
        return false;
    }
    if is_dir && SKIP_DIRS.contains(&name) {
        return true;
    }
    if name.starts_with('.') {
        return true;
    }
    false
}

/// Convert a path relative to `root` into a forward-slash string for glob matching.
pub fn relative_posix_path(root: &Path, target: &Path) -> String {
    let rel = target.strip_prefix(root).unwrap_or(target);
    rel.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_fence_matches_node_guards_parity() {
        let blocked = [
            "/workspace/.gnupg/secring.gpg",
            "/workspace/.ssh/id_ecdsa",
            "/workspace/keys/id_dsa",
            "/workspace/certs/server.p12",
            "/workspace/certs/client.pfx",
            "/workspace/certs/tls.pem",
            "/workspace/certs/private.key",
            "/workspace/gcp/service-account-prod.json",
            "/workspace/gcp/service_account_dev.json",
            "/workspace/gcp/serviceaccount.json",
            "/workspace/.env",
            "/workspace/.env.local",
            "/workspace/.config/gcloud/credentials.db",
            "/workspace/.docker/config.json",
        ];
        for p in blocked {
            assert!(
                is_credential_path(Path::new(p)),
                "Expected credential fence to block {p}"
            );
        }

        let allowed = [
            "/workspace/.env.example",
            "/workspace/.env.sample",
            "/workspace/src/main.rs",
            "/workspace/package.json",
        ];
        for p in allowed {
            assert!(
                !is_credential_path(Path::new(p)),
                "Expected credential fence to allow {p}"
            );
        }
    }
}
