# Group Tabs by Collection

A [Zotero](https://www.zotero.org/) plugin that groups open reader/snapshot tabs by collection, with collapsible group chips — similar to Chrome's tab groups.

<img width="835" height="68" alt="image" src="https://github.com/user-attachments/assets/11b42988-ab90-43d8-9be4-899f35b26370" />

I decided to implement this after realizing this was a common complaint about Zotero, and a [long-standing feature request](https://forums.zotero.org/discussion/110657/feature-request-improved-tab-navigation-tab-search-tab-grouping-cycle-last-used-tab). If Zotero releases an official feature, this plugin should probably not be used.

## What it does

When you have many PDFs or snapshots open at once, the Zotero tab bar becomes a flat, unorganised list. This plugin lets you group those tabs by the Zotero collection each item belongs to:

- A coloured **group chip** appears before each collection's first tab, labelled with the collection name.
- **Click a chip** to collapse the group — the tabs fold away and the chip shows a count badge. Click again to expand.
- **Right-click a chip** for a context menu with **"Close all tabs in …"**.
- **Right-click a tab** for an **"Add to tab group"** submenu to move it into an existing group.
- **Right-click items** in the item list for an **"Open in tab group(s)"** option that opens and groups them in one step.
- When there are multiple groups, all start **collapsed** so you get an instant overview. When everything belongs to one collection the group starts expanded (collapsing it would leave nothing visible).
- Newly opened tabs are automatically assigned to an existing group if they belong to that collection — no need to re-run the command.
- Up to 8 distinct colours are assigned automatically (blue, green, orange, purple, teal, rose, amber, indigo).
- Tabs within a group are tinted with that group's colour.
- Items with no collection are placed at the end, ungrouped.

## Usage

1. Select papers in the item list and right-click → **"Open in tab group(s)"** to open and group them in one step, or open PDFs/snapshots manually and then click the **four-box button** in the tab bar (or **Tools → Group Tabs by Collection**).
2. Tabs are reordered and coloured group chips appear in the tab bar.
3. Click a chip to collapse or expand that group; right-click for close-all.
4. Newly opened tabs are automatically slotted into the correct group — run the command again only if you want a full re-sort.

If a tab's item belongs to **multiple collections**, a confirmation dialog lists each conflict and suggests a default resolution (the first collection alphabetically).

## Installation

Download the latest `group-tabs-by-collection.xpi` from the [Releases](../../releases) page.

In Zotero: **Tools → Add-ons → gear icon → Install Add-on From File…**

Requires Zotero 7, 8, or 9.

## Building from source

**macOS / Linux**
```bash
git clone https://github.com/ppavlidis/group-tabs-by-collection.git
cd group-tabs-by-collection
bash build-xpi.sh
```

**Windows** (PowerShell, no WSL required)
```powershell
git clone https://github.com/ppavlidis/group-tabs-by-collection.git
cd group-tabs-by-collection
Compress-Archive -Path manifest.json,bootstrap.js,group-tabs.js,style.css,updates.json,content -DestinationPath group-tabs-by-collection.zip -Force
Rename-Item group-tabs-by-collection.zip group-tabs-by-collection.xpi
```

Then install the resulting `group-tabs-by-collection.xpi` as above.

## Notes

Groups are not persisted across Zotero restarts — click the four-box button to regroup after reopening your tabs.
