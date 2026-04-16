/**
 * Group Tabs by Collection
 *
 * After calling "Group Tabs", the plugin:
 *  1. Reorders reader/note tabs so each collection's tabs are contiguous.
 *  2. Injects a coloured chip before the first tab of each group.
 *  3. Click a chip to collapse/expand that group.
 *  4. Right-click a chip → "Close all tabs in …"
 *  5. Right-click a tab  → "Add to tab group …" submenu.
 *  6. Right-click items in the item list → "Open in tab group(s)".
 *  7. A MutationObserver re-injects chips when React re-renders the tab bar,
 *     and auto-assigns any newly opened tabs to their matching group.
 */
var GroupTabsByCollection = {
	id: null,
	version: null,
	rootURI: null,
	_windows: new Map(),

	// Per-window grouping state.
	// { groups: GroupEntry[], tabBarObs: MutationObserver|null, debounceTimer: id|null }
	// GroupEntry: { name, color, tabIds: string[], collapsed: bool }
	_state: new Map(),

	COLORS: [
		"#4D6B8A", // blue   (Zotero brand)
		"#5B8A4D", // green
		"#C97C3F", // orange
		"#7B5EA7", // purple
		"#3F8A8A", // teal
		"#A7395E", // rose
		"#8A6D3F", // amber
		"#3F5CA7", // indigo
	],

	// ── Window lifecycle ─────────────────────────────────────────────────────

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	addToAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (!win.closed) this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		for (const win of Zotero.getMainWindows()) this.removeFromWindow(win);
	},

	addToWindow(window) {
		if (this._windows.has(window)) return;
		const doc = window.document;
		const data = { addedElementIDs: [], tabContextHandler: null };
		this._windows.set(window, data);

		const link = doc.createElement("link");
		link.id = "gtbc-style";
		link.rel = "stylesheet";
		link.href = this.rootURI + "style.css";
		doc.documentElement.appendChild(link);
		data.addedElementIDs.push(link.id);

		this._addMenuItem(window);
		this._addGroupButton(window);
		this._addItemContextMenu(window);
		this._setupTabContextMenuListener(window);
	},

	removeFromWindow(window) {
		const st = this._state.get(window);
		if (st) {
			if (st.tabBarObs) st.tabBarObs.disconnect();
			if (st.debounceTimer) window.clearTimeout(st.debounceTimer);
		}
		this._state.delete(window);

		const data = this._windows.get(window);
		if (!data) return;
		const doc = window.document;

		for (const id of data.addedElementIDs) doc.getElementById(id)?.remove();

		if (data.tabContextHandler) {
			doc.removeEventListener("contextmenu", data.tabContextHandler, true);
		}

		for (const chip of doc.querySelectorAll(".gtbc-chip")) chip.remove();
		for (const el of doc.querySelectorAll(".tab[data-gtbc-group]")) {
			el.style.backgroundColor = "";
			el.removeAttribute("data-gtbc-group");
		}

		this._windows.delete(window);
	},

	// ── UI injection ─────────────────────────────────────────────────────────

	_addMenuItem(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

		const menu = doc.getElementById("menu_ToolsPopup");
		if (!menu) return;

		const sep = doc.createElementNS(XUL, "menuseparator");
		sep.id = "gtbc-menu-sep";
		menu.appendChild(sep);
		data.addedElementIDs.push(sep.id);

		const item = doc.createElementNS(XUL, "menuitem");
		item.id = "gtbc-menuitem";
		item.setAttribute("label", "Group Tabs by Collection");
		item.addEventListener("command", () => this.groupTabs(window));
		menu.appendChild(item);
		data.addedElementIDs.push(item.id);
	},

	_addGroupButton(window) {
		const doc = window.document;
		const data = this._windows.get(window);

		const tryAdd = () => {
			if (doc.getElementById("gtbc-group-btn")) return;
			const container =
				doc.getElementById("tab-bar-container") ||
				doc.querySelector(".tab-bar-container");
			if (!container) return;

			const btn = doc.createElement("button");
			btn.id = "gtbc-group-btn";
			btn.className = "gtbc-group-button";
			btn.title = "Group tabs by collection";
			btn.setAttribute("aria-label", "Group tabs by collection");
			btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
				<rect x="0.5" y="0.5" width="5" height="5" rx="1"/>
				<rect x="7.5" y="0.5" width="5" height="5" rx="1"/>
				<rect x="0.5" y="7.5" width="5" height="5" rx="1"/>
				<rect x="7.5" y="7.5" width="5" height="5" rx="1"/>
			</svg>`;
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.groupTabs(window);
			});
			container.appendChild(btn);
			data.addedElementIDs.push(btn.id);
		};

		tryAdd();
		window.setTimeout(tryAdd, 500);
		window.setTimeout(tryAdd, 2000);
	},

	_addItemContextMenu(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

		const itemMenu =
			doc.getElementById("zotero-itemmenu") ||
			doc.getElementById("itemMenu");
		if (!itemMenu) return;

		const sep = doc.createElementNS(XUL, "menuseparator");
		sep.id = "gtbc-itemmenu-sep";
		itemMenu.appendChild(sep);
		data.addedElementIDs.push(sep.id);

		const item = doc.createElementNS(XUL, "menuitem");
		item.id = "gtbc-itemmenu-open";
		item.setAttribute("label", "Open in tab group(s)");
		item.addEventListener("command", () =>
			this._openSelectedItemsInGroups(window)
		);
		itemMenu.addEventListener("popupshowing", () => {
			const hasSelection =
				(window.ZoteroPane?.getSelectedItems?.()?.length ?? 0) > 0;
			item.setAttribute("disabled", hasSelection ? "false" : "true");
		});
		itemMenu.appendChild(item);
		data.addedElementIDs.push(item.id);
	},

	_setupTabContextMenuListener(window) {
		const doc = window.document;
		const data = this._windows.get(window);

		const handler = (e) => {
			const st = this._state.get(window);
			if (!st || st.groups.length === 0) return;

			const tabEl = e.target.closest?.(".tab[data-id]");
			if (!tabEl) return;

			e.preventDefault();
			e.stopPropagation();
			this._showTabContextMenu(doc, window, tabEl.dataset.id, tabEl);
		};

		doc.addEventListener("contextmenu", handler, true);
		data.tabContextHandler = handler;
	},

	// ── Core grouping logic ───────────────────────────────────────────────────

	async groupTabs(window) {
		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) {
			Zotero.debug("GTBC: Zotero_Tabs not found");
			return;
		}

		const allTabs = ZoteroTabs._tabs || [];
		const readerTabs = allTabs.filter(
			(t) => t.type === "reader" || t.type === "note"
		);

		if (readerTabs.length === 0) {
			Zotero.alert(
				window,
				"Group Tabs by Collection",
				"No reader or note tabs are currently open."
			);
			return;
		}

		const tabInfos = await this._buildTabInfos(readerTabs);
		const conflicts = tabInfos.filter((ti) => ti.collections.length > 1);

		if (conflicts.length > 0) {
			const proceed = this._handleConflicts(window, conflicts);
			if (!proceed) return;
		}

		this._applyGrouping(window, tabInfos, ZoteroTabs);
		this._buildGroupState(window, tabInfos);
		this._renderGroupChips(window);
		this._setupTabBarObserver(window);
	},

	async _buildTabInfos(tabs) {
		const infos = [];
		for (const tab of tabs) {
			const item = this._getParentItem(tab.data?.itemID);
			let collections = [];

			if (item) {
				const raw = item
					.getCollections()
					.map((id) => Zotero.Collections.get(id))
					.filter(Boolean);
				// Drop ancestor collections: only keep the most specific
				// (deepest) collections. This prevents "Neuroscience >
				// Schizophrenia" from showing as a multi-collection conflict.
				collections = this._filterToLeafCollections(raw);
			}

			infos.push({
				tab,
				item,
				collections,
				selectedCollection:
					collections.length === 1 ? collections[0] : null,
			});
		}
		return infos;
	},

	_handleConflicts(window, conflicts) {
		for (const ci of conflicts) {
			ci.selectedCollection = ci.collections
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))[0];
		}

		const lines = conflicts.map((ci) => {
			const title = this._truncate(
				ci.item?.getDisplayTitle?.() || ci.tab.title || "Untitled",
				52
			);
			const all = ci.collections.map((c) => c.name).sort().join(", ");
			return (
				`\u2022 "${title}"\n` +
				`   In: ${all}\n` +
				`   \u2192 Will group under: ${ci.selectedCollection.name}`
			);
		});

		const msg =
			`${conflicts.length} tab(s) belong to multiple collections:\n\n` +
			lines.join("\n\n") +
			`\n\nProceed? (Each will be placed under the suggested collection.)`;

		const flags =
			Services.prompt.BUTTON_POS_0 *
				Services.prompt.BUTTON_TITLE_IS_STRING +
			Services.prompt.BUTTON_POS_1 *
				Services.prompt.BUTTON_TITLE_IS_STRING;

		return (
			Services.prompt.confirmEx(
				window,
				"Group Tabs by Collection — Conflicts",
				msg,
				flags,
				"Group (use suggested)",
				"Cancel",
				"",
				null,
				{}
			) === 0
		);
	},

	_applyGrouping(window, tabInfos, ZoteroTabs) {
		const groups = new Map();
		const uncollected = [];

		for (const ti of tabInfos) {
			const c = ti.selectedCollection;
			if (!c) { uncollected.push(ti); continue; }
			if (!groups.has(c.name)) groups.set(c.name, { collection: c, items: [] });
			groups.get(c.name).items.push(ti);
		}

		const sorted = Array.from(groups.values()).sort((a, b) =>
			a.collection.name.localeCompare(b.collection.name)
		);

		let idx = 1;
		for (const g of sorted) {
			for (const ti of g.items) {
				try { ZoteroTabs.move(ti.tab.id, idx++); }
				catch (e) { Zotero.debug(`GTBC: move failed: ${e}`); }
			}
		}
		for (const ti of uncollected) {
			try { ZoteroTabs.move(ti.tab.id, idx++); }
			catch (e) { Zotero.debug(`GTBC: move failed: ${e}`); }
		}
	},

	// ── Group state & chip rendering ──────────────────────────────────────────

	_buildGroupState(window, tabInfos) {
		// Cancel any in-flight debounce timer from the old state before
		// replacing it, so the old observer callback cannot fire after we set
		// up the new state and inadvertently reconnect a dead observer.
		const existing = this._state.get(window);
		if (existing) {
			if (existing.tabBarObs) existing.tabBarObs.disconnect();
			if (existing.debounceTimer) window.clearTimeout(existing.debounceTimer);
		}

		// Preserve colour and collapsed state for groups that already existed.
		const existingByName = new Map(
			(existing?.groups ?? []).map((g) => [g.name, g])
		);

		const groups = [];
		const nameToGroup = new Map();

		for (const ti of tabInfos) {
			const c = ti.selectedCollection;
			if (!c) continue;
			if (!nameToGroup.has(c.name)) {
				const prev = existingByName.get(c.name);
				nameToGroup.set(c.name, {
					name: c.name,
					color: prev?.color ?? null,     // filled in below for new groups
					tabIds: [],
					collapsed: prev?.collapsed ?? null, // filled in below for new groups
				});
				groups.push(nameToGroup.get(c.name));
			}
			nameToGroup.get(c.name).tabIds.push(ti.tab.id);
		}

		groups.sort((a, b) => a.name.localeCompare(b.name));

		// Assign colours to new groups, skipping colours already in use so
		// re-grouping doesn't change existing groups' colours.
		const usedColors = new Set(
			groups.filter((g) => g.color).map((g) => g.color)
		);
		let ci = 0;
		for (const g of groups) {
			if (!g.color) {
				while (usedColors.has(this.COLORS[ci % this.COLORS.length])) ci++;
				g.color = this.COLORS[ci++ % this.COLORS.length];
				usedColors.add(g.color);
			}
		}

		// Set default collapsed state for new groups only.
		// Existing groups keep whatever state the user last set.
		const hasMultiple = groups.length > 1;
		for (const g of groups) {
			if (g.collapsed === null) g.collapsed = hasMultiple;
		}

		this._state.set(window, { groups, tabBarObs: null, debounceTimer: null });
	},

	_renderGroupChips(window) {
		const st = this._state.get(window);
		if (!st) return;

		const doc = window.document;
		const ZoteroTabs = window.Zotero_Tabs;
		const tabBar = doc.getElementById("tab-bar-container");
		if (!tabBar) return;

		// 1. Remove stale chips.
		for (const chip of tabBar.querySelectorAll(".gtbc-chip")) chip.remove();

		// 2. Sync: drop tabIds Zotero has since closed.
		const openTabIds = new Set((ZoteroTabs?._tabs || []).map((t) => t.id));
		for (const g of st.groups) {
			g.tabIds = g.tabIds.filter((id) => openTabIds.has(id));
		}

		// 3. Auto-assign newly opened tabs that belong to an existing group.
		//    This handles the "opened more PDFs after grouping" case without
		//    requiring the user to re-run Group Tabs.
		const groupedIds = new Set(st.groups.flatMap((g) => g.tabIds));
		const allReaderTabs = (ZoteroTabs?._tabs || []).filter(
			(t) => t.type === "reader" || t.type === "note"
		);
		for (const tab of allReaderTabs) {
			if (groupedIds.has(tab.id)) continue;
			const item = this._getParentItem(tab.data?.itemID);
			if (!item) continue;
			const raw = item.getCollections()
				.map((id) => Zotero.Collections.get(id)).filter(Boolean);
			const cols = this._filterToLeafCollections(raw);
			// Use first matching group (alphabetical order, same as explicit grouping).
			const match = cols
				.map((c) => st.groups.find((g) => g.name === c.name))
				.find(Boolean);
			if (match) {
				match.tabIds.push(tab.id);
				groupedIds.add(tab.id);
			}
		}

		// 4. Clear previous tints so stale colour doesn't linger.
		for (const el of tabBar.querySelectorAll(".tab[data-gtbc-group]")) {
			el.style.backgroundColor = "";
			el.removeAttribute("data-gtbc-group");
		}

		// 5. Apply collapse state + tint to each tab element.
		for (const g of st.groups) {
			const tint = this._hexToRgba(g.color, 0.15);
			for (const tabId of g.tabIds) {
				const el = tabBar.querySelector(`.tab[data-id="${tabId}"]`);
				if (!el) continue;
				el.style.display = g.collapsed ? "none" : "";
				el.style.backgroundColor = tint;
				el.dataset.gtbcGroup = g.name;
			}
		}

		// 6. Insert a chip before each group's first tab.
		for (const g of st.groups) {
			if (g.tabIds.length === 0) continue;
			const anchorEl = tabBar.querySelector(
				`.tab[data-id="${g.tabIds[0]}"]`
			);
			if (!anchorEl) continue;
			anchorEl.parentNode.insertBefore(
				this._makeChip(doc, g, window),
				anchorEl
			);
		}
	},

	_makeChip(doc, group, window) {
		const chip = doc.createElement("div");
		chip.className = "gtbc-chip";
		chip.dataset.gtbcGroup = group.name;
		chip.style.setProperty("--gtbc-color", group.color);

		const label = group.collapsed
			? `${group.name} (${group.tabIds.length})`
			: group.name;

		chip.innerHTML =
			`<span class="gtbc-chip-dot"></span>` +
			`<span class="gtbc-chip-name">${this._escapeHtml(this._truncate(label, 22))}</span>` +
			`<span class="gtbc-chip-arrow">${group.collapsed ? "▶" : "▼"}</span>`;

		chip.title = group.collapsed
			? `Expand "${group.name}" (${group.tabIds.length} tab${group.tabIds.length === 1 ? "" : "s"})`
			: `Collapse "${group.name}"`;

		chip.addEventListener("click", (e) => {
			e.stopPropagation();
			group.collapsed = !group.collapsed;
			const st = this._state.get(window);
			if (st?.tabBarObs) st.tabBarObs.disconnect();
			this._renderGroupChips(window);
			if (st?.tabBarObs) {
				const tabBar = window.document.getElementById("tab-bar-container");
				if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
			}
		});

		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._showChipContextMenu(doc, window, group, chip);
		});

		return chip;
	},

	// ── Chip context menu ─────────────────────────────────────────────────────

	_showChipContextMenu(doc, window, group, anchorEl) {
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
		doc.getElementById("gtbc-chip-popup")?.remove();

		const popup = doc.createElementNS(XUL, "menupopup");
		popup.id = "gtbc-chip-popup";

		const closeAll = doc.createElementNS(XUL, "menuitem");
		closeAll.setAttribute(
			"label",
			`Close all tabs in "${this._truncate(group.name, 30)}"`
		);
		closeAll.addEventListener("command", () =>
			this._closeGroupTabs(window, group)
		);
		popup.appendChild(closeAll);

		doc.documentElement.appendChild(popup);
		popup.openPopup(anchorEl, "after_start", 0, 0, true, false);
		popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
	},

	_closeGroupTabs(window, group) {
		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) return;
		const st = this._state.get(window);
		if (st?.tabBarObs) st.tabBarObs.disconnect();
		ZoteroTabs.close([...group.tabIds]);
		if (st) st.groups = st.groups.filter((g) => g !== group);
		this._renderGroupChips(window);
		this._setupTabBarObserver(window);
	},

	// ── Tab context menu ──────────────────────────────────────────────────────

	_showTabContextMenu(doc, window, tabId, anchorEl) {
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
		const st = this._state.get(window);
		if (!st) return;

		doc.getElementById("gtbc-tab-popup")?.remove();

		const popup = doc.createElementNS(XUL, "menupopup");
		popup.id = "gtbc-tab-popup";

		const currentGroup = this._findGroupForTab(window, tabId);

		const addMenu = doc.createElementNS(XUL, "menu");
		addMenu.setAttribute("label", "Add to tab group");
		const addPopup = doc.createElementNS(XUL, "menupopup");

		for (const g of st.groups) {
			const mi = doc.createElementNS(XUL, "menuitem");
			const isCurrent = g === currentGroup;
			mi.setAttribute(
				"label",
				(isCurrent ? "\u2713 " : "") + this._truncate(g.name, 35)
			);
			if (isCurrent) mi.setAttribute("disabled", "true");
			mi.addEventListener("command", () =>
				this._addTabToGroup(window, tabId, g)
			);
			addPopup.appendChild(mi);
		}

		if (currentGroup) {
			addPopup.appendChild(doc.createElementNS(XUL, "menuseparator"));
			const remove = doc.createElementNS(XUL, "menuitem");
			remove.setAttribute("label", "Remove from group");
			remove.addEventListener("command", () =>
				this._removeTabFromGroup(window, tabId)
			);
			addPopup.appendChild(remove);
		}

		addMenu.appendChild(addPopup);
		popup.appendChild(addMenu);

		doc.documentElement.appendChild(popup);
		popup.openPopup(anchorEl, "after_start", 0, 0, true, false);
		popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
	},

	_findGroupForTab(window, tabId) {
		const st = this._state.get(window);
		return st?.groups.find((g) => g.tabIds.includes(tabId)) ?? null;
	},

	_addTabToGroup(window, tabId, targetGroup) {
		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) return;
		const st = this._state.get(window);
		if (!st) return;

		for (const g of st.groups) {
			g.tabIds = g.tabIds.filter((id) => id !== tabId);
		}
		targetGroup.tabIds.push(tabId);

		// Move tab to follow the last existing member of the target group.
		const allTabs = ZoteroTabs._tabs || [];
		const membersExceptNew = targetGroup.tabIds.slice(0, -1);
		let insertAfterIdx = -1;
		for (let i = 0; i < allTabs.length; i++) {
			if (membersExceptNew.includes(allTabs[i].id)) insertAfterIdx = i;
		}
		if (insertAfterIdx >= 0) {
			try { ZoteroTabs.move(tabId, insertAfterIdx + 1); }
			catch (e) { Zotero.debug(`GTBC: move failed: ${e}`); }
		}

		if (st.tabBarObs) st.tabBarObs.disconnect();
		this._renderGroupChips(window);
		if (st.tabBarObs) {
			const tabBar = window.document.getElementById("tab-bar-container");
			if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		}
	},

	_removeTabFromGroup(window, tabId) {
		const st = this._state.get(window);
		if (!st) return;
		for (const g of st.groups) {
			g.tabIds = g.tabIds.filter((id) => id !== tabId);
		}
		if (st.tabBarObs) st.tabBarObs.disconnect();
		this._renderGroupChips(window);
		if (st.tabBarObs) {
			const tabBar = window.document.getElementById("tab-bar-container");
			if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		}
	},

	// ── Item context menu: "Open in tab group(s)" ────────────────────────────

	async _openSelectedItemsInGroups(window) {
		const pane = window.ZoteroPane;
		if (!pane) return;

		const items = pane.getSelectedItems?.() ?? [];
		if (items.length === 0) return;

		try {
			await pane.viewItems(items);
		} catch (e) {
			Zotero.debug(`GTBC: viewItems failed: ${e}`);
			return;
		}

		// Brief settle so Zotero finishes registering the new tabs.
		await new Promise((r) => window.setTimeout(r, 300));
		await this.groupTabs(window);
	},

	// ── Tab-bar MutationObserver ──────────────────────────────────────────────

	_setupTabBarObserver(window) {
		const st = this._state.get(window);
		if (!st) return;
		if (st.tabBarObs) st.tabBarObs.disconnect();

		const doc = window.document;
		const tabBar = doc.getElementById("tab-bar-container");
		if (!tabBar) return;

		st.tabBarObs = new window.MutationObserver((mutations) => {
			const chipRemoved = mutations.some((m) =>
				Array.from(m.removedNodes).some(
					(n) => n.classList?.contains?.("gtbc-chip")
				)
			);
			if (!chipRemoved) return;

			if (st.debounceTimer) window.clearTimeout(st.debounceTimer);
			st.debounceTimer = window.setTimeout(() => {
				st.debounceTimer = null;
				// Abort if a new grouping run has replaced the state.
				if (this._state.get(window) !== st) return;
				st.tabBarObs.disconnect();
				this._renderGroupChips(window);
				st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
			}, 60);
		});

		st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
	},

	// ── Helpers ───────────────────────────────────────────────────────────────

	/**
	 * Return the parent item for an attachment, or the item itself otherwise.
	 * This ensures collection lookups reflect where the paper lives, not the
	 * attachment filename.
	 */
	_getParentItem(itemID) {
		if (!itemID) return null;
		const item = Zotero.Items.get(itemID);
		if (!item) return null;
		if (item.isAttachment() && item.parentID) {
			return Zotero.Items.get(item.parentID) || item;
		}
		return item;
	},

	/**
	 * Given a list of collections an item belongs to, remove any that are
	 * ancestors of another collection in the same list.
	 *
	 * Example: item in [Neuroscience, Schizophrenia] where Schizophrenia ⊂
	 * Neuroscience → returns [Schizophrenia]. No conflict is raised.
	 *
	 * If the item is in two sibling collections (e.g. [Schizophrenia,
	 * Depression], both children of Neuroscience) both are kept and the caller
	 * must handle the conflict.
	 */
	_filterToLeafCollections(collections) {
		if (collections.length <= 1) return collections;

		// Collect IDs of every ancestor of every collection in the list.
		const ancestorIds = new Set();
		for (const c of collections) {
			let cur = c;
			while (cur.parentID) {
				const parent = Zotero.Collections.get(cur.parentID);
				if (!parent) break;
				ancestorIds.add(parent.id);
				cur = parent;
			}
		}

		// Keep only collections that are NOT an ancestor of another in the list.
		const leaves = collections.filter((c) => !ancestorIds.has(c.id));
		return leaves.length > 0 ? leaves : collections;
	},

	_hexToRgba(hex, alpha) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	},

	_escapeHtml(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	},

	_truncate(s, n) {
		return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
	},
};
