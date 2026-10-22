import { builtinModules } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const desktopModules = new Set([...builtinModules.map((name) => name.replace(/^node:/, "")), "electron"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate the release metadata without network access or a build. */
export function validateMetadata(manifest, versions, packageJson) {
  const errors = [];
  if (!record(manifest)) return ["manifest.json must contain an object."];
  for (const key of ["id", "name", "version", "minAppVersion", "description", "author"]) {
    if (typeof manifest[key] !== "string" || manifest[key].trim().length === 0) {
      errors.push(`manifest.${key} must be a nonempty string.`);
    }
  }
  if (typeof manifest.id === "string" && (!/^[a-z]+(?:-[a-z]+)*$/.test(manifest.id) || manifest.id.includes("obsidian") || manifest.id.endsWith("plugin"))) {
    errors.push("manifest.id must use lowercase letters and hyphens, exclude obsidian, and not end in plugin.");
  }
  if (typeof manifest.name === "string" && (!/^[A-Za-z0-9 ()+-]+$/.test(manifest.name) || /(?:obsidian|obsi-|sidian|\bplugin\b)/i.test(manifest.name))) {
    errors.push("manifest.name must use Basic Latin letters, numbers, spaces, parentheses, plus or hyphen, without Obsidian or Plugin.");
  }
  for (const key of ["version", "minAppVersion"]) {
    if (typeof manifest[key] === "string" && !semver.test(manifest[key])) errors.push(`manifest.${key} must use x.y.z without a prefix or prerelease suffix.`);
  }
  if (typeof manifest.description === "string" && (manifest.description.length > 250 || !manifest.description.endsWith(".") || [...manifest.description].some(char => char.charCodeAt(0) < 32))) {
    errors.push("manifest.description must be one line, at most 250 characters, ending with a period.");
  }
  if (typeof manifest.isDesktopOnly !== "boolean") errors.push("manifest.isDesktopOnly must be a boolean.");
  if (manifest.authorUrl !== undefined) {
    try {
      const url = new URL(manifest.authorUrl);
      if (!["https:", "http:"].includes(url.protocol)) errors.push("manifest.authorUrl must be an HTTP(S) URL.");
    } catch {
      errors.push("manifest.authorUrl must be an HTTP(S) URL.");
    }
  }
  if (!record(versions)) {
    errors.push("versions.json must contain an object.");
  } else {
    for (const [version, minimum] of Object.entries(versions)) {
      if (!semver.test(version) || typeof minimum !== "string" || !semver.test(minimum)) errors.push("versions.json entries must map x.y.z plugin versions to x.y.z Obsidian versions.");
    }
    if (versions[manifest.version] !== manifest.minAppVersion) errors.push("versions.json must map the current version to manifest.minAppVersion.");
  }
  if (!record(packageJson)) {
    errors.push("package.json must contain an object.");
  } else {
    if (packageJson.name !== manifest.id) errors.push("package.name must match manifest.id.");
    if (packageJson.version !== manifest.version) errors.push("package.version must match manifest.version.");
    if (packageJson.main !== "main.js") errors.push("package.main must be main.js.");
    if (packageJson.license !== "MIT") errors.push("package.license must match this repository's MIT license.");
  }
  return errors;
}

/** Check static, dynamic and CommonJS imports for desktop-only modules. */
export function findDesktopImports(source) {
  const results = new Set();
  const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(imports)) {
    const module = match[1].replace(/^node:/, "");
    if (desktopModules.has(module) || desktopModules.has(module.split("/")[0])) results.add(match[1]);
  }
  return [...results];
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

export async function validateRepository(root) {
  const readJson = async (name) => JSON.parse(await readFile(join(root, name), "utf8"));
  const [manifest, versions, packageJson] = await Promise.all(["manifest.json", "versions.json", "package.json"].map(readJson));
  const errors = validateMetadata(manifest, versions, packageJson);
  for (const name of ["README.md", "LICENSE"]) {
    const content = await readFile(join(root, name), "utf8");
    if (!content.trim()) errors.push(`${name} must not be empty.`);
  }
  const license = await readFile(join(root, "LICENSE"), "utf8");
  if (!license.startsWith("MIT License\n")) errors.push("LICENSE must contain the MIT license declared in package.json.");
  if (!manifest.isDesktopOnly) {
    for (const file of await sourceFiles(join(root, "src"))) {
      const imports = findDesktopImports(await readFile(file, "utf8"));
      if (imports.length) errors.push(`${relative(root, file)} imports desktop-only APIs: ${imports.join(", ")}.`);
    }
  }
  return { errors, manifest };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { errors, manifest } = await validateRepository(root);
    if (errors.length) {
      for (const error of errors) console.error(error);
      process.exitCode = 1;
    } else {
      console.log(`Manifest validation passed: ${manifest.id} ${manifest.version}, Obsidian >= ${manifest.minAppVersion}.`);
      console.log("Package/version agreement, documentation/license files, and runtime imports checked.");
    }
  } catch (error) {
    console.error(`Manifest validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
