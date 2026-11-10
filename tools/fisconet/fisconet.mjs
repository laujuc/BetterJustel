#!/usr/bin/env node
// Download a legal code from FisconetPlus (SPF Finances) and convert it with Pandoc.
//
//   node tools/fisconet/fisconet.mjs list [filter]
//   node tools/fisconet/fisconet.mjs get <guid|url> [options]
//
// FisconetPlus is an Angular app on top of a public JSON API (no login). A
// code is a "root" document (a table of contents) that links to one document
// per article. `get` downloads the root and every article (cached as raw HTML
// files, so an interrupted run can be resumed), assembles one HTML file with a
// proper heading hierarchy and Pandoc-style article anchors, then runs Pandoc
// to produce Markdown.
//
// The parsing is shared with the in-page button (scripts/lib/fisconet-core.js).
// Requires Node.js 18+ (built-in fetch) and, for the Markdown step, Pandoc
// 3.0+ (`gfm+attributes`). No npm dependencies.

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const core = createRequire(import.meta.url)('../../scripts/lib/fisconet-core.js');

const UA = 'BetterJustel-fisconet-tool/1.0 (+https://github.com/laujuc/BetterJustel)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(file) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

function extractGuid(input) {
	const match = String(input).match(core.GUID_RE);
	if (!match) throw new Error(`No document GUID found in "${input}"`);
	return match[0].toLowerCase();
}

async function getJson(url, attempts = 4) {
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { 'User-Agent': UA, Accept: 'application/json' },
			});
			if (!response.ok) {
				const error = new Error(`HTTP ${response.status}`);
				error.fatal = response.status >= 400 && response.status < 500;
				throw error;
			}
			return await response.json();
		} catch (error) {
			if (error.fatal || attempt >= attempts) {
				throw new Error(`${url}: ${error.message}`);
			}
			await sleep(1000 * 2 ** (attempt - 1));
		}
	}
}

// Returns { guid, title, type, effectiveDate, html }; `html` is the decoded
// HTML for HTML documents, `data` the base64 payload otherwise.
async function fetchDocument(guid) {
	const json = await getJson(`${core.API}/document/${guid}`);
	const document = json.data;
	if (!document?.content) throw new Error(`Document ${guid} has no content`);
	const { type, content } = document.content;
	const meta = document.metadata ?? {};
	const result = {
		guid,
		title: meta.title ?? guid,
		type,
		effectiveDate: meta.effectiveDate ?? null,
	};
	if (type === 'HTML') {
		result.html = core.decodeBase64(content);
	} else {
		result.data = content;
	}
	return result;
}

async function fetchCached(guid, rawDir, refresh) {
	const htmlFile = path.join(rawDir, `${guid}.html`);
	const metaFile = path.join(rawDir, `${guid}.json`);
	if (!refresh && (await exists(metaFile))) {
		const meta = JSON.parse(await readFile(metaFile, 'utf8'));
		if (meta.type && meta.type !== 'HTML') return meta;
		if (await exists(htmlFile)) return { ...meta, html: await readFile(htmlFile, 'utf8') };
	}
	const document = await fetchDocument(guid);
	const { html, data, ...meta } = document;
	await writeFile(metaFile, JSON.stringify(meta, null, 2));
	if (document.type !== 'HTML') return document;
	await writeFile(htmlFile, html);
	return document;
}

async function pool(items, size, worker) {
	let next = 0;
	const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			await worker(items[index], index);
		}
	});
	await Promise.all(runners);
}

async function listCommand(filter) {
	const json = await getJson(`${core.API}/navigation/tree`);
	const needle = core.slugify(filter ?? '').split('-').filter(Boolean);
	const rows = [];

	const walk = (node, trail) => {
		if (Array.isArray(node)) {
			node.forEach((child) => walk(child, trail));
		} else if (node && typeof node === 'object') {
			if (node.guid && node.label) {
				const label = node.label.fr || node.name || node.guid;
				const trailHere = [...trail, label];
				const documentId = node.documentId?.fr;
				if (documentId && core.GUID_RE.test(documentId)) {
					rows.push({ guid: documentId, path: trailHere.join(' > ') });
				}
				walk(node.children ?? [], trailHere);
			} else {
				Object.values(node).forEach((child) => walk(child, trail));
			}
		}
	};
	walk(json.data, []);

	const matches = rows.filter((row) => {
		const haystack = core.slugify(row.path);
		return needle.every((word) => haystack.includes(word));
	});
	if (matches.length === 0) {
		console.error(`No document found${filter ? ` matching "${filter}"` : ''}.`);
		process.exit(1);
	}
	for (const row of matches) console.log(`${row.guid}  ${row.path}`);
	console.error(
		`\n${matches.length} document(s). Download one with: node tools/fisconet/fisconet.mjs get <guid>`,
	);
}

