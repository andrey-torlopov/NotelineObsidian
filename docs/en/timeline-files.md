# Timeline files and independent tabs

**English** · [Русский](../ru/timeline-files.md) · [Documentation](index.md)

## Create, open, and manage

Since 0.3.0, each timeline is a `.timeline` JSON file in the vault. Use **Noteline: Создать временную ось** or **Создать ось** on the toolbar and enter a vault-relative path. The extension is added if omitted. Existing files are not overwritten.

Open a file from the vault, use **Noteline: Выбрать временную ось**, or select it through **Выбрать временную ось** on the toolbar. Different files open in separate tabs. Each file owns its note selection, date-property priority, fallback dates, layout, expanded states, viewport, orientation, and chronological direction. The same note can appear in several files. Tabs for the same file refer to the same document.

| Toolbar action | Effect |
| --- | --- |
| **Сохранить копию оси** | Create a new file from the current in-memory arrangement, including unsaved changes; note contents are not copied |
| **Перечитать файл оси** | After confirmation, replace the in-memory arrangement with the file version; save a copy first if needed |
| **Удалить ось** | After confirmation, move the timeline file to the configured trash; source notes remain |
| **Ориентация оси / Направление дат** | Save horizontal/vertical orientation and earlier-to-later/reversed chronology in this file |

Removing a card affects only its membership in this timeline. Adding a tag changes the shared source note and is visible on other timelines that use it. [Controls](quick-start.md).

## Minimal complete example

Create the note `Notes/Research kickoff.md`:

```markdown
---
date: "2026-10-23"
tags:
  - research
---

# Research kickoff

The research journal starts here.
```

The following complete `Research.timeline` document includes that note:

```json
{
  "schemaVersion": 1,
  "settings": {
    "dateProperties": ["timeline-date", "date"]
  },
  "timeline": {
    "entries": [
      {
        "entryId": "research-kickoff",
        "filePath": "Notes/Research kickoff.md",
        "preferredLane": 0,
        "expanded": false
      }
    ]
  }
}
```

Prefer the UI for ordinary editing. When inspecting or changing JSON externally, preserve a backup and finish or close active editing first.

## File contract

`schemaVersion: 1`, `settings.dateProperties`, and `timeline.entries` are required. Date-property names are unique, nonempty strings in priority order; an empty list leaves the leading `📅` marker as the date source. Entries require a unique nonempty `entryId`, a unique vault-relative `.md` `filePath`, a nonnegative integer `preferredLane`, and a boolean `expanded`. Absolute paths, backslashes, and `.`/`..` path segments are not accepted.

Optional fields:

- `entry.fallbackDate`: a real `YYYY-MM-DD` day retained for a note whose source date is missing. It is not a replacement for an invalid date. Partial or BCE source dates stay in the note.
- `timeline.orientation`: `"horizontal"` or `"vertical"`; omitted means horizontal.
- `timeline.reverse`: a boolean; omitted means earlier-to-later.
- `timeline.viewport`: numeric `start` and `end` calendar coordinates in milliseconds, with at least a one-hour span; nonnegative `scrollTop` is required and nonnegative `scrollLeft` is optional. The camera must remain inside the supported calendar range.

Compatible unknown fields are retained. Invalid JSON, unsupported schema versions, and invalid known fields are reported without resetting the source file.

## Migration and synchronization

The old single-timeline `data.json` state is migrated to `Noteline.timeline`, or another free name. Legacy fields remain in plugin data for recovery; `notelineFiles.migratedPath` and `lastPath` record migration and navigation. After migration, `.timeline` files are the shared source of timeline state.

Synchronize these files together with their notes and attachments. Saves compare the current local file with the version previously loaded and block a stale overwrite. This does not merge layouts or prevent a sync provider from replacing a file later. Preserve a copy before confirmed reload when a conflict occurs. [Backup, desktop/iOS Sync settings, and recovery](data-and-security.md).
