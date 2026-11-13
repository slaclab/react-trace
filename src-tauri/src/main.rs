// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod proxy;

use config::{read_resource_config, CanopyConfig, CliOverrides};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set when release startup fails before any window exists (proxy bind failed).
/// The run-loop callback reads it to keep the window-less event loop alive while
/// the native error dialog is up; the dialog's callback exits the process.
static STARTUP_FAILED: AtomicBool = AtomicBool::new(false);

/// Fixed loopback port the in-process proxy listens on in production. The webview
/// is created pointing here so the SPA's relative fetches and `window.location.host`
/// WebSocket URLs resolve to the proxy (which injects the backend auth headers).
/// Kept fixed so the origin — and therefore localStorage — is stable across launches.
const PROXY_PORT: u16 = 5178;

/// Recreates the window formerly defined in tauri.conf.json `windows[0]`
/// (label "main", 1440x900, title "Trace"). Created programmatically so release
/// builds can bind the proxy BEFORE any webview exists and point the window
/// straight at the proxy origin — the asset-protocol origin is never visited,
/// so no doomed fetches or wrong-origin localStorage writes during boot.
fn create_main_window(app: &tauri::App, url: tauri::WindowUrl) -> tauri::Result<tauri::Window> {
    tauri::WindowBuilder::new(app, "main", url)
        .title("Trace")
        .inner_size(1440.0, 900.0)
        .resizable(true)
        .fullscreen(false)
        .build()
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        // stderr, not the default stdout: release builds are GUI-subsystem on
        // Windows (no console), and `Trace.exe 2>log.txt` capturing stderr is
        // the one channel operators can actually redirect.
        .with_writer(std::io::stderr)
        .init();

    tauri::Builder::default()
        .setup(|app| {
            // CLI overrides (--canopy-url / --api-key / --elog-key), best-effort:
            // flags that don't parse (an unknown one, say) are all ignored.
            let cli = match app.get_cli_matches() {
                Ok(matches) => {
                    let get = |name: &str| {
                        matches
                            .args
                            .get(name)
                            .and_then(|a| a.value.as_str().map(str::to_string))
                    };
                    CliOverrides {
                        canopy_url: get("canopy-url"),
                        api_key: get("api-key"),
                        elog_key: get("elog-key"),
                    }
                }
                Err(err) => {
                    tracing::warn!(%err, "ignoring all command-line flags");
                    CliOverrides::default()
                }
            };

            // Bundled config.json resource (absent in `tauri dev`).
            let resource_path = app.path_resolver().resolve_resource("config.json");
            let cfg = CanopyConfig::resolve(read_resource_config(resource_path.as_deref()), cli);
            tracing::info!(
                canopy_url = %cfg.canopy_url,
                has_key = !cfg.api_key.is_empty(),
                has_elog_key = !cfg.elog_key.is_empty(),
                "resolved backend config"
            );

            // Dev: the window points straight at the Vite dev server, whose proxy
            // owns the API; no Rust proxy. WindowUrl::App("index.html") is the
            // same default URL the old config-file window used — Tauri resolves
            // it to `build.devPath` in dev builds.
            #[cfg(debug_assertions)]
            {
                let _ = PROXY_PORT;
                create_main_window(app, tauri::WindowUrl::App("index.html".into()))?;
            }

            // Release: bind the proxy BEFORE creating any window, then create the
            // window directly on the proxy origin. On bind failure no window is
            // ever created — the user gets a native error dialog instead of a
            // half-loaded page whose API calls all fail.
            #[cfg(not(debug_assertions))]
            {
                // `../dist` is listed in tauri.conf.json `resources`; Tauri maps
                // the leading `..` to a literal `_up_` segment in the resource
                // dir, so the bundled SPA lands at `_up_/dist`.
                let dist_dir = app
                    .path_resolver()
                    .resolve_resource("_up_/dist")
                    .ok_or("bundled dist/ resource missing")?;

                // block_on enters tauri's tokio runtime, so proxy::bind (and the
                // server task it spawns) lands on the normal runtime. A loopback
                // bind resolves in milliseconds, and no UI exists yet to block.
                match tauri::async_runtime::block_on(proxy::bind(PROXY_PORT, dist_dir, cfg)) {
                    Ok(addr) => {
                        let url: tauri::Url =
                            format!("http://{addr}/").parse().expect("loopback URL");
                        tracing::info!(%addr, "proxy listening; creating window at {url}");
                        create_main_window(app, tauri::WindowUrl::External(url))?;
                    }
                    Err(err) => {
                        tracing::error!(%err, port = PROXY_PORT, "failed to bind proxy port");
                        STARTUP_FAILED.store(true, Ordering::SeqCst);
                        // Non-blocking dialog + exit from its callback. Do NOT
                        // "simplify" this to dialog::blocking::message: called
                        // inside setup it deadlocks on Linux — the dialog is
                        // queued to the glib main context, which only starts
                        // iterating after setup returns, while blocking::message
                        // parks this very thread waiting for the answer.
                        // Returning Ok with no window lets the event loop start
                        // and service the dialog; the process exits when the
                        // user dismisses it.
                        tauri::api::dialog::MessageDialogBuilder::new(
                            "Trace failed to start",
                            format!(
                                "Trace could not start its local server on 127.0.0.1:{PROXY_PORT}.\n\n\
                                 {err}\n\n\
                                 If another copy of Trace is already running, close it and try again."
                            ),
                        )
                        .kind(tauri::api::dialog::MessageDialogKind::Error)
                        .show(|_| std::process::exit(1));
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // With zero windows (startup-failure path) the runtime immediately
            // requests exit, which would tear the error dialog down before the
            // user can read it. Hold the loop open; the dialog callback exits.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if STARTUP_FAILED.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
