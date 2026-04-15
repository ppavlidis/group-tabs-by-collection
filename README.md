# Group Tabs by Collection

A [Zotero](https://www.zotero.org/) plugin that groups open reader/snapshot tabs by collection, with collapsible group chips — similar to Chrome's tab groups.

![icon](content/icons/favicon.svg)

## What it does

When you have many PDFs or snapshots open at once, the Zotero tab bar becomes a flat, unorganised list. This plugin lets you group those tabs by the Zotero collection each item belongs to:

- A coloured **group chip** appears before each collection's first tab, labelled with the collection name.
- **Click a chip** to collapse the group — the tabs fold away and the chip shows a count badge.
- **Click again** to expand.
- Up to 8 distinct colours are assigned automatically (blue, green, orange, purple, teal, rose, amber, indigo).

If a tab's item belongs to **multiple collections**, the plugin shows a confirmation dialog listing each conflict and suggesting a default resolution (the first collection alphabetically). You can proceed or cancel.

## Usage

1. Open several PDFs or snapshots from different collections.
2. Go to **Tools → Group Tabs by Collection**.
3. Tabs are reordered and group chips appear in the tab bar.
4. Click any chip to collapse or expand that group.

The grouping is **on-demand** — run it again any time you open new tabs and want to re-sort.

## Installation

Download the latest `group-tabs-by-collection.xpi` from the [Releases](../../releases) page.

In Zotero: **Tools → Add-ons → gear icon → Install Add-on From File…**

Requires Zotero 7 or 8.

## Building from source

```bash
git clone https://github.com/ppavlidis/group-tabs-by-collection.git
cd group-tabs-by-collection
bash build-xpi.sh
```

Then install the resulting `group-tabs-by-collection.xpi` as above.
