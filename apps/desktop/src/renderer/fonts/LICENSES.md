# Bundled typefaces

Six typefaces ship inside the application so it renders identically on every
machine. **They are licensed separately from RefRain itself** — the SIL Open
Font License, not the GPL — and their terms travel with the font files.

The OFL permits bundling, redistribution, and modification. It requires that
the fonts not be sold on their own and that derivatives under a reserved name
be renamed. Nothing in it constrains what you write with them.

| Typeface | Role | Copyright | Licence |
|---|---|---|---|
| Chiron Sung HK | Chinese body text | © Chiron Fonts | SIL OFL 1.1 |
| Zen Kaku Gothic New | Japanese body text | © The Zen Kaku Gothic Project Authors | SIL OFL 1.1 |
| Antic Didone | Display / titles | © Santiago Orozco | SIL OFL 1.1 |
| Jost | Interface sans | © indestructible type* | SIL OFL 1.1 |
| Murecho | CJK-capable sans | © The Murecho Project Authors | SIL OFL 1.1 |
| Courier Prime | Monospace | © Quote-Unquote Apps | SIL OFL 1.1 |

Chinese and Japanese are separate faces because they are separate settings:
直, 骨 and 令 exist in both traditions and are drawn differently, so a single
CJK face renders one reader's characters in shapes they will call wrong.

Full licence text: <https://openfontlicense.org>

Sources:

- Chiron Sung HK — <https://github.com/chiron-fonts/chiron-sung-hk>
- Zen Kaku Gothic New — <https://github.com/googlefonts/zen-kakugothic>
- Antic Didone, Jost, Murecho, Courier Prime — <https://github.com/google/fonts>

The files here are subset to the ranges the application needs (CJK Unified
Ideographs, kana, CJK and fullwidth punctuation, Latin and Latin Extended-A).
Subsetting is a modification the OFL permits; the reserved names are unchanged
because the glyph outlines are not. None of the six declares a Reserved Font
Name, so no rename is owed — a face that did (KazukiReiwa, ChillDINGothic)
would have to ship under a new family name once subset.
