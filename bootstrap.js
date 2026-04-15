var GroupTabsByCollection;

function log(msg) {
	Zotero.debug("Group Tabs by Collection: " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log("Starting");
	Services.scriptloader.loadSubScript(rootURI + "group-tabs.js");
	GroupTabsByCollection.init({ id, version, rootURI });
	GroupTabsByCollection.addToAllWindows();
}

function onMainWindowLoad({ window }) {
	GroupTabsByCollection.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	GroupTabsByCollection.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	GroupTabsByCollection.removeFromAllWindows();
	GroupTabsByCollection = undefined;
}

function uninstall() {
	log("Uninstalled");
}
