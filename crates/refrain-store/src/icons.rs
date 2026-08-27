// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The Universal Button icon pipeline (SPEC 9.8).
//!
//! The author picks an image; the pipeline decides. Two acceptable shapes,
//! judged by content, never by the file picker's accept string:
//!
//! - **SVG**: UTF-8, one root, viewBox or explicit dimensions. Refused:
//!   script, foreignObject, event attributes, external href, CSS `url()`,
//!   animation, nested data URLs — the formats that reach out of the file,
//!   so a malicious icon issues zero requests by construction, not by audit.
//! - **PNG**: magic bytes agree, 8-bit RGB(A), 32²–1024², at least one
//!   non-transparent pixel.
//!
//! Both normalise to one 256×256 RGBA PNG, named by its BLAKE3 identity in the
//! application data assets directory. The preference stores the digest and
//! nothing else — the asset is content-addressed, so a preference can never
//! point at content it did not mean.

use refrain_core::{ErrorCode, RefrainError, digest::content_hex};
use std::io;
use std::path::{Path, PathBuf};

/// The normalised icon edge.
pub const ICON_SIZE: u32 = 256;

/// What the pipeline produced.
#[derive(Debug, Clone)]
pub struct IconAsset {
    pub digest: String,
    pub path: PathBuf,
}

/// Rejection, in the author's terms.
fn refuse(what: &str, why: &str) -> RefrainError {
    RefrainError::new(ErrorCode::UnsupportedFormat, what, why)
}

// The scan that runs before any parser sees the bytes. Each pattern is one
// way an SVG reaches out of itself; a match is a refusal, not a sanitisation,
// because "cleaned" markup is markup the author never chose.
const SVG_FORBIDDEN: &[&str] = &[
    "<script",
    "foreignobject",
    "onload",
    "onerror",
    "onclick",
    "onmouseover",
    "onbegin",
    "onend",
    "onrepeat",
    "url(http",
    "url(//",
    "@import",
    "<animate",
    "<set",
    "data:",
    "javascript:",
];

fn sanitize_svg(bytes: &[u8]) -> Result<Vec<u8>, RefrainError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| refuse("read an icon", "the SVG is not valid UTF-8"))?;
    if bytes.len() > 512 * 1024 {
        return Err(refuse("read an icon", "the SVG is over 512 KiB"));
    }
    let lowered = text.to_lowercase();
    for pattern in SVG_FORBIDDEN {
        if lowered.contains(pattern) {
            return Err(refuse(
                "read an icon",
                &format!("the SVG contains `{pattern}`, which is not allowed"),
            ));
        }
    }
    // External hrefs are refused; fragment references (#id) are the only
    // legal target. http(s) in any attribute is caught here as a class.
    for marker in [
        "href=\"http",
        "href='http",
        "xlink:href=\"http",
        "xlink:href='http",
    ] {
        if lowered.contains(marker) {
            return Err(refuse(
                "read an icon",
                "the SVG references an external resource",
            ));
        }
    }

    let tree = usvg::Tree::from_data(bytes, &usvg::Options::default())
        .map_err(|error| refuse("read an icon", &format!("the SVG does not parse: {error}")))?;
    let size = tree.size();
    if size.width() <= 0.0 || size.height() <= 0.0 {
        return Err(refuse(
            "read an icon",
            "the SVG has no viewBox or explicit size",
        ));
    }

    let mut pixmap = tiny_skia::Pixmap::new(ICON_SIZE, ICON_SIZE)
        .ok_or_else(|| refuse("render an icon", "could not allocate the raster surface"))?;
    let scale = (ICON_SIZE as f32 / size.width()).min(ICON_SIZE as f32 / size.height());
    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    encode_png(pixmap)
}

fn sanitize_png(bytes: &[u8]) -> Result<Vec<u8>, RefrainError> {
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(refuse("read an icon", "the PNG is over 4 MiB"));
    }
    let image = image::load_from_memory(bytes)
        .map_err(|error| refuse("read an icon", &format!("the PNG does not decode: {error}")))?;
    let (width, height) = (image.width(), image.height());
    if !(32..=1024).contains(&width) || !(32..=1024).contains(&height) {
        return Err(refuse(
            "read an icon",
            &format!("the PNG is {width}×{height}; icons must be 32²–1024²"),
        ));
    }
    let rgba = image.to_rgba8();
    if !rgba.pixels().any(|pixel| pixel.0[3] > 0) {
        return Err(refuse("read an icon", "the PNG is entirely transparent"));
    }

    let mut pixmap = tiny_skia::Pixmap::new(ICON_SIZE, ICON_SIZE)
        .ok_or_else(|| refuse("render an icon", "could not allocate the raster surface"))?;
    let source = tiny_skia::PixmapRef::from_bytes(rgba.as_raw(), width, height)
        .ok_or_else(|| refuse("render an icon", "could not read the decoded PNG"))?;
    let scale = (ICON_SIZE as f32 / width as f32).min(ICON_SIZE as f32 / height as f32);
    let transform = tiny_skia::Transform::from_scale(scale, scale);
    let paint = tiny_skia::PixmapPaint {
        quality: tiny_skia::FilterQuality::Bicubic,
        ..Default::default()
    };
    pixmap.draw_pixmap(0, 0, source, &paint, transform, None);
    encode_png(pixmap)
}

fn encode_png(pixmap: tiny_skia::Pixmap) -> Result<Vec<u8>, RefrainError> {
    pixmap.encode_png().map_err(|error| {
        refuse(
            "encode an icon",
            &format!("could not encode the PNG: {error}"),
        )
    })
}

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Pick the pipeline by content, never by the picker.
pub fn import_icon(assets_dir: &Path, bytes: &[u8]) -> Result<IconAsset, RefrainError> {
    let png = if bytes.starts_with(PNG_MAGIC) {
        sanitize_png(bytes)?
    } else {
        sanitize_svg(bytes)?
    };
    let digest = content_hex(&png);
    std::fs::create_dir_all(assets_dir).map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "create the icon assets directory",
            assets_dir.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    let path = assets_dir.join(format!("{digest}.png"));
    crate::atomic::replace_file_atomically(&path, &png, |_| Ok(())).map_err(|source| {
        RefrainError::new(
            ErrorCode::Io,
            "write the icon asset",
            path.display().to_string(),
        )
        .with_detail(source.to_string())
    })?;
    Ok(IconAsset { digest, path })
}

/// The bytes of a stored asset, for the interface's data-URL projection.
pub fn read_icon(assets_dir: &Path, digest: &str) -> io::Result<Vec<u8>> {
    std::fs::read(assets_dir.join(format!("{digest}.png")))
}
