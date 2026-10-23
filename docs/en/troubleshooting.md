# Troubleshooting and known limits

**English** · [Русский](../ru/troubleshooting.md) · [Documentation](index.md)

| Symptom | What to check |
| --- | --- |
| Noteline is absent from Community plugins | Put the three built files directly in `plugins/noteline/`, check `manifest.id`, reload Obsidian, and verify the minimum app version. The source-code ZIP alone has no `main.js`. |
| No timeline appears in the selector | Create or sync a file with the `.timeline` extension inside this vault. Check the current vault and excluded folders. Plugin settings alone do not contain the file-backed timelines. |
| A timeline opens read-only | Preserve the `.timeline` file. Check its JSON, schema version, and required fields against the [file contract](timeline-files.md). Unsupported data is not silently reset. |
| The date is rejected | Use a [supported format](dates-and-tags.md). Check the highest-priority nonempty property, YAML syntax, and duplicate leading date lines. A filled invalid value is not replaced with today. |
| A card has a gray frame | Read its reason. Add a source date and/or tags to the note; a fallback date does not repair missing source metadata. |
| A date in prose is ignored | Put it in a configured property or in the recognized initial metadata block. Noteline does not search the entire body for event dates. |
| Cards moved after zooming or expansion | Collision avoidance can change the effective cross-axis level. The preferred level remains saved in this file; the date still controls the time-axis coordinate. |
| The wheel moves cards sideways in vertical mode | This scrolls cross-axis levels. Use **Сдвинуть в прошлое / Сдвинуть в будущее**, **К дате**, or `Shift` + wheel to navigate dates. |
| A note is missing | Restore the file at its old path, or use **Выбрать другой файл** — Choose another file — in the problem list and select the intended note. |
| A tag cannot be added | Check tag syntax, malformed YAML, duplicate marker lines, and the current save status. For a YAML-target note open in a source editor, use Properties or close that editor before retrying. |
| A save error is shown | Check write permission, disk space, and sync activity. Click **Ошибка сохранения — нажмите для повтора** to retry. Keep Obsidian open until it shows **Сохранено**. |
| **Конфликт файла** or an externally changed file | Save unsaved work with **Сохранить копию оси**. Then use **Перечитать файл оси** and confirm only if you want the current disk version. Preserve both versions; no layout merge is performed. |
| Notes sync, but the timeline does not reach iOS | Sync the `.timeline` file as well as notes and attachments. Enable custom file types on each device; see [desktop/iOS setup](data-and-security.md#multiple-devices). |
| The old timeline is missing after an update | Look for the migrated `Noteline.timeline` or an available numbered name. Preserve `data.json`, including its legacy recovery fields and `notelineFiles` paths. [Migration](data-and-security.md#migration-from-the-single-timeline-versions). |

Renames of notes and folders are tracked while Noteline is enabled and writable. Renames made while it is disabled, or during a blocked save state, can require relinking. Removing a card does not delete its note.

## Compatibility and scope

Version 0.3.0 provides multiple independent `.timeline` files, separate tabs, horizontal/vertical orientation, either chronological direction, and one card per note within each file. It has no intervals, recurring events, date dragging, image export, collaborative layout merge, or pinch-to-zoom. Card text is a reading view; edit the original note in Obsidian.

Version 0.3.0 passed native macOS smoke checks with Obsidian 1.14.4, including migration, independent timeline files, file actions, both orientations and directions, partial/BCE dates, persisted layout, and clean external-file updates. The manifest allows mobile installation and the runtime uses browser-compatible public APIs. Physical iOS/Android, Windows/Linux, Obsidian 1.7.2 itself, touch gestures, and actual sync transport/provider conflicts remain unverified. Large-vault performance has not been certified. A successful local external-file update does not verify a sync provider's transport or conflict handling.

## Reporting an issue

Open an [issue](https://github.com/andrey-torlopov/NotelineObsidian/issues) with the Noteline version, Obsidian version, OS/device, reproducible steps, expected behavior, orientation/direction, and the displayed error. Provide a minimal sanitized note for metadata problems or a [minimal timeline document](timeline-files.md) for file problems. Include relevant console errors if available; console access differs by platform.

Remove private note content, vault paths, and unrelated plugin data before posting. Mention whether other plugins or sync were active. Do not attach an entire personal vault.
