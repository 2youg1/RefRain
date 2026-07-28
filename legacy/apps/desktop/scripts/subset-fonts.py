#!/usr/bin/env python3
"""Subset and compress the bundled typefaces.

Chiron Sung HK ships at 78 MB because it covers the full HK glyph set including
rare and historical forms. A writing application needs the characters people
actually write, so the face is subset to the common ranges and converted to
WOFF2 — the same glyphs at a fraction of the size.

The unicode ranges are stated rather than guessed:
  - GB/T 2312 level 1+2 via CJK Unified Ideographs (the working set)
  - CJK punctuation, fullwidth forms, and the vertical presentation forms
  - Latin, digits, and the punctuation Chinese prose actually borrows
"""

import subprocess
import sys
from pathlib import Path

FONT_DIR = Path(__file__).resolve().parent.parent / "src" / "renderer" / "fonts"

# Ranges kept in the CJK face. Everything outside these falls back to a system
# font, which is the correct behaviour for a character nobody types.
CJK_RANGES = ",".join(
    [
        "U+0020-007E",  # Latin, digits, ASCII punctuation
        "U+00A0-00FF",  # Latin-1 supplement
        "U+2010-2027",  # dashes, quotes, ellipsis
        "U+2030-205E",  # per-mille, primes, reference marks
        "U+3000-303F",  # CJK symbols and punctuation
        "U+3040-30FF",  # kana, for Japanese quotation inside Chinese text
        "U+4E00-9FFF",  # CJK Unified Ideographs
        "U+FE10-FE19",  # vertical punctuation
        "U+FF00-FFEF",  # fullwidth forms
    ]
)

LATIN_RANGES = ",".join(
    [
        "U+0020-007E",
        "U+00A0-00FF",
        "U+0100-017F",  # Latin Extended-A
        "U+2010-2027",
        "U+2030-205E",
        "U+20A0-20BF",  # currency
        "U+2100-214F",  # letterlike symbols
    ]
)

# Japanese has a stack of its own — a gothic and a mincho — rather than one
# slot borrowed from the Chinese side. 直, 骨 and 令 exist in both traditions
# and are drawn differently, so a single CJK face renders one reader's
# characters in shapes they will call wrong; and a writer setting Japanese body
# text needs a mincho, because a gothic is a display face there the way a
# grotesque is in Latin.
#
# Murecho moved to this list. It is a Japanese sans, and it had been offered as
# a Chinese option while also sitting ahead of PingFang and Microsoft YaHei in
# the interface stack — so the whole interface rendered Chinese in Japanese
# letterforms.
JP_RANGES = ",".join(
    [
        "U+0020-007E",
        "U+00A0-00FF",
        "U+2010-2027",
        "U+2030-205E",
        "U+3000-303F",
        "U+3040-30FF",  # hiragana and katakana
        "U+31F0-31FF",  # katakana phonetic extensions
        "U+4E00-9FFF",
        "U+FE10-FE19",
        "U+FF00-FFEF",
    ]
)

JOBS = [
    ("ChironSungHK.ttf", CJK_RANGES),
    ("NotoSansSC-Regular.otf", CJK_RANGES),
    ("ZenKakuGothicNew-Regular.ttf", JP_RANGES),
    ("ShipporiMincho-Regular.ttf", JP_RANGES),
    ("Murecho.ttf", JP_RANGES),
    ("Jost.ttf", LATIN_RANGES),
    ("AnticDidone.ttf", LATIN_RANGES),
    ("CourierPrime.ttf", LATIN_RANGES),
]


missing: list[str] = []


def subset(name: str, ranges: str) -> None:
    source = FONT_DIR / name
    # `.otf` and `.ttf` both become `.woff2`; `with_suffix` handles either.
    target = source.with_suffix(".woff2")
    if not source.exists():
        # Already subset on a previous run is fine; never converted is not.
        if target.exists():
            print(f"  {name:30} already subset")
        else:
            print(f"  MISSING {name}")
            missing.append(name)
        return

    before = source.stat().st_size
    subprocess.run(
        [
            sys.executable,
            "-m",
            "fontTools.subset",
            str(source),
            f"--unicodes={ranges}",
            "--flavor=woff2",
            f"--output-file={target}",
            "--layout-features=*",
            "--no-hinting",
            "--desubroutinize",
            "--drop-tables+=DSIG",
            "--name-IDs=*",
        ],
        check=True,
        capture_output=True,
    )
    after = target.stat().st_size
    print(f"  {name:22} {before // 1024:>7} KB -> {after // 1024:>6} KB  ({after * 100 // before}%)")
    source.unlink()


# Chiron Sung HK also carries a second variable axis, PADG, which nothing in
# this application drives. Dropping it costs 5.5 MB and no capability:
#
#   python3 -m fontTools.varLib.instancer ChironSungHK.woff2 PADG=0 \
#       --output=ChironSungHK.woff2
#
# Verified rather than assumed — 21,706 glyphs before and after, wght still
# 200..900, and 直 骨 令 雨 漢 字 all still present. The step is not in JOBS
# because the shipped file is already instanced; it is written down so the next
# person to re-fetch the face knows what to redo.

print("Subsetting bundled typefaces")
for name, ranges in JOBS:
    subset(name, ranges)

# Exiting 0 with a face missing is how the application shipped announcing five
# typefaces and rendering four. A build step that cannot fail is not a step.
if missing:
    print(f"FAIL  {len(missing)} typeface(s) neither present nor already subset: {', '.join(missing)}")
    sys.exit(1)

print("Done.")
