# Troubleshooting and known limits

**English** · [Русский](../ru/troubleshooting.md) · [Documentation](index.md)

| Symptom | What to check |
| --- | --- |
| Noteline is absent from Community plugins | Put the three built files directly in `plugins/noteline/`, check `manifest.id`, reload Obsidian, and verify the minimum app version. The source-code ZIP alone has no `main.js`. |
| The date is rejected | Use a [supported format](dates-and-tags.md). Check the highest-priority nonempty property, YAML syntax, and duplicate leading date lines. A filled invalid value is not replaced with today. |
| A card has a gray frame | Read its reason. Add a source date and/or tags to the note; a fallback date does not repair missing source metadata. |
| A date in prose is ignored | Put it in a configured property or in the recognized initial metadata block. Noteline does not search the entire body for event dates. |
| Cards moved after zooming or expansion | Collision avoidance can change the effective level. The preferred vertical level remains saved; the date still controls horizontal placement. |
| A note is missing | Restore the file at its old path, or use **Выбрать другой файл** — Choose another file — in the problem list and select the intended note. |
| A tag cannot be added | Check tag syntax, malformed YAML, duplicate marker lines, and the current save status. For a YAML-target note open in a source editor, use Properties or close that editor before retrying. |
| A save error is shown | Check write permission, disk space, and sync activity. Click **Ошибка сохранения — нажмите для повтора** to retry. Keep Obsidian open until it shows **Сохранено**. |
| Settings conflict or read-only mode | Preserve `data.json` before reloading or restoring. Follow [data recovery](data-and-security.md); do not delete the only copy. |

Renames of notes and folders are tracked while Noteline is enabled and writable. Renames made while it is disabled, or during a blocked save state, can require relinking. Removing a card does not delete its note.

## Compatibility and scope

Version 0.1.0 provides one timeline per vault and one card per note. It has no intervals, recurring events, date dragging, image export, multiple named timelines, automatic conflict merging, or pinch-to-zoom. Card text is a reading view; edit the original note in Obsidian.

The manifest allows mobile installation and runtime code uses browser-compatible APIs. Touch buttons are available. Native smoke checks were performed on macOS with Obsidian 1.14.4; physical iOS/Android, Windows/Linux, and the minimum declared version 1.7.2 remain unverified. Large-vault performance has not been certified.

## Reporting an issue

Open an [issue](https://github.com/andrey-torlopov/NotelineObsidian/issues) with the Noteline version, Obsidian version, OS/device, reproducible steps, expected behavior, and the displayed error. For metadata problems, provide a minimal sanitized note that reproduces the issue. Include relevant console errors if available; console access differs by platform.

Remove private note content, vault paths, and unrelated plugin data before posting. Mention whether other plugins or sync were active. Do not attach an entire personal vault.
