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
			.replace(/<a\s+(?:name|id)="[^"]*"\s*><\/a>/gi, "")
			.replace(/<p>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, "")
			.replace(/(<\/(?:p|div|table|ul|ol)>)\s*<br\s*\/?>/gi, "$1");
	}

	function rewriteLinks(html, ids) {
		return html
			.replace(
				/<a\b[^>]*href="https?:\/\/fisconet\.addenda\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
				"$1",
			)
			.replace(/href="https?:\/\/fisconet\.(?:compare|direct|range)\/([^"]*)"/gi, (match, rest) => {
				const guid = rest.match(GUID_RE)?.[0].toLowerCase();
				if (!guid) return match;
				return ids.has(guid) ? `href="#${ids.get(guid)}"` : `href="${SITE}${guid}"`;
			});
	}

	function articleSlug(label) {
		return slugify(label.replace(/^art(?:icle|\.)?\s*/i, "")) || "x";
	}

	function articleHeadingText(label) {
		return /^art/i.test(label) ? label.split(",")[0].trim() : label;
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

	// `bodies` maps an article GUID to its raw HTML, or to {error: "..."}.
	function buildHtml(rootHtml, bodies) {
		const analysis = analyse(rootHtml);
		const { root, ids } = analysis;
		const lookup = (guid) => (bodies && typeof bodies.get === "function" ? bodies.get(guid) : undefined);
		const parts = [];
		const missing = [];
		if (root.intro) parts.push(rewriteLinks(root.intro, ids));
		for (const item of root.items) {
			if (item.kind === "section") {
				const level = analysis.sectionLevel(item.depth);
				parts.push(`<h${level}>${item.label}</h${level}>`);
				continue;
			}
			parts.push(`<h${analysis.articleLevel} id="${item.id}">${articleHeadingText(item.label)}</h${analysis.articleLevel}>`);
			const entry = item.guid ? lookup(item.guid) : undefined;
			const html = typeof entry === "string" ? entry : entry?.html;
			if (html) {
				let body = unwrapDanglingLinks(removeNavigationLinks(cleanHtml(cutHistory(html))));
				body = dropLeadingTitle(body, articleHeadingText(item.label));
				body = body.replace(/\b(name|id)="([^"]+)"/gi, `id="${item.id}-$2"`);
				body = body.replace(/href="#([^"]+)"/gi, (match, target) =>
					target.startsWith("art-") ? match : `href="#${item.id}-${target}"`,
				);
				parts.push(rewriteLinks(body, ids));
			} else if (entry?.error) {
				missing.push(item.label);
				parts.push(`<p><em>(texte indisponible : ${entry.error})</em></p>`);
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
		buildHtml,
	};
});
