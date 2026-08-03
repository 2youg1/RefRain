const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dep = b.dependency("native_sdk", .{});
    const artifacts = native_sdk.addAppArtifacts(b, dep, .{
        .name = "refrain",
        .main = "src/app_main.zig",
    });

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

    const rust_host = b.addSystemCommand(&.{
        "rustc", "--edition=2024", "--crate-type=staticlib", "-C", "panic=abort", "-O",
    });
    rust_host.addFileArg(b.path("host/src/staticlib.rs"));
    // Step 4 deletes this source include when the archive moves to Cargo-linked,
    // stateful refrain-app use cases. Until then both builds execute one owner.
    rust_host.addFileInput(b.path("../../crates/refrain-app/src/native.rs"));
    rust_host.addArg("-o");
    const archive = rust_host.addOutputFileArg("librefrain_native_host.a");
    artifacts.exe.root_module.addObjectFile(archive);
    artifacts.tests.root_module.addObjectFile(archive);
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
