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
		this._addCollectionContextMenu(window);
		this._setupTabContextMenuListener(window);

		// Restore previously saved group state after Zotero has had time
		// to fully rebuild its tab list from the last session.
		window.setTimeout(() => this._restoreState(window), 2000);
	},

	removeFromWindow(window) {
		const st = this._state.get(window);
		if (st) {
			if (st.tabBarObs) st.tabBarObs.disconnect();
			if (st.debounceTimer) window.clearTimeout(st.debounceTimer);
		}
		this._state.delete(window);
		// Leave saved state intact — it will be restored on the next startup.
		// Only clear it on a full uninstall (handled by shutdown/uninstall hooks).

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

			// Flash the button on every confirmed activation so users get
			// immediate feedback even when no tabs are open yet.
			const flashBtn = () => {
				btn.classList.add("gtbc-group-button--active");
				window.setTimeout(
					() => btn.classList.remove("gtbc-group-button--active"),
					150
				);
			};

			// Handle both mousedown AND click as a fallback:
			// - mousedown fires before focus-management on Windows (first click works)
			// - click is kept as safety net in case mousedown is swallowed somewhere
			// A short-lived flag prevents both from firing in the same interaction.
			let _btnFiredFromMousedown = false;

			// Prevent a double-click on the button from triggering the OS
			// window-maximise behaviour (the tab bar sits in the title-bar drag
			// region on Windows; -moz-window-dragging:no-drag in CSS is the
			// primary fix, this is belt-and-suspenders).
			btn.addEventListener("dblclick", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});

			// Use mousedown instead of click so the action fires on the first
			// interaction even when the Zotero window was not already focused
			// (Windows swallows the click event that brings the window forward).
			btn.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				_btnFiredFromMousedown = true;
				flashBtn();
				this.groupTabs(window);
			});

			btn.addEventListener("click", (e) => {
				if (_btnFiredFromMousedown) {
					_btnFiredFromMousedown = false;
					return;
				}
				e.stopPropagation();
				flashBtn();
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

	_addCollectionContextMenu(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

		const collMenu = doc.getElementById("zotero-collectionmenu");
		if (!collMenu) return;

		const sep = doc.createElementNS(XUL, "menuseparator");
		sep.id = "gtbc-collmenu-sep";
		collMenu.appendChild(sep);
		data.addedElementIDs.push(sep.id);

		const item = doc.createElementNS(XUL, "menuitem");
		item.id = "gtbc-collmenu-open";
		item.setAttribute("label", "Open all in tab group");
		item.addEventListener("command", () => this._openCollectionAsGroup(window));
		collMenu.addEventListener("popupshowing", () => {
			const row = window.ZoteroPane?.getCollectionTreeRow?.();
			item.setAttribute("disabled", row?.isCollection?.() ? "false" : "true");
		});
		collMenu.appendChild(item);
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
			(t) => t.type === "reader" || t.type === "reader-unloaded" || t.type === "note"
		);

		if (readerTabs.length === 0) {
			Zotero.alert(
				window,
				"Group Tabs by Collection",
				"No reader or note tabs are currently open."
			);
			return;
		}

		// If groups already exist, only pull in tabs that aren't assigned yet.
		// This preserves manually moved tabs and existing group colours/order.
		const existingState = this._state.get(window);
		if (existingState && existingState.groups.length > 0) {
			await this._groupNewTabs(window, readerTabs, ZoteroTabs);
			return;
		}

		// No groups yet — full initial grouping.
		const tabInfos = await this._buildTabInfos(readerTabs);
		const conflicts = tabInfos.filter((ti) => ti.collections.length > 1);

		if (conflicts.length > 0) {
			const proceed = this._handleConflicts(window, conflicts);
			if (!proceed) return;
		}

		const existingOverrides = existingState?.overrides ?? new Map();
		this._applyGrouping(window, tabInfos, ZoteroTabs, existingOverrides);
		this._buildGroupState(window, tabInfos, existingOverrides);
		this._renderGroupChips(window, "groupTabs");
		this._setupTabBarObserver(window);
		this._saveState(window);
	},

	// Incremental grouping: called when groups already exist.
	// Creates group entries for any new collections, then re-renders.
	// Already-grouped tabs are untouched; their order and overrides are preserved.
	async _groupNewTabs(window, readerTabs, ZoteroTabs) {
		const st = this._state.get(window);
		const groupedIds = new Set(st.groups.flatMap((g) => g.tabIds));
		const newTabs = readerTabs.filter((t) => !groupedIds.has(t.id));

		if (newTabs.length === 0) return;

		const tabInfos = await this._buildTabInfos(newTabs);
		const conflicts = tabInfos.filter((ti) => ti.collections.length > 1);
		if (conflicts.length > 0) {
			const proceed = this._handleConflicts(window, conflicts);
			if (!proceed) return;
		}

		// Create a group entry for any collection not yet represented.
		// _renderGroupChips step 3 will handle assigning the actual tab IDs.
		const usedColors = new Set(st.groups.map((g) => g.color));
		let ci = 0;
		for (const ti of tabInfos) {
			const colName = ti.selectedCollection?.name;
			if (!colName) continue;
			if (st.groups.find((g) => g.name === colName)) continue;
			while (usedColors.has(this.COLORS[ci % this.COLORS.length])) ci++;
			const color = this.COLORS[ci++ % this.COLORS.length];
			usedColors.add(color);
			st.groups.push({ name: colName, color, tabIds: [], collapsed: false });
		}
		st.groups.sort((a, b) => a.name.localeCompare(b.name));

		if (st.tabBarObs) st.tabBarObs.disconnect();
		this._renderGroupChips(window, "groupTabs");
		const tabBar = window.document.getElementById("tab-bar-container");
		if (st.tabBarObs && tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		this._saveState(window);
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

	_applyGrouping(window, tabInfos, ZoteroTabs, overrides = new Map()) {
		// Build groups using override name (if any) in place of collection name
		// so manually-moved tabs end up physically next to their assigned group.
		const groups = new Map();
		const uncollected = [];

		for (const ti of tabInfos) {
			const overrideName = overrides.get(ti.tab.id);
			const groupName = overrideName ?? ti.selectedCollection?.name;
			if (!groupName) { uncollected.push(ti); continue; }
			if (!groups.has(groupName)) {
				groups.set(groupName, {
					collection: overrideName ? { name: overrideName } : ti.selectedCollection,
					items: [],
				});
			}
			groups.get(groupName).items.push(ti);
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

	_buildGroupState(window, tabInfos, overrides = new Map()) {
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

		// Apply manual overrides: move tabs from their collection-assigned group
		// to the group the user explicitly chose.  Do this after colour/collapse
		// assignment so the overridden group still gets its usual styling.
		const openTabIdSet = new Set(tabInfos.map(ti => ti.tab.id));
		const groupNameSet = new Set(groups.map(g => g.name));
		// Prune stale overrides (tab closed, or target group no longer exists).
		for (const [tabId, targetName] of overrides) {
			if (!openTabIdSet.has(tabId) || !groupNameSet.has(targetName)) {
				overrides.delete(tabId);
			}
		}
		// Apply valid overrides.
		for (const [tabId, targetName] of overrides) {
			const target = groups.find(g => g.name === targetName);
			if (!target) continue;
			for (const g of groups) {
				if (g !== target) g.tabIds = g.tabIds.filter(id => id !== tabId);
			}
			if (!target.tabIds.includes(tabId)) target.tabIds.push(tabId);
		}
		// Remove any groups left empty after override application.
		const nonEmpty = groups.filter(g => g.tabIds.length > 0);
		groups.length = 0;
		nonEmpty.forEach(g => groups.push(g));

		this._state.set(window, { groups, tabBarObs: null, debounceTimer: null, overrides });
	},

	_renderGroupChips(window, source) {
		const st = this._state.get(window);
		if (!st) return;

		const doc = window.document;
		const ZoteroTabs = window.Zotero_Tabs;
		const tabBar = doc.getElementById("tab-bar-container");
		if (!tabBar) return;

		// 1. Remove stale chips.
		for (const chip of tabBar.querySelectorAll(".gtbc-chip")) chip.remove();

		// 2. Build the set of currently-open tab IDs.
		//    READ-ONLY — do NOT mutate g.tabIds here.  The observer fires during tab
		//    creation when Zotero._tabs can be momentarily incomplete; a destructive
		//    filter at that instant would permanently drop valid tabs from their groups.
		//    Stale IDs are simply skipped in steps 5 and 6; actual cleanup happens only
		//    in groupTabs() which runs at a stable, user-initiated moment.
		const openTabIds = new Set((ZoteroTabs?._tabs || []).map((t) => t.id));

		// 3. Auto-assign newly opened tabs that belong to an existing group.
		//    Manual overrides take precedence over collection-based assignment.
		const overrides = st.overrides ?? new Map();
		const groupedIds = new Set(st.groups.flatMap((g) => g.tabIds));
		const allReaderTabs = (ZoteroTabs?._tabs || []).filter(
			(t) => t.type === "reader" || t.type === "reader-unloaded" || t.type === "note"
		);
		for (const tab of allReaderTabs) {
			if (groupedIds.has(tab.id)) continue;
			// Honour manual override first.
			const overrideName = overrides.get(tab.id);
			if (overrideName) {
				const target = st.groups.find(g => g.name === overrideName);
				if (target) {
					target.tabIds.push(tab.id);
					groupedIds.add(tab.id);
				}
				continue;
			}
			// Fall back to collection-based assignment.
			const item = this._getParentItem(tab.data?.itemID);
			if (!item) continue;
			const raw = item.getCollections()
				.map((id) => Zotero.Collections.get(id)).filter(Boolean);
			const cols = this._filterToLeafCollections(raw);
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
				if (!openTabIds.has(tabId)) continue; // skip stale IDs without dropping them
				const el = tabBar.querySelector(`.tab[data-id="${tabId}"]`);
				if (!el) continue;
				el.style.display = g.collapsed ? "none" : "";
				el.style.backgroundColor = tint;
				el.dataset.gtbcGroup = g.name;
				el.setAttribute("draggable", "true");
			}
		}

		// 6. Insert a chip before each group's first *open* tab.
		for (const g of st.groups) {
			const firstOpenId = g.tabIds.find((id) => openTabIds.has(id));
			if (!firstOpenId) continue;
			const anchorEl = tabBar.querySelector(`.tab[data-id="${firstOpenId}"]`);
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

		const _toggleCollapse = () => {
			group.collapsed = !group.collapsed;
			const st = this._state.get(window);
			if (st?.tabBarObs) st.tabBarObs.disconnect();
			this._renderGroupChips(window, "toggle");
			if (st?.tabBarObs) {
				const tabBar = window.document.getElementById("tab-bar-container");
				if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
			}
			this._saveState(window);
		};

		let _chipFiredFromMousedown = false;

		chip.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			_chipFiredFromMousedown = true;
			_toggleCollapse();
		});

		chip.addEventListener("click", (e) => {
			if (_chipFiredFromMousedown) {
				_chipFiredFromMousedown = false;
				return;
			}
			e.stopPropagation();
			_toggleCollapse();
		});

		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._showChipContextMenu(doc, window, group, chip);
		});

		// Drop target: accept a tab dragged from the tab bar.
		chip.addEventListener("dragover", (e) => {
			if (!e.dataTransfer.types.includes("text/x-gtbc-tab-id")) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			chip.classList.add("gtbc-chip--drop-target");
		});
		chip.addEventListener("dragleave", () => {
			chip.classList.remove("gtbc-chip--drop-target");
		});
		chip.addEventListener("drop", (e) => {
			e.preventDefault();
			chip.classList.remove("gtbc-chip--drop-target");
			const tabId = e.dataTransfer.getData("text/x-gtbc-tab-id");
			if (tabId && tabId !== group.tabIds[0]) {
				this._addTabToGroup(window, tabId, group);
			}
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
		this._renderGroupChips(window, "closeGroup");
		this._setupTabBarObserver(window);
		this._saveState(window);
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
		addMenu.setAttribute("label", "Move to group");
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
		// Record manual override so this assignment survives re-grouping.
		if (!st.overrides) st.overrides = new Map();
		st.overrides.set(tabId, targetGroup.name);

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
		this._renderGroupChips(window, "addToGroup");
		if (st.tabBarObs) {
			const tabBar = window.document.getElementById("tab-bar-container");
			if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		}
		this._saveState(window);
	},

	_removeTabFromGroup(window, tabId) {
		const st = this._state.get(window);
		if (!st) return;
		for (const g of st.groups) {
			g.tabIds = g.tabIds.filter((id) => id !== tabId);
		}
		st.overrides?.delete(tabId);
		if (st.tabBarObs) st.tabBarObs.disconnect();
		this._renderGroupChips(window, "removeFromGroup");
		if (st.tabBarObs) {
			const tabBar = window.document.getElementById("tab-bar-container");
			if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		}
		this._saveState(window);
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

	// ── Collection context menu: "Open all in tab group" ─────────────────────

	async _openCollectionAsGroup(window) {
		const pane = window.ZoteroPane;
		if (!pane) return;

		const row = pane.getCollectionTreeRow?.();
		if (!row?.isCollection?.()) return;
		const collection = row.collection;
		if (!collection) return;

		// Find items in this collection that have readable attachments.
		// We intentionally do not recurse into sub-collections; the user can
		// right-click those separately.
		const allItems = collection.getChildItems();
		const openable = allItems.filter((item) => {
			if (item.isAttachment()) {
				return (
					item.attachmentContentType === "application/pdf" ||
					item.isSnapshot()
				);
			}
			if (item.isRegularItem()) {
				return item.getAttachments().some((id) => {
					const att = Zotero.Items.get(id);
					return att && (
						att.attachmentContentType === "application/pdf" ||
						att.isSnapshot()
					);
				});
			}
			return false;
		});

		if (openable.length === 0) {
			Zotero.alert(
				window,
				"Group Tabs by Collection",
				`No PDFs or snapshots found in "${collection.name}".`
			);
			return;
		}

		const WARN_THRESHOLD = 20;
		if (openable.length > WARN_THRESHOLD) {
			const flags =
				Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
				Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
			const result = Services.prompt.confirmEx(
				window,
				"Group Tabs by Collection",
				`"${collection.name}" contains ${openable.length} items with attachments. Open all as tabs?`,
				flags,
				"Open all",
				"Cancel",
				"",
				null,
				{}
			);
			if (result !== 0) return;
		}

		try {
			await pane.viewItems(openable);
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
				this._renderGroupChips(window, "observer");
				st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
			}, 60);
		});

		st.tabBarObs.observe(tabBar, { childList: true, subtree: true });

		// Delegated dragstart: tag any tab element drag with its GTBC tab ID
		// so chips can identify which tab is being dropped onto them.
		tabBar.addEventListener("dragstart", (e) => {
			const tabEl = e.target.closest?.(".tab[data-id]");
			if (!tabEl) return;
			e.dataTransfer.setData("text/x-gtbc-tab-id", tabEl.dataset.id);
			e.dataTransfer.effectAllowed = "move";
		});
	},

	// ── State persistence ─────────────────────────────────────────────────────

	_saveState(window) {
		const st = this._state.get(window);
		if (!st || st.groups.length === 0) {
			try { Zotero.Prefs.clear("extensions.group-tabs-by-collection.state"); } catch (e) {}
			return;
		}

		const ZoteroTabs = window.Zotero_Tabs;
		const allTabs = ZoteroTabs?._tabs || [];

		// Tab IDs are ephemeral — translate overrides to itemId keys for storage.
		const itemOverrides = {};
		for (const [tabId, groupName] of (st.overrides ?? new Map())) {
			const tab = allTabs.find((t) => t.id === tabId);
			const itemID = tab?.data?.itemID;
			if (itemID) itemOverrides[String(itemID)] = groupName;
		}

		const data = {
			groups: st.groups.map((g) => ({ name: g.name, color: g.color, collapsed: g.collapsed })),
			overrides: itemOverrides,
		};

		try {
			Zotero.Prefs.set(
				"extensions.group-tabs-by-collection.state",
				JSON.stringify(data)
			);
		} catch (e) {
			Zotero.debug(`GTBC: failed to save state: ${e}`);
		}
	},

	async _restoreState(window) {
		// Don't clobber a grouping the user has already set up this session.
		if ((this._state.get(window)?.groups.length ?? 0) > 0) return;

		let data;
		try {
			const raw = Zotero.Prefs.get("extensions.group-tabs-by-collection.state");
			if (!raw) return;
			data = JSON.parse(raw);
		} catch (e) {
			Zotero.debug(`GTBC: failed to load saved state: ${e}`);
			return;
		}

		if (!data?.groups?.length) return;

		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) return;

		const allTabs = ZoteroTabs._tabs || [];
		const readerTabs = allTabs.filter(
			(t) => t.type === "reader" || t.type === "reader-unloaded" || t.type === "note"
		);
		if (readerTabs.length === 0) return;

		const tabInfos = await this._buildTabInfos(readerTabs);
		// Auto-resolve multi-collection conflicts silently on restore.
		for (const ti of tabInfos.filter((ti) => ti.collections.length > 1)) {
			ti.selectedCollection = ti.collections
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))[0];
		}

		// Translate saved itemId overrides back to current tab IDs.
		const overrides = new Map();
		for (const ti of tabInfos) {
			const itemID = ti.tab.data?.itemID;
			const savedGroup = itemID && data.overrides?.[String(itemID)];
			if (savedGroup) overrides.set(ti.tab.id, savedGroup);
		}

		this._applyGrouping(window, tabInfos, ZoteroTabs, overrides);
		this._buildGroupState(window, tabInfos, overrides);

		// Overlay the saved colours and collapsed states.  _buildGroupState
		// assigns defaults for "new" groups; we want the user's last-seen values.
		const st = this._state.get(window);
		if (st) {
			const savedByName = new Map(data.groups.map((g) => [g.name, g]));
			for (const g of st.groups) {
				const saved = savedByName.get(g.name);
				if (saved) {
					g.color = saved.color;
					g.collapsed = saved.collapsed;
				}
			}
		}

		this._renderGroupChips(window, "restore");
		this._setupTabBarObserver(window);
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
