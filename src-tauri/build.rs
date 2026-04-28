fn main() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=BUILD_TIMESTAMP=epoch{}", secs);
    println!("cargo:rerun-if-changed=src/lib.rs");
    tauri_build::build();
}
