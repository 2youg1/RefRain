import { readFileSync } from "node:fs";

const failures: string[] = [];
const digestOwner = "crates/refrain-core/src/digest.rs";
const rustGlobs = [
  "crates/refrain-core/src/**/*.rs",
  "crates/refrain-host/src/**/*.rs",
  "crates/refrain-store/src/**/*.rs",
  "crates/refrain-app/src/**/*.rs",
  "apps/desktop/src-tauri/src/**/*.rs",
] as const;
const rustFiles = new Set<string>();
for (const pattern of rustGlobs) {
  for await (const file of new Bun.Glob(pattern).scan({ cwd: ".", onlyFiles: true })) {
    rustFiles.add(file.replaceAll("\\", "/"));
  }
}
for (const file of rustFiles) {
  const source = readFileSync(file, "utf8");
  if (/sha2::|Sha256/.test(source)) failures.push(`${file}: retains SHA-256 product code`);
  if (file !== digestOwner && /blake3::/.test(source)) {
    failures.push(`${file}: bypasses ${digestOwner}`);
  }
}

const manifests = [
  "Cargo.toml",
  "crates/refrain-core/Cargo.toml",
  "apps/desktop/src-tauri/Cargo.toml",
  "crates/refrain-host/Cargo.toml",
  "crates/refrain-store/Cargo.toml",
] as const;
for (const file of manifests) {
  if (/^sha2\s*=/m.test(readFileSync(file, "utf8"))) {
    failures.push(`${file}: retains a product SHA-256 dependency`);
  }
}
for (const file of manifests.slice(2)) {
  if (/^blake3\s*=/m.test(readFileSync(file, "utf8"))) {
    failures.push(`${file}: depends on BLAKE3 instead of the core identity owner`);
  }
}

const requiredOwners = [
  ["crates/refrain-core/src/source_layout.rs", "content_bytes"],
  ["crates/refrain-core/src/context_compiler.rs", "content_hex"],
  ["crates/refrain-store/src/project.rs", "content_hex"],
  ["crates/refrain-store/src/ingest.rs", "content_hex"],
  ["crates/refrain-store/src/icons.rs", "content_hex"],
  ["crates/refrain-store/src/materials.rs", "content_hex"],
  ["crates/refrain-store/src/migrate.rs", "content_hex"],
  ["crates/refrain-host/src/staging.rs", "content_hex"],
  // 收取一次派发时算的 artifact 摘要，随用例一起搬出了装配层。
  ["crates/refrain-app/src/collect.rs", "content_hex"],
] as const;
for (const [file, primitive] of requiredOwners) {
  if (!readFileSync(file, "utf8").includes(primitive)) {
    failures.push(`${file}: no longer uses ${primitive}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exit(1);
}
console.log(
  `PASS  verify:digest-authority  (${rustFiles.size} Rust files; one BLAKE3 identity owner, no product SHA-256)`,
);
