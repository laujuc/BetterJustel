// In-page "Download Markdown" button for FisconetPlus document pages.
// A code page (table of contents) downloads every article; a single document
// downloads just that document. Parsing is shared with the command-line tool.
(function () {
	"use strict";

	const core = globalThis.FisconetCore;
	const CONCURRENCY = 4;
	const CONFIRM_FROM = 25;
	const HOST_ID = "betterjustel-fisconet";

	if (!core || document.getElementById(HOST_ID)) return;

	const host = document.createElement("div");
	host.id = HOST_ID;
	host.style.cssText = "all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;";
	const shadow = host.attachShadow({mode: "open"});
	shadow.innerHTML = `
		<style>
			:host { all: initial; }
			.panel {
				width: 250px; padding: 10px 12px; background: #fff; color: #17212b;
				border: 1px solid #c5d0dc; border-radius: 8px;
				box-shadow: 0 8px 24px rgba(23, 33, 43, .18);
				font: 13px/1.4 system-ui, sans-serif;
			}
			.brand { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #5c6b7a; }
			.status { margin: 6px 0 0; min-height: 1.4em; }
			button {
				display: block; width: 100%; margin-top: 8px; padding: 7px 10px;
				border: 0; border-radius: 4px; background: #0b3d91; color: #fff;
				font: inherit; cursor: pointer;
			}
			button.secondary { background: #e7edf4; color: #17212b; }
			button:disabled { opacity: .6; cursor: progress; }
		</style>
		<div class="panel">
			<div class="brand">Better Justel</div>
			<div class="status"></div>
			<button type="button" class="primary">Télécharger en Markdown</button>
		</div>
	`;
	const status = shadow.querySelector(".status");
	const primary = shadow.querySelector(".primary");
	let abort = null;

	function documentGuid() {
		const match = location.pathname.match(/\/fisconet\/document\/([0-9a-f-]{36})/i);
		return match ? match[1].toLowerCase() : null;
	}

	function syncVisibility() {
		const visible = Boolean(documentGuid());
		if (visible && !host.isConnected) document.documentElement.append(host);
		if (!visible && host.isConnected && !abort) host.remove();
	}

	function setStatus(text) {
		status.textContent = text;
	}

	function saveBlob(blob, filename) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = filename;
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	}

	function htmlToMarkdown(html) {
		const service = new TurndownService({
			headingStyle: "atx",
			hr: "---",
			bulletListMarker: "-",
			emDelimiter: "*",
		});
		if (typeof turndownPluginGfm !== "undefined") service.use(turndownPluginGfm.gfm);
		service.addRule("headingAnchor", {
			filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
			replacement: (content, node) => {
				const id = node.getAttribute("id");
				const text = content.replace(/\n+/g, " ").trim();
				return `\n\n${"#".repeat(Number(node.nodeName[1]))} ${text}${id ? ` {#${id}}` : ""}\n\n`;
			},
		});
		service.addRule("superscript", {filter: "sup", replacement: (content) => `<sup>${content}</sup>`});
		service.addRule("subscript", {filter: "sub", replacement: (content) => `<sub>${content}</sub>`});
		return service.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
	}

	function frontMatter(title, guid, articles) {
		const yaml = (value) => JSON.stringify(String(value));
		return [
			"---",
			`title: ${yaml(title)}`,
			`source: ${yaml(core.SITE + guid)}`,
			`guid: ${yaml(guid)}`,
			`retrieved: ${yaml(new Date().toISOString().slice(0, 10))}`,
			`articles: ${articles}`,
			"lang: fr",
			"---",
			"",
			"",
		].join("\n");
	}

	async function fetchJson(guid, signal) {
		const response = await fetch(`${core.API}/document/${guid}`, {
			headers: {Accept: "application/json"},
			credentials: "same-origin",
			signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} pour ${guid}`);
		return response.json();
	}

	// Content-script requests are same-origin here, but some browsers still
	// apply CORS to them. The service worker, which has host permission, does not.
	function fetchJsonViaBackground(guid) {
		return new Promise((resolve, reject) => {
			chrome.runtime.sendMessage({action: "fisconetDocument", guid}, (response) => {
				const error = chrome.runtime.lastError;
				if (error) reject(new Error(error.message));
				else if (!response?.ok) reject(new Error(response?.error || "Échec du téléchargement"));
				else resolve(response.json);
			});
		});
	}

	let useBackground = false;
	async function loadDocument(guid, signal) {
		let json;
		if (useBackground) {
			json = await fetchJsonViaBackground(guid);
		} else {
			try {
				json = await fetchJson(guid, signal);
			} catch (error) {
				if (error.name === "AbortError") throw error;
				useBackground = true;
				json = await fetchJsonViaBackground(guid);
			}
		}
		const content = json?.data?.content;
		if (!content) throw new Error(`Document ${guid} sans contenu`);
		return {
			title: json.data.metadata?.title || guid,
			type: content.type,
			html: content.type === "HTML" ? core.decodeBase64(content.content) : null,
			data: content.type === "HTML" ? null : content.content,
		};
	}

	async function pool(items, worker, signal) {
		let next = 0;
		let done = 0;
		const runners = Array.from({length: Math.min(CONCURRENCY, items.length)}, async () => {
			while (next < items.length) {
				if (signal.aborted) return;
				const item = items[next++];
				await worker(item);
				done++;
				setStatus(`Article ${done} / ${items.length}`);
			}
		});
		await Promise.all(runners);
	}

	function askConfirmation(articleCount) {
		return new Promise((resolve) => {
			setStatus(`Ce document est un code de ${articleCount} articles. Le téléchargement complet prend plusieurs minutes.`);
			primary.hidden = true;
			const go = document.createElement("button");
			go.type = "button";
			go.textContent = "Télécharger le code complet";
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.className = "secondary";
			cancel.textContent = "Annuler";
			const panel = shadow.querySelector(".panel");
			panel.append(go, cancel);
			const finish = (accepted) => {
				go.remove();
				cancel.remove();
				primary.hidden = false;
				resolve(accepted);
			};
			go.addEventListener("click", () => finish(true));
			cancel.addEventListener("click", () => finish(false));
		});
	}

	async function download() {
		const guid = documentGuid();
		if (!guid || abort) return;
		abort = new AbortController();
		primary.textContent = "Annuler";
		const onCancel = () => abort.abort();
		primary.addEventListener("click", onCancel);
		try {
			setStatus("Lecture du document…");
			const root = await loadDocument(guid, abort.signal);
			const title = core.codeTitle(root.title);
			const filename = (core.slugify(title) || guid) + ".md";

			if (root.type !== "HTML") {
				if (root.type === "PDF" && root.data) {
					const bytes = Uint8Array.from(atob(root.data), (char) => char.charCodeAt(0));
					saveBlob(new Blob([bytes], {type: "application/pdf"}), filename.replace(/\.md$/, ".pdf"));
					setStatus("PDF téléchargé (ce document n'est pas du HTML).");
					return;
				}
				throw new Error(`Type de document non pris en charge : ${root.type}`);
			}

			const analysis = core.analyse(root.html);
			const articles = analysis.articles.filter((article) => article.guid);
			if (articles.length >= CONFIRM_FROM) {
				primary.removeEventListener("click", onCancel);
				primary.disabled = false;
				const accepted = await askConfirmation(articles.length);
				if (!accepted || abort.signal.aborted) {
					setStatus("");
					return;
				}
				primary.textContent = "Annuler";
				primary.addEventListener("click", onCancel);
			}

			const bodies = new Map();
			if (articles.length > 0) {
				setStatus(`Article 0 / ${articles.length}`);
				await pool(articles, async (article) => {
					try {
						const document = await loadDocument(article.guid, abort.signal);
						if (document.type === "HTML") bodies.set(article.guid, document.html);
						else bodies.set(article.guid, {error: `pas un document HTML (${document.type})`});
					} catch (error) {
						if (error.name === "AbortError") throw error;
						bodies.set(article.guid, {error: error.message});
					}
				}, abort.signal);
			}
			if (abort.signal.aborted) {
				setStatus("Téléchargement annulé.");
				return;
			}

			setStatus("Conversion en Markdown…");
			if (typeof TurndownService === "undefined") throw new Error("Convertisseur Markdown indisponible");
			const built = core.buildHtml(root.html, bodies);
			let html = built.html;
			if (built.root.mode === "plain") {
				html = `<h1>${title.replace(/[&<>]/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[char]))}</h1>\n${html}`;
			}
			const markdown = frontMatter(title, guid, articles.length) + htmlToMarkdown(html) + "\n";
			saveBlob(new Blob([markdown], {type: "text/markdown;charset=utf-8"}), filename);
			const missing = built.missing.length;
			setStatus(missing ? `Téléchargé, ${missing} article(s) manquant(s). Relancez pour réessayer.` : "Markdown téléchargé.");
		} catch (error) {
			if (error.name === "AbortError") setStatus("Téléchargement annulé.");
			else setStatus(error.message);
		} finally {
			primary.removeEventListener("click", onCancel);
			primary.disabled = false;
			primary.textContent = "Télécharger en Markdown";
			abort = null;
			syncVisibility();
		}
	}

	primary.addEventListener("click", download);
	syncVisibility();
	window.addEventListener("popstate", syncVisibility);
	setInterval(syncVisibility, 500);
})();
