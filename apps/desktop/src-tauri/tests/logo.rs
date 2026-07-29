use std::collections::HashSet;
use std::path::PathBuf;

#[test]
fn packaged_logo_is_square_visible_and_not_a_solid_placeholder() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png");
    let image = image::open(path).expect("decode the packaged application icon");
    assert_eq!((image.width(), image.height()), (512, 512));

    let colors = image
        .into_rgba8()
        .pixels()
        .map(|pixel| pixel.0)
        .collect::<HashSet<_>>();
    assert!(
        colors.len() > 3,
        "the application icon must contain the mark, not one solid color"
    );
}
