use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let os = env::var("CARGO_CFG_TARGET_OS").expect("Cargo 必须提供目标系统");
    if !matches!(os.as_str(), "macos" | "linux") {
        return;
    }
    let target = env::var("TARGET").expect("Cargo 必须提供目标平台");
    let source = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join(".cache/ripgrep")
        .join(&target);
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for name in ["rg", "LICENSE-ripgrep", "VERSION"] {
        let path = source.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        fs::copy(&path, output.join(name)).unwrap_or_else(|error| {
            panic!(
                "内置 ripgrep 资源未就绪：{error}；请先运行 node --use-env-proxy modules/agent/scripts/prepare-ripgrep.mjs {target}"
            )
        });
    }
}