function pandocMarkdown(htmlFile) {
	const result = spawnSync(
		'pandoc',
		['--from', 'html-auto_identifiers', '--to', 'gfm+attributes', '--wrap=none', htmlFile],
		{ encoding: 'utf8', maxBuffer: 1 << 30 },
	);
	if (result.error) {
		if (result.error.code === 'ENOENT') {
			console.error('Pandoc not found in PATH: skipping the Markdown conversion (https://pandoc.org).');
			return null;
		}
		throw result.error;
	}
	if (result.status !== 0) throw new Error(`Pandoc failed:\n${result.stderr}`);
	return result.stdout;
}

const yamlString = (value) => JSON.stringify(String(value));

async function getCommand(target, options) {
	const rootGuid = extractGuid(target);
	const refresh = Boolean(options.refresh);
	const concurrency = Math.max(1, Number(options.concurrency) || 12);

	console.error(`Fetching root document ${rootGuid}...`);
	const baseOut = path.resolve(options.out ?? 'fisconet');
	const rootDocument = await fetchDocument(rootGuid);
	const title = core.codeTitle(rootDocument.title);
	const name = options.name ?? (core.slugify(title) || rootGuid);
	const outDir = path.join(baseOut, name);
	const rawDir = path.join(outDir, 'raw');
	await mkdir(rawDir, { recursive: true });

	if (rootDocument.type !== 'HTML') {
		const buffer = Buffer.from(rootDocument.data ?? '', 'base64');
		if (rootDocument.type === 'PDF' && buffer.subarray(0, 4).toString() === '%PDF') {
			const pdfFile = path.join(outDir, `${name}.pdf`);
			await writeFile(pdfFile, buffer);
			console.error(`This document is a PDF, saved as ${pdfFile}`);
			return;
		}
		throw new Error(`Unsupported document type "${rootDocument.type}"; open ${core.SITE}${rootGuid}`);
	}
	await writeFile(path.join(rawDir, `${rootGuid}.html`), rootDocument.html);
	const { html: _html, ...rootMeta } = rootDocument;
	await writeFile(path.join(rawDir, `${rootGuid}.json`), JSON.stringify(rootMeta, null, 2));

	const analysis = core.analyse(rootDocument.html);
	const articles = analysis.articles;
	console.error(`"${title}": ${analysis.root.mode} layout, ${analysis.root.items.length - articles.length} section(s), ${articles.length} article(s)`);

	if (options.outline) {
		for (const item of analysis.root.items) {
			if (item.kind === 'section') {
				console.log(`${'#'.repeat(analysis.sectionLevel(item.depth))} ${item.label}`);
			} else if (options.outline === 'full') {
				console.log(`${'#'.repeat(analysis.articleLevel)} ${item.label.split(',')[0].trim()} {#${item.id}}`);
			}
		}
		console.error(`(articles are level-${analysis.articleLevel} headings; pass --outline full to list them)`);
		return;
	}

	const bodies = new Map();
	const downloadable = articles.filter((article) => article.guid);
	const failures = [];
	let done = 0;
	await pool(downloadable, concurrency, async (article) => {
		try {
			const document = await fetchCached(article.guid, rawDir, refresh);
			if (document.type === 'HTML') {
				bodies.set(article.guid, document.html);
			} else {
				const error = `not an HTML document (${document.type})`;
				bodies.set(article.guid, { error });
				failures.push(`${article.label}: ${error}`);
			}
		} catch (error) {
			bodies.set(article.guid, { error: error.message });
			failures.push(`${article.label}: ${error.message}`);
		}
		done++;
		if (process.stderr.isTTY) {
			process.stderr.write(`\r  articles ${done}/${downloadable.length}`);
		} else if (done % 50 === 0 || done === downloadable.length) {
			console.error(`  articles ${done}/${downloadable.length}`);
		}
	});
	if (process.stderr.isTTY) process.stderr.write('\n');

	// A commentary code's table of contents stops at a hub page. The text is
	// the document linked under "Commentaire", one hop further. Stay at the
	// same concurrency; do not inline the legislation "(historique)" document.
	const commentaryGuids = new Set();
	for (const article of downloadable) {
		const html = bodies.get(article.guid);
		if (typeof html !== 'string') continue;
		const target = core.commentaryTarget(html);
		if (target && !bodies.has(target.guid)) commentaryGuids.add(target.guid);
	}
	if (commentaryGuids.size > 0) {
		console.error(`Following ${commentaryGuids.size} commentary document(s)...`);
		let followed = 0;
		await pool([...commentaryGuids], concurrency, async (guid) => {
			try {
				const document = await fetchCached(guid, rawDir, refresh);
				if (document.type === 'HTML') {
					bodies.set(guid, document.html);
				} else {
					bodies.set(guid, { type: document.type });
					console.error(`  ${guid} is ${document.type}; left as a link`);
				}
			} catch (error) {
				bodies.set(guid, { error: error.message });
				failures.push(`commentary ${guid}: ${error.message}`);
			}
			followed++;
			if (process.stderr.isTTY) {
				process.stderr.write(`\r  commentary ${followed}/${commentaryGuids.size}`);
			} else if (followed % 50 === 0 || followed === commentaryGuids.size) {
				console.error(`  commentary ${followed}/${commentaryGuids.size}`);
			}
		});
		if (process.stderr.isTTY) process.stderr.write('\n');
	}

	const built = core.buildHtml(rootDocument.html, bodies);
	const htmlFile = path.join(outDir, `${name}.html`);
	await writeFile(
		htmlFile,
		`<!DOCTYPE html>\n<html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body>\n${built.html}\n</body></html>\n`,
	);
	console.error(`Wrote ${htmlFile}`);

	if (!options['no-markdown']) {
		const body = pandocMarkdown(htmlFile);
		if (body !== null) {
			const frontMatter = [
				'---',
				`title: ${yamlString(title)}`,
				`source: ${yamlString(`${core.SITE}${rootGuid}`)}`,
				`guid: ${yamlString(rootGuid)}`,
				`retrieved: ${yamlString(new Date().toISOString().slice(0, 10))}`,
				`articles: ${articles.length}`,
				'lang: fr',
				'---',
				'',
				'',
			].join('\n');
			const mdFile = path.join(outDir, `${name}.md`);
			await writeFile(mdFile, frontMatter + body);
			console.error(`Wrote ${mdFile}`);
		}
	}

	if (failures.length > 0) {
		console.error(`\n${failures.length} article(s) could not be downloaded:`);
		failures.slice(0, 20).forEach((failure) => console.error(`  - ${failure}`));
		console.error('Run the same command again: articles already downloaded are cached.');
		process.exit(1);
	}
}

