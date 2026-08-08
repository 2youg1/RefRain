// RefRain — 7 套主题的原生色表。
// 由 scripts/generate-themes.ts 生成，勿手改；改锚点后重跑该脚本。
//
// 色值由 THEMES 表的锚点推导而来：
// 推导走 derive() → srgb()。APCA 门槛（正文 |75|、界面与强调 |45|）在生成时
// 已经拦过，不达标的主题不会出现在这里。
//
// 每套只由四个锚点定义（纸・墨・印・副强调），其余全部推导。

const native_sdk = @import("native_sdk");
const Color = native_sdk.canvas.Color;
const ColorTokenOverrides = native_sdk.canvas.ColorTokenOverrides;

pub const Theme = struct {
    slug: []const u8,
    name: []const u8,
    night: bool,
    /// 供 SDK 控件使用的标准语义色，只覆盖 RefRain 定义过的字段。
    colors: ColorTokenOverrides,
    /// RefRain 自有语义色：--rail
    rail: Color,
    /// RefRain 自有语义色：--rail-ink
    rail_ink: Color,
    /// RefRain 自有语义色：--rail-faint
    rail_faint: Color,
    /// RefRain 自有语义色：--rail-rule
    rail_rule: Color,
    /// RefRain 自有语义色：--ink-faint
    ink_faint: Color,
    /// RefRain 自有语义色：--caret
    caret: Color,
    /// RefRain 自有语义色：--seal
    seal: Color,
    /// RefRain 自有语义色：--agent
    agent: Color,
    /// RefRain 自有语义色：--accepted
    accepted: Color,
    /// RefRain 自有语义色：--refused
    refused: Color,
    /// RefRain 自有语义色：--source
    source: Color,
    /// RefRain 自有语义色：--pending
    pending: Color,
};

