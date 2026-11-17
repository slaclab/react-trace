//! Runtime resolution of backend URLs and keys for the desktop app.
//!
//! Everything goes to one Canopy backend (base URL), with two keys sent as
//! `X-API-Key`:
//! - the Canopy key, on `/mole`, `/hare`, `/formula-engine`, `/magpie`, `/vole`;
//! - the e-log key, on `/elog/v1/apps/trace/` (Trace's app in Canopy's e-log
//!   module). It falls back to the Canopy key, as in the Vite dev proxy.
//!
//! Precedence per value (highest first):
//!   1. CLI args: `--canopy-url` / `--api-key` / `--elog-key`
//!   2. Env vars: `CANOPY_BASE_URL` / `CANOPY_API_KEY` / `CANOPY_ELOG_API_KEY`
//!      (same names as the web dev proxy reads from `.env`, so a single .env
//!      works for both targets).
//!   3. Bundled `config.json` resource:
//!      `{ "canopyUrl": "...", "apiKey": "...", "elogApiKey": "..." }`.
//!   4. Built-in default (`http://localhost:8000`, empty key; the e-log key is
//!      the Canopy key).
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
    /// API key injected as `X-API-Key` on Trace's e-log app path: the e-log key
    /// when one is set, else `api_key`. May be empty (header omitted).
    pub elog_key: String,
}

/// CLI overrides, parsed from Tauri's CLI matches in `main.rs`.
#[derive(Debug, Default)]
pub struct CliOverrides {
    pub canopy_url: Option<String>,
    pub api_key: Option<String>,
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
        let elog_key = pick(cli.elog_key, env, "CANOPY_ELOG_API_KEY", file.elog_api_key)
            .unwrap_or_else(|| api_key.clone());

        Self {
            canopy_url: strip_slash(canopy_url),
            api_key,
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
        elog_key: Option<&str>,
    ) -> CliOverrides {
        CliOverrides {
            canopy_url: canopy_url.map(str::to_string),
            api_key: api_key.map(str::to_string),
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
            elog_api_key: Some("fileelogkey".into()),
        })
    }

    #[test]
    fn cli_beats_env_and_file() {
        let cfg = resolve(
            file_all(),
            cli(Some("http://cli:2"), Some("clikey"), Some("clielogkey")),
        );
        assert_eq!(cfg.canopy_url, "http://cli:2");
        assert_eq!(cfg.api_key, "clikey");
        assert_eq!(cfg.elog_key, "clielogkey");
    }

    #[test]
    fn file_used_when_no_override() {
        let cfg = resolve(file_all(), CliOverrides::default());
        assert_eq!(cfg.canopy_url, "http://file:1");
        assert_eq!(cfg.api_key, "filekey");
        assert_eq!(cfg.elog_key, "fileelogkey");
    }

    #[test]
    fn falls_back_to_default_url() {
        let cfg = resolve(None, CliOverrides::default());
        assert_eq!(cfg.canopy_url, DEFAULT_CANOPY_URL);
        assert_eq!(cfg.api_key, "");
        assert_eq!(cfg.elog_key, "");
    }

    #[test]
    fn empty_strings_do_not_shadow_lower_layers() {
        let cfg = resolve(file_all(), cli(Some(""), Some(""), Some("")));
        assert_eq!(cfg.canopy_url, "http://file:1");
        assert_eq!(cfg.elog_key, "fileelogkey");
    }

    /// Without an e-log key at any layer, or with only empty ones, the e-log
    /// path gets the Canopy key, as in the Vite dev proxy.
    #[test]
    fn elog_key_falls_back_to_api_key() {
        let file = || {
            Some(FileConfig {
                elog_api_key: Some(String::new()),
                ..file_all().unwrap()
            })
        };
        let unset = || CliOverrides::default();
        let empty = || cli(None, None, Some(""));
        let empty_env: &[(&str, &str)] = &[("CANOPY_ELOG_API_KEY", "")];
        assert_eq!(resolve(file(), unset()).elog_key, "filekey");
        assert_eq!(resolve(file(), empty()).elog_key, "filekey");
        assert_eq!(resolve_env(file(), empty(), empty_env).elog_key, "filekey");
        // The fallback is the resolved Canopy key, wherever it came from.
        let cfg = resolve(file(), cli(None, Some("clikey"), None));
        assert_eq!(cfg.elog_key, "clikey");
    }

    const ENV_ALL: &[(&str, &str)] = &[
        ("CANOPY_BASE_URL", "http://env:4/"),
        ("CANOPY_API_KEY", "envkey"),
        ("CANOPY_ELOG_API_KEY", "envelogkey"),
    ];

    #[test]
    fn env_beats_file() {
        let cfg = resolve_env(file_all(), CliOverrides::default(), ENV_ALL);
        // Trailing slash stripped on env values too.
        assert_eq!(cfg.canopy_url, "http://env:4");
        assert_eq!(cfg.api_key, "envkey");
        assert_eq!(cfg.elog_key, "envelogkey");
    }

    #[test]
    fn cli_beats_env() {
        let cfg = resolve_env(
            file_all(),
            cli(Some("http://cli:2"), Some("clikey"), None),
            ENV_ALL,
        );
        assert_eq!(cfg.canopy_url, "http://cli:2");
        assert_eq!(cfg.api_key, "clikey");
        // Values without a CLI override still come from env.
        assert_eq!(cfg.elog_key, "envelogkey");
    }

    #[test]
    fn empty_env_does_not_shadow_file() {
        let empty = &[
            ("CANOPY_BASE_URL", ""),
            ("CANOPY_API_KEY", ""),
            ("CANOPY_ELOG_API_KEY", ""),
        ];
        let cfg = resolve_env(file_all(), CliOverrides::default(), empty);
        assert_eq!(cfg.canopy_url, "http://file:1");
        assert_eq!(cfg.api_key, "filekey");
        assert_eq!(cfg.elog_key, "fileelogkey");
    }

    #[test]
    fn ws_url_scheme_swap() {
        let https = CanopyConfig {
            canopy_url: "https://h:9".into(),
            api_key: String::new(),
            elog_key: String::new(),
        };
        assert_eq!(https.ws_url(), "wss://h:9");
        let http = CanopyConfig {
            canopy_url: "http://h:9".into(),
            api_key: String::new(),
            elog_key: String::new(),
        };
        assert_eq!(http.ws_url(), "ws://h:9");
    }
}
