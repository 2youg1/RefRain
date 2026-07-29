//! The fixture child for `refrain_host::process` tests. Cargo builds examples
//! for `cargo test`; this binary never ships with a release.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--echo") => print!("{}", args.get(1).map(String::as_str).unwrap_or("")),
        Some("--exit") => {
            std::process::exit(args.get(1).and_then(|n| n.parse().ok()).unwrap_or(1));
        }
        Some("--env-of") => print!(
            "{}",
            std::env::var(args.get(1).map(String::as_str).unwrap_or(""))
                .unwrap_or_else(|_| "<unset>".to_string())
        ),
        Some("--sleep") => std::thread::sleep(std::time::Duration::from_secs(
            args.get(1).and_then(|n| n.parse().ok()).unwrap_or(60),
        )),
        Some("--argv-count") => print!("{}", args.len()),
        _ => std::process::exit(2),
    }
}
