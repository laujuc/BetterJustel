// Shared FisconetPlus parsing for the command-line tool (tools/fisconet) and
// the in-page "Download Markdown" button. No dependencies; works as a classic
// script (window.FisconetCore) and as a CommonJS module.
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	} else {
		root.FisconetCore = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	"use strict";

	const API = "https://www.minfin.fgov.be/myminfin-rest/fisconetPlus/public";
	const SITE = "https://www.minfin.fgov.be/myminfin-web/pages/public/fisconet/document/";
	const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
	const GUID_RE = new RegExp(GUID, "i");

	const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

	function decodeEntities(text) {
		return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity) => {
			if (entity[0] === "#") {
				const code = entity[1].toLowerCase() === "x"
					? parseInt(entity.slice(2), 16)
					: parseInt(entity.slice(1), 10);
				return Number.isNaN(code) ? match : String.fromCodePoint(code);
			}
			return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
		});
	}

	const stripTags = (html) => html.replace(/<[^>]*>/g, "");
	const plainText = (html) => decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();

	function slugify(text) {
		return String(text)
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	function codeTitle(title) {
		return String(title || "").replace(/^Table des mati\u00e8res\s*-\s*/i, "").trim();
	}

	function decodeBase64(b64) {
		const clean = String(b64).replace(/\s/g, "");
		if (typeof Buffer !== "undefined") {
			return Buffer.from(clean, "base64").toString("utf8");
		}
		const binary = atob(clean);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return new TextDecoder("utf-8").decode(bytes);
	}

	// A root document is either a nested <ul>/<li> table of contents ("tree";
	// e.g. CIR 92), a flat index of <p> paragraphs ("index"; e.g. Code de la
	// TVA), or plain content without article links.
	function parseTree(html) {
		const root = { children: [] };
		const stack = [root];
		const tokens = /<(\/?)(ul|li|a)\b([^>]*)>|([^<]+)/gi;
		let match;
		while ((match = tokens.exec(html))) {
			const [, closing, tag, attributes, text] = match;
			const top = stack[stack.length - 1];
			if (text !== undefined) {
				if (top !== root && top.children.length === 0) top.label += text;
			} else if (tag.toLowerCase() === "li") {
				if (closing) {
					if (stack.length > 1) stack.pop();
				} else {
					const node = { label: "", href: null, children: [] };
					top.children.push(node);
					stack.push(node);
				}
			} else if (tag.toLowerCase() === "a" && !closing && top !== root) {
				const href = attributes.match(/href="([^"]*)"/i);
				if (href && !top.href) top.href = decodeEntities(href[1]);
			}
		}

		const items = [];
		const flatten = (nodes, depth) => {
			for (const node of nodes) {
				const label = plainText(node.label);
				if (node.children.length > 0) {
					items.push({ kind: "section", depth, label });
					flatten(node.children, depth + 1);
					continue;
				}
				const guid = node.href?.match(GUID_RE)?.[0].toLowerCase() ?? null;
				if (guid || /^art/i.test(label)) {
					items.push({ kind: "article", guid, label });
				} else {
					items.push({ kind: "section", depth, label });
				}
			}
		};
		flatten(root.children, 1);
		return items;
	}

	const SECTION_START =
		/^(partie|livre|titre|chap(?:itre|\.)|sec(?:tion|\.)|sous-sec(?:tion|\.)|sous-sous-sec(?:tion|\.)|paragraphe|division|annexe)(?=\s|$)/i;

	function sectionKind(label) {
		const word = label.match(SECTION_START)[1].toLowerCase().replace(/\.$/, "");
		return word
			.replace(/^chap$/, "chapitre")
			.replace(/^sous-sous-sec$/, "sous-sous-section")
			.replace(/^sous-sec$/, "sous-section")
			.replace(/^sec$/, "section");
	}

	function parseIndex(html) {
		const items = [];
		const introParagraphs = [];
		const kindOrder = [];
		for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
			const inner = match[1];
			const text = plainText(inner);
			if (!text) continue;
			const link = inner.match(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
			const linkText = link ? plainText(link[2]) : "";
			const guid = link?.[1].match(GUID_RE)?.[0].toLowerCase() ?? null;
			if (guid && /^art/i.test(linkText) && text.startsWith(linkText)) {
				items.push({
					kind: "article",
					guid,
					label: linkText.charAt(0).toUpperCase() + linkText.slice(1),
				});
			} else if (SECTION_START.test(text)) {
				const kind = sectionKind(text);
				if (!kindOrder.includes(kind)) kindOrder.push(kind);
				const label = text.replace(/\s*\(\s*Com\.[^)]*\)\s*$/i, "");
				items.push({ kind: "section", depth: kindOrder.indexOf(kind) + 1, label });
			} else if (items.length === 0) {
				introParagraphs.push(`<p>${inner}</p>`);
			}
		}
		return { items, intro: introParagraphs.join("\n") };
	}

	function parseRoot(html) {
		if (/<ul\b/i.test(html) && /<li\b/i.test(html) && /fisconet\.(compare|direct)/i.test(html)) {
			return { mode: "tree", intro: "", items: parseTree(html) };
		}
		const index = parseIndex(html);
		if (index.items.some((item) => item.kind === "article")) {
			return { mode: "index", ...index };
		}
		return { mode: "plain", intro: html, items: [] };
	}

	function cutHistory(html) {
		let anchor = html.search(/<a\s+name="[^"]*hist(?:orique)?(?:_[a-z]{2})?"/i);
		if (anchor === -1) {
			const heading = html.search(/<p\b[^>]*>(?:\s|&nbsp;|&#160;|<[^>]+>)*Historique des modifications/i);
			if (heading === -1) return html;
			anchor = heading;
		}
		const paragraphStart = html.lastIndexOf("<p", anchor);
		const insideParagraph = paragraphStart !== -1 && !html.slice(paragraphStart, anchor).includes("</p>");
		let cut = insideParagraph ? paragraphStart : anchor;
		const divStart = html.lastIndexOf("<div", cut);
		if (divStart !== -1 && !/<\/div>|<p\b/i.test(html.slice(divStart, cut))) cut = divStart;
		return html
			.slice(0, cut)
			.replace(
				/(?:<hr\b[^>]*>\s*|<(p|div)\b[^>]*>(?:\s|&nbsp;|&#160;|<(?!\/?(?:p|div)\b)[^>]+>)*<\/\1>\s*)+$/i,
				"",
			);
	}

	function removeNavigationLinks(html) {
		return html
			.replace(
				/\[\s*<a\b[^>]*href="#[^"]*"[^>]*>\s*(?:Top|Haut|Boven|historique|hist\.?)\s*<\/a>\s*\]/gi,
				"",
			)
			.replace(/<p>(?:\s|&nbsp;|&#160;)*<\/p>/gi, "");
	}

	function unwrapDanglingLinks(html) {
		const live = new Set([...html.matchAll(/\b(?:name|id)="([^"]+)"/gi)].map((match) => match[1]));
		return html.replace(
			/<a\b[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
			(match, target, text) => (live.has(target) ? match : text),
		);
	}

	function dropLeadingTitle(html, heading) {
		const match = html.match(/^\s*<p>([\s\S]*?)<\/p>/i);
		if (match && plainText(match[1]).toLowerCase() === heading.toLowerCase()) {
			return html.slice(match[0].length);
		}
		return html;
	}

	function cleanHtml(html) {
		return html
			.replace(/[\u200b\ufeff]/g, "")
			.replace(/&#58;/g, ":")
			.replace(/<title>[\s\S]*?<\/title>/gi, "")
			.replace(
				/\s(?:style|class|target|align|size|border|width|height|cellspacing|cellpadding|data-[\w-]+)="[^"]*"/gi,
				"",
			)
			.replace(/<\/?(?:div|center|font)\b[^>]*>/gi, "")
			.replace(/<\/?span\b[^>]*>/gi, "")
			.replace(/<a\s+(?:name|id)="([^"]*)"\s*><\/a>/gi, '<span id="$1"></span>')
			.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (match, inner) =>
				plainText(inner).replace(/\u00a0/g, "").trim() ? match : "",
			)
			.replace(/(<\/(?:p|div|table|ul|ol)>)\s*<br\s*\/?>/gi, "$1");
	}

	function linkRecords(html) {
		const records = [];
		const re = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
		let match;
		while ((match = re.exec(html))) {
			const href = decodeEntities(match[1]);
			const guid = href.match(GUID_RE)?.[0].toLowerCase() ?? null;
			records.push({ href, guid, label: plainText(match[2]) });
		}
		return records;
	}

	function escapeText(text) {
		return String(text).replace(/[&<>"']/g, (char) => ({
			"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
		}[char]));
	}

	function isUpdateLabel(label) {
		return /mise\s+[àa]\s+jour/i.test(label);
	}

	function isRangeCommentary(label) {
		return /\d+\s*[-\u2013\u2014]\s*\d+/.test(label);
	}

	// Fisconet commentary codes (ComIR, and the same hub layout in other codes)
	// store a table-of-contents leaf that only points at the real text. The
	// leaf is not the commentary: "Commentaire" is a link, and "(historique)"
	// is the legislation, which must stay a link. A law article that merely
	// links to abrogated articles is not this pattern.
	function commentaryTarget(html) {
		if (!html) return null;
		const links = linkRecords(html).filter((link) =>
			link.guid && /^(?:commentaire|commentaar)\b/i.test(link.label),
		);
		if (links.length === 0) return null;
		return links.find((link) => !isUpdateLabel(link.label) && !isRangeCommentary(link.label))
			|| links.find((link) => !isRangeCommentary(link.label))
			|| null;
	}

	function legislationLink(html) {
		return linkRecords(html).find((link) => link.guid && /historique|historiek/i.test(link.label)) || null;
	}

	function publicHref(link) {
		if (link.guid && /fisconet\.(?:compare|direct|range)\//i.test(link.href)) return `${SITE}${link.guid}`;
		if (/^https?:\/\//i.test(link.href)) return link.href;
		return null;
	}

	function relatedLinksHtml(html, skipGuids) {
		const seen = new Set();
		const items = [];
		for (const link of linkRecords(html)) {
			if (link.guid && (skipGuids.has(link.guid) || /historique|historiek/i.test(link.label))) continue;
			const href = publicHref(link);
			if (!href || seen.has(href)) continue;
			seen.add(href);
			items.push(`<li><a href="${escapeText(href)}">${escapeText(link.label || href)}</a></li>`);
		}
		if (items.length === 0) return "";
		return `<h2>Documents liés</h2><ul>${items.join("")}</ul>`;
	}

	// Legislation stays a link. The commentary document, when we have it, is
	// the article body. History inside that document is still removed.
	function composeArticle(rawHtml, followedHtml, label, id) {
		const target = commentaryTarget(rawHtml);
		if (!target || !followedHtml) return prepareArticle(rawHtml, label, id);
		const legislation = legislationLink(rawHtml);
		const skip = new Set([target.guid]);
		if (legislation?.guid) skip.add(legislation.guid);
		const preface = legislation
			? `<p><a href="${SITE}${legislation.guid}">${escapeText(legislation.label)}</a></p>`
			: "";
		return preface
			+ prepareArticle(followedHtml, label, id)
			+ relatedLinksHtml(rawHtml, skip);
	}

	function rewriteLinks(html, ids) {
		const mapGuid = (match, rest) => {
			const guid = String(rest).match(GUID_RE)?.[0].toLowerCase();
			if (!guid) return match;
			return ids.has(guid) ? `href="#${ids.get(guid)}"` : `href="${SITE}${guid}"`;
		};
		return html
			.replace(
				/<a\b[^>]*href="https?:\/\/fisconet\.addenda\/[^\"]*"[^>]*>([\s\S]*?)<\/a>/gi,
				"$1",
			)
			.replace(/href="https?:\/\/fisconet\.(?:compare|direct|range)\/([^"]*)"/gi, mapGuid)
			.replace(/href="https?:\/\/www\.minfin\.fgov\.be\/myminfin-web\/pages\/public\/fisconet\/document\/([^"]*)"/gi, mapGuid);
	}

	function articleSlug(label) {
		return slugify(label.replace(/^art(?:icle|\.)?\s*/i, "")) || "x";
	}

	function articleHeadingText(label) {
		return /^art/i.test(label) ? label.split(",")[0].trim() : label;
	}

	// Longest article id that is the fragment, or a prefix of it followed by "-".
	// `art-1` must not swallow `art-10` or `art-1bis`; `art-5` must not swallow `art-5-1`.
	function articleIdFromFragment(fragment, ids) {
		const list = [...ids].filter((id) => typeof id === "string").sort((a, b) => b.length - a.length);
		for (const id of list) {
			if (fragment === id || fragment.startsWith(`${id}-`)) return id;
		}
		return null;
	}

	function sectionPath(items, articleId) {
		const stack = [];
		for (const item of items) {
			if (item.kind === "section") {
				while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop();
				stack.push(item);
			} else if (item.id === articleId) {
				return stack.map((section) => section.label);
			}
		}
		return [];
	}

	function sanitizeHtml(html) {
		return String(html)
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<script\b[^>]*\/?>/gi, "")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)>/gi, "")
			.replace(/<(?:iframe|object|embed)\b[^>]*\/?>/gi, "")
			.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
			.replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "");
	}

	function analyse(rootHtml) {
		const root = parseRoot(cleanHtml(rootHtml));
		const articles = root.items.filter((item) => item.kind === "article");
		const maxDepth = Math.max(0, ...root.items.filter((item) => item.kind === "section").map((item) => item.depth));
		const articleLevel = Math.min(6, maxDepth + 1);
		const sectionLevel = (depth) => Math.max(1, Math.min(depth, articleLevel - 1));
		const usedIds = new Set();
		const ids = new Map();
		for (const article of articles) {
			let id = `art-${articleSlug(articleHeadingText(article.label))}`;
			const base = id;
			for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
			usedIds.add(id);
			article.id = id;
			if (article.guid && !ids.has(article.guid)) ids.set(article.guid, id);
		}
		return { root, articles, articleLevel, sectionLevel, ids };
	}

	// Current text of one article, with history and in-page navigation removed.
	function prepareArticle(rawHtml, label, id) {
		let body = unwrapDanglingLinks(removeNavigationLinks(cleanHtml(cutHistory(rawHtml))));
		body = dropLeadingTitle(body, articleHeadingText(label || ""));
		if (id) {
			body = body.replace(/\b(name|id)="([^"]+)"/gi, `id="${id}-$2"`);
			body = body.replace(/href="#([^"]+)"/gi, (match, target) =>
				target.startsWith("art-") ? match : `href="#${id}-${target}"`,
			);
		}
		return sanitizeHtml(body);
	}

	function htmlOf(entry) {
		return typeof entry === "string" ? entry : entry?.html;
	}

	// `bodies` maps an article GUID (and any followed commentary GUID) to its
	// raw HTML, or to {error: "..."}.
	function buildHtml(rootHtml, bodies) {
		const analysis = analyse(rootHtml);
		const { root, ids } = analysis;
		const lookup = (guid) => (bodies && typeof bodies.get === "function" ? bodies.get(guid) : undefined);
		for (const item of root.items) {
			if (item.kind !== "article" || !item.guid) continue;
			const raw = htmlOf(lookup(item.guid));
			const target = raw ? commentaryTarget(raw) : null;
			if (target && !ids.has(target.guid)) ids.set(target.guid, item.id);
		}
		const parts = [];
		const missing = [];
		if (root.intro) parts.push(sanitizeHtml(rewriteLinks(root.intro, ids)));
		for (const item of root.items) {
			if (item.kind === "section") {
				const level = analysis.sectionLevel(item.depth);
				parts.push(`<h${level}>${escapeText(item.label)}</h${level}>`);
				continue;
			}
			parts.push(`<h${analysis.articleLevel} id="${item.id}">${escapeText(articleHeadingText(item.label))}</h${analysis.articleLevel}>`);
			const entry = item.guid ? lookup(item.guid) : undefined;
			const html = htmlOf(entry);
			if (html) {
				const target = commentaryTarget(html);
				const followed = target ? htmlOf(lookup(target.guid)) : null;
				const body = followed
					? composeArticle(html, followed, item.label, item.id)
					: prepareArticle(html, item.label, item.id);
				parts.push(rewriteLinks(body, ids));
			} else if (entry?.error) {
				missing.push(item.label);
				parts.push(`<p><em>(texte indisponible : ${escapeText(entry.error)})</em></p>`);
			}
		}
		return { ...analysis, html: parts.join("\n"), missing };
	}

	return {
		API,
		SITE,
		GUID_RE,
		slugify,
		codeTitle,
		decodeBase64,
		analyse,
		prepareArticle,
		commentaryTarget,
		composeArticle,
		rewriteLinks,
		articleHeadingText,
		articleIdFromFragment,
		sectionPath,
		sanitizeHtml,
		buildHtml,
	};
});
