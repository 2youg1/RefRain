const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dep = b.dependency("native_sdk", .{});
    const artifacts = native_sdk.addAppArtifacts(b, dep, .{
        .name = "refrain",
        .main = "src/app_main.zig",
    });
    // 界面与正文共用的 CJK 字面。它是**编译输入**而不是运行时资产：
    // `addAnonymousImport` 把字节嵌进可执行文件，运行时从不读这个路径。
    // 放在 `fonts/` 而不是 `assets/` 是有硬理由的——`native package` 的资产
    // 打包器逐个 slurp 每份资产，单文件上限 16 MiB，而这份字面 17.7 MiB，
    // 放在 assets 下会让打包以 `StreamTooLong` 失败；而且它已经在二进制里，
    // 再拷一份进安装包等于凭空多 17 MiB。分发许可 `assets/fonts/OFL.txt`
    // 仍随包走（OFL 要求许可与字面同行）。
    const manuscript_font = b.path("fonts/NotoSansSC-Variable.ttf");
    artifacts.exe.root_module.addAnonymousImport("manuscript_font", .{ .root_source_file = manuscript_font });
    artifacts.tests.root_module.addAnonymousImport("manuscript_font", .{ .root_source_file = manuscript_font });
    // 三槽的另外两张：Latin 用 Antic Didone，日文用 Zen Kaku Gothic New。
    // 嵌入即注册（app_main.zig 的 fonts 表），SDK 一个文本节点一张字面，
    // 逐字回退要 SDK 支持后才能在正稿上生效——目前它们是已注册的可用面。
    const latin_font = b.path("fonts/NotoSansSC-Variable.ttf");
    const japanese_font = b.path("fonts/ZenKakuGothicNew-Regular.ttf");
    artifacts.exe.root_module.addAnonymousImport("latin_font", .{ .root_source_file = latin_font });
    artifacts.exe.root_module.addAnonymousImport("japanese_font", .{ .root_source_file = japanese_font });
    artifacts.tests.root_module.addAnonymousImport("latin_font", .{ .root_source_file = latin_font });
    artifacts.tests.root_module.addAnonymousImport("japanese_font", .{ .root_source_file = japanese_font });

    // 单元 13 之前这里登台一个 TS 核心（`appTsCoreStage`：前端检查、corewire 镜像、
    // ScriptC 归档），把转译后的 `core.ts` 以 `refrain_core` 接进 exe 与 tests。
    // 状态机现在是 `src/core.zig`，没有第二个核心可登，那一整块连同它拉进来的
    // ScriptC 工具链一起消失。`addAppArtifacts` 本来就把这棵树按 Zig 核心处理。
    const exe_runner = artifacts.exe.root_module.import_table.get("runner").?;
    artifacts.exe.root_module.addImport("app_manifest_zon", exe_runner.import_table.get("app_manifest_zon").?);
    const test_runner = artifacts.tests.root_module.import_table.get("runner").?;
    artifacts.tests.root_module.addImport("app_manifest_zon", test_runner.import_table.get("app_manifest_zon").?);

    const host_os = artifacts.exe.root_module.resolved_target.?.result.os.tag;
    const rust_host = b.addSystemCommand(&.{ "cargo", "build", "--manifest-path" });
    rust_host.addFileArg(b.path("../../Cargo.toml"));
    rust_host.addArgs(&.{ "-p", "refrain-native-host", "--release" });
    // Native SDK's Windows host is a Zig/MinGW C++ graph. Cargo must emit the
    // matching GNU COFF archive instead of the runner's default MSVC archive;
    // mixing them either requests MSVCRT import archives that Zig does not own
    // or mixes MSVC headers with Zig libc++.
    const rust_target: ?[]const u8 = if (host_os == .windows)
        "x86_64-pc-windows-gnu"
    else
        null;
    if (rust_target) |target| rust_host.addArgs(&.{ "--target", target });
    rust_host.addFileInput(b.path("../../Cargo.lock"));

    const archive_name = "librefrain_native_host.a";
    const archive_path = if (rust_target) |target|
        b.fmt("../../target/{s}/release/{s}", .{ target, archive_name })
    else
        b.fmt("../../target/release/{s}", .{archive_name});

    // 用 zig 自己的 WriteFiles 拷归档而不是 system 的 `cp`：Windows 的
    // 构建环境里没有 coreutils，归档一旦过期（协议变更触发 cargo 重建）
    // cp 就找不到，整个链接链断在一个与代码无关的地方。
    const stage_host = b.addWriteFiles();
    stage_host.step.dependOn(&rust_host.step);
    const archive = stage_host.addCopyFile(b.path(archive_path), archive_name);
    artifacts.exe.root_module.addObjectFile(archive);
    linkRustRuntime(artifacts.exe.root_module);
    // `native build -Doptimize=ReleaseFast` reuses the executable module as
    // the test module (SDK build/app.zig:609). Adding the archive and runtime
    // libraries to both then puts the same staticlib on ONE link line twice;
    // lld extracts Rust's compiler_builtins twice and reports duplicate
    // __udivti3/__divti3. Only configure the second module when it is actually
    // distinct (Debug `native test` is the common case).
    if (artifacts.tests.root_module != artifacts.exe.root_module) {
        artifacts.tests.root_module.addObjectFile(archive);
        linkRustRuntime(artifacts.tests.root_module);
    }

    if (host_os == .windows) {
        // Zig 0.16 ships Propsys/OleAut32/DbgHelp import libraries but not
        // RuntimeObject. Rust std needs one symbol, RoGetActivationFactory,
        // whose implementation lives in combase.dll (RuntimeObject.dll only
        // forwards there and is absent on some installs), so the import
        // library names combase directly.
        const runtimeobject = b.addSystemCommand(&.{ "zig", "dlltool", "-d" });
        runtimeobject.addFileArg(b.path("build-inputs/windows/runtimeobject.def"));
        runtimeobject.addArg("-l");
        const runtimeobject_archive = runtimeobject.addOutputFileArg("libruntimeobject.a");
        runtimeobject.addArgs(&.{ "-m", "i386:x86-64" });
        artifacts.exe.root_module.addObjectFile(runtimeobject_archive);
        if (artifacts.tests.root_module != artifacts.exe.root_module) {
            artifacts.tests.root_module.addObjectFile(runtimeobject_archive);
        }
    }
}