pub const themes = [_]Theme{
    // 濤 · 日间 · 北斎《神奈川沖浪裏》
    .{
        .slug = "tou",
        .name = "濤",
        .night = false,
        .colors = .{
            .background = Color.rgb8(243, 237, 223),
            .surface = Color.rgb8(247, 242, 230),
            .surface_subtle = Color.rgb8(249, 243, 231),
            .surface_pressed = Color.rgb8(235, 228, 213),
            .text = Color.rgb8(25, 52, 92),
            .text_muted = Color.rgb8(64, 93, 137),
            .border = Color.rgb8(220, 212, 194),
            .accent = Color.rgb8(202, 77, 35),
            .accent_text = Color.rgb8(243, 237, 223),
            .destructive = Color.rgb8(152, 57, 56),
            .success = Color.rgb8(43, 108, 65),
            .warning = Color.rgb8(202, 77, 35),
            .info = Color.rgb8(38, 100, 129),
            .focus_ring = Color.rgb8(102, 0, 0),
            .disabled = Color.rgb8(144, 171, 212),
        },
        .rail = Color.rgb8(34, 59, 96),
        .rail_ink = Color.rgb8(212, 224, 240),
        .rail_faint = Color.rgb8(167, 181, 202),
        .rail_rule = Color.rgb8(52, 81, 124),
        .ink_faint = Color.rgb8(104, 133, 177),
        .caret = Color.rgb8(102, 0, 0),
        .seal = Color.rgb8(202, 77, 35),
        .agent = Color.rgb8(157, 119, 0),
        .accepted = Color.rgb8(43, 108, 65),
        .refused = Color.rgb8(152, 57, 56),
        .source = Color.rgb8(38, 100, 129),
        .pending = Color.rgb8(202, 77, 35),
    },
    // 霞 · 日间 · 新海誠・波子汽水
    .{
        .slug = "kasumi",
        .name = "霞",
        .night = false,
        .colors = .{
            .background = Color.rgb8(223, 245, 248),
            .surface = Color.rgb8(231, 249, 251),
            .surface_subtle = Color.rgb8(229, 248, 251),
            .surface_pressed = Color.rgb8(213, 237, 240),
            .text = Color.rgb8(11, 48, 73),
            .text_muted = Color.rgb8(52, 89, 116),
            .border = Color.rgb8(194, 221, 225),
            .accent = Color.rgb8(235, 114, 140),
            .accent_text = Color.rgb8(223, 245, 248),
            .destructive = Color.rgb8(152, 57, 56),
            .success = Color.rgb8(43, 108, 65),
            .warning = Color.rgb8(235, 114, 140),
            .info = Color.rgb8(38, 100, 129),
            .focus_ring = Color.rgb8(153, 0, 41),
            .disabled = Color.rgb8(133, 165, 190),
        },
        .rail = Color.rgb8(191, 223, 228),
        .rail_ink = Color.rgb8(9, 46, 70),
        .rail_faint = Color.rgb8(65, 93, 115),
        .rail_rule = Color.rgb8(169, 204, 209),
        .ink_faint = Color.rgb8(93, 128, 155),
        .caret = Color.rgb8(153, 0, 41),
        .seal = Color.rgb8(235, 114, 140),
        .agent = Color.rgb8(0, 147, 210),
        .accepted = Color.rgb8(43, 108, 65),
        .refused = Color.rgb8(152, 57, 56),
        .source = Color.rgb8(38, 100, 129),
        .pending = Color.rgb8(235, 114, 140),
    },
    // 砂 · 日间 · 枯山水
    .{
        .slug = "suna",
        .name = "砂",
        .night = false,
        .colors = .{
            .background = Color.rgb8(243, 241, 237),
            .surface = Color.rgb8(247, 246, 242),
            .surface_subtle = Color.rgb8(245, 243, 240),
            .surface_pressed = Color.rgb8(235, 233, 228),
            .text = Color.rgb8(64, 76, 65),
            .text_muted = Color.rgb8(105, 118, 106),
            .border = Color.rgb8(219, 216, 211),
            .accent = Color.rgb8(61, 102, 180),
            .accent_text = Color.rgb8(243, 241, 237),
            .destructive = Color.rgb8(152, 57, 56),
            .success = Color.rgb8(43, 108, 65),
            .warning = Color.rgb8(61, 102, 180),
            .info = Color.rgb8(38, 100, 129),
            .focus_ring = Color.rgb8(0, 26, 113),
            .disabled = Color.rgb8(185, 197, 186),
        },
        .rail = Color.rgb8(49, 63, 50),
        .rail_ink = Color.rgb8(218, 225, 218),
        .rail_faint = Color.rgb8(173, 184, 174),
        .rail_rule = Color.rgb8(68, 86, 70),
        .ink_faint = Color.rgb8(146, 159, 147),
        .caret = Color.rgb8(0, 26, 113),
        .seal = Color.rgb8(61, 102, 180),
        .agent = Color.rgb8(69, 128, 128),
        .accepted = Color.rgb8(43, 108, 65),
        .refused = Color.rgb8(152, 57, 56),
        .source = Color.rgb8(38, 100, 129),
        .pending = Color.rgb8(61, 102, 180),
    },
    // 桦 · 日间 · 桦木・木漏れ日
    .{
        .slug = "hua",
        .name = "桦",
        .night = false,
        .colors = .{
            .background = Color.rgb8(242, 237, 231),
            .surface = Color.rgb8(246, 242, 237),
            .surface_subtle = Color.rgb8(247, 243, 238),
            .surface_pressed = Color.rgb8(234, 228, 222),
            .text = Color.rgb8(65, 58, 49),
            .text_muted = Color.rgb8(107, 99, 89),
            .border = Color.rgb8(218, 212, 204),
            .accent = Color.rgb8(175, 112, 0),
            .accent_text = Color.rgb8(242, 237, 231),
            .destructive = Color.rgb8(152, 57, 56),
            .success = Color.rgb8(43, 108, 65),
            .warning = Color.rgb8(175, 112, 0),
            .info = Color.rgb8(38, 100, 129),
            .focus_ring = Color.rgb8(79, 4, 0),
            .disabled = Color.rgb8(184, 177, 168),
        },
        .rail = Color.rgb8(69, 57, 42),
        .rail_ink = Color.rgb8(228, 222, 214),
        .rail_faint = Color.rgb8(187, 179, 168),
        .rail_rule = Color.rgb8(91, 78, 60),
        .ink_faint = Color.rgb8(146, 139, 129),
        .caret = Color.rgb8(79, 4, 0),
        .seal = Color.rgb8(175, 112, 0),
        .agent = Color.rgb8(62, 119, 79),
        .accepted = Color.rgb8(43, 108, 65),
        .refused = Color.rgb8(152, 57, 56),
        .source = Color.rgb8(38, 100, 129),
        .pending = Color.rgb8(175, 112, 0),
    },
    // 侘 · 日间 · 青瓷・侘び
    .{
        .slug = "wabi",
        .name = "侘",
        .night = false,
        .colors = .{
            .background = Color.rgb8(234, 242, 236),
            .surface = Color.rgb8(240, 246, 242),
            .surface_subtle = Color.rgb8(239, 246, 241),
            .surface_pressed = Color.rgb8(225, 233, 227),
            .text = Color.rgb8(27, 51, 51),
            .text_muted = Color.rgb8(65, 91, 91),
            .border = Color.rgb8(208, 217, 211),
            .accent = Color.rgb8(0, 122, 52),
            .accent_text = Color.rgb8(234, 242, 236),
            .destructive = Color.rgb8(152, 57, 56),
            .success = Color.rgb8(43, 108, 65),
            .warning = Color.rgb8(0, 122, 52),
            .info = Color.rgb8(38, 100, 129),
            .focus_ring = Color.rgb8(0, 58, 0),
            .disabled = Color.rgb8(144, 167, 167),
        },
        .rail = Color.rgb8(40, 64, 64),
        .rail_ink = Color.rgb8(214, 225, 225),
        .rail_faint = Color.rgb8(168, 184, 184),
        .rail_rule = Color.rgb8(59, 86, 86),
        .ink_faint = Color.rgb8(105, 130, 130),
        .caret = Color.rgb8(0, 58, 0),
        .seal = Color.rgb8(0, 122, 52),
        .agent = Color.rgb8(93, 116, 157),
        .accepted = Color.rgb8(43, 108, 65),
        .refused = Color.rgb8(152, 57, 56),
        .source = Color.rgb8(38, 100, 129),
        .pending = Color.rgb8(0, 122, 52),
    },
    // 墨 · 夜间 · AI 业黑白・人文の朱
    .{
        .slug = "sumi",
        .name = "墨",
        .night = true,
        .colors = .{
            .background = Color.rgb8(28, 25, 21),
            .surface = Color.rgb8(31, 29, 26),
            .surface_subtle = Color.rgb8(34, 32, 29),
            .surface_pressed = Color.rgb8(22, 19, 15),
            .text = Color.rgb8(232, 230, 224),
            .text_muted = Color.rgb8(186, 183, 178),
            .border = Color.rgb8(47, 43, 38),
            .accent = Color.rgb8(246, 125, 81),
            .accent_text = Color.rgb8(28, 25, 21),
            .destructive = Color.rgb8(233, 129, 124),
            .success = Color.rgb8(115, 180, 132),
            .warning = Color.rgb8(255, 157, 113),
            .info = Color.rgb8(110, 171, 203),
            .focus_ring = Color.rgb8(255, 187, 134),
            .disabled = Color.rgb8(110, 108, 104),
        },
        .rail = Color.rgb8(16, 11, 5),
        .rail_ink = Color.rgb8(218, 217, 212),
        .rail_faint = Color.rgb8(177, 174, 168),
        .rail_rule = Color.rgb8(37, 31, 22),
        .ink_faint = Color.rgb8(147, 145, 140),
        .caret = Color.rgb8(255, 187, 134),
        .seal = Color.rgb8(246, 125, 81),
        .agent = Color.rgb8(175, 163, 144),
        .accepted = Color.rgb8(115, 180, 132),
        .refused = Color.rgb8(233, 129, 124),
        .source = Color.rgb8(110, 171, 203),
        .pending = Color.rgb8(255, 157, 113),
    },
    // 韶 · 夜间 · Blade Runner の雨夜・Edgerunners
    .{
        .slug = "shao",
        .name = "韶",
        .night = true,
        .colors = .{
            .background = Color.rgb8(19, 26, 39),
            .surface = Color.rgb8(23, 29, 40),
            .surface_subtle = Color.rgb8(26, 33, 45),
            .surface_pressed = Color.rgb8(12, 20, 34),
            .text = Color.rgb8(214, 226, 232),
            .text_muted = Color.rgb8(168, 179, 186),
            .border = Color.rgb8(34, 44, 62),
            .accent = Color.rgb8(0, 203, 199),
            .accent_text = Color.rgb8(19, 26, 39),
            .destructive = Color.rgb8(233, 129, 124),
            .success = Color.rgb8(115, 180, 132),
            .warning = Color.rgb8(71, 236, 231),
            .info = Color.rgb8(110, 171, 203),
            .focus_ring = Color.rgb8(58, 255, 255),
            .disabled = Color.rgb8(96, 104, 109),
        },
        .rail = Color.rgb8(1, 9, 35),
        .rail_ink = Color.rgb8(203, 220, 229),
        .rail_faint = Color.rgb8(154, 179, 193),
        .rail_rule = Color.rgb8(15, 31, 61),
        .ink_faint = Color.rgb8(131, 141, 147),
        .caret = Color.rgb8(58, 255, 255),
        .seal = Color.rgb8(0, 203, 199),
        .agent = Color.rgb8(255, 106, 101),
        .accepted = Color.rgb8(115, 180, 132),
        .refused = Color.rgb8(233, 129, 124),
        .source = Color.rgb8(110, 171, 203),
        .pending = Color.rgb8(71, 236, 231),
    },
};

/// 默认主题的下标。产品首次启动用它。
pub const default_index: usize = 0;

/// 按 slug 取主题；未知 slug 落到默认，与设置面板的行为一致。
pub fn bySlug(slug: []const u8) Theme {
    for (themes) |theme| {
        if (std.mem.eql(u8, theme.slug, slug)) return theme;
    }
    return themes[default_index];
}

const std = @import("std");
