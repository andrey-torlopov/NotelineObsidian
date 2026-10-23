# Installation and updates

**English** · [Русский](../ru/installation.md) · [Documentation](index.md)

## Requirements

Noteline 0.4.1 declares Obsidian 1.7.2 or newer and uses existing vault Markdown notes. A built plugin needs no server, account, or Node.js. Version 0.3.0 passed native macOS smoke checks with Obsidian 1.14.4; the 0.4.0 touch iteration has static and automated regression checks. The manifest enables mobile installation; physical iOS/Android, Windows/Linux, Obsidian 1.7.2 itself, touch gestures, and actual sync transport/provider conflicts remain unverified.

## Get a built copy

When a [GitHub release](https://github.com/andrey-torlopov/NotelineObsidian/releases) is available, download its individual `main.js`, `manifest.json`, and `styles.css` assets. GitHub's **Source code** archive does not contain the ignored build output. Community directory installation becomes available only after submission and acceptance.

If there is no release yet, use the [source-build instructions](development.md) or a built copy provided by the maintainer. A local installation ZIP may contain a `noteline/` folder with the three required files.

## Manual installation

1. Start with a test vault. Open its configuration folder: `.obsidian` by default, or your custom configuration folder.
2. Create `plugins/noteline/` inside it and copy these files:

```text
.obsidian/
  plugins/
    noteline/
      main.js
      manifest.json
      styles.css
```

3. Reload Obsidian if necessary and enable Noteline under **Settings → Community plugins**. Only enable code you trust.
4. Run **Noteline: Открыть временную ось** in the command palette. Create a `.timeline` file when prompted, or select an existing one. Different files open as independent timeline tabs.

The folder name must match `manifest.id`: `noteline`. Avoid a second nested `noteline` folder. Do not copy `node_modules` or the entire repository into the plugin folder. On mobile, transfer the built files to the configuration folder of the same vault before enabling the plugin. Timeline documents belong in the vault, not the plugin's installation folder.

## Updates

Back up the vault, including `.timeline` files and `plugins/noteline/data.json`. Disable Noteline, replace `main.js`, `manifest.json`, and `styles.css` together, preserve `data.json`, and enable it again. Use matching files from one version.

When upgrading from a single-timeline version, valid legacy `data.json` state is transferred to `Noteline.timeline`, or another available name if needed. The legacy fields remain for recovery and `notelineFiles` records the migrated and last-opened paths. In 0.3.0, each `.timeline` file holds its own membership, fallback dates, settings, and layout; `data.json` is no longer the source for these shared documents.

Do not delete `data.json` during an update: doing so can destroy pre-migration data or its retained recovery copy. A damaged or unsupported timeline file is reported rather than silently reset. [Migration, backup, and restore](data-and-security.md).

## Desktop and mobile using the same vault

Install a compatible built version on each device, then synchronize `.timeline` files together with their notes and attachments. Make sure custom file types are included in your sync setup; copying or syncing only the plugin does not transfer the timelines. Keep the same note paths relative to the vault.

If notes arrive on iOS but a timeline does not, check the actual `.timeline` file and the sync configuration on that device before creating another copy. Let synchronization finish before editing the same timeline on another device. [Obsidian Sync setup and conflict recovery](data-and-security.md#multiple-devices).
