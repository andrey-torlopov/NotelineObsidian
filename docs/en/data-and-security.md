# Data, privacy, backup, and sync

**English** · [Русский](../ru/data-and-security.md) · [Documentation](index.md)

## What is stored

Notes remain Markdown files at their existing vault paths. Noteline reads their contents and metadata to render cards. It stores its own state through Obsidian's plugin data API, normally at `.obsidian/plugins/noteline/data.json`. A custom vault configuration folder changes the `.obsidian` part of that path.

The data file contains schema version `1`, date-property settings, selected note paths and entry IDs, preferred vertical levels, expanded/collapsed states, saved fallback dates, and the last viewport. It contains no duplicate archive of note bodies or attachments.

Adding a note, moving or expanding a card, and removing a card from the timeline change plugin state. They do not rewrite or delete the note. **Adding a tag explicitly writes to the source note.** YAML writes can change YAML formatting while preserving other property values and the body. [Tag write rules](dates-and-tags.md).

## Network and external content

Noteline makes no network requests of its own and includes no telemetry, account, or server connection. Markdown is rendered by Obsidian. Images, embeds, links, or other plugins can still involve external resources; the timeline is not an offline-content filter.

## Backup and restore

1. Wait for **Сохранено** — Saved. Resolve any save error first.
2. Close Obsidian on devices using this vault and pause synchronization before copying or restoring files.
3. Back up the complete vault, including notes, attachments, and the hidden configuration folder with `plugins/noteline/data.json`.
4. To restore, preserve a copy of the current files first, restore the matching vault and plugin data, then open Obsidian and verify note paths, card membership, fallback dates, and layout.

Noteline does not create automatic backups. A copy of `data.json` alone cannot restore deleted notes. A copy of the notes alone cannot restore timeline membership and layout.

Deleting `data.json` resets the timeline and settings. It also discards saved fallback dates, so adding an undated note again may place it on a different day. Do not use this as a routine repair step.

## Multiple devices

Noteline delegates file transport to your sync tool. Check that it actually includes plugin data; installation and settings sync depend on that tool's configuration. Use one active writer and let synchronization finish before editing the timeline on another device.

A clean external state change can be reloaded. If one arrives during a local write or while changes remain unsaved, Noteline reports **Конфликт настроек** — Settings conflict — and blocks further changes. It does not merge two layouts. Preserve both copies, stop the other writer, choose the data file to retain while Obsidian is closed, and reload. In-memory changes can be lost on reload; copy their arrangement manually before proceeding if needed.

An invalid or unsupported schema is opened in read-only mode rather than overwritten. Keep the original file and restore a known-good copy or use the compatible plugin version. [Troubleshooting](troubleshooting.md).
