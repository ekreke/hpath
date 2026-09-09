// Debug-only HTTP bridge (T18 dogfooding): a loopback HTTP server inside the
// desktop app that exposes the shell's live state and a true-window
// screenshot so the execute-agent can verify the desktop client itself
// (PRD rule <-> frontend display <-> backend output).
//
// Safety gates:
//   - The HTTP server (and the capture machinery) only exists in DEBUG
//     builds (`#[cfg(debug_assertions)]`); release builds compile them out —
//     `start()` becomes a no-op there.
//   - Binds 127.0.0.1 only, on an ephemeral port; the port is published to
//     `<tmpdir>/hpath-debug-bridge.json` (`{"port":N,"pid":P}`) for the
//     dogfood env / desktop tool provider to discover.
//   - Read-only surface: GET /health, GET /state, GET /screenshot. No command
//     invocation endpoint in v1 (the agent exercises the app through the
//     browser layer instead; revisit deliberately if a future need appears).
//
// macOS note: /screenshot finds the app's own on-screen window via
// core-graphics (CGWindowListCopyWindowInfo filtered by pid) and captures it
// with the system `screencapture` CLI. The first capture triggers the macOS
// Screen Recording (TCC) permission prompt — grant it once to the parent
// terminal / app; without it the endpoint answers 503 with the reason.

use std::sync::Mutex;

/// Live shell state pushed by the webview (debug builds only) via the
/// `debug_push_state` command. Last write wins; read by GET /state. Present
/// in release builds too (harmless: nothing serves it there) so lib.rs needs
/// no cfg gymnastics around `.manage()` / command registration.
#[derive(Default)]
pub struct BridgeState {
    inner: Mutex<Option<serde_json::Value>>,
}

impl BridgeState {
    pub fn push(&self, state: serde_json::Value) {
        let mut guard = self.inner.lock().expect("bridge state mutex poisoned");
        *guard = Some(state);
    }
}

#[cfg(debug_assertions)]
mod serve {
    use std::sync::Arc;

    use base64::Engine;
    use serde::Serialize;
    use serde_json::json;
    use tauri::AppHandle;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::BridgeState;

    /// Where the ephemeral port is published (same file the server-side
    /// dogfood helpers read): `<tmpdir>/hpath-debug-bridge.json`.
    fn port_file_path() -> std::path::PathBuf {
        std::env::temp_dir().join("hpath-debug-bridge.json")
    }

    #[derive(Serialize)]
    struct PortFile {
        port: u16,
        pid: u32,
    }

    /// Start the bridge (debug builds only). Binds 127.0.0.1:0, writes the
    /// port file, then serves forever on the tauri async runtime. Failure is
    /// logged and swallowed: the bridge is a dev tool, never a boot
    /// dependency.
    pub fn start(app_handle: AppHandle, state: Arc<BridgeState>) {
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                Ok(listener) => listener,
                Err(err) => {
                    eprintln!("[hpath-debug-bridge] failed to bind: {err}");
                    return;
                }
            };
            let port = listener
                .local_addr()
                .map(|addr| addr.port())
                .unwrap_or_default();
            let _ = std::fs::write(
                port_file_path(),
                serde_json::to_string(&PortFile {
                    port,
                    pid: std::process::id(),
                })
                .unwrap_or_default(),
            );
            println!(
                "[hpath-debug-bridge] listening on 127.0.0.1:{port} (state file: {})",
                port_file_path().display()
            );

