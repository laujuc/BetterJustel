// In-page tools for FisconetPlus document pages.
// "Lecture" opens a minimalist reader (one article at a time). "Télécharger
// en Markdown" downloads a code page in full, or just the open document.
// Parsing is shared with the command-line tool.
(function () {
	"use strict";

	const core = globalThis.FisconetCore;
	const CONCURRENCY = 12;
	const CONFIRM_FROM = 25;
	const HOST_ID = "betterlaws-fisconet";
	const READER_ID = "betterlaws-fisconet-reader";

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
			button.lecture { background: #1c1917; }
			button.secondary { background: #e7edf4; color: #17212b; }
			button:disabled { opacity: .6; cursor: progress; }
		</style>
		<div class="panel">
			<div class="brand">betterlaws</div>
			<div class="status"></div>
			<button type="button" class="lecture">Lecture</button>
			<button type="button" class="primary">Télécharger en Markdown</button>
		</div>
	`;
	const status = shadow.querySelector(".status");
	const primary = shadow.querySelector(".primary");
	const lecture = shadow.querySelector(".lecture");
	let abort = null;
	let reader = null;
	let openingReader = false;

	function documentGuid() {
		const match = location.pathname.match(/\/fisconet\/document\/([0-9a-f-]{36})/i);
		return match ? match[1].toLowerCase() : null;
	}

	function syncVisibility() {
		const guid = documentGuid();
		const visible = Boolean(guid);
		if (visible && !host.isConnected) document.documentElement.append(host);
		if (!visible && host.isConnected && !abort) host.remove();
		if (reader && reader.guid !== guid) closeReader();
	}

	function escapeHtml(text) {
		return String(text).replace(/[&<>"']/g, (char) => ({
			"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
		}[char]));
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

	async function pool(items, worker, signal, label = "Article") {
		let next = 0;
		let done = 0;
		const runners = Array.from({length: Math.min(CONCURRENCY, items.length)}, async () => {
			while (next < items.length) {
				if (signal.aborted) return;
				const item = items[next++];
				await worker(item);
				done++;
				setStatus(`${label} ${done} / ${items.length}`);
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
			const commentaryGuids = [];
			const seenCommentary = new Set();
			for (const article of articles) {
				const html = bodies.get(article.guid);
				if (typeof html !== "string") continue;
				const target = core.commentaryTarget(html);
				if (!target || bodies.has(target.guid) || seenCommentary.has(target.guid)) continue;
				seenCommentary.add(target.guid);
				commentaryGuids.push(target.guid);
			}
			if (commentaryGuids.length > 0) {
				setStatus(`Commentaire 0 / ${commentaryGuids.length}`);
				await pool(commentaryGuids, async (guid) => {
					try {
						const document = await loadDocument(guid, abort.signal);
						if (document.type === "HTML") bodies.set(guid, document.html);
						else bodies.set(guid, {type: document.type});
					} catch (error) {
						if (error.name === "AbortError") throw error;
						bodies.set(guid, {error: error.message});
					}
				}, abort.signal, "Commentaire");
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

	const READER_CSS = `
		:host { all: initial; }
		.overlay {
			position: absolute; inset: 0; display: flex; flex-direction: column;
			background: #f7f5f2; color: #1c1917;
			font: 17px/1.6 "Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif;
		}
		header, aside, .pager, .hint, .crumbs, footer {
			font-family: system-ui, sans-serif;
		}
		header {
			display: flex; align-items: center; gap: 12px;
			padding: 10px 16px; background: #fff; border-bottom: 1px solid #e7e5e4;
		}
		.titles { flex: 1; min-width: 0; }
		.brand { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #57534e; }
		.doc-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.close {
			border: 0; border-radius: 4px; background: #1c1917; color: #fff;
			padding: 7px 12px; font: inherit; cursor: pointer;
		}
		.layout { display: flex; min-height: 0; flex: 1; }
		aside {
			width: 300px; flex: none; overflow: auto; background: #fff;
			border-right: 1px solid #e7e5e4; padding: 10px;
		}
		.search {
			position: sticky; top: 0; z-index: 1; box-sizing: border-box;
			width: 100%; margin-bottom: 8px; padding: 7px 8px;
			border: 1px solid #d6d3d1; border-radius: 4px; background: #fff;
			font: 13px/1.3 system-ui, sans-serif;
		}
		.sec { margin: 10px 0 2px; color: #57534e; font-size: 11px; font-weight: 650; line-height: 1.3; }
		.art {
			display: block; width: 100%; margin: 0; padding: 4px 6px;
			border: 0; border-radius: 4px; background: transparent; color: #1c1917;
			font: 13px/1.35 system-ui, sans-serif; text-align: left; cursor: pointer;
		}
		.art:hover, .art.current { background: #f1efe9; }
		.art.current { font-weight: 600; }
		main { flex: 1; overflow: auto; padding: 28px 24px 72px; }
		.sheet { max-width: 42rem; margin: 0 auto; }
		.pager { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
		.pager button {
			max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			border: 0; background: transparent; color: #1d4e89; font: 13px/1.3 system-ui, sans-serif;
			cursor: pointer; padding: 0;
		}
		.pager button:disabled { color: #a8a29e; cursor: default; }
		.hint, .crumbs, footer { color: #57534e; font-size: 13px; }
		h1 { font-size: 1.7rem; line-height: 1.25; font-weight: 600; margin: 0 0 .8rem; }
		p { margin: .75em 0; }
		ul, ol { padding-left: 1.4em; }
		a { color: #1d4e89; }
		table { border-collapse: collapse; width: 100%; margin: 1em 0; font: .92rem/1.4 system-ui, sans-serif; }
		td, th { border: 1px solid #d6d3d1; padding: .35em .6em; vertical-align: top; text-align: left; }
		sup, sub { font-size: .75em; }
		footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #e7e5e4; }
		.layout.single aside { display: none; }
		.empty { color: #57534e; font-size: 13px; }
	`;

	function closeReader() {
		if (!reader) return;
		reader.abort.abort();
		document.documentElement.style.overflow = reader.previousOverflow;
		reader.host.remove();
		reader = null;
	}

	function articleHtml(raw, article, ids, followed) {
		const body = followed
			? core.composeArticle(raw, followed, article.label, article.id)
			: core.prepareArticle(raw, article.label, article.id);
		return core.sanitizeHtml(core.rewriteLinks(body, ids));
	}

	async function openReader() {
		const guid = documentGuid();
		if (!guid) return;
		if (reader?.guid === guid) return;
		closeReader();
		const root = await loadDocument(guid);
		if (documentGuid() !== guid) return;
		if (root.type !== "HTML") {
			throw new Error(root.type === "PDF"
				? "Ce document est un PDF : utilisez le téléchargement."
				: `Type non pris en charge : ${root.type}`);
		}
		const title = core.codeTitle(root.title);
		const analysis = core.analyse(root.html);
		const articles = analysis.articles.filter((article) => article.guid);
		const idList = articles.map((article) => article.id);
		const cache = new Map();
		const inflight = new Map();
		const controller = new AbortController();

		const readerHost = document.createElement("div");
		readerHost.id = READER_ID;
		readerHost.style.cssText = "all: initial; display: block; position: fixed; inset: 0; z-index: 2147483647;";
		const readerShadow = readerHost.attachShadow({mode: "open"});
		readerShadow.innerHTML = `
			<style>${READER_CSS}</style>
			<div class="overlay">
				<header>
					<div class="titles">
						<div class="brand">betterlaws · Lecture</div>
						<div class="doc-title"></div>
					</div>
					<button type="button" class="close">Fermer</button>
				</header>
				<div class="layout">
					<aside>
						<input class="search" type="search" placeholder="Rechercher un article" aria-label="Rechercher un article">
						<div class="nav"></div>
					</aside>
					<main>
						<div class="sheet">
							<div class="pager">
								<button type="button" class="prev"></button>
								<button type="button" class="next"></button>
							</div>
							<p class="crumbs" hidden></p>
							<article class="prose"></article>
							<footer>Texte en vigueur, sans l'historique des modifications. Vérifiez toujours le texte sur FisconetPlus.</footer>
						</div>
					</main>
				</div>
			</div>
		`;
		const previousOverflow = document.documentElement.style.overflow;
		document.documentElement.style.overflow = "hidden";
		document.documentElement.append(readerHost);
		reader = {
			host: readerHost,
			guid,
			abort: controller,
			previousOverflow,
			currentId: null,
		};

		const docTitle = readerShadow.querySelector(".doc-title");
		const layout = readerShadow.querySelector(".layout");
		const nav = readerShadow.querySelector(".nav");
		const search = readerShadow.querySelector(".search");
		const prose = readerShadow.querySelector(".prose");
		const crumbs = readerShadow.querySelector(".crumbs");
		const prev = readerShadow.querySelector(".prev");
		const next = readerShadow.querySelector(".next");
		const main = readerShadow.querySelector("main");
		docTitle.textContent = title;
		readerShadow.querySelector(".close").addEventListener("click", closeReader);

		function renderNav(query) {
			const needle = query.trim().toLowerCase();
			const html = [];
			const stack = [];
			for (const item of analysis.root.items) {
				if (item.kind === "section") {
					while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop();
					stack.push(item);
					if (!needle) {
						html.push(`<div class="sec" style="padding-left:${(item.depth - 1) * 12}px">${escapeHtml(item.label)}</div>`);
					}
					continue;
				}
				const heading = core.articleHeadingText(item.label);
				if (needle && !`${heading} ${item.label}`.toLowerCase().includes(needle)) continue;
				const current = item.id === reader.currentId ? " current" : "";
				html.push(`<button type="button" class="art${current}" data-id="${item.id}">${escapeHtml(heading)}</button>`);
			}
			nav.innerHTML = html.join("") || `<p class="empty">Aucun article</p>`;
			nav.querySelector(".current")?.scrollIntoView({block: "nearest"});
		}

		function updatePager() {
			const index = articles.findIndex((article) => article.id === reader.currentId);
			const previous = index > 0 ? articles[index - 1] : null;
			const following = index >= 0 ? articles[index + 1] : null;
			prev.hidden = articles.length === 0;
			next.hidden = articles.length === 0;
			prev.disabled = !previous;
			next.disabled = !following;
			prev.textContent = previous ? `← ${core.articleHeadingText(previous.label)}` : "Précédent";
			next.textContent = following ? `${core.articleHeadingText(following.label)} →` : "Suivant";
			prev.dataset.id = previous?.id || "";
			next.dataset.id = following?.id || "";
		}

		function loadArticle(article) {
			if (cache.has(article.guid)) return Promise.resolve(cache.get(article.guid));
			if (inflight.has(article.guid)) return inflight.get(article.guid);
			const promise = loadDocument(article.guid, controller.signal).then(async (document) => {
				if (document.type !== "HTML") throw new Error(`pas un document HTML (${document.type})`);
				let followed = null;
				const target = core.commentaryTarget(document.html);
				if (target) {
					const commentary = await loadDocument(target.guid, controller.signal);
					if (commentary.type === "HTML") followed = commentary.html;
					if (followed && !analysis.ids.has(target.guid)) analysis.ids.set(target.guid, article.id);
				}
				const html = articleHtml(document.html, article, analysis.ids, followed);
				cache.set(article.guid, html);
				return html;
			}).finally(() => inflight.delete(article.guid));
			inflight.set(article.guid, promise);
			return promise;
		}

		let shownToken = 0;
		async function showArticle(id, fragment) {
			const article = articles.find((item) => item.id === id);
			if (!article || !reader) return;
			const token = ++shownToken;
			reader.currentId = id;
			renderNav(search.value);
			updatePager();
			const path = core.sectionPath(analysis.root.items, id);
			crumbs.hidden = path.length === 0;
			crumbs.textContent = path.join(" · ");
			prose.innerHTML = `<p class="hint">Chargement…</p>`;
			main.scrollTop = 0;
			try {
				const html = await loadArticle(article);
				if (token !== shownToken || !reader) return;
				prose.innerHTML = `<h1 id="${article.id}">${escapeHtml(core.articleHeadingText(article.label))}</h1>${html}`;
				if (fragment) scrollToFragment(fragment);
				const index = articles.findIndex((item) => item.id === id);
				if (articles[index + 1]) loadArticle(articles[index + 1]).catch(() => {});
			} catch (error) {
				if (error.name === "AbortError" || token !== shownToken) return;
				prose.innerHTML = `<h1>${escapeHtml(core.articleHeadingText(article.label))}</h1><p>${escapeHtml(error.message)}</p>`;
			}
		}

		function scrollToFragment(fragment) {
			if (!fragment) return;
			try {
				prose.querySelector(`#${CSS.escape(fragment)}`)?.scrollIntoView({block: "start"});
			} catch {
				// ignore a fragment that is not a valid selector
			}
		}

		function openFragment(fragment) {
			if (!fragment || !reader) return false;
			const articleId = core.articleIdFromFragment(fragment, idList);
			if (articleId && articleId !== reader.currentId) {
				showArticle(articleId, fragment === articleId ? null : fragment);
				return true;
			}
			let target = null;
			try {
				target = prose.querySelector(`#${CSS.escape(fragment)}`);
			} catch {
				target = null;
			}
			if (target) {
				target.scrollIntoView({block: "start"});
				return true;
			}
			return Boolean(articleId);
		}

		readerShadow.addEventListener("click", (event) => {
			const button = event.target.closest?.("button.art[data-id]");
			if (button?.dataset.id) {
				showArticle(button.dataset.id);
				return;
			}
			const link = event.target.closest?.("a[href]");
			if (!link) return;
			const href = link.getAttribute("href") || "";
			if (href.startsWith("#")) {
				event.preventDefault();
				let fragment = href.slice(1);
				try { fragment = decodeURIComponent(fragment); } catch { /* keep */ }
				openFragment(fragment);
				return;
			}
			const linkedGuid = href.match(core.GUID_RE)?.[0]?.toLowerCase();
			if (linkedGuid && analysis.ids.has(linkedGuid)) {
				event.preventDefault();
				showArticle(analysis.ids.get(linkedGuid));
				return;
			}
			if (/^https?:/i.test(href)) {
				event.preventDefault();
				window.open(href, "_blank", "noopener");
			}
		});
		search.addEventListener("input", () => renderNav(search.value));
		prev.addEventListener("click", () => prev.dataset.id && showArticle(prev.dataset.id));
		next.addEventListener("click", () => next.dataset.id && showArticle(next.dataset.id));

		if (articles.length === 0) {
			layout.classList.add("single");
			const body = core.sanitizeHtml(core.prepareArticle(root.html, title, null));
			prose.innerHTML = `<h1>${escapeHtml(title)}</h1>${body}`;
			updatePager();
			return;
		}

		renderNav("");
		updatePager();
		const intro = analysis.root.intro
			? core.sanitizeHtml(core.rewriteLinks(analysis.root.intro, analysis.ids))
			: "";
		prose.innerHTML = `<p class="hint">Choisissez un article. Un seul article est téléchargé à la fois, puis conservé en mémoire.</p>${intro}`;
		search.focus();
	}

	async function onLecture() {
		if (openingReader) return;
		if (reader?.guid === documentGuid()) return;
		openingReader = true;
		lecture.disabled = true;
		try {
			await openReader();
		} catch (error) {
			if (error.name !== "AbortError" && !abort) setStatus(error.message);
		} finally {
			openingReader = false;
			lecture.disabled = false;
		}
	}

	lecture.addEventListener("click", onLecture);
	primary.addEventListener("click", download);
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && reader) {
			event.preventDefault();
			closeReader();
		}
	});
	syncVisibility();
	window.addEventListener("popstate", syncVisibility);
	setInterval(syncVisibility, 500);
})();
