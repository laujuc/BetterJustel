window.BJ = window.BJ || {};
window.BJ.backupModule = function(ctx) {

	// pCloud has no dedicated application folder like Dropbox does:
	// backups are grouped in a folder reserved to this extension.
	// New backups go to /betterlaws. If /BetterJustel already exists from
	// before the rename, keep writing there so existing backups are not orphaned.
	const PCLOUD_FOLDER = "/betterlaws";
	const PCLOUD_FOLDER_LEGACY = "/BetterJustel";

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

	async function resolvePcloudFolder(backup) {
		try {
			await pcloudRequest(backup, "listfolder", {path: PCLOUD_FOLDER_LEGACY});
			return PCLOUD_FOLDER_LEGACY;
		}
		catch (e) {
			if (!pcloudFolderMissing(e)) {
				throw e;
			}
		}
		return PCLOUD_FOLDER;
	}

	async function backupToPcloud(backup, data) {
		const folder = await resolvePcloudFolder(backup);
		await pcloudRequest(backup, "createfolderifnotexists", {path: folder});
		// In the multipart body, parameters must come before the file; a file
		// with the same name is overwritten (the previous version is kept as a
		// revision by pCloud)
		const form = new FormData();
		form.append("path", folder);
		form.append("filename", `${backup.filename}.json`);
		form.append("data", new Blob([data], {type: "application/json"}), `${backup.filename}.json`);
		return pcloudRequest(backup, "uploadfile", {}, form);
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
			}
			catch (e) {
				// The page must remain usable even if the backup fails; the date
				// is not recorded so that the backup is retried on next loading
				console.error(`[betterlaws] Backup to ${provider} failed:`, e);
				ctx.showStatusMessage(`Highlights could not be backed up to ${provider}: ${e.message}`);
				return;
			}
			backup.lastBackup = date;
			await ctx.setStorage("highlightsBackup", backup);
		}
	}

	return { runCloudBackup };
};
