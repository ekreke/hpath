fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri_build::build();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")?;
    let proto = std::path::Path::new(&manifest_dir).join("../../../proto/hpath/v1/hpath.proto");
    let includes = std::path::Path::new(&manifest_dir).join("../../../proto");

    tonic_build::configure()
        .compile_protos(&[proto.to_str().unwrap()], &[includes.to_str().unwrap()])
        .expect("Failed to compile protos");

    println!(
        "cargo:rerun-if-changed={}",
        std::path::Path::new(&manifest_dir)
            .join("../../../proto/hpath/v1/hpath.proto")
            .display()
    );
    Ok(())
}
