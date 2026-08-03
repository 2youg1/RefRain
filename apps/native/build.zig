const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dep = b.dependency("native_sdk", .{});
    const artifacts = native_sdk.addAppArtifacts(b, dep, .{
        .name = "refrain",
        .main = "src/app_main.zig",
    });
    const manuscript_font = b.path("assets/fonts/NotoSansSC-Variable.ttf");
    artifacts.exe.root_module.addAnonymousImport("manuscript_font", .{ .root_source_file = manuscript_font });
    artifacts.tests.root_module.addAnonymousImport("manuscript_font", .{ .root_source_file = manuscript_font });

    const core_root = transpileCore(b, dep);
    const exe_core = b.createModule(.{
        .root_source_file = core_root,
        .target = artifacts.exe.root_module.resolved_target.?,
        .optimize = artifacts.exe.root_module.optimize.?,
    });
    const test_core = b.createModule(.{
        .root_source_file = core_root,
        .target = artifacts.tests.root_module.resolved_target.?,
        .optimize = artifacts.tests.root_module.optimize.?,
    });
    artifacts.exe.root_module.addImport("refrain_core", exe_core);
    const exe_runner = artifacts.exe.root_module.import_table.get("runner").?;
    artifacts.exe.root_module.addImport("app_manifest_zon", exe_runner.import_table.get("app_manifest_zon").?);
    artifacts.tests.root_module.addImport("refrain_core", test_core);
    const test_runner = artifacts.tests.root_module.import_table.get("runner").?;
    artifacts.tests.root_module.addImport("app_manifest_zon", test_runner.import_table.get("app_manifest_zon").?);

    const rust_host = b.addSystemCommand(&.{ "cargo", "build", "--manifest-path" });
    rust_host.addFileArg(b.path("../../Cargo.toml"));
    rust_host.addArgs(&.{ "-p", "refrain-native-host", "--release" });
    rust_host.addFileInput(b.path("../../Cargo.lock"));

    const stage_host = b.addSystemCommand(&.{"cp"});
    stage_host.step.dependOn(&rust_host.step);
    stage_host.addFileArg(b.path("../../target/release/librefrain_native_host.a"));
    const archive = stage_host.addOutputFileArg("librefrain_native_host.a");
    artifacts.exe.root_module.addObjectFile(archive);
    artifacts.tests.root_module.addObjectFile(archive);
    linkRustRuntime(artifacts.exe.root_module);
    linkRustRuntime(artifacts.tests.root_module);
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
        .windows => inline for ([_][]const u8{ "advapi32", "bcrypt", "kernel32", "ntdll", "userenv", "ws2_32" }) |library| {
            module.linkSystemLibrary(library, .{ .use_pkg_config = .no });
        },
        else => @panic("RefRain's stateful Native host does not support this target"),
    }
}

/// Reuse the SDK's pinned transpiler while retaining an app-owned runner for
/// the Rust host binding. JavaScript exists only in this build step.
fn transpileCore(b: *std.Build, dep: *std.Build.Dependency) std.Build.LazyPath {
    const node = b.findProgram(&.{"node"}, &.{}) catch @panic(
        "building RefRain's native core needs Node.js 22.15+ at build time",
    );
    const transpile = b.addSystemCommand(&.{node});
    transpile.addFileArg(dep.path("build/ts_run.mjs"));
    transpile.addFileArg(dep.path("packages/core/src/cli.ts"));
    transpile.addFileArg(b.path("src/core.ts"));
    transpile.addArg("-o");
    const emitted = transpile.addOutputFileArg("core.zig");
    transpile.addFileInput(b.path("src/generated/protocol.ts"));

    const staged = b.addWriteFiles();
    const core_root = staged.addCopyFile(emitted, "core.zig");
    _ = staged.addCopyFile(dep.path("packages/core/rt/rt.zig"), "rt.zig");
    return core_root;
}
