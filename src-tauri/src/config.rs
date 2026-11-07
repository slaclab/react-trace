//! Runtime resolution of backend URLs and keys for the desktop app.
//!
//! Two upstreams are configured here:
//! - Canopy (`/mole`, `/hare`, `/fox`): base URL + `X-API-Key`.
//! - E-Log / elog-plus (`/elog`): base URL + `x-vouch-idp-accesstoken`. Optional;
//!   when no URL is configured the proxy answers 502 and the frontend hides the
//!   Post to E-Log button (same behavior as the web app without `ELOG_BASE_URL`).
//!
//! Precedence per value (highest first):
//!   1. CLI args: `--canopy-url` / `--api-key` / `--elog-url` / `--elog-key`
//!   2. Env vars: `CANOPY_BASE_URL` / `CANOPY_API_KEY` / `ELOG_BASE_URL` /
//!      `ELOG_API_KEY` (same names as the web dev proxy reads from `.env`, so a
//!      single .env works for both targets).
//!   3. Bundled `config.json` resource:
//!      `{ "canopyUrl": "...", "apiKey": "...", "elogUrl": "...", "elogApiKey": "..." }`.
//!   4. Built-in default (`http://localhost:8000`, empty keys, e-log disabled).
//!
//! This lets an operator repoint the packaged app at any backend without a
//! rebuild, while keeping the keys out of the JS bundle: they live only here and
//! are injected by the in-process proxy (see `proxy.rs`).

use serde::Deserialize;
use std::path::Path;

/// Default Canopy backend, matching `.env.example` / the Vite proxy default.
const DEFAULT_CANOPY_URL: &str = "http://localhost:8000";

#[derive(Debug, Clone)]
pub struct CanopyConfig {
    /// Base URL of the Canopy backend, no trailing slash (e.g. `http://host:8000`).
    pub canopy_url: String,
    /// API key injected as `X-API-Key` on every forwarded Canopy request. May be empty.
    pub api_key: String,
    /// Base URL of the elog-plus backend, no trailing slash. `None` disables
    /// e-log forwarding (the proxy answers 502 on `/elog`).
    pub elog_url: Option<String>,
    /// Token injected as `x-vouch-idp-accesstoken` on forwarded e-log requests.
    /// May be empty (header omitted), matching the Vite dev proxy.
    pub elog_key: String,
}

/// CLI overrides, parsed from Tauri's CLI matches in `main.rs`.
#[derive(Debug, Default)]
pub struct CliOverrides {
    pub canopy_url: Option<String>,
    pub api_key: Option<String>,
    pub elog_url: Option<String>,
    pub elog_key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileConfig {
    #[serde(default)]
    canopy_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    elog_url: Option<String>,
    #[serde(default)]
    elog_api_key: Option<String>,
}

/// Environment lookup used by [`CanopyConfig::resolve_with_env`]: `std::env::var`
/// in the app, a fixed map in tests (so they never see the operator's real
/// `CANOPY_BASE_URL` etc. and never mutate process-wide env).
type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// One precedence chain: CLI > env > file. Empty strings at any level are
/// treated as unset so an empty CLI flag or `""` in config.json can't shadow a
/// lower layer.
fn pick(
    cli: Option<String>,
    env: EnvLookup<'_>,
    env_name: &str,
    file: Option<String>,
) -> Option<String> {
    cli.filter(|s| !s.is_empty())
        .or_else(|| env(env_name).filter(|s| !s.is_empty()))
        .or(file.filter(|s| !s.is_empty()))
}

/// Normalize a base URL: strip any trailing slash so `${url}${path}` joins cleanly.
fn strip_slash(url: String) -> String {
    url.trim_end_matches('/').to_string()
}

impl CanopyConfig {
    /// Resolve the effective config from the sources above.
    ///
    /// `resource_config` is the parsed bundled `config.json` (if present), and
    /// `cli` carries the optional CLI overrides.
    pub fn resolve(resource_config: Option<FileConfig>, cli: CliOverrides) -> Self {
        Self::resolve_with_env(resource_config, cli, &|name| std::env::var(name).ok())
    }

