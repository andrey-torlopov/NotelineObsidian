import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findDesktopImports, validateMetadata, validateRepository } from "../scripts/validate-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const versions = JSON.parse(await readFile(new URL("../versions.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("repository release metadata and browser-only imports are valid", async () => {
  const { errors } = await validateRepository(root);
  assert.deepEqual(errors, []);
  assert.equal(manifest.id, "noteline");
  assert.equal(manifest.isDesktopOnly, false);
});

test("release metadata rejects incompatible shapes and unsupported version tags", () => {
  assert.match(validateMetadata([], versions, packageJson).join("\n"), /must contain an object/);
  for (const version of ["v0.1.0", "0.1.0-beta.1", "01.1.0", "1.0", "1.0.0.0"]) {
    const altered = { ...manifest, version };
    assert.match(validateMetadata(altered, versions, packageJson).join("\n"), /manifest.version must use x.y.z/);
  }
});

test("release metadata rejects mismatched package and supported-app mappings", () => {
  assert.match(validateMetadata(manifest, { [manifest.version]: "1.0.0" }, packageJson).join("\n"), /must map the current version/);
  assert.match(validateMetadata(manifest, versions, { ...packageJson, version: "9.9.9" }).join("\n"), /package.version must match/);
  assert.match(validateMetadata(manifest, versions, { ...packageJson, name: "another-name" }).join("\n"), /package.name must match/);
});

test("release metadata enforces naming and required fields", () => {
  for (const id of ["Noteline", "noteline-plugin", "obsidian-noteline", "noteline_2"]) {
    assert.match(validateMetadata({ ...manifest, id }, versions, packageJson).join("\n"), /manifest.id must use/);
  }
  assert.match(validateMetadata({ ...manifest, name: "Obsidian Timeline Plugin" }, versions, packageJson).join("\n"), /manifest.name must use/);
  assert.match(validateMetadata({ ...manifest, isDesktopOnly: "false" }, versions, packageJson).join("\n"), /must be a boolean/);
  assert.match(validateMetadata({ ...manifest, description: "x".repeat(251) }, versions, packageJson).join("\n"), /at most 250 characters/);
  assert.match(validateMetadata({ ...manifest, authorUrl: "javascript:alert(1)" }, versions, packageJson).join("\n"), /HTTP\(S\) URL/);
});

test("mobile import guard covers static, dynamic, subpath and CommonJS desktop imports", () => {
  const source = `import fs from "node:fs/promises";
import { remote } from "electron";
const os = require("os");
const path = await import("path/posix");
import { Plugin } from "obsidian";`;
  assert.deepEqual(findDesktopImports(source), ["node:fs/promises", "electron", "os", "path/posix"]);
  assert.deepEqual(findDesktopImports('import type { Plugin } from "obsidian";\nimport { parse } from "./date.ts";'), []);
});
