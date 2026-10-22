# Development and publication

**English** · [Русский](../ru/development.md) · [Documentation](index.md)

## Build from source

Use Node.js 24+ and npm. Clone the repository and run from its root:

```sh
npm ci
npm run check
npm run build
```

`check` validates manifests, runs ESLint, checks TypeScript without emitting files, and runs automated tests. `build` produces a minified CommonJS `main.js`, targeting ES2020 with Obsidian external. `npm run dev` runs an esbuild watcher for development. Neither `main.js` nor `node_modules` belongs in a source commit.

Install `main.js`, `manifest.json`, and `styles.css` in a test vault's `plugins/noteline/` folder. [Installation](installation.md). Test real Obsidian separately: unit tests do not prove native rendering or physical-device compatibility.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, vault integration, commands, and settings |
| `src/domain/` | Calendar metadata, timeline geometry, and persisted-state validation |
| `src/services/` | Note writes and serialized persistence |
| `src/ui/` | Timeline view, dialogs, and rendered cards |
| `tests/` | Domain and service regression checks |
| `scripts/validate-manifest.mjs` | Metadata agreement and desktop-import checks |
| `styles.css` | Scoped UI styles using Obsidian variables |

## Manifest and release contract

The root [`manifest.json`](../../manifest.json) describes the plugin. Keep these values consistent:

| Field | Current value / meaning |
| --- | --- |
| `id` | `noteline`; also the installation folder name |
| `name` | `Noteline` |
| `version` | `0.2.0`; plain `x.y.z`, matching the release tag |
| `minAppVersion` | `1.7.2`; the minimum declared Obsidian version |
| `isDesktopOnly` | `false`; mobile installation is enabled, physical-device testing is pending |
| `author`, `authorUrl` | Maintainer identity and profile |
| `description` | A short English description of the plugin's actual behavior |

`package.json` and `package-lock.json` must use the same plugin version. [`versions.json`](../../versions.json) maps each published plugin version to its minimum supported Obsidian version.

For a release, run checks and the production build from the intended commit. Publish a **GitHub Release**, with a tag exactly equal to `manifest.version`: **`0.2.0`, without `v`**. Attach `main.js`, `manifest.json`, and `styles.css` individually with those exact filenames. A tag alone, a draft release, or a source-code archive does not provide the installable assets. Verify the downloaded files against the prepared ones.

The error **No release matches your manifest version** means the Community service cannot find the published release for the manifest on the default branch. Check its exact tag, publication state, and attached files before changing a correct manifest. For later code updates, increment the version and publish a matching new release; replacing an already distributed version can leave users with different binaries under one version number.

## Community submission

Follow Obsidian's current [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) guide. The default branch needs an accurate manifest, README, and license; a matching published release is required before the directory can distribute the plugin. Submission and acceptance are separate from publishing a GitHub release. This repository does not claim Community approval.

Before publishing, verify metadata fallbacks and gray frames, explicit tag writes, backup/reload, missing-note relinking, and the claimed platforms in a test vault. Do not mark physical mobile compatibility as verified without device checks.
