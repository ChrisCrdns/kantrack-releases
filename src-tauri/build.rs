fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/login_item.m")
            .flag("-fobjc-arc")
            .compile("kantrack_login_item");
        println!("cargo:rustc-link-lib=framework=ServiceManagement");
    }

    tauri_build::build()
}