    /// [`Self::resolve`] with an injectable environment, so tests are
    /// deterministic regardless of the caller's real env.
    fn resolve_with_env(
        resource_config: Option<FileConfig>,
        cli: CliOverrides,
        env: EnvLookup<'_>,
    ) -> Self {
        let file = resource_config.unwrap_or_default();

        let canopy_url = pick(cli.canopy_url, env, "CANOPY_BASE_URL", file.canopy_url)
            .unwrap_or_else(|| DEFAULT_CANOPY_URL.to_string());
        let api_key = pick(cli.api_key, env, "CANOPY_API_KEY", file.api_key).unwrap_or_default();
        let elog_url = pick(cli.elog_url, env, "ELOG_BASE_URL", file.elog_url).map(strip_slash);
        let elog_key =
            pick(cli.elog_key, env, "ELOG_API_KEY", file.elog_api_key).unwrap_or_default();

        Self {
            canopy_url: strip_slash(canopy_url),
            api_key,
            elog_url,
            elog_key,
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
    use std::collections::HashMap;

    fn cli(
        canopy_url: Option<&str>,
        api_key: Option<&str>,
        elog_url: Option<&str>,
        elog_key: Option<&str>,
    ) -> CliOverrides {
        CliOverrides {
            canopy_url: canopy_url.map(str::to_string),
            api_key: api_key.map(str::to_string),
            elog_url: elog_url.map(str::to_string),
            elog_key: elog_key.map(str::to_string),
        }
    }

    /// Resolve against a fixed env (`pairs`), never the process env.
    fn resolve_env(
        file: Option<FileConfig>,
        cli: CliOverrides,
        pairs: &[(&str, &str)],
    ) -> CanopyConfig {
        let env: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        CanopyConfig::resolve_with_env(file, cli, &|name| env.get(name).cloned())
    }

    /// Resolve with an empty env.
    fn resolve(file: Option<FileConfig>, cli: CliOverrides) -> CanopyConfig {
        resolve_env(file, cli, &[])
    }

    fn file_all() -> Option<FileConfig> {
        Some(FileConfig {
            canopy_url: Some("http://file:1".into()),
            api_key: Some("filekey".into()),
            elog_url: Some("http://file-elog:2/".into()),
            elog_api_key: Some("filetoken".into()),
        })
    }

    #[test]
    fn cli_beats_env_and_file() {
        let cfg = resolve(
            file_all(),
            cli(
                Some("http://cli:2"),
                Some("clikey"),
                Some("http://cli-elog:3"),
                Some("clitoken"),
            ),
        );
        assert_eq!(cfg.canopy_url, "http://cli:2");
        assert_eq!(cfg.api_key, "clikey");
        assert_eq!(cfg.elog_url.as_deref(), Some("http://cli-elog:3"));
        assert_eq!(cfg.elog_key, "clitoken");
    }

    #[test]
    fn file_used_when_no_override() {
        let cfg = resolve(file_all(), CliOverrides::default());
        assert_eq!(cfg.canopy_url, "http://file:1");
        assert_eq!(cfg.api_key, "filekey");
        // Trailing slash stripped on the elog URL too.
        assert_eq!(cfg.elog_url.as_deref(), Some("http://file-elog:2"));
        assert_eq!(cfg.elog_key, "filetoken");
    }

    #[test]
    fn falls_back_to_default_url() {
        let cfg = resolve(None, CliOverrides::default());
        assert_eq!(cfg.canopy_url, DEFAULT_CANOPY_URL);
        assert_eq!(cfg.api_key, "");
        // E-log defaults to disabled, matching the web app without ELOG_BASE_URL.
        assert_eq!(cfg.elog_url, None);
        assert_eq!(cfg.elog_key, "");
    }

    #[test]
    fn empty_strings_do_not_shadow_lower_layers() {
        let cfg = resolve(file_all(), cli(Some(""), Some(""), Some(""), Some("")));
        assert_eq!(cfg.canopy_url, "http://file:1");
        assert_eq!(cfg.elog_url.as_deref(), Some("http://file-elog:2"));
    }

    const ENV_ALL: &[(&str, &str)] = &[
        ("CANOPY_BASE_URL", "http://env:4/"),
        ("CANOPY_API_KEY", "envkey"),
        ("ELOG_BASE_URL", "http://env-elog:5"),
        ("ELOG_API_KEY", "envtoken"),
    ];

    #[test]
    fn env_beats_file() {
        let cfg = resolve_env(file_all(), CliOverrides::default(), ENV_ALL);
        // Trailing slash stripped on env values too.
        assert_eq!(cfg.canopy_url, "http://env:4");
        assert_eq!(cfg.api_key, "envkey");
        assert_eq!(cfg.elog_url.as_deref(), Some("http://env-elog:5"));
        assert_eq!(cfg.elog_key, "envtoken");
    }

    #[test]
    fn cli_beats_env() {
        let cfg = resolve_env(
            file_all(),
            cli(Some("http://cli:2"), Some("clikey"), None, None),
            ENV_ALL,
        );
        assert_eq!(cfg.canopy_url, "http://cli:2");
        assert_eq!(cfg.api_key, "clikey");
        // Values without a CLI override still come from env.
        assert_eq!(cfg.elog_url.as_deref(), Some("http://env-elog:5"));
        assert_eq!(cfg.elog_key, "envtoken");
    }

    #[test]
    fn empty_env_does_not_shadow_file() {
        let empty = &[
            ("CANOPY_BASE_URL", ""),
            ("CANOPY_API_KEY", ""),
            ("ELOG_BASE_URL", ""),
            ("ELOG_API_KEY", ""),
        ];
        let cfg = resolve_env(file_all(), CliOverrides::default(), empty);
        assert_eq!(cfg.canopy_url, "http://file:1");
        assert_eq!(cfg.api_key, "filekey");
        assert_eq!(cfg.elog_url.as_deref(), Some("http://file-elog:2"));
        assert_eq!(cfg.elog_key, "filetoken");
    }

    #[test]
    fn ws_url_scheme_swap() {
        let https = CanopyConfig {
            canopy_url: "https://h:9".into(),
            api_key: String::new(),
            elog_url: None,
            elog_key: String::new(),
        };
        assert_eq!(https.ws_url(), "wss://h:9");
        let http = CanopyConfig {
            canopy_url: "http://h:9".into(),
            api_key: String::new(),
            elog_url: None,
            elog_key: String::new(),
        };
        assert_eq!(http.ws_url(), "ws://h:9");
    }
}
