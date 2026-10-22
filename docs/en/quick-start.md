# Quick start and controls

**English** · [Русский](../ru/quick-start.md) · [Documentation](index.md)

## Add and read notes

Open **Noteline: Открыть временную ось** — Open timeline — from the command palette or ribbon. Choose **Добавить заметку** — Add note. Search the filename or full vault path. The search spans the vault; identical basenames are distinguished by path.

Other entry points are **Добавить на временную ось** in a Markdown file's context menu and **Noteline: Добавить активную заметку на ось** for the active note. Adding the same note again focuses its existing card.

Missing dates and tags do not block addition. An undated note receives a saved fallback date; a filled but invalid date is reported for correction. [Metadata rules](dates-and-tags.md).

The collapsed card shows the filename without `.md`, the date, tags, and actions. The expand button opens Markdown in a scrollable reading area. One note stays one card even when it contains multiple headings.

The title opens the source note in a separate tab. Edit there: the card is a reading view, and preview task checkboxes are disabled. The recognized initial metadata block is hidden from the card body without changing the file. Relative links and images use the source note path.

## Controls

| Control | Behavior |
| --- | --- |
| Vertical grip | Drag a card up/down without changing its date |
| Card **↑/↓** | Move to an available level; works with touch buttons |
| Focused grip + **↑/↓** keys | Keyboard equivalent of moving a card |
| **Escape** during grip drag | Cancel the move while the grip has focus |
| **−/+** | Zoom around the center of the time window |
| `Ctrl/Cmd` + wheel over the field | Zoom around the date under the pointer |
| Toolbar **←/→** | Pan to earlier or later dates |
| `Shift` + wheel or horizontal trackpad scroll | Pan the time window |
| Ordinary wheel | Scroll levels; over expanded text, scroll its body first |
| **Показать все** — Show all | Fit dates horizontally; tall sets still scroll vertically |
| **Сегодня** — Today | Center today without changing the window duration |
| **К дате** — Go to date | Enter `YYYY-MM-DD` or `YYYY-MM-DD HH:mm` |
| **Параметры даты** — Date properties | Change property names and priority |

Coincident or nearby dates use additional levels to avoid overlap. Your preferred level is retained; the effective level may change with zoom or card expansion. The narrowest time window is one hour; the widest depends on the selected dates and fitted view.

Rings on the thin time axis mark note dates and follow the selected range. Notes missing a date or tags use a gray ring and a dashed connector, matching their gray card frame. The axis stays visible while the cards scroll vertically.

Pinch-to-zoom is not implemented. Use buttons on a phone or tablet; physical-device verification is still outstanding.

## Tags and removal

Use the **+** beside the tags or **Действия с карточкой → Добавить тег**. Applying a valid tag writes to the source note without changing its date. [Where tags are written](dates-and-tags.md).

**Действия с карточкой → Убрать с оси** removes membership and layout only. The note stays in the vault.

The toolbar shows saving status. If it reports an error, retry before closing; see [troubleshooting](troubleshooting.md).
