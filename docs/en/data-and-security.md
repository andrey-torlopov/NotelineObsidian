# Data, privacy, backup, and sync

**English** · [Русский](../ru/data-and-security.md) · [Documentation](index.md)

## What is stored

Version 0.4.1 stores each timeline as a separate `.timeline` JSON file inside the vault, for example `Research/Family history.timeline`. Different files can be open in different tabs.

| File | What it owns |
| --- | --- |
| Markdown notes and attachments | The source text, dates, tags, and media |
| Each `.timeline` file | Schema version `1`, date-property settings, note paths and entry IDs, layout levels, expanded states, fallback dates, viewport, orientation, and chronological direction |
| `plugins/noteline/data.json` inside the vault configuration folder | Last-opened path and migration bookkeeping under `notelineFiles`; retained legacy fields after migration |

The `.timeline` file is the shared source for its timeline state. It stores vault-relative note paths, not note bodies or attachments. Each file has independent membership, date settings, fallback dates, and layout. The same note can appear on several timelines without being duplicated. Copying a timeline copies these references and settings, not its notes.

Adding a note, arranging or expanding a card, and removing a card change that timeline file. They do not rewrite or delete the note. **Adding a tag explicitly writes to the source note**, so other timelines using it also see the change. YAML writes can change formatting while preserving other property values and the body. [Tag write rules](dates-and-tags.md).

## Migration from the single-timeline versions

On first load, valid legacy state in `data.json` is transferred to `Noteline.timeline`. If that name contains different data, a free name such as `Noteline 2.timeline` is used. An existing equivalent migrated file can be reused. The original legacy fields remain in `data.json` as a recovery copy; `notelineFiles.migratedPath` records the migration destination and `lastPath` remembers navigation.

After migration, the `.timeline` file is authoritative. The old fields are not a second actively synchronized timeline. Invalid legacy data is reported and preserved instead of being replaced with an empty file. Preserve `data.json` when updating so migration and its recovery copy remain available.

## Network and external content

Noteline makes no network requests of its own and includes no telemetry, account, or server connection. Markdown is rendered by Obsidian. Images, embeds, links, or other plugins can still involve external resources; the timeline is not an offline-content filter.

## Backup and restore

1. Wait for **Сохранено** — Saved — on the timelines you changed. Save a copy of any unsaved timeline before resolving a conflict.
2. Close Obsidian on devices using this vault and pause synchronization before copying or restoring files.
3. Back up the complete vault, including `.timeline` files, notes, attachments, and the hidden configuration folder with `plugins/noteline/data.json`.
4. To restore, preserve a copy of the current files first, restore matching timelines and their source files, then open Obsidian and verify note paths, membership, fallback dates, layout, and orientation.

Noteline does not maintain automatic versioned backups. Retaining legacy data during migration is not an ongoing backup system. The toolbar's save-copy action creates another timeline snapshot with the same note references. Timeline files alone cannot restore deleted notes; notes alone cannot restore timeline membership and layout.

Deleting `data.json` in 0.4.1 does not delete existing `.timeline` files, but removes navigation preferences and any retained legacy recovery data. Deleting a `.timeline` file removes that timeline, not its source notes. The toolbar asks for confirmation and sends the file to Obsidian's configured trash. Do not delete either file as a routine repair step.

## Multiple devices

Synchronize `.timeline` files together with their notes and attachments, keeping the same paths relative to the vault. Plugin installation or settings sync alone is insufficient. On every device, enable **Settings → Sync → Selective sync → Sync all other types** for Obsidian Sync. Sync settings are device-specific; restart after changing selective sync, with a force-quit if needed on mobile. [Official Sync settings](https://obsidian.md/help/sync/settings).

Obsidian documents “last modified wins” behavior for non-Markdown files. `.timeline` is a custom non-Markdown file, so do not expect note-style merging or plugin-settings JSON merging to combine layouts. Other providers may also replace earlier versions. Use one active writer per timeline and let synchronization finish before switching devices. [Official conflict rules](https://obsidian.md/help/sync/troubleshoot).

Noteline checks the current timeline text before saving. If it differs from the version the tab loaded, the stale write is blocked. This local check cannot prevent a sync provider from replacing a file later. A clean external update can be reloaded automatically; unsaved local changes produce a conflict. Preserve them with the toolbar's save-copy action, then use reload from file and confirm replacing the in-memory arrangement. The plugin does not automatically merge two layouts.

### Desktop and iOS

**The notes arrived, but the timeline did not.** Confirm the `.timeline` file exists on the second device, its folder is not excluded, and its custom file type is included in sync there. Install the same compatible Noteline version on that device and open the file through the timeline selector.

**The timeline opens, but notes are missing.** Its note paths are relative to the vault. Wait for those notes and attachments to arrive at the same paths; copying only the timeline cannot supply them.

**Will edits from desktop and iOS merge?** No collaborative merge is provided. Wait for sync and switch devices serially; preserve separate copies when a conflict is reported. On macOS with Obsidian 1.14.4, a clean external `.timeline` update applied orientation, direction, and expanded states. Actual sync transport/provider conflicts and physical iOS/Android operation remain unverified.

An invalid or unsupported schema is opened in read-only mode rather than overwritten. Keep the original file and restore a known-good copy or use the compatible plugin version. [Troubleshooting](troubleshooting.md).
