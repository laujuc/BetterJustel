window.BJ = window.BJ || {};
window.BJ.backupModule = function(ctx) {

	// pCloud has no dedicated application folder like Dropbox does:
	// backups are grouped in a folder reserved to this extension.
	const PCLOUD_FOLDER = "/betterlaws";
	const PCLOUD_FOLDER_LEGACY = "/BetterJustel";
	const PCLOUD_LAWS = "/betterlaws/laws";
	const LAWS_PER_RUN = 4;

	async function pcloudRequest(backup, method, params = {}, form = undefined) {
		// The access token is passed as a query parameter: the pCloud API does
		// not list the Authorization header in its CORS preflight answers, while
		// requests with query parameters only need no preflight at all
		const url = new URL(`https://${backup.hostname || "api.pcloud.com"}/${method}`);
		url.searchParams.set("access_token", backup.accessToken);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, String(value));
		}
		const response = await fetch(url, {method: form ? "POST" : "GET", body: form});
		const result = await response.json();
		if (result.result !== 0) {
			throw new Error(`${result.error || "unknown error"} (code ${result.result})`);
		}
		return result;
	}

	function pcloudFolderMissing(error) {
		return /\(code 2005\)|\(code 2009\)/.test(error?.message || "");
	}

	async function renameLegacyPcloudFolder(backup) {
		// Rename /BetterJustel to /betterlaws. A missing legacy folder is normal.
		// If /betterlaws already exists, leave the old folder and write to the new one.
		try {
			await pcloudRequest(backup, "renamefolder", {
				path: PCLOUD_FOLDER_LEGACY,
				topath: PCLOUD_FOLDER,
			});
		}
		catch (e) {
			if (!pcloudFolderMissing(e) && !/\(code 2004\)/.test(e?.message || "")) {
				throw e;
			}
		}
	}

	async function ensurePcloudFolder(backup) {
		await renameLegacyPcloudFolder(backup);
		await pcloudRequest(backup, "createfolderifnotexists", {path: PCLOUD_FOLDER});
		await pcloudRequest(backup, "createfolderifnotexists", {path: PCLOUD_LAWS});
	}

	async function backupToPcloud(backup, data) {
		await ensurePcloudFolder(backup);
		// In the multipart body, parameters must come before the file; a file
		// with the same name is overwritten (the previous version is kept as a
		// revision by pCloud)
		const form = new FormData();
		form.append("path", PCLOUD_FOLDER);
		form.append("filename", `${backup.filename}.json`);
		form.append("data", new Blob([data], {type: "application/json"}), `${backup.filename}.json`);
		return pcloudRequest(backup, "uploadfile", {}, form);
	}

	function isCachedAct(key, value) {
		if (typeof key !== "string" || !/^https?:\/\//.test(key)) { return false; }
		if (!value || typeof value !== "object" || Array.isArray(value)) { return false; }
		return Array.isArray(value.content) && value.content.length > 0;
	}

	function lawFileName(act, version) {
		const numac = String(act.numac || "").replace(/[^A-Za-z0-9]+/g, "");
		const stamp = String(version || "undated").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "undated";
		let base = numac;
		if (!base) {
			try {
				base = new URL(act.eli || "https://example.invalid/act").pathname
					.replace(/^\/+|\/+$/g, "")
					.replace(/[^A-Za-z0-9]+/g, "-")
					.replace(/^-|-$/g, "");
			} catch {
				base = "act";
			}
		}
		if (!base) { base = "act"; }
		if (base.length > 80) { base = base.slice(0, 80); }
		return `${base}-${stamp}.json`;
	}

	async function pcloudFileExists(backup, filePath) {
		try {
			await pcloudRequest(backup, "stat", {path: filePath});
			return true;
		}
		catch (e) {
			if (/\(code 2002\)|\(code 2005\)|\(code 2009\)|\(code 2055\)/.test(e?.message || "")) {
				return false;
			}
			throw e;
		}
	}

	async function uploadCachedAct(backup, key, act, version) {
		const filename = lawFileName(act, version);
		const remote = `${PCLOUD_LAWS}/${filename}`;
		if (await pcloudFileExists(backup, remote)) { return filename; }
		const payload = {
			eli: act.eli || key,
			numac: act.numac || "",
			fullTitle: act.fullTitle || "",
			date: act.date || "",
			lastUpdate: version,
			consulted: version,
			act,
		};
		const form = new FormData();
		form.append("path", PCLOUD_LAWS);
		form.append("filename", filename);
		form.append("data", new Blob([JSON.stringify(payload)], {type: "application/json"}), filename);
		await pcloudRequest(backup, "uploadfile", {}, form);
		return filename;
	}

	async function backupCachedLaws(backup) {
		const all = await chrome.storage.local.get(null);
		const updateInfo = all.updateInfo || {};
		const uploaded = backup.uploadedLaws || {};
		const pending = [];
		for (const [key, value] of Object.entries(all)) {
			if (!isCachedAct(key, value)) { continue; }
			const version = value.lastUpdate || updateInfo[key]?.act;
			if (!version || uploaded[key] === version) { continue; }
			pending.push({key, value, version});
		}
		if (!pending.length) { return; }
		await ensurePcloudFolder(backup);
		let stored = 0;
		for (const item of pending.slice(0, LAWS_PER_RUN)) {
			await uploadCachedAct(backup, item.key, item.value, item.version);
			uploaded[item.key] = item.version;
			stored += 1;
		}
		backup.uploadedLaws = uploaded;
		await ctx.setStorage("highlightsBackup", backup);
		const left = pending.length - stored;
		ctx.showStatusMessage(
			left > 0
				? `Stored ${stored} consulted act version(s) on pCloud (${left} still queued)`
				: `Stored ${stored} consulted act version(s) on pCloud`
		);
	}

	async function backupToDropbox(backup, data) {
		let dbxAuth = new Dropbox.DropboxAuth({
			clientId: ctx.DROPBOX_CLIENT_ID,
		});
		dbxAuth.setAccessToken(backup.accessToken);
		dbxAuth.setRefreshToken(backup.refreshToken);
		let dbx = new Dropbox.Dropbox({
			auth: dbxAuth
		});
		return dbx.filesUpload({
			path: '/' + backup.filename /* + " " + date */ + ".json",
			contents: data,
			mode: {".tag": "overwrite"},
		});
	}

	async function runCloudBackup() {
		let backup = ctx.highlightsBackup;
		if (!backup?.accessToken) {return;}
		let date = new Date().toJSON().slice(0,10);
		if (date != backup.lastBackup) {
			let data = await ctx.getAllHighlights();
			const provider = backup.provider === "pcloud" ? "pCloud" : "Dropbox";
			try {
				if (backup.provider === "pcloud") {
					await backupToPcloud(backup, data);
				}
				else {
					const response = await backupToDropbox(backup, data);
					if (response.status != 200) {
						throw new Error(`HTTP ${response.status}`);
					}
				}
				console.log(`Backup to ${provider} done`);
				ctx.showStatusMessage(`Highlights have been backed up to ${provider} (success)`);
				backup.lastBackup = date;
				await ctx.setStorage("highlightsBackup", backup);
			}
			catch (e) {
				// The page must remain usable even if the backup fails; the date
				// is not recorded so that the backup is retried on next loading.
				console.error(`[betterlaws] Backup to ${provider} failed:`, e);
				ctx.showStatusMessage(`Highlights could not be backed up to ${provider}: ${e.message}`);
			}
		}
		if (backup.provider === "pcloud") {
			try {
				await backupCachedLaws(backup);
			}
			catch (e) {
				console.error("[betterlaws] Could not store consulted acts on pCloud:", e);
				ctx.showStatusMessage(`Consulted acts could not be stored on pCloud: ${e.message}`);
			}
		}
	}

	return { runCloudBackup };
};
