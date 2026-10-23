# Development and publication

**English** · [Русский](../ru/development.md) · [Documentation](index.md)

## Build from source

Use Node.js 24+ and npm for 0.4.0. Clone the repository and run from its root:

```sh
npm ci
npm run check
npm run build
```

`check` validates manifests, runs ESLint, checks TypeScript without emitting files, and runs automated tests. `build` produces a minified CommonJS `main.js`, targeting ES2020 with Obsidian external. `npm run dev` runs an esbuild watcher for development. Neither `main.js` nor `node_modules` belongs in a source commit.

`npm test` runs Node's native test runner over `tests/*.test.mjs`; those tests import erasable TypeScript directly. Controlled Obsidian adapters test service behavior without launching the app. They do not substitute for its real editor, renderer, sync provider, or filesystem lifecycle.

Install `main.js`, `manifest.json`, and `styles.css` in a test vault's `plugins/noteline/` folder. [Installation](installation.md). Test real Obsidian separately: unit tests do not prove native rendering or physical-device compatibility.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | File-extension registration, timeline session ownership, migration, vault events, and commands |
| `src/domain/` | Calendar metadata, timeline geometry, and persisted-state validation |
| `src/services/timeline-session.ts` | Per-file note controller, metadata reads, fallback dates, and stale-request protection |
| `src/services/timeline-files.ts` | `.timeline` JSON loading, validation, creation, and compare-before-save protection |
| `src/services/persistence.ts` | Serialized snapshots, retry, and external-change conflicts |
| `src/services/notes.ts` | Current-buffer or transaction-based explicit tag writes |
| `src/ui/` | `EditableFileView` for `.timeline`, file dialogs, orientation/direction, and rendered cards |
| `src/ui/timeline-touch.ts` | Touch camera panning, pointer capture/cancellation, and tap protection |
| `tests/` | Domain and service regression checks |
| `scripts/validate-manifest.mjs` | Metadata agreement and desktop-import checks |
| `styles.css` | Scoped UI styles using Obsidian variables |

The runtime uses [public Obsidian API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts), including `EditableFileView`, `registerExtensions`, `Vault.process`, `FileManager.processFrontMatter`, and `MarkdownRenderer.render`. No Node/Electron filesystem API is needed. The [timeline-file contract](timeline-files.md) documents schema `1`; plugin `data.json` stores navigation/migration information rather than the active timeline document.

## Manifest and release contract

The root [`manifest.json`](../../manifest.json) describes the plugin. Keep these values consistent:

| Field | Current value / meaning |
| --- | --- |
| `id` | `noteline`; also the installation folder name |
| `name` | `Noteline` |
| `version` | `0.4.0`; plain `x.y.z`, matching the release tag |
| `minAppVersion` | `1.7.2`; the minimum declared Obsidian version |
| `isDesktopOnly` | `false`; mobile installation is enabled, physical-device testing is pending |
| `author`, `authorUrl` | Maintainer identity and profile |
| `description` | A short English description of the plugin's actual behavior |

`package.json` and `package-lock.json` must use the same plugin version. [`versions.json`](../../versions.json) maps each published plugin version to its minimum supported Obsidian version.

Prepare the checked production build from the intended commit. For 0.4.0, the published release tag must be **`0.4.0`, without `v`**. Attach `main.js`, `manifest.json`, and `styles.css` individually and verify downloads. A source archive or draft release is insufficient.

If Community reports **No release matches your manifest version**, check the default-branch manifest, exact published tag, and assets before changing correct metadata. Increment the version for later code updates.

## Community submission

Follow [Obsidian's submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin): provide an accurate manifest, README, license, and matching published release. Community acceptance is separate; this repository does not claim approval.

Before publishing another build, repeat checks for independent files/tabs, both orientations and directions, BCE/partial dates, gray frames, tag writes, migration, backup/copy/reload, stale writes, and relinking in a test vault.

The 0.3.0 native macOS smoke run on Obsidian 1.14.4 passed activation; legacy migration of three entries with expanded state and fallback dates; two independent timeline files; create/copy/add/delete with the source note retained; both orientations and reversed directions; fit; month/year/Roman-century/BCE-year/BCE-century precision; persistence after app reload; and clean external updates to orientation, direction, and expanded states.

Physical iOS/Android, Windows/Linux, Obsidian 1.7.2 itself, touch gestures, and actual sync transport/provider conflicts remain unverified. Local file-update checks do not establish provider synchronization behavior.

The 0.4.0 touch change is a statically reviewed iteration with automated event regressions. No new physical-device or native Obsidian smoke result is claimed for this build. Confirm the [touch scenarios](quick-start.md#touch-devices) on a real iPhone/iPad after updating; [analysis](../ios-scroll-analysis.md).
