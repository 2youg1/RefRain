# Bundled font licences and attribution

RefRain ships eight font files. They are licensed separately from the GPL-3.0-only application code: each font remains under the SIL Open Font License, Version 1.1. The release places the complete OFL text beside this inventory and keeps RefRain's GPL text in a separate file.

| Packaged file | Typeface and role | Copyright notice embedded in the packaged font | Upstream |
|---|---|---|---|
| `ChironSungHK.woff2` | Chiron Sung HK; Chinese serif | © 2017-2024 Adobe (http://www.adobe.com/). | <https://github.com/chiron-fonts/chiron-sung-hk> |
| `NotoSansSC-Regular.woff2` | Noto Sans SC; Chinese sans | © 2014-2021 Adobe (http://www.adobe.com/). | <https://github.com/notofonts/noto-cjk> |
| `ShipporiMincho-Regular.woff2` | Shippori Mincho; Japanese mincho | Copyright 2021 The Shippori Mincho Project Authors (https://github.com/fontdasu/ShipporiMincho) | <https://github.com/googlefonts/shippori-mincho> |
| `ZenKakuGothicNew-Regular.woff2` | Zen Kaku Gothic New; Japanese gothic | Copyright 2022 The Zen Project Authors (https://github.com/googlefonts/zen-kakugothic) | <https://github.com/googlefonts/zen-kakugothic> |
| `Murecho.woff2` | Murecho; Japanese gothic and interface | Copyright 2021 The Murecho Project Authors (https://github.com/positype/Murecho-Project) | <https://github.com/positype/Murecho-Project> |
| `AnticDidone.woff2` | Antic Didone; display and titles | Copyright (c) 2011, Santiago Orozco (hi@typemade.mx), with Reserved Font Name Antic Didone. | <https://github.com/google/fonts/tree/main/ofl/anticdidone> |
| `Jost.woff2` | Jost; Latin interface sans | Copyright 2020 The Jost Project Authors (https://github.com/indestructible-type/Jost) | <https://github.com/indestructible-type/Jost> |
| `CourierPrime.woff2` | Courier Prime; monospace | Copyright 2015 The Courier Prime Project Authors (https://github.com/quoteunquoteapps/CourierPrime). | <https://github.com/quoteunquoteapps/CourierPrime> |

The copyright column reproduces name ID 0 from each packaged WOFF2, inspected on 2026-07-28. Every file also declares OFL 1.1 in name ID 13 and reports installable embedding (`OS/2.fsType = 0`). Antic Didone's notice declares its Reserved Font Name; any modified build must obey OFL clause 3 rather than assuming that no rename is required.

Chinese and Japanese retain separate serif and sans stacks because shared characters such as 直, 骨, and 令 have language-specific forms. This is a rendering decision, not a change to the fonts' licences.

## OFL text provenance

`OFL-1.1.txt` is the complete plaintext retrieved from SIL's official endpoint on 2026-07-28:

- <https://openfontlicense.org/documents/OFL.txt>
- SHA-256: `1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e`

The URL records provenance; it does not replace the packaged text. `electron-builder.yml` copies this inventory and the complete OFL into `resources/licenses/fonts/`, while RefRain's GPL text goes to `resources/licenses/RefRain-GPL-3.0.txt`. The application licence does not relicense the font files.
