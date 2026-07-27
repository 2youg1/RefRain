# Bundled typefaces

Eight typefaces ship inside the application so it renders identically on every
machine. **They are licensed separately from RefRain itself** — the SIL Open
Font License, not the GPL — and their terms travel with the font files.

The OFL permits bundling, redistribution, and modification. It requires that
the fonts not be sold on their own and that derivatives under a reserved name
be renamed. Nothing in it constrains what you write with them.

| Typeface | Role | Copyright | Licence |
|---|---|---|---|
| Chiron Sung HK | Chinese serif — the reading face | © Chiron Fonts | SIL OFL 1.1 |
| Noto Sans SC | Chinese sans, manuscript and interface | © The Noto Project Authors | SIL OFL 1.1 |
| Shippori Mincho | Japanese mincho — the reading face | © The Shippori Mincho Project Authors | SIL OFL 1.1 |
| Zen Kaku Gothic New | Japanese gothic | © The Zen Kaku Gothic Project Authors | SIL OFL 1.1 |
| Murecho | Japanese gothic, interface | © The Murecho Project Authors | SIL OFL 1.1 |
| Antic Didone | Display / titles | © Santiago Orozco | SIL OFL 1.1 |
| Jost | Latin interface sans | © indestructible type* | SIL OFL 1.1 |
| Courier Prime | Monospace | © Quote-Unquote Apps | SIL OFL 1.1 |

Chinese and Japanese have stacks of their own — a serif and a sans each —
because they are separate settings: 直, 骨 and 令 exist in both traditions and
are drawn differently, so a single CJK face renders one reader's characters in
shapes they will call wrong, and a writer quoting Japanese inside Chinese prose
needs both at once.

Japanese carries a mincho as well as a gothic because Japanese body text is set
in mincho; a gothic there is a display face, the way a grotesque is in Latin.
Murecho is listed under Japanese, which is what it is — it had been offered as a
Chinese option, and sat ahead of PingFang in the interface stack, so the whole
interface rendered Chinese in Japanese letterforms.

Full licence text: <https://openfontlicense.org>

Sources:

- Chiron Sung HK — <https://github.com/chiron-fonts/chiron-sung-hk>
- Noto Sans SC — <https://github.com/notofonts/noto-cjk>
- Shippori Mincho — <https://github.com/googlefonts/shippori-mincho>
- Zen Kaku Gothic New — <https://github.com/googlefonts/zen-kakugothic>
- Antic Didone, Jost, Murecho, Courier Prime — <https://github.com/google/fonts>

The files here are subset to the ranges the application needs (CJK Unified
Ideographs, kana, CJK and fullwidth punctuation, Latin and Latin Extended-A).
Subsetting is a modification the OFL permits; the reserved names are unchanged
because the glyph outlines are not. None of the eight declares a Reserved Font
Name, so no rename is owed — a face that did (KazukiReiwa, ChillDINGothic)
would have to ship under a new family name once subset, which means a family
nobody else's machine has ever heard of.

That is why the Chinese sans is Noto Sans SC rather than a proprietary face
with a friendlier weight range: the OFL cannot be withdrawn, and a licence that
can be is a dependency on somebody's continued goodwill. A typeface is not a
thing to have to replace in version three.
