fn main() {
    // Rebuild the Tauri binary when frontend sources or built assets change.
    // This prevents stale UI inside src-tauri/target/debug when Rust code is unchanged.
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../index.html");
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