const USAGE = `Usage:
  fisconet.mjs list [filter]        List codes/documents (with their GUID); filter by words
  fisconet.mjs get <guid|url> [options]
                                    Download a code and convert it to HTML + Markdown

Options for "get":
  --out DIR          Output folder (default: ./fisconet); files go in DIR/<name>/
  --name NAME        Name of the sub-folder and files (default: derived from the title)
  --concurrency N    Parallel downloads (default: 12; measured plateau, no errors)
  --refresh          Ignore the local cache and download everything again
  --outline [full]   Only print the heading structure (no article download)
  --no-markdown      Stop after the HTML file (skip Pandoc)
`;

function parseArguments(argv) {
	const positional = [];
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const key = arg.slice(2);
		const isFlag = ['refresh', 'no-markdown'].includes(key);
		if (key === 'outline') {
			options.outline = argv[i + 1] === 'full' ? (i++, 'full') : true;
		} else if (isFlag) {
			options[key] = true;
		} else {
			options[key] = argv[++i];
		}
	}
	return { positional, options };
}

async function main() {
	const { positional, options } = parseArguments(process.argv.slice(2));
	const [command, target] = positional;
	if (command === 'list') return listCommand(positional.slice(1).join(' '));
	if (command === 'get' && target) return getCommand(target, options);
	console.error(USAGE);
	process.exit(command ? 1 : 0);
}

main().catch((error) => {
	console.error(`Error: ${error.message}`);
	process.exit(1);
});
