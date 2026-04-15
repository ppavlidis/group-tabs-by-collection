/**
 * Group Tabs by Collection
 *
 * After calling "Group Tabs", the plugin:
 *  1. Reorders reader/note tabs so each collection's tabs are contiguous.
 *  2. Injects a colored chip before the first tab of each group.
 *  3. Clicking a chip collapses (hides) or expands (shows) that group.
 *  4. A MutationObserver re-injects chips whenever React re-renders the
 *     tab bar (e.g., a new tab is opened).
 */
var GroupTabsByCollection = {
	id: null,
	version: null,
	rootURI: null,
	_windows: new Map(),

	// Per-window grouping state.
	// Map<Window, { groups: GroupEntry[], tabBarObs: MutationObserver|null }>
	// GroupEntry: { name, color, tabIds, collapsed }
	_state: new Map(),

	// Colours assigned to groups in the order they appear (alphabetical).
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
		const data = { addedElementIDs: [] };
		this._windows.set(window, data);

		const link = doc.createElement("link");
		link.id = "gtbc-style";
		link.rel = "stylesheet";
		link.href = this.rootURI + "style.css";
		doc.documentElement.appendChild(link);
		data.addedElementIDs.push(link.id);

		this._addMenuItem(window);
		this._addGroupButton(window);
	},

	removeFromWindow(window) {
		// Stop the tab-bar observer.
		const st = this._state.get(window);
		if (st?.tabBarObs) st.tabBarObs.disconnect();
		this._state.delete(window);

		// Remove all injected DOM elements (stylesheet, menu items, button).
		const data = this._windows.get(window);
		if (!data) return;
		const doc = window.document;
		for (const id of data.addedElementIDs) doc.getElementById(id)?.remove();

		// Also remove any lingering chips from the tab bar.
		for (const chip of doc.querySelectorAll(".gtbc-chip")) chip.remove();

		this._windows.delete(window);
	},

	// ── UI injection ─────────────────────────────────────────────────────────

	_addMenuItem(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const XUL =
			"http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

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
			const itemID = tab.data?.itemID;
			let item = null;
			let collections = [];

			if (itemID) {
				item = Zotero.Items.get(itemID);
				if (item) {
					let src = item;
					if (item.isAttachment() && item.parentID) {
						src = Zotero.Items.get(item.parentID) || item;
					}
					const ids = src.getCollections();
					collections = ids
						.map((id) => Zotero.Collections.get(id))
						.filter(Boolean);
				}
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
			const all = ci.collections
				.map((c) => c.name)
				.sort()
				.join(", ");
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

		const choice = Services.prompt.confirmEx(
			window,
			"Group Tabs by Collection — Conflicts",
			msg,
			flags,
			"Group (use suggested)",
			"Cancel",
			"",
			null,
			{}
		);
		return choice === 0;
	},

	_applyGrouping(window, tabInfos, ZoteroTabs) {
		const groups = new Map();
		const uncollected = [];

		for (const ti of tabInfos) {
			const c = ti.selectedCollection;
			if (!c) {
				uncollected.push(ti);
				continue;
			}
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
		// Tear down any existing observer.
		const existing = this._state.get(window);
		if (existing?.tabBarObs) existing.tabBarObs.disconnect();

		const groups = [];
		const nameToGroup = new Map();

		for (const ti of tabInfos) {
			const c = ti.selectedCollection;
			if (!c) continue;
			if (!nameToGroup.has(c.name)) {
				const g = {
					name: c.name,
					color: this.COLORS[nameToGroup.size % this.COLORS.length],
					tabIds: [],
					collapsed: false,
				};
				nameToGroup.set(c.name, g);
				groups.push(g);
			}
			nameToGroup.get(c.name).tabIds.push(ti.tab.id);
		}

		groups.sort((a, b) => a.name.localeCompare(b.name));
		this._state.set(window, { groups, tabBarObs: null });
	},

	/**
	 * Remove stale chips, re-insert one before the first (visible) tab of
	 * each group, and hide/show tab elements to match collapsed state.
	 *
	 * This is safe to call multiple times; it always starts by removing
	 * all existing chips.
	 */
	_renderGroupChips(window) {
		const st = this._state.get(window);
		if (!st) return;

		const doc = window.document;
		const ZoteroTabs = window.Zotero_Tabs;
		const tabBar = doc.getElementById("tab-bar-container");
		if (!tabBar) return;

		// ── 1. Remove stale chips ───────────────────────────────────────────
		for (const chip of tabBar.querySelectorAll(".gtbc-chip")) {
			chip.remove();
		}

		// ── 2. Sync open tabs: drop tabIds that Zotero has since closed ─────
		const openTabIds = new Set(
			(ZoteroTabs?._tabs || []).map((t) => t.id)
		);
		for (const g of st.groups) {
			g.tabIds = g.tabIds.filter((id) => openTabIds.has(id));
		}

		// ── 3. Apply collapsed/expanded visibility to each tab element ──────
		for (const g of st.groups) {
			for (const tabId of g.tabIds) {
				const el = tabBar.querySelector(`.tab[data-id="${tabId}"]`);
				if (el) el.style.display = g.collapsed ? "none" : "";
			}
		}

		// ── 4. Insert a chip before each group's first (non-hidden) tab ─────
		for (const g of st.groups) {
			if (g.tabIds.length === 0) continue;

			// Use the first tab in the group (visible or not) as anchor.
			const anchorId = g.tabIds[0];
			const anchorEl = tabBar.querySelector(`.tab[data-id="${anchorId}"]`);
			if (!anchorEl) continue;

			const chip = this._makeChip(doc, g, window);
			anchorEl.parentNode.insertBefore(chip, anchorEl);
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
			`<span class="gtbc-chip-arrow">${group.collapsed ? "▸" : "▾"}</span>`;

		chip.title = group.collapsed
			? `Expand "${group.name}" (${group.tabIds.length} tab${group.tabIds.length === 1 ? "" : "s"})`
			: `Collapse "${group.name}"`;

		chip.addEventListener("click", (e) => {
			e.stopPropagation();
			group.collapsed = !group.collapsed;
			// Pause the observer so our re-render doesn't trigger it.
			const st = this._state.get(window);
			if (st?.tabBarObs) st.tabBarObs.disconnect();
			this._renderGroupChips(window);
			if (st?.tabBarObs) {
				const tabBar = window.document.getElementById("tab-bar-container");
				if (tabBar) {
					st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
				}
			}
		});

		return chip;
	},

	// ── Tab-bar MutationObserver ──────────────────────────────────────────────

	/**
	 * Watch the tab bar for React re-renders (detected by our chips
	 * disappearing) and re-inject chips when that happens.
	 */
	_setupTabBarObserver(window) {
		const st = this._state.get(window);
		if (!st) return;
		if (st.tabBarObs) st.tabBarObs.disconnect();

		const doc = window.document;
		const tabBar = doc.getElementById("tab-bar-container");
		if (!tabBar) return;

		let timer = null;

		st.tabBarObs = new window.MutationObserver((mutations) => {
			// Only act if one of our chips was removed.
			const chipRemoved = mutations.some((m) =>
				Array.from(m.removedNodes).some(
					(n) => n.classList?.contains?.("gtbc-chip")
				)
			);
			if (!chipRemoved) return;

			if (timer) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				st.tabBarObs.disconnect();
				this._renderGroupChips(window);
				st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
			}, 60);
		});

		st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
	},

	// ── Helpers ───────────────────────────────────────────────────────────────

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
