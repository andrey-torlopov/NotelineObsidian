# Installation and updates

**English** · [Русский](../ru/installation.md) · [Documentation](index.md)

## Requirements

Obsidian 1.7.2 or newer and a vault with Markdown notes. A built plugin needs no server, account, or Node.js. Desktop smoke checks were performed on macOS with Obsidian 1.14.4. The manifest enables mobile installation, but physical iOS/Android and the minimum Obsidian version are not yet verified.

## Get a built copy

When a [GitHub release](https://github.com/andrey-torlopov/noteline/releases) is available, download its individual `main.js`, `manifest.json`, and `styles.css` assets. GitHub's **Source code** archive does not contain the ignored build output. Community directory installation becomes available only after submission and acceptance.

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
4. Run **Noteline: Открыть временную ось** in the command palette.

The folder name must match `manifest.id`: `noteline`. Avoid a second nested `noteline` folder. Do not copy `node_modules` or the entire repository into the plugin folder. On mobile, transfer the built files to the configuration folder of the same vault before enabling the plugin.

## Updates

Back up the vault and `plugins/noteline/data.json`. Disable Noteline, replace `main.js`, `manifest.json`, and `styles.css` together, preserve `data.json`, and enable it again. Use matching files from one version.

Do not delete `data.json` during a normal update: it contains membership, fallback dates, and layout. A damaged or unsupported schema is reported rather than silently reset. [Backup and restore](data-and-security.md).

Deleting saved plugin data discards the timeline, not the notes. Adding an undated note after that reset can give it a new fallback date.
