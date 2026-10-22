# Dates, tags, and gray frames

**English** · [Русский](../ru/dates-and-tags.md) · [Documentation](index.md)

## Date sources and formats

The default priority is the first nonempty `timeline-date` property, then `date`, then a leading `📅` line. Change property names and their order with **Параметры даты** or the plugin's settings. Names are case-sensitive.

| Source | Accepted example |
| --- | --- |
| Property or leading line | `2026-10-22` |
| Property or leading line | `2026-10-22 15:30` |
| Property only | `2026-10-22T15:30` |
| Property only | `2026-10-22T15:30:00` |

Store property dates as strings; quoting YAML values makes the intent explicit. Dates without a time keep day precision and do not display an invented `00:00`. Values are Gregorian calendar dates in years `0001–9999`, independent of the device time zone. UTC `Z`, offsets, fractional or nonzero seconds, invalid days, and ambiguous local formats are not accepted.

The leading metadata block comes after optional YAML frontmatter. It may contain blank lines, `📅`, `📍 Tags:`, `🧭 MOC:`, and `🔗 Links:`. Date markers must start at the beginning of a line. Parsing stops at body text, a heading, a separator, a code block, or the first 32 lines after frontmatter. A date in the middle of prose is not an event date.

A nonempty invalid highest-priority source produces an error rather than silently falling back. A valid higher-priority date wins over conflicting lower-priority sources, with a warning. Duplicate date markers and malformed YAML are diagnosed explicitly. Modification time, creation time, and filenames are never treated as event dates.

## Missing fields

| Date in note | Tags in note | Card date | Frame |
| --- | --- | --- | --- |
| Present | Present | Source date | Normal |
| Missing | Present | Saved local date of addition | Gray: missing date |
| Present | Missing | Source date | Gray: missing tags |
| Missing | Missing | Saved local date of addition | Gray: both reasons |

An empty property, empty `tags` list, or empty `📍 Tags:` is not a filled field. The fallback date is stored in plugin data, not written into the note. It remains fixed after restart, a day change, or a time-zone change.

Adding a real source date moves the card to that date and clears its stored fallback. If the source date is later removed, a new fallback is captured when its absence is detected. Removing a card and adding it again also creates a new fallback if the note is still undated.

The gray frame disappears only after both required fields exist in the note. Filling tags alone does not resolve a missing date. Read errors and not-yet-ready metadata are not treated as missing dates.

## Reading and adding tags

Noteline combines YAML `tags`, Obsidian inline tags, and the leading `📍 Tags:` line. Duplicates are compared without case; the first spelling is retained. The current tag writer accepts letters, combining marks, numbers, underscores, hyphens, and nested `/` segments. A tag cannot contain spaces or be only a number. Emoji-only tags are not supported by this version's validator.

**Добавить тег** writes one explicit tag. If the tag already exists, no duplicate is written. The destination is:

1. The existing, unambiguous leading `📍 Tags:` line.
2. Otherwise, an existing valid YAML `tags` property.
3. Otherwise, a new leading `📍 Tags:` line after the date marker, or after frontmatter and initial blank lines.

Multiple tag marker lines or an invalid destination block the write with an explanation. Text edits use the current editor buffer or a transaction over the latest file text. YAML writes preserve the body and unrelated property values, but YAML formatting can be reserialized. If a YAML-target note is open in a source editor, change its tags through Properties or close that editor before retrying.

The action does not remove tags, change the note date, or rewrite arbitrary body hashtags. [Data and backup](data-and-security.md).
