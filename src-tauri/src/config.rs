//! Runtime resolution of the Canopy backend URL and API key for the desktop app.
//!
//! Precedence (highest first):
//!   1. CLI args: `--canopy-url <url>` / `--api-key <key>`
//!   2. Env vars: `CANOPY_BASE_URL` / `CANOPY_API_KEY` (same names as the web
//!      dev proxy uses in `.env`, so a single .env works for both targets).
//!   3. Bundled `config.json` resource: `{ "canopyUrl": "...", "apiKey": "..." }`.
//!   4. Built-in default (`http://localhost:8000`, empty key).
//!
//! This lets an operator repoint the packaged app at any backend without a
//! rebuild, while keeping the key out of the JS bundle: it lives only here and
//! is injected by the in-process proxy (see `proxy.rs`).

use serde::Deserialize;
use std::path::Path;

/// Default Canopy backend, matching `.env.example` / the Vite proxy default.
const DEFAULT_CANOPY_URL: &str = "http://localhost:8000";

#[derive(Debug, Clone)]
pub struct CanopyConfig {
    /// Base URL of the Canopy backend, no trailing slash (e.g. `http://host:8000`).
    pub canopy_url: String,
    /// API key injected as `X-API-Key` on every forwarded request. May be empty.
    pub api_key: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileConfig {
    #[serde(default)]
    canopy_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
}

impl CanopyConfig {
    /// Resolve the effective config from the sources above.
    ///
    /// `resource_config` is the parsed bundled `config.json` (if present), and
    /// `cli_url` / `cli_key` are the optional CLI overrides.
    pub fn resolve(
        resource_config: Option<FileConfig>,
        cli_url: Option<String>,
        cli_key: Option<String>,
    ) -> Self {
        let file = resource_config.unwrap_or_default();

        let canopy_url = cli_url
            .filter(|s| !s.is_empty())
            .or_else(|| {
                std::env::var("CANOPY_BASE_URL")
                    .ok()
                    .filter(|s| !s.is_empty())
            })
            .or(file.canopy_url.filter(|s| !s.is_empty()))
            .unwrap_or_else(|| DEFAULT_CANOPY_URL.to_string());

        let api_key = cli_key
            .filter(|s| !s.is_empty())
            .or_else(|| {
                std::env::var("CANOPY_API_KEY")
                    .ok()
                    .filter(|s| !s.is_empty())
            })
            .or(file.api_key.filter(|s| !s.is_empty()))
            .unwrap_or_default();

        // Normalize: strip any trailing slash so `${url}${path}` joins cleanly.
        let canopy_url = canopy_url.trim_end_matches('/').to_string();

        Self {
            canopy_url,
            api_key,
        }
    }

    /// WebSocket base derived from the HTTP base (`http`->`ws`, `https`->`wss`).
    pub fn ws_url(&self) -> String {
        if let Some(rest) = self.canopy_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.canopy_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            // Unknown scheme: assume ws for parity with the HTTP base.
            format!("ws://{}", self.canopy_url)
        }
    }
}

/// Read and parse the bundled `config.json` resource, if it exists.
/// Returns `None` when absent (e.g. `tauri dev`), `Some(default)` on parse error
/// so a malformed file degrades to env/CLI/default rather than crashing.
pub fn read_resource_config(path: Option<&Path>) -> Option<FileConfig> {
    let path = path?;
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<FileConfig>(&text) {
        Ok(cfg) => Some(cfg),
        Err(err) => {
            tracing::warn!(?path, %err, "config.json present but unparseable; ignoring");
            Some(FileConfig::default())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_beats_env_and_file() {
        let file = Some(FileConfig {
            canopy_url: Some("http://file:1".into()),
            api_key: Some("filekey".into()),
        });
        let cfg = CanopyConfig::resolve(file, Some("http://cli:2".into()), Some("clikey".into()));
        assert_eq!(cfg.canopy_url, "http://cli:2");
        assert_eq!(cfg.api_key, "clikey");
    }

    #[test]
    fn file_used_when_no_override() {
        let file = Some(FileConfig {
            canopy_url: Some("http://file:1/".into()),
            api_key: Some("filekey".into()),
        });
        let cfg = CanopyConfig::resolve(file, None, None);
        // Trailing slash stripped.
        assert_eq!(cfg.canopy_url, "http://file:1");
        assert_eq!(cfg.api_key, "filekey");
    }

    #[test]
    fn falls_back_to_default_url() {
        let cfg = CanopyConfig::resolve(None, None, None);
        assert_eq!(cfg.canopy_url, DEFAULT_CANOPY_URL);
        assert_eq!(cfg.api_key, "");
    }

    #[test]
    fn ws_url_scheme_swap() {
        let https = CanopyConfig {
            canopy_url: "https://h:9".into(),
            api_key: String::new(),
        };
        assert_eq!(https.ws_url(), "wss://h:9");
        let http = CanopyConfig {
            canopy_url: "http://h:9".into(),
            api_key: String::new(),
        };
        assert_eq!(http.ws_url(), "ws://h:9");
    }
}