            loop {
                let (mut socket, _peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(err) => {
                        eprintln!("[hpath-debug-bridge] accept failed: {err}");
                        continue;
                    }
                };
                let handle = app_handle.clone();
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    // One tiny GET per connection: read until the header
                    // block ends (no bodies on this surface).
                    let mut buf = Vec::with_capacity(1024);
                    let mut chunk = [0u8; 1024];
                    loop {
                        match socket.read(&mut chunk).await {
                            Ok(0) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&chunk[..n]);
                                if buf.windows(4).any(|w| w == b"\r\n\r\n")
                                    || buf.len() > 16 * 1024
                                {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let request = String::from_utf8_lossy(&buf);
                    let path = request
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let (status, body) = route(&handle, &state, &path).await;
                    let reason = match status {
                        200 => "OK",
                        404 => "Not Found",
                        503 => "Service Unavailable",
                        _ => "Error",
                    };
                    let payload =
                        serde_json::to_string(&body).unwrap_or_else(|_| "{}".into());
                    let response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.flush().await;
                    let _ = socket.shutdown().await;
                });
            }
        });
    }

    async fn route(
        _app: &AppHandle,
        state: &BridgeState,
        path: &str,
    ) -> (u16, serde_json::Value) {
        match path {
            "/health" => (200, json!({ "ok": true, "bridge": "hpath-debug-bridge/1" })),
            "/state" => {
                let mut snapshot = state_snapshot(state);
                snapshot["pid"] = json!(std::process::id());
                (200, snapshot)
            }
            "/screenshot" => match capture_window_png().await {
                Ok(bytes) => {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&bytes);
                    (
                        200,
                        json!({
                            "mime": "image/png",
                            "base64": encoded,
                            "bytes": bytes.len(),
                            "pid": std::process::id(),
                        }),
                    )
                }
                Err(err) => (503, json!({ "ok": false, "error": err })),
            },
            _ => (
                404,
                json!({ "ok": false, "error": format!("unknown path: {path}") }),
            ),
        }
    }

    fn state_snapshot(state: &BridgeState) -> serde_json::Value {
        state
            .inner
            .lock()
            .expect("bridge state mutex poisoned")
            .clone()
            .unwrap_or_else(|| json!({ "pushed": false }))
    }

    /// Capture the app's own on-screen window as PNG bytes (macOS).
    #[cfg(target_os = "macos")]
    async fn capture_window_png() -> Result<Vec<u8>, String> {
        let window_id = own_window_id()?;
        let dir = std::env::temp_dir();
        let path = dir.join(format!("hpath-bridge-window-{}.png", std::process::id()));
        let output = tokio::process::Command::new("screencapture")
            .arg("-x")
            .arg("-o")
            .arg("-l")
            .arg(window_id.to_string())
            .arg(&path)
            .output()
            .await
            .map_err(|err| format!("screencapture failed to launch: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "screencapture exited with {:?} (Screen Recording permission granted?)",
                output.status.code()
            ));
        }
        std::fs::read(&path).map_err(|err| format!("captured file unreadable: {err}"))
    }

    #[cfg(not(target_os = "macos"))]
    async fn capture_window_png() -> Result<Vec<u8>, String> {
        Err("window capture is macOS-only (T18 dogfood)".into())
    }

    /// Find this process's own on-screen window via CGWindowListCopyWindowInfo,
    /// filtered by pid. Returns the CGWindowID used by `screencapture -l`.
    #[cfg(target_os = "macos")]
    fn own_window_id() -> Result<u64, String> {
        use core_foundation::array::CFArray;
        use core_foundation::base::TCFType;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::{CFNumber, CFNumberRef};
        use core_graphics::display::kCGNullWindowID;
        use core_graphics::window::{
            CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGWindowNumber,
            kCGWindowOwnerPID,
        };

        /// Look up a CFNumber-valued key in a window-info dictionary.
        ///
        /// # Safety
        /// `key` must be a valid CFString static whose value is a CFNumber.
        unsafe fn number_for_key(
            dict: &CFDictionary,
            key: core_foundation::string::CFStringRef,
        ) -> Option<i64> {
            dict.find(key.cast())
                .map(|value| CFNumber::wrap_under_get_rule(*value as CFNumberRef).to_i64())
                .flatten()
        }

        let pid = std::process::id() as i64;
        // SAFETY: thread-safe system query returning the array under the
        // create rule; wrapped accordingly before use.
        let list: CFArray<CFDictionary> = unsafe {
            TCFType::wrap_under_create_rule(CGWindowListCopyWindowInfo(
                kCGWindowListOptionOnScreenOnly,
                kCGNullWindowID,
            ))
        };
        for entry in list.iter() {
            // SAFETY: documented window-info keys with CFNumber values.
            let owner_pid = unsafe { number_for_key(&entry, kCGWindowOwnerPID) };
            if owner_pid != Some(pid) {
                continue;
            }
            if let Some(id) = unsafe { number_for_key(&entry, kCGWindowNumber) } {
                return Ok(id as u64);
            }
        }
        Err("no on-screen window owned by this process found".into())
    }
}

#[cfg(debug_assertions)]
pub use serve::start;

#[cfg(not(debug_assertions))]
/// Release builds: the bridge is compiled out — nothing starts.
pub fn start(_app_handle: tauri::AppHandle, _state: std::sync::Arc<BridgeState>) {}
