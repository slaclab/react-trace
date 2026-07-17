// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod proxy;

use config::{read_resource_config, CanopyConfig};

/// Fixed loopback port the in-process proxy listens on in production. The webview
/// is navigated here so the SPA's relative fetches and `window.location.host`
/// WebSocket URLs resolve to the proxy (which injects X-API-Key). Kept fixed so
/// the origin is stable across launches.
const PROXY_PORT: u16 = 5178;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            // CLI overrides (--canopy-url / --api-key), best-effort.
            let (cli_url, cli_key) = match app.get_cli_matches() {
                Ok(matches) => (
                    matches
                        .args
                        .get("canopy-url")
                        .and_then(|a| a.value.as_str().map(str::to_string)),
                    matches
                        .args
                        .get("api-key")
                        .and_then(|a| a.value.as_str().map(str::to_string)),
                ),
                Err(_) => (None, None),
            };

            // Bundled config.json resource (absent in `tauri dev`).
            let resource_path = app
                .path_resolver()
                .resolve_resource("config.json");
            let file_cfg = read_resource_config(resource_path.as_deref());
            let cfg = CanopyConfig::resolve(file_cfg, cli_url, cli_key);
            tracing::info!(canopy_url = %cfg.canopy_url, has_key = !cfg.api_key.is_empty(), "resolved Canopy config");

            // In `tauri dev` the window already points at the Vite dev server
            // (devPath), whose proxy handles the API. Only in a packaged build
            // do we need the in-process proxy + navigation.
            //
            // `dist` is bundled as a resource; locate it and start the proxy.
            #[cfg(not(debug_assertions))]
            {
                use tauri::Manager;
                // `../dist` is listed in tauri.conf.json `resources`; Tauri maps
                // the leading `..` to a literal `_up_` segment in the resource
                // dir, so the bundled SPA lands at `_up_/dist`.
                let dist_dir = app
                    .path_resolver()
                    .resolve_resource("_up_/dist")
                    .ok_or("bundled dist/ resource missing")?;
                let window = app
                    .get_window("main")
                    .ok_or("main window missing")?;
                tauri::async_runtime::spawn(async move {
                    match proxy::bind(PROXY_PORT, dist_dir, cfg).await {
                        Ok(addr) => {
                            // Navigate the webview from the asset-protocol boot
                            // page to the proxy origin, so all relative fetches
                            // and window.location.host WS URLs resolve here.
                            let url = format!("http://{addr}/");
                            tracing::info!(%addr, "proxy listening; navigating webview to {url}");
                            let _ = window.eval(&format!("window.location.replace('{url}')"));
                        }
                        Err(err) => {
                            tracing::error!(%err, "failed to start proxy");
                        }
                    }
                });
            }

            // Debug builds: silence unused warnings for the prod-only path.
            #[cfg(debug_assertions)]
            {
                let _ = (PROXY_PORT, &cfg);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
