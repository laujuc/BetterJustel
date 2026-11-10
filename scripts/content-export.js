window.BJ = window.BJ || {};
window.BJ.exportModule = function(ctx) {
	const BASE_URL = "https://www.ejustice.just.fgov.be";
	const MONTHS = {
		janvier: "01", février: "02", fevrier: "02", mars: "03", avril: "04",
		mai: "05", juin: "06", juillet: "07", août: "08", aout: "08",
		septembre: "09", octobre: "10", novembre: "11", décembre: "12", decembre: "12",
	};
	const HEADING_TYPES = ["partie", "livre", "titre", "sous-titre", "chapitre", "section", "sous-section", "paragraphe", "§"];
	// Justel sometimes emits broken markup (unclosed <p> wrapping article anchors, raw <L ...>
	// modification references parsed as unknown elements); such nodes are flattened into their
	// children so that the line-based analysis below sees a flat flow of inline content.
	// Top-level <i> elements are kept (they carry the italic of the (NOTE : ...) lines) unless
	// they wrap anchors, which would then be invisible to the line analysis.
	const FLATTEN_NODE_NAMES = ["ERRATUM,M.B.", "I", "BR&GT;<BR", "L", "P", "AR"];
	const ANNOTATION_LINE = /^(?:[-_]{5,}|<\w|\(\d+\))/;
	// "Article 1er.", "Art. 2/1.", "Art. N." ... possibly followed on the same line by the first sentence
	const ARTICLE_LABEL = /^(?:article|art\.?)\s+(.+?)\s*\.(?:\s*(.*))?$/i;
	// A heading type followed by a number, hidden inside a longer line of text
	const HIDDEN_HEADING = /[\w\-]+\s\d\w*\.\s.+/;
	const SEPARATOR_LINE = /^[-_]{5,}$/;

	function makeDiscoveryUrl() {
		const url = new URL("/cgi_loi/article.pl", BASE_URL);
		url.search = new URLSearchParams({
			language: "fr",
			lg_txt: "f",
			numac_search: ctx.act.numac,
			caller: "eli",
		});
		return url.href;
	}

	async function readJustelHtml(response) {
		const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
			|| "windows-1252";
		return new TextDecoder(charset).decode(await response.arrayBuffer());
	}

	function extractCn(doc) {
		for (const p of doc.querySelectorAll("#list-title-1 .plain-text p")) {
			const label = p.querySelector("strong")?.textContent?.trim() || "";
			if (!/dossier/i.test(label)) { continue; }
			const value = p.textContent.replace(label, "").replace(/^[\s:：/]+/, "").trim();
			const cn = value.replace(/[^0-9]/g, "");
			if (cn) { return cn; }
		}
		for (const link of doc.querySelectorAll('a[href*="cn_search="]')) {
			const value = new URL(link.href, BASE_URL).searchParams.get("cn_search");
			if (value) { return value.replace(/[^0-9]/g, ""); }
		}
		throw new Error("Justel did not provide a dossier number for this act");
	}

	function extractVersionCount(doc) {
		for (const link of doc.querySelectorAll('a[href*="arch="]')) {
			const text = link.textContent.trim();
			if (!/vers(?:ion|ie)|archiv/i.test(text)) { continue; }
			const count = text.match(/\d+/);
			if (count) { return Number(count[0]); }
		}
		return 0;
	}

	function buildVersionUrl(cn, version, total) {
		const url = new URL("/cgi_loi/article.pl", BASE_URL);
		const params = new URLSearchParams({
			language: "fr",
			lg_txt: "f",
		});
		if (version < total) { params.set("arch", String(version).padStart(3, "0")); }
		params.set("numac_search", ctx.act.numac);
		params.set("cn_search", cn);
		params.set("caller", "eli");
		params.set("view_numac", `${ctx.act.numac}nx${cn}nx${cn}fr`);
		url.search = params;
		return url.href;
	}

	function formatDate(dateMatch) {
		if (!dateMatch) { return undefined; }
		const day = dateMatch[1].padStart(2, "0");
		const month = MONTHS[dateMatch[2].toLowerCase()];
		if (!month) { return undefined; }
		return `${dateMatch[3]}-${month}-${day}`;
	}

	function extractUpdateDate(doc) {
		const title = doc.querySelector("#list-title-1 .list-item--title")?.textContent || "";
		const match = title.match(/mise\s+\S+\s+jour au\s+(\d{1,2})\s+([\p{L}]+)\s+(\d{4})/iu);
		if (match) { return formatDate(match); }
		const numeric = title.match(/mise\s+\S+\s+jour au\s+(\d{2})-(\d{2})-(\d{4})/i);
		return numeric ? `${numeric[3]}-${numeric[2]}-${numeric[1]}` : undefined;
	}


	// ---------------------------------------------------------------------------
	// HTML to Markdown conversion
	//
	// Justel does not use semantic HTML: the law text in #list-title-3 is a flat
	// flow of text, <br> separators and anchors. Headings are only recognisable
	// through their <a name="LNK..."> anchor, articles through <a name="Art...">.
	// Footnote references are <sup><a href="#t" title="...">N</a></sup>: the
	// footnote text lives in the title attribute and the numbering restarts within
	// each article, so footnote labels are scoped per block of text.
	// Inline formatting is delegated to Turndown, extended with Justel rules.
	// ---------------------------------------------------------------------------

	let turndownService = null;
	// State used by the Turndown rules while a block is being converted:
	// {prefix: footnote label prefix, notes: Map<number, footnote text>}
	let footnoteScope = null;

	function getTurndownService() {
		if (turndownService) { return turndownService; }
		const service = new TurndownService({
			headingStyle: "atx",
			hr: "---",
			bulletListMarker: "-",
		});
		service.use(turndownPluginGfm.tables);
		service.addRule("justelFootnote", {
			filter: node => node.nodeName === "SUP" && node.querySelector('a[href="#t"]'),
			replacement: (content, node) => {
				const link = node.querySelector('a[href="#t"]');
				const number = (link.textContent || "").trim();
				const title = link.getAttribute("title") || "";
				if (!footnoteScope || !number) { return `<sup>${number}</sup>`; }
				footnoteScope.notes.set(number, title.trim());
				return `[^${footnoteScope.prefix}-${number}]`;
			},
		});
		service.addRule("justelBareSuperscript", {
			filter: node => node.nodeName === "SUP"
				&& !node.querySelector('a[href="#t"]')
				&& /^\d+$/.test((node.textContent || "").trim()),
			replacement: (content, node) => {
				const number = (node.textContent || "").trim();
				if (footnoteScope?.notes.has(number)) {
					return `[^${footnoteScope.prefix}-${number}]`;
				}
				return `<sup>${number}</sup>`;
			},
		});
		service.addRule("justelLinks", {
			filter: node => node.nodeName === "A",
			replacement: (content, node) => {
				const href = node.getAttribute("href") || "";
				// In-page navigation links (previous/next article, table of contents)
				// are meaningless in an export: keep their text only
				if (!content.trim() || !href || href.startsWith("#")) { return content; }
				try {
					return `[${content}](${new URL(href, BASE_URL).href})`;
				}
				catch (e) {
					return content;
				}
			},
		});
		turndownService = service;
		return service;
	}

	function isElement(node) {
		return node?.nodeType === 1;
	}

	function rawTextOf(line) {
		return line.map(node => node.textContent || "").join("");
	}

	function lineTextOf(line) {
		return rawTextOf(line).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
	}

	function needsFlattening(node) {
		if (!FLATTEN_NODE_NAMES.includes(node.nodeName)) { return false; }
		if (node.nodeName === "I" && !node.querySelector("a[name]")) { return false; }
		return true;
	}

	// Flatten the broken nodes listed in FLATTEN_NODE_NAMES, exactly like the
	// analysis module does when displaying the act
	function flattenContentNodes(content) {
		const nodes = Array.from(content.childNodes);
		let i = 0;
		while (i < nodes.length) {
			if (isElement(nodes[i]) && needsFlattening(nodes[i])) {
				nodes.splice(i, 1, ...nodes[i].childNodes);
				// Do not increment i: re-check position i, which is now either the first
				// inserted child (needs checking too) or the next element if this was empty.
			}
			else {
				i++;
			}
		}
		return nodes;
	}

	function splitIntoLines(nodes) {
		const lines = [[]];
		for (const node of nodes) {
			if (isElement(node) && node.nodeName === "BR") {
				lines.push([]);
			}
			else {
				lines[lines.length - 1].push(node);
			}
		}
		return lines;
	}

	function findAnchor(line) {
		for (const node of line) {
			if (!isElement(node)) { continue; }
			const name = node.getAttribute("name");
			if (!name) { continue; }
			if (/^lnk/i.test(name)) { return {kind: "heading", anchor: node}; }
			if (/^art/i.test(name)) { return {kind: "article", anchor: node}; }
		}
		return null;
	}

	function headingTypeOf(text) {
		return (text.trim().split(/\s+/)[0] || "").toLowerCase().replace(/[.:-]+$/, "");
	}

	// Justel sometimes merges two headings into one line of text; split the line
	// at the second heading (mirrors the same correction in the analysis module)
	function splitHiddenHeading(line) {
		for (let i = 0; i < line.length; i++) {
			const node = line[i];
			if (node.nodeType !== 3) { continue; }
			const match = (node.textContent || "").match(HIDDEN_HEADING);
			if (!match || match.index < 1) { continue; }
			if (!HEADING_TYPES.some(type => match[0].toLowerCase().startsWith(type))) { continue; }
			const text = node.textContent;
			const doc = node.ownerDocument;
			const before = line.slice(0, i);
			const firstPart = text.slice(0, match.index - 1);
			if (firstPart.trim()) { before.push(doc.createTextNode(firstPart)); }
			const after = [doc.createTextNode(text.slice(match.index)), ...line.slice(i + 1)];
			return {before, after};
		}
		return null;
	}

	// An article sometimes contains a heading that Justel forgot to anchor;
	// detect it to avoid losing the section structure (same heuristic as the
	// analysis module: heading type + number, on a line of its own)
	function isHiddenHeadingLine(text, lines, index) {
		if (text.startsWith("§")) { return false; }
		const words = text.trim().split(/\s+/);
		if (words.length < 2) { return false; }
		if (!HEADING_TYPES.some(type => text.toLowerCase().startsWith(type))) { return false; }
		if (!/^[\dIVXL]+\./.test(words[1])) { return false; }
		const next = lines[index + 1];
		return !next || !lineTextOf(next);
	}

	function buildBlocks(content) {
		const lines = splitIntoLines(flattenContentNodes(content));
		const blocks = [];
		let current = null;
		const closeBlock = () => {
			if (current) { blocks.push(current); }
			current = null;
		};
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const text = lineTextOf(line);
			if (!text) { continue; }
			const anchor = findAnchor(line);
			if (anchor) {
				closeBlock();
				current = {kind: anchor.kind, lines: [line]};
				continue;
			}
			if (!current) { current = {kind: "intro", lines: []}; }
			if (current.kind === "heading") {
				const split = splitHiddenHeading(line);
				if (split) {
					if (split.before.length) { current.lines.push(split.before); }
					closeBlock();
					current = {kind: "heading", lines: [split.after]};
				}
				else {
					current.lines.push(line);
				}
			}
			else if (current.kind === "article" && isHiddenHeadingLine(text, lines, index)) {
				closeBlock();
				current = {kind: "heading", lines: [line]};
			}
			else {
				current.lines.push(line);
			}
		}
		closeBlock();
		return blocks;
	}

	// Assign Markdown levels: the heading types actually used by the act are
	// mapped to consecutive levels starting at ###, so that an act that only
	// uses CHAPITRE/SECTION still gets a shallow, correct hierarchy. Articles
	// are nested one level below their parent heading.
	function assignHeadingLevels(blocks) {
		const types = [];
		for (const block of blocks) {
			if (block.kind !== "heading") { continue; }
			block.type = headingTypeOf(lineTextOf(block.lines[0]));
			if (HEADING_TYPES.includes(block.type) && !types.includes(block.type)) {
				types.push(block.type);
			}
		}
		types.sort((a, b) => HEADING_TYPES.indexOf(a) - HEADING_TYPES.indexOf(b));
		const levelOf = new Map(types.map((type, rank) => [type, Math.min(3 + rank, 6)]));
		let lastHeadingLevel = 0;
		for (const block of blocks) {
			if (block.kind === "heading") {
				block.level = levelOf.get(block.type) || Math.max(lastHeadingLevel, 3);
				lastHeadingLevel = block.level;
			}
			else if (block.kind === "article") {
				block.level = Math.min(Math.max(lastHeadingLevel, 2) + 1, 6);
			}
		}
	}

	function markdownOfLine(line, doc) {
		const text = lineTextOf(line);
		if (!text) { return ""; }
		// Justel separates subparagraphs introduced at different times with a
		// line of dashes; keep it as a thematic break
		if (SEPARATOR_LINE.test(text)) { return "---"; }
		const holder = doc.createElement("div");
		for (const node of line) { holder.append(node); }
		const markdown = getTurndownService().turndown(holder);
		const hasTable = line.some(node => isElement(node) && node.nodeName === "TABLE");
		return hasTable ? markdown.trim() : markdown.replace(/\s+/g, " ").trim();
	}

	// Convert the lines of a block, after scanning them for the footnote
	// definitions they contain (a bare <sup>N</sup> may appear before the
	// reference that carries N's text, so the scan must happen first)
	function markdownOfBlockLines(lines, doc) {
		const scanHolder = doc.createElement("div");
		for (const line of lines) {
			for (const node of line) { scanHolder.append(node); }
		}
		if (footnoteScope) {
			for (const link of scanHolder.querySelectorAll('a[href="#t"][title]')) {
				const number = (link.textContent || "").trim();
				if (number) { footnoteScope.notes.set(number, (link.getAttribute("title") || "").trim()); }
			}
		}
		return lines.map(line => markdownOfLine(line, doc)).filter(Boolean);
	}

	// Justel indents lines with non-breaking spaces; strip that indentation so
	// that label patterns anchored at ^ can match, keeping the line nodes intact
	function trimLineStart(line) {
		const trimmed = [...line];
		while (trimmed.length) {
			const node = trimmed[0];
			if (node.nodeType !== 3) { return trimmed; }
			const text = node.textContent;
			const stripped = text.replace(/^[\s\u00a0]+/, "");
			if (stripped) {
				if (stripped !== text) { trimmed[0] = node.ownerDocument.createTextNode(stripped); }
				return trimmed;
			}
			trimmed.shift();
		}
		return trimmed;
	}

	function splitLineAtOffset(line, offset) {
		const before = [];
		const after = [];
		let consumed = 0;
		for (const node of line) {
			const length = (node.textContent || "").length;
			if (consumed >= offset) {
				after.push(node);
			}
			else if (consumed + length <= offset) {
				before.push(node);
			}
			else if (node.nodeType === 3) {
				const local = offset - consumed;
				const text = node.textContent;
				const doc = node.ownerDocument;
				before.push(doc.createTextNode(text.slice(0, local)));
				after.push(doc.createTextNode(text.slice(local)));
			}
			else {
				before.push(node);
			}
			consumed += length;
		}
		return {before, after};
	}

	function footnoteDefinitions() {
		if (!footnoteScope?.notes.size) { return []; }
		return Array.from(footnoteScope.notes.entries())
			.sort((a, b) => Number(a[0]) - Number(b[0]))
			.map(([number, title]) => `[^${footnoteScope.prefix}-${number}]: ${title}`);
	}

	function convertBlock(block, index, doc) {
		footnoteScope = {prefix: `b${index}`, notes: new Map()};
		const output = [];
		if (block.kind === "heading") {
			// The heading title sits on the anchor line; Justel appends modification
			// annotations to it and to the following lines. Keep the annotations as
			// a paragraph under the heading, and only genuine title continuations
			// (plain prose) as part of the heading text.
			const anchorLine = block.lines[0];
			const annotationOffset = rawTextOf(anchorLine).search(/\s<[A-Z]/);
			const titleLines = [];
			const annotationLines = [];
			if (annotationOffset > -1) {
				const split = splitLineAtOffset(anchorLine, annotationOffset + 1);
				titleLines.push(split.before);
				annotationLines.push(split.after);
			}
			else {
				titleLines.push(anchorLine);
			}
			for (const line of block.lines.slice(1)) {
				if (ANNOTATION_LINE.test(lineTextOf(line))) { annotationLines.push(line); }
				else { titleLines.push(line); }
			}
			const title = markdownOfBlockLines(titleLines, doc).join(" ").replace(/\s+/g, " ").trim();
			if (title) { output.push(`${"#".repeat(block.level)} ${title}`, ""); }
			for (const line of markdownOfBlockLines(annotationLines, doc)) { output.push(line, ""); }
		}
		else if (block.kind === "article") {
			const labelLine = trimLineStart(block.lines[0]);
			const rawText = rawTextOf(labelLine);
			const labelMatch = rawText.match(ARTICLE_LABEL);
			const bodyNodes = [];
			let label;
			if (labelMatch) {
				label = `Article ${labelMatch[1].replace(/\u00a0/g, " ").trim()}`;
				// The first sentence of the article may follow the label on the same line;
				// match[0] also covers that sentence, so the split offset is the start of it
				const bodyStart = labelMatch.index + labelMatch[0].length - (labelMatch[2] || "").length;
				const remainder = splitLineAtOffset(labelLine, bodyStart);
				if (rawTextOf(remainder.after).trim()) { bodyNodes.push(remainder.after); }
			}
			else {
				label = markdownOfLine(labelLine, doc) || "Article";
			}
			output.push(`${"#".repeat(block.level)} ${label}`, "");
			const bodyLines = markdownOfBlockLines([...bodyNodes, ...block.lines.slice(1)], doc);
			for (const line of bodyLines) { output.push(line, ""); }
		}
		else {
			for (const line of markdownOfBlockLines(block.lines, doc)) { output.push(line, ""); }
		}
		const definitions = footnoteDefinitions();
		if (definitions.length) { output.push(...definitions, ""); }
		return output;
	}

	function lawHtmlToMarkdown(doc) {
		const content = doc.querySelector("#list-title-3");
		if (!content) { throw new Error("The Justel page has no law text"); }
		content.querySelector("h2")?.remove();
		const blocks = buildBlocks(content);
		assignHeadingLevels(blocks);
		const output = [];
		blocks.forEach((block, index) => output.push(...convertBlock(block, index, doc)));
		footnoteScope = null;
		return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	}

	function extractFullTitle(doc) {
		const title = doc.querySelector("#list-title-1 .list-item--title")?.textContent || "";
		return title
			.replace(/\(NOTE\b[\s\S]*$/i, "")
			.replace(/\u00a0/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}


	function yamlString(value) {
		return JSON.stringify(String(value || ""));
	}

	function makeMarkdown(act) {
		const title = act.title || ctx.act.fullTitle;
		const lines = [
			"---",
			`numac: ${yamlString(ctx.act.numac)}`,
			`title: ${yamlString(title)}`,
			`eli: ${yamlString(ctx.act.eli)}`,
			`consolidated: ${yamlString(act.date || "")}`,
			"source: Justel consolidated text",
			"---",
			"",
			`# ${title}`,
			"",
		];
		if (act.date) {
			lines.push(`Consolidated text as of ${act.date}.`, "");
		}
		if (ctx.act.eli) {
			lines.push(`ELI: ${ctx.act.eli}`, "");
		}
		if (act.url) {
			lines.push(`Source: ${act.url}`, "");
		}
		lines.push(act.markdown, "");
		return lines.join("\n");
	}

	function appendInlineMarkdown(parent, text, doc) {
		const parts = text.split(/((?<!\\)\*\*[^*]+\*\*|(?<!\\)__[^_]+__|(?<!\\)_[^_]+_|\[\^[^\]]+\]|\[[^\]]+\]\([^)\s]+\)|<sup>\d+<\/sup>)/g);
		for (const part of parts) {
			if (/^\*\*[^*]+\*\*$/.test(part) || /^__[^_]+__$/.test(part)) {
				const strong = doc.createElement("strong");
				strong.textContent = part.slice(2, -2);
				parent.append(strong);
			}
			else if (/^_[^_]+_$/.test(part)) {
				const em = doc.createElement("em");
				em.textContent = part.slice(1, -1);
				parent.append(em);
			}
			else if (/^<sup>\d+<\/sup>$/.test(part)) {
				const sup = doc.createElement("sup");
				sup.textContent = part.slice(5, -6);
				parent.append(sup);
			}
			else if (/^\[\^[^\]]+\]$/.test(part)) {
				const label = part.slice(2, -1);
				const display = label.split("-").pop() || label;
				const link = doc.createElement("a");
				link.href = `#fn-${label}`;
				const sup = doc.createElement("sup");
				sup.textContent = display;
				link.append(sup);
				parent.append(link);
			}
			else if (/^\[[^\]]+\]\([^)\s]+\)$/.test(part)) {
				const match = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
				const link = doc.createElement("a");
				link.href = match[2];
				link.target = "_blank";
				link.textContent = match[1];
				parent.append(link);
			}
			else {
				// Undo the Markdown escaping applied by Turndown for plain text
				parent.append(doc.createTextNode(part.replace(/\\([\\*_`[\]#+\-.!>~])/g, "$1")));
			}
		}
	}

	function markdownToHtml(markdown, doc) {
		const container = doc.createElement("div");
		const lines = markdown.split(/\r?\n/);
		let inFrontmatter = lines[0]?.trim() === "---";
		let frontmatterClosed = !inFrontmatter;
		let paragraph = [];
		const footnotes = [];

		function flushParagraph() {
			if (!paragraph.length) { return; }
			const p = doc.createElement("p");
			appendInlineMarkdown(p, paragraph.join("\n"), doc);
			container.append(p);
			paragraph = [];
		}

		for (const [index, line] of lines.entries()) {
			if (inFrontmatter && !frontmatterClosed) {
				if (index > 0 && line.trim() === "---") { frontmatterClosed = true; }
				continue;
			}
			if (!line.trim()) { flushParagraph(); continue; }
			const definition = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
			if (definition) {
				flushParagraph();
				footnotes.push([definition[1], definition[2]]);
				continue;
			}
			const heading = line.match(/^(#{1,6})\s+(.+)$/);
			if (heading) {
				flushParagraph();
				const h = doc.createElement(`h${heading[1].length}`);
				appendInlineMarkdown(h, heading[2], doc);
					container.append(h);
				continue;
			}
			if (line.trim() === "---") {
				flushParagraph();
				container.append(doc.createElement("hr"));
				continue;
			}
			if (line.startsWith("> ")) {
				flushParagraph();
				const previous = container.lastElementChild;
				const quote = previous?.nodeName === "BLOCKQUOTE" ? previous : doc.createElement("blockquote");
				if (quote === previous) { quote.append(doc.createElement("br")); }
				else { container.append(quote); }
				appendInlineMarkdown(quote, line.slice(2), doc);
				continue;
			}
			paragraph.push(line);
		}
		flushParagraph();
		if (footnotes.length) {
			const section = doc.createElement("section");
			section.className = "footnotes";
			const title = doc.createElement("h3");
			title.textContent = "Notes";
			section.append(title);
			for (const [label, text] of footnotes) {
				const p = doc.createElement("p");
				p.id = `fn-${label}`;
				const sup = doc.createElement("sup");
				sup.textContent = label.split("-").pop() || label;
				p.append(sup, doc.createTextNode(" "));
				appendInlineMarkdown(p, text, doc);
				section.append(p);
			}
			container.append(section);
		}
		return container;
	}

	function safeFilename(title) {
		return (title || "law").replace(/[\\/:*?"<>|]/g, "_").trim() || "law";
	}

	function showProgress(popup, message) {
		if (!popup || popup.closed) { throw new Error("Export was cancelled"); }
		popup.document.querySelector("#export-status").textContent = message;
	}

	function preparePopup(popup) {
		if (!popup || popup.closed) { throw new Error("Could not open the export window"); }
		const doc = popup.document;
		doc.open();
		doc.write("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Consolidated law export</title></head><body></body></html>");
		doc.close();
		const style = doc.createElement("style");
		style.textContent = `
			body { max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #17212b; font: 16px/1.55 system-ui, sans-serif; }
			#controls { position: sticky; top: 0; padding: 1rem 0; background: white; border-bottom: 1px solid #dce3ea; }
			button { margin-right: .5rem; padding: .55rem .8rem; cursor: pointer; }
			#export-status { color: #526273; }
			main { overflow-wrap: anywhere; }
			h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin-top: 1.4em; }
			h1 { font-size: 1.7rem; }
			h2 { border-bottom: 1px solid #dce3ea; padding-bottom: .3em; }
			p { margin: .45em 0 1em; white-space: pre-wrap; }
			hr { margin: 2rem 0; border: 0; border-top: 1px solid #dce3ea; }
			blockquote { margin: .8em 0; padding: .4em 1em; border-left: 3px solid #dce3ea; color: #526273; }
			section.footnotes { margin-top: 2.5rem; padding-top: .8rem; border-top: 1px solid #dce3ea; font-size: .85em; color: #526273; }
			section.footnotes h3 { font-size: 1rem; }
			section.footnotes sup { color: #8a1f1f; }
			sup a { color: inherit; text-decoration: none; }
			@page { margin: 18mm; }
			@media print { #controls { display: none; } body { max-width: none; margin: 0; padding: 0; } }
		`;
		doc.head.append(style);
		const controls = doc.createElement("div");
		controls.id = "controls";
		const status = doc.createElement("span");
		status.id = "export-status";
		status.textContent = "Preparing the consolidated text…";
		controls.append(status);
		doc.body.append(controls);
		return doc;
	}

	function presentMarkdown(popup, markdown) {
		const doc = popup.document;
		const controls = doc.querySelector("#controls");
		const status = doc.querySelector("#export-status");
		status.textContent = "Consolidated text ready. Use Print / Save PDF to create the PDF.";
		const download = doc.createElement("button");
		download.textContent = "Download Markdown";
		download.addEventListener("click", function() {
			const blob = new Blob([markdown], {type: "text/markdown;charset=utf-8"});
			const url = URL.createObjectURL(blob);
			const link = doc.createElement("a");
			link.href = url;
			link.download = `${safeFilename(ctx.act.fullTitle)}.md`;
			doc.body.append(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		});
		const print = doc.createElement("button");
		print.textContent = "Print / Save PDF";
		print.addEventListener("click", () => popup.print());
		controls.insertBefore(download, status);
		controls.insertBefore(print, status);
		const main = doc.createElement("main");
		main.append(markdownToHtml(markdown, doc));
		doc.body.append(main);
		doc.title = safeFilename(ctx.act.fullTitle);
	}

	async function exportConsolidated(popup) {
		const doc = preparePopup(popup);
		try {
			if (!ctx.act.numac) { throw new Error("The selected act has no NUMAC identifier"); }
			showProgress(popup, "Finding the consolidated text on Justel…");
			const discoveryResponse = await fetch(makeDiscoveryUrl(), {credentials: "include"});
			if (!discoveryResponse.ok) { throw new Error(`Justel returned HTTP ${discoveryResponse.status}`); }
			const discoveryDoc = new DOMParser().parseFromString(await readJustelHtml(discoveryResponse), "text/html");
			const cn = extractCn(discoveryDoc);
			const total = Math.max(extractVersionCount(discoveryDoc), 1);
			// The highest version number is the text in force: Justel omits arch for it.
			const url = buildVersionUrl(cn, total, total);
			showProgress(popup, "Fetching the consolidated text…");
			const response = await fetch(url, {credentials: "include"});
			if (!response.ok) { throw new Error(`Justel returned HTTP ${response.status}`); }
			const versionDoc = new DOMParser().parseFromString(await readJustelHtml(response), "text/html");
			if (!versionDoc.querySelector("#list-title-3")) {
				throw new Error("Justel did not return the consolidated law text");
			}
			const date = extractUpdateDate(versionDoc) || ctx.act.lastUpdate;
			const markdown = makeMarkdown({
				date,
				url,
				title: extractFullTitle(versionDoc) || ctx.act.fullTitle,
				markdown: lawHtmlToMarkdown(versionDoc),
			});
			presentMarkdown(popup, markdown);
			console.info(`[betterlaws] Prepared consolidated Markdown for ${ctx.act.numac} (${date || "undated"})`);
		}
		catch (error) {
			if (!popup.closed) {
				doc.querySelector("#export-status").textContent = `Export failed: ${error.message}`;
				const retry = doc.createElement("p");
				retry.textContent = "Close this window and try again after checking the Justel page.";
				doc.body.append(retry);
			}
			throw error;
		}
	}

	return {exportConsolidated, lawHtmlToMarkdown};
};
