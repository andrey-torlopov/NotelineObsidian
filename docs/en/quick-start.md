# Quick start and controls

**English** · [Русский](../ru/quick-start.md) · [Documentation](index.md)

## Open a timeline

Version 0.4.1 uses independent `.timeline` files. Run **Noteline: Открыть временную ось** — Open timeline — from the command palette or ribbon. If no timeline exists, create one when prompted. **Noteline: Создать временную ось** creates another file; **Noteline: Выбрать временную ось** selects an existing file. Different files can stay open in separate tabs.

The toolbar's **Выбрать временную ось** selector opens another timeline. **Создать ось**, **Сохранить копию оси**, **Перечитать файл оси**, and **Удалить ось** manage the current document. Reloading and deletion require confirmation; copying keeps references to the same notes. [Timeline files](timeline-files.md).

## Add and read notes

Choose **Добавить заметку** — Add note — in the intended timeline tab. Search the filename or full vault path. The search spans the vault; identical basenames are distinguished by path.

Other entry points are **Добавить на временную ось** in a Markdown file's context menu and **Noteline: Добавить активную заметку на ось** for the active note. These let you choose the destination timeline. Adding the same note again focuses its existing card in that timeline; another timeline can use the same note independently.

Missing dates and tags do not block addition. An undated note receives a saved fallback date; a filled but invalid date is reported for correction. [Metadata rules](dates-and-tags.md).

The collapsed card shows the filename without `.md`, the date, tags, and actions. The expand button opens Markdown in a scrollable reading area. One note stays one card even when it contains multiple headings.

The title opens the source note in a separate tab. Edit there: the card is a reading view, and preview task checkboxes are disabled. The recognized initial metadata block is hidden from the card body without changing the file. Relative links and images use the source note path.

## Controls

| Control | Behavior |
| --- | --- |
| **Ориентация оси** | Choose **Горизонтальная** or **Вертикальная** — horizontal or vertical time axis |
| **Направление дат** | Choose **От старых к новым** or **От новых к старым** — earlier-to-later or reversed |
| Card grip | Drag across the axis: up/down in horizontal mode, right/left in vertical mode; the date stays unchanged |
| **Дальше от оси / Ближе к оси** | Move to an available level farther from / closer to the axis; also available to touch users |
| Focused grip + **↑/→** or **↓/←** | Increase or decrease the cross-axis level, respectively |
| **Escape** during grip drag | Cancel the move while the grip has focus |
| **−/+** | Zoom around the center of the time window |
| `Ctrl/Cmd` + wheel over the field | Zoom around the pointer's date along the active axis; wheel delta controls zoom in both orientations |
| **Сдвинуть в прошлое / Сдвинуть в будущее** | Pan to earlier / later dates, with the same chronological meaning in reversed mode |
| `Shift` + wheel | Pan the time window in either orientation |
| Horizontal trackpad gesture in horizontal mode | Pan the time window |
| One-finger swipe along the axis, on its background or a card header | Pan through time: left/right horizontally, up/down vertically; reversed dates are respected |
| One-finger swipe across the axis | Native scrolling of card levels: up/down horizontally, left/right vertically |
| Ordinary wheel | Scroll cross-axis levels: vertically in horizontal mode, horizontally in vertical mode; over expanded text, scroll its body first |
| **Показать все** — Show all | Fit dates along the active time axis; additional levels remain scrollable across it |
| **Сегодня** — Today | Center today without changing the window duration |
| **К дате** — Go to date | Enter a supported value, such as `2026-10-22`, `2026-10`, `2026`, `XIX`, or `II BC` |
| **Параметры даты** — Date properties | Change property names and priority for this timeline file |

Earlier-to-later runs left to right in horizontal mode and top to bottom in vertical mode; reversed mode swaps those directions. The orientation and direction are saved in this timeline file. Coincident or nearby dates use additional cross-axis levels to avoid overlap. Your preferred level is retained; the effective level may change with zoom or expansion. The narrowest time window is one hour; the widest depends on the selected dates and fitted view.

Rings on the thin time axis mark note dates and follow the selected range. Notes missing a date or tags use a gray ring and a dashed connector, matching their gray card frame. The axis stays visible while cross-axis levels scroll. In vertical mode, use the horizontal scrollbar or a cross-axis swipe to browse those levels; ordinary mouse scrolling over the field also moves them horizontally.

## Touch devices

In 0.3.0, scrolling through dates depended on wheel input and toolbar buttons. Version 0.4.0 adds one-finger date panning on the fixed scale, field background, and card headers. Swipe along the axis to move the visible dates; swipe across it to scroll card levels. A tap on a title still opens its note, while a drag does not.

Gestures starting in expanded Markdown text, an overflowing card, or an action control keep that element's own interaction. To pan dates from a long card, start on the fixed scale or the field background. Adding a second finger cancels the current date drag. Timeline pinch-to-zoom and kinetic time panning are not implemented; use **−/+** for the timeline scale. Browser zoom remains subject to the host app.

This fix was reviewed statically and covered by automated event regressions. It has not yet been confirmed in Obsidian on a physical iPhone/iPad. After updating all three plugin files and reloading the plugin, check left/right date swipes in horizontal mode, up/down date swipes in vertical mode, perpendicular card scrolling, and long-text reading. Repeat with reversed dates; report the iOS/Obsidian versions and where the gesture starts if it still fails.

## Tags and removal

Use the **+** beside the tags or **Действия с карточкой → Добавить тег**. Applying a valid tag writes to the source note without changing its date. [Where tags are written](dates-and-tags.md).

**Действия с карточкой → Убрать с оси** removes membership and layout only. The note stays in the vault.

The toolbar shows saving status for this file. For an I/O error, fix the cause and click **Ошибка сохранения — нажмите для повтора**. For a file conflict, preserve unsaved work with **Сохранить копию оси**, then use **Перечитать файл оси** if you want the disk version. Confirming reload replaces the in-memory arrangement. See [troubleshooting](troubleshooting.md).
