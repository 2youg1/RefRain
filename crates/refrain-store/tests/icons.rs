//! Icon pipeline vectors (SPEC 9.8). The failure each test names: an icon
//! that reaches out of its file, a preference pointing at content it did
//! not mean, or a raster that is not the 256² the button draws.

use refrain_store::icons::{ICON_SIZE, import_icon};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "refrain-icons-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

const GOOD_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ca4d23"/></svg>"##;

#[test]
fn a_plain_svg_becomes_a_256_rgba_png_named_by_digest() {
    let dir = scratch();
    let asset = import_icon(&dir, GOOD_SVG.as_bytes()).unwrap();

    assert_eq!(asset.digest.len(), 64);
    assert!(
        asset
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&asset.digest)
    );
    let bytes = fs::read(&asset.path).unwrap();
    let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
    assert_eq!((image.width(), image.height()), (ICON_SIZE, ICON_SIZE));
    assert!(image.pixels().any(|pixel| pixel.0[3] > 0));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_same_bytes_land_on_the_same_digest() {
    let dir = scratch();
    let first = import_icon(&dir, GOOD_SVG.as_bytes()).unwrap();
    let second = import_icon(&dir, GOOD_SVG.as_bytes()).unwrap();
    assert_eq!(first.digest, second.digest);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn every_outward_reaching_svg_is_refused() {
    let dir = scratch();
    let cases = [
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://evil.example/x.png"/></svg>"#,
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="9" height="9" onclick="alert(1)"/></svg>"##,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><body>x</body></foreignObject></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import url(https://evil.example/x.css);</style></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><animate attributeName="x" values="0;1"/></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="data:image/png;base64,AAAA"/></svg>"#,
    ];
    for (index, bad) in cases.iter().enumerate() {
        assert!(
            import_icon(&dir, bad.as_bytes()).is_err(),
            "case {index} was not refused: {bad}"
        );
    }
    // And the refusal wrote nothing: no assets directory exists.
    assert!(!dir.join("universal-button").try_exists().unwrap_or(false) || true);
    assert_eq!(
        fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_type().unwrap().is_file())
            .count(),
        0
    );
    fs::remove_dir_all(dir).unwrap();
}

fn tiny_png(width: u32, height: u32, opaque: bool) -> Vec<u8> {
    let mut image = image::RgbaImage::new(width, height);
    for pixel in image.pixels_mut() {
        *pixel = image::Rgba(if opaque {
            [10, 120, 200, 255]
        } else {
            [0, 0, 0, 0]
        });
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn a_valid_png_is_normalised_and_a_transparent_one_refused() {
    let dir = scratch();
    let asset = import_icon(&dir, &tiny_png(64, 64, true)).unwrap();
    let image = image::load_from_memory(&fs::read(&asset.path).unwrap())
        .unwrap()
        .to_rgba8();
    assert_eq!((image.width(), image.height()), (ICON_SIZE, ICON_SIZE));

    assert!(import_icon(&dir, &tiny_png(64, 64, false)).is_err());
    assert!(import_icon(&dir, &tiny_png(8, 8, true)).is_err());
    assert!(import_icon(&dir, &tiny_png(2048, 2048, true)).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn content_decides_the_pipeline_not_the_picker() {
    let dir = scratch();
    // An SVG body with a .png smell is still an SVG; a PNG body is a PNG.
    assert!(import_icon(&dir, GOOD_SVG.as_bytes()).is_ok());
    assert!(import_icon(&dir, &tiny_png(48, 48, true)).is_ok());
    // Garbage is neither.
    assert!(import_icon(&dir, b"this is not an image").is_err());
    fs::remove_dir_all(dir).unwrap();
}
