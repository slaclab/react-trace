use serde_json::{json, Value};

fn main() {
    // tauri-build copies every `bundle.resources` entry into the target dir on
    // every build and fails if one is missing, including `tauri dev` and
    // `cargo test/check/clippy`. Both resources are release-only: the bundled
    // `config.json` (gitignored, it can hold keys) and `../dist` (the frontend
    // build) are read only by the release proxy path in main.rs. `tauri build`
    // enables the `custom-protocol` feature; without it, drop the resources so
    // a fresh checkout builds. Release builds still require both.
    if std::env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_none() {
        drop_bundle_resources();
    }
    tauri_build::build()
}

/// Set `tauri.bundle.resources = []` in `TAURI_CONFIG`, the JSON merge patch
/// tauri-build applies on top of tauri.conf.json (read in this process). The
/// Tauri CLI may already have set it (e.g. a devPath override), so the key is
/// added to the existing patch rather than replacing it. An unparseable value
/// is left alone for tauri-build to report.
fn drop_bundle_resources() {
    let mut patch = match std::env::var("TAURI_CONFIG") {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(value) => value,
            Err(_) => return,
        },
        Err(_) => json!({}),
    };
    let Some(root) = patch.as_object_mut() else {
        return;
    };
    let Some(tauri) = root
        .entry("tauri")
        .or_insert_with(|| json!({}))
        .as_object_mut()
    else {
        return;
    };
    let Some(bundle) = tauri
        .entry("bundle")
        .or_insert_with(|| json!({}))
        .as_object_mut()
    else {
        return;
    };
    bundle.insert("resources".into(), json!([]));
    std::env::set_var("TAURI_CONFIG", patch.to_string());
}
