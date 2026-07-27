import { parse } from "yaml";

type Mapping = Record<string, unknown>;

export const validateReleaseWorkflow = (source: string): string[] => {
  const errors: string[] = [];
  let workflow: unknown;
  try {
    workflow = parse(source);
  } catch (error) {
    return [`release workflow is not valid YAML: ${String(error)}`];
  }

  const stack: unknown[] = [workflow];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;

    const mapping = value as Mapping;
    const uses = mapping.uses;
    if (typeof uses === "string" && !uses.startsWith("./")) {
      const separator = uses.lastIndexOf("@");
      const ref = separator < 0 ? "" : uses.slice(separator + 1);
      if (!/^[0-9a-f]{40}$/.test(ref)) {
        errors.push(`${uses} must use a verified 40-character commit SHA`);
      }
    }
    stack.push(...Object.values(mapping));
  }

  const root = workflow as Mapping;
  const jobs = root.jobs as Mapping | undefined;
  const publish = jobs?.publish as Mapping | undefined;
  const steps = publish?.steps;
  if (!Array.isArray(steps)) {
    errors.push("publish job must contain release steps");
    return errors;
  }

  const mappings = steps.filter(
    (step): step is Mapping => step !== null && typeof step === "object" && !Array.isArray(step),
  );
  const checksumIndex = mappings.findIndex(
    (step) => typeof step.run === "string" && step.run.includes("SHA256SUMS"),
  );
  const releaseIndex = mappings.findIndex(
    (step) => typeof step.uses === "string" && step.uses.startsWith("softprops/action-gh-release@"),
  );

  if (checksumIndex < 0) {
    errors.push("publish job must generate and verify SHA256SUMS");
  } else {
    const checksum = mappings[checksumIndex];
    const run = checksum.run as string;
    if (checksum["working-directory"] !== "release-assets") {
      errors.push("SHA256SUMS must be generated inside release-assets");
    }
    if (!run.includes("sha256sum") || !run.includes("*.exe") || !run.includes("> SHA256SUMS")) {
      errors.push("SHA256SUMS must cover every published installer");
    }
    if (!run.includes("sha256sum --check SHA256SUMS")) {
      errors.push("SHA256SUMS must be read back with sha256sum --check before publication");
    }
  }

  if (releaseIndex < 0) {
    errors.push("publish job must use softprops/action-gh-release");
  } else {
    const release = mappings[releaseIndex];
    const withOptions = release.with as Mapping | undefined;
    const files = typeof withOptions?.files === "string" ? withOptions.files.split(/\r?\n/) : [];
    const assets = files.map((file) => file.trim()).filter(Boolean);
    if (!assets.includes("release-assets/*.exe")) {
      errors.push("softprops/action-gh-release must publish the installer explicitly");
    }
    if (!assets.includes("release-assets/SHA256SUMS")) {
      errors.push("softprops/action-gh-release must publish release-assets/SHA256SUMS");
    }
  }

  if (checksumIndex >= 0 && releaseIndex >= 0 && checksumIndex > releaseIndex) {
    errors.push("SHA256SUMS must be generated before the GitHub Release is published");
  }

  return errors;
};