/// Cargo reports these Linux native-static-libs for the stateful Rust archive.
/// Other platform sets stay explicit so a new target fails at its actual seam.
fn linkRustRuntime(module: *std.Build.Module) void {
    module.linkSystemLibrary("c", .{});
    switch (module.resolved_target.?.result.os.tag) {
        .linux => inline for ([_][]const u8{ "gcc_s", "util", "rt", "pthread", "m", "dl" }) |library| {
            module.linkSystemLibrary(library, .{ .use_pkg_config = .no });
        },
        .macos => inline for ([_][]const u8{ "System", "resolv", "m" }) |library| {
            module.linkSystemLibrary(library, .{ .use_pkg_config = .no });
        },
        .windows => inline for ([_][]const u8{
            "advapi32",
            "bcrypt",
            "dbghelp",
            // 编译核心归档带 scriptc 运行时：scr_os_ifaddrs 引用
            // GetAdaptersAddresses，它住在 iphlpapi。
            "iphlpapi",
            "kernel32",
            "ntdll",
            "ole32",
            "oleaut32",
            "propsys",
            "userenv",
            "ws2_32",
        }) |library| {
            module.linkSystemLibrary(library, .{ .use_pkg_config = .no });
        },
        else => @panic("RefRain's stateful Native host does not support this target"),
    }
    if (module.resolved_target.?.result.os.tag == .windows) {
        // Rust 的 GNU 静态库引用 libgcc 的 SEH unwinding（_Unwind_* 与
        // _GCC_specific_handler）。它不是 Windows 系统库而是 toolchain 运行时，
        // 由 Zig 自带的 libunwind 提供。
        module.linkSystemLibrary("unwind", .{ .use_pkg_config = .no });
    }
}
