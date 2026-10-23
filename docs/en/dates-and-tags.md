# Dates, tags, and gray frames

**English** · [Русский](../ru/dates-and-tags.md) · [Documentation](index.md)

## Date sources and formats

The default priority is the first nonempty `timeline-date` property, then `date`, then a leading `📅` line. Change property names and their order with **Параметры даты** in the current timeline tab. This setting belongs to that `.timeline` file. Names are case-sensitive.

| Source | Accepted example | Precision |
| --- | --- | --- |
| Property or leading line | `2026-10-22 15:30` | Minute |
| Property or leading line | `2026-10-22` | Day |
| Property or leading line | `2026-10` | Month |
| Property or leading line | `2026`, `44`, `0044` | Year |
| Property or leading line | `XIX`, `II` | Century |
| Property or leading line | `44 BC`, `44 BCE`, `II BC` | BCE year or century |
| Property only | `2026-10-22T15:30`, `2026-10-22T15:30:00` | Minute |

Property values normally use strings. A year can also be a YAML integer from `1` to `9999`, such as `date: 2026`. Booleans, arrays, objects, negative numbers, zero, and fractional numbers are not date values. Quote months, centuries, and BCE years to make their string type explicit:

```yaml
---
date: 2026
tags:
  - history
---
```

For a different note, use `date: "2026-10"`, `date: "XIX"`, or `date: "44 BC"`. A leading marker uses the same text formats, for example `📅 II BC`; the `T` separator and seconds are accepted only in a property.

The original precision is retained. A month is placed at the beginning of that month, a year at the beginning of that year, and a century at the beginning of its historical period. These coordinates only position the card: `2026-10` is still displayed as a month, `2026` as a year, and `XIX` as a century. The plugin does not display an invented day or time for a less precise value and does not fill missing date components in the note. Day-only dates do not acquire a visible `00:00`.

Years in source values range from `1` to `9999`; complete day and month formats use four-digit years. Centuries use canonical uppercase Roman numerals from `I` through `C`, with no added word: `XIX` is accepted; `xix`, `IIII`, `IC`, `CI`, `XIX century`, and `XIX век` are rejected. `I` CE begins in year 1, `XIX` CE begins in 1801, and `C` CE covers 9901–10000. A Roman numeral always means a century, not a year.

BCE is supported only for years and centuries. Add a space and `BC`, `BCE`, `д.н.э.`, or `до н.э.`; spaces inside the Russian abbreviations are also accepted, such as `44 до н. э.`. Latin era suffixes are case-insensitive, but Roman numerals remain uppercase. For example, `44 BC` is a year, `II BC` begins in 200 BC, `I BC` begins in 100 BC, and `C BC` covers 10000–9901 BC. A BCE suffix on a month, day, or time is rejected. Values without an era suffix are CE; explicit `CE` and `AD` suffixes are not accepted.

Historical numbering has no year zero: 2 BC is followed by 1 BC, then 1 CE. The internal astronomical year zero represents 1 BC and is never displayed as a historical year. The English notation `44 BC` corresponds to the Russian label `44 до н. э.`.

Calendar coordinates are independent of the device time zone and DST. Day-level dates use the Gregorian calendar. UTC `Z`, offsets, fractional or nonzero seconds, invalid days, and ambiguous local formats such as `22/10/26` are not accepted. An incomplete value must match a supported precision exactly; it is not parsed as an approximate full date.

The leading metadata block comes after optional YAML frontmatter. It may contain blank lines, `📅`, `📍 Tags:`, `🧭 MOC:`, and `🔗 Links:`. Date markers must start at the beginning of a line. Parsing stops at body text, a heading, a separator, a code block, or the first 32 lines after frontmatter. A date in the middle of prose is not an event date.

A nonempty invalid highest-priority source produces an error rather than silently falling back. A valid higher-priority date wins over conflicting lower-priority sources, with a warning. Duplicate date markers and malformed YAML are diagnosed explicitly. Modification time, creation time, and filenames are never treated as event dates.

## Missing fields

| Date in note | Tags in note | Card date | Frame |
| --- | --- | --- | --- |
| Present | Present | Source date | Normal |
| Missing | Present | Saved local date of addition | Gray: missing date |
| Present | Missing | Source date | Gray: missing tags |
| Missing | Missing | Saved local date of addition | Gray: both reasons |

An empty property, empty `tags` list, or empty `📍 Tags:` is not a filled field. The fallback date is stored as `fallbackDate` in this note's entry in the current `.timeline` file. The source note remains unchanged. The saved day stays fixed after restart, a day change, or a time-zone change. Different timelines can retain different fallback dates for the same undated note.

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
