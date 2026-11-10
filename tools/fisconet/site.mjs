#!/usr/bin/env node
// Build a minimalist static site from a folder produced by `just fisconet`.
//
//   node tools/fisconet/site.mjs <downloaded-dir> [--publish]
//
// Writes <dir>/site/index.html, one HTML page per article, style.css, a
// standalone toc.html, and a copy of the Markdown file when it exists. Article
// links become art-<id>.html (pico+ pages also serves that URL without the
// extension). The sidebar is inlined HTML and CSS: pgs sends
// X-Frame-Options: DENY, so an iframe of toc.html is refused. No script.
//
// pico+ pages (pgs.sh) is a static-file host, not a Markdown CMS, so the
// readable site is HTML. Every code is uploaded into the same project, as a
// subdirectory, so one site holds all of them:
//
//   rsync -rtv --delete ".../cir-92-revenus-2027/site/" pgs.sh:/laws/cir-92-revenus-2027/
//   https://ljuc-laws.pgs.sh/cir-92-revenus-2027/
//
// SSH upload is always to pgs.sh. ljuc-laws.pgs.sh is the public hostname of
// the `laws` project, not an rsync host. --delete applies only to that code's
// subdirectory, so other codes under /laws/ are left in place. --publish runs
// rsync when it is installed; otherwise it prints an scp command.
//
// Requires Node.js 18+. No npm dependencies. Works the same on Windows
// (PowerShell) and Unix: it is a Node script, not a shell script.

import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const core = createRequire(import.meta.url)('../../scripts/lib/fisconet-core.js');

const PICO_USER = 'ljuc';
const PICO_PROJECT = 'laws';

const USAGE = `Usage:
  site.mjs <downloaded-dir> [--publish] [--project laws] [--user ljuc]

  <downloaded-dir>   A folder created by \`just fisconet\` (contains raw/ and usually a .md file)
  --project NAME     pico+ project (default: laws). Each code is a subdirectory.
  --user NAME        pico username used in the public URL (default: ljuc)
  --publish          Upload site/ to pgs.sh:/laws/<folder>/ with rsync when rsync is installed

The site is always written to <downloaded-dir>/site/ before any upload.
Public URL: https://ljuc-laws.pgs.sh/<folder>/
`;

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (char) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[char]));
}

function parseFrontMatter(text) {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const data = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		let value = kv[2].trim();
		if (value.startsWith('"')) {
			try {
				value = JSON.parse(value);
			} catch {
				// keep the raw scalar
			}
		}
		data[kv[1]] = value;
	}
	return data;
}

function parseArguments(argv) {
	const positional = [];
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--publish') options.publish = true;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--project') options.project = argv[++i];
		else if (arg === '--user') options.user = argv[++i];
		else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
		else positional.push(arg);
	}
	return { positional, options };
}

function picoSlug(value, label) {
	const name = String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!name || !/^[a-z0-9]/.test(name)) {
		throw new Error(`Invalid pico+ ${label} "${value}"`);
	}
	return name;
}

// One project (`laws`), one subdirectory per code. The folder name is the
// public path: fisconet/cir-92-revenus-2027 -> /laws/cir-92-revenus-2027/.
function publishTarget(dir, options) {
	return {
		user: picoSlug(options.user || PICO_USER, 'username'),
		project: picoSlug(options.project || PICO_PROJECT, 'project'),
		code: picoSlug(core.slugify(path.basename(dir)) || 'code', 'code name'),
	};
}

async function findRoot(dir) {
	const entries = await readdir(dir);
	for (const file of entries) {
		if (!file.endsWith('.md')) continue;
		const meta = parseFrontMatter(await readFile(path.join(dir, file), 'utf8'));
		if (meta.guid && core.GUID_RE.test(String(meta.guid))) {
			return {
				guid: String(meta.guid).toLowerCase(),
				title: meta.title ? core.codeTitle(meta.title) : null,
				retrieved: meta.retrieved || null,
				markdown: file,
			};
		}
	}

	const rawDir = path.join(dir, 'raw');
	let rawEntries;
	try {
		rawEntries = await readdir(rawDir);
	} catch {
		throw new Error(`No Markdown front matter and no raw/ folder in ${dir}. Run \`just fisconet\` first.`);
	}
	const candidates = [];
	for (const file of rawEntries) {
		if (!file.endsWith('.json')) continue;
		const meta = JSON.parse(await readFile(path.join(rawDir, file), 'utf8'));
		if (meta?.guid && !/^article\b/i.test(meta.title || '')) candidates.push(meta);
	}
	for (const meta of candidates) {
		const htmlPath = path.join(rawDir, `${meta.guid}.html`);
		let html;
		try {
			html = await readFile(htmlPath, 'utf8');
		} catch {
			continue;
		}
		const analysis = core.analyse(html);
		if (analysis.root.mode !== 'plain' && analysis.articles.length > 0) {
			return {
				guid: meta.guid.toLowerCase(),
				title: core.codeTitle(meta.title),
				retrieved: null,
				markdown: null,
			};
		}
	}
	throw new Error(`No Fisconet code found in ${dir}. Pass a folder created by \`just fisconet\`.`);
}

// Sections on the path to the current article stay open, so the reader
// sees where they are without a script to scroll the list.
function ancestorSections(items, currentId) {
	const open = new Set();
	if (!currentId) return open;
	const stack = [];
	for (const item of items) {
		if (item.kind === 'section') {
			while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop();
			stack.push(item);
		} else if (item.id === currentId) {
			for (const section of stack) open.add(section);
			break;
		}
	}
	return open;
}

function renderToc(items, currentId = null, expandAll = false) {
	const openSections = ancestorSections(items, currentId);
	const parts = ['<ul>'];
	const stack = [0];
	const closeTo = (depth) => {
		while (stack.length > 1 && stack[stack.length - 1] >= depth) {
			parts.push('</ul></details></li>');
			stack.pop();
		}
	};
	for (const item of items) {
		if (item.kind === 'section') {
			closeTo(item.depth);
			const open = expandAll || openSections.has(item) ? ' open' : '';
			parts.push(`<li class="section"><details${open}><summary>${escapeHtml(item.label)}</summary><ul>`);
			stack.push(item.depth);
		} else {
			const heading = core.articleHeadingText(item.label);
			const current = item.id === currentId;
			const attrs = current ? ' id="current" aria-current="page"' : '';
			parts.push(`<li class="article"><a${attrs} href="${escapeHtml(item.id)}.html">${escapeHtml(heading)}</a></li>`);
		}
	}
	closeTo(0);
	parts.push('</ul>');
	return parts.join('\n');
}

// Point in-code links at article pages. Match `art-1` only as a whole id or
// as a prefix followed by "-", so it does not swallow art-10 or art-1bis.
function retarget(html, currentId, idSet, idByGuid) {
	let out = html.replace(/href="#([^"]+)"/gi, (match, rawFragment) => {
		let fragment = rawFragment;
		try {
			fragment = decodeURIComponent(rawFragment);
		} catch {
			// keep the raw fragment
		}
		const id = core.articleIdFromFragment(fragment, idSet);
		if (!id) return match;
		if (fragment === id) return currentId === id ? `href="#${escapeHtml(id)}"` : `href="${escapeHtml(id)}.html"`;
		const target = currentId === id ? `#${fragment}` : `${id}.html#${fragment}`;
		return `href="${escapeHtml(target)}"`;
	});
	out = out.replace(
		/href="([^"]*\/fisconet\/document\/([0-9a-f-]{36})[^"]*)"/gi,
		(match, url, guid) => {
			const id = idByGuid.get(guid.toLowerCase());
			if (!id) return match;
			const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
			if (!hash) return currentId === id ? `href="#${escapeHtml(id)}"` : `href="${escapeHtml(id)}.html"`;
			const target = currentId === id ? `#${hash}` : `${id}.html#${hash}`;
			return `href="${escapeHtml(target)}"`;
		},
	);
	return out;
}

// tocHtml is the inlined list. null omits the sidebar (the standalone toc page).
// homeLabel is the short name in the sidebar; title is the document title.
function pageShell(title, body, tocHtml = null, currentLabel = '', homeLabel = '') {
	const here = currentLabel
		? `<a class="toc-current" href="#current">${escapeHtml(currentLabel)}</a>`
		: '';
	const home = homeLabel || title;
	const sidebar = tocHtml == null ? '' : `<aside class="toc-side">
<details open>
<summary>Table des matières</summary>
<a class="toc-home" href="index.html">${escapeHtml(home)}</a>
${here}
<nav class="toc" aria-label="Table des matières">
${tocHtml}
</nav>
</details>
</aside>`;
	return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body class="${sidebar ? 'with-toc' : ''}">
${sidebar}
<div class="reading">
${body}
</div>
</body>
</html>
`;
}

function tocPage(title, items) {
	return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Table des matières — ${escapeHtml(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body class="toc-page">
<header>
<a class="brand" href="index.html">${escapeHtml(title)}</a>
</header>
<main class="wrap">
<h1>Table des matières</h1>
<nav class="toc" aria-label="Table des matières">
${renderToc(items, null, true)}
</nav>
</main>
</body>
</html>
`;
}

function footer(sourceUrl, retrieved) {
	const when = retrieved ? ` Récupéré le ${escapeHtml(retrieved)}.` : '';
	return `<footer><p>Texte en vigueur, sans l'historique des modifications. Repris de <a href="${escapeHtml(sourceUrl)}">FisconetPlus</a> (SPF Finances).${when} Ce n'est pas une publication officielle.</p></footer>`;
}

const CSS = `/* Minimalist reading layout for a Fisconet code. */
:root {
	color-scheme: light;
	--bg: #f7f5f2;
	--ink: #1c1917;
	--muted: #57534e;
	--line: #e7e5e4;
	--link: #1d4e89;
	--measure: 42rem;
}
* { box-sizing: border-box; }
html { hyphens: auto; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--ink);
	font: 1.05rem/1.6 "Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif;
}
a { color: var(--link); }
header, footer, .pager, .meta, .toc, .brand {
	font-family: system-ui, sans-serif;
}
header {
	position: sticky;
	top: 0;
	z-index: 2;
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: 0.6rem 1.2rem;
	padding: 0.8rem 1.2rem;
	background: rgba(247, 245, 242, 0.94);
	border-bottom: 1px solid var(--line);
}
.brand { font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.brand a { color: inherit; text-decoration: none; }
header h1, .doc-title { font: 600 1rem/1.3 system-ui, sans-serif; margin: 0; }
.wrap { max-width: var(--measure); margin: 0 auto; padding: 1.6rem 1.2rem 4rem; }
.index { --measure: 46rem; }
.meta, .crumbs, footer { color: var(--muted); font-size: 0.85rem; }
.crumbs { margin: 0 0 0.4rem; }
.pager { display: flex; justify-content: space-between; gap: 1rem; margin: 0.8rem 0 1.2rem; font-size: 0.85rem; }
.pager a { text-decoration: none; }
.pager a:hover { text-decoration: underline; }
.prose h1 { font-size: 1.7rem; line-height: 1.25; font-weight: 600; margin: 0 0 0.8rem; }
.prose p { margin: 0.75em 0; }
.prose ul, .prose ol { padding-left: 1.4em; }
.prose table { border-collapse: collapse; width: 100%; margin: 1em 0; font: 0.92rem/1.4 system-ui, sans-serif; }
.prose td, .prose th { border: 1px solid #d6d3d1; padding: 0.35em 0.6em; vertical-align: top; text-align: left; }
.prose sup, .prose sub { font-size: 0.75em; }
	.toc ul { list-style: none; margin: 0.15rem 0; padding-left: 0.75rem; }
	.toc > ul { padding-left: 0; }
	.toc a { color: var(--ink); text-decoration: none; }
	.toc summary {
		cursor: pointer;
		font-weight: 600;
		padding: 0.28rem 0.15rem;
	}
	.toc li.article a {
		display: block;
		padding: 0.12rem 0.35rem;
		border-radius: 4px;
	}
	.toc li.article a:hover, .toc summary:hover { background: #f1efe9; }
	.toc a[aria-current="page"] { background: #e7e5e4; font-weight: 600; }
	footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); }
	body.with-toc { display: grid; grid-template-columns: 18rem minmax(0, 1fr); min-height: 100vh; }
	.reading { min-width: 0; }
	.toc-side {
		position: sticky; top: 0; align-self: start;
		height: 100vh; overflow: auto;
		border-right: 1px solid var(--line); background: #fff;
		font: 13px/1.4 system-ui, sans-serif;
	}
	.toc-side > details > summary { display: none; }
	.toc-home, .toc-current {
		display: block;
		padding: 0.7rem 0.8rem 0;
		font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
		color: var(--muted); text-decoration: none;
	}
	.toc-current {
		padding-top: 0.35rem; padding-bottom: 0.45rem;
		border-bottom: 1px solid var(--line);
		font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none;
		color: var(--ink);
	}
	.toc-side nav.toc { padding: 0.35rem 0.55rem 2rem; }
	body.toc-page .toc { font: 0.95rem/1.45 system-ui, sans-serif; }
	@media (max-width: 800px) {
		body.with-toc { display: block; }
		body.with-toc .reading header { position: static; }
		.toc-side {
			position: sticky; top: 0; z-index: 3;
			height: auto; max-height: 45vh;
			border-right: 0; border-bottom: 1px solid var(--line);
		}
		.toc-side > details > summary {
			display: block; position: sticky; top: 0; z-index: 1;
			padding: 0.7rem 1rem; cursor: pointer;
			background: #fff; border-bottom: 1px solid var(--line);
			font: 600 0.85rem/1.3 system-ui, sans-serif;
		}
	}
@media print {
	header, .pager, footer, .toc-side { display: none; }
	body, body.with-toc { display: block; background: #fff; }
	.wrap { max-width: none; }
}
`;

function publishCommands(siteDir, target) {
	const source = path.resolve(siteDir).replace(/\\/g, '/').replace(/\/?$/, '/');
	// pgs.sh:/<project>/<code>/ is the SSH destination. The public host is
	// https://<user>-<project>.pgs.sh/<code>/ (ljuc-laws.pgs.sh is not an rsync host).
	const dest = `pgs.sh:/${target.project}/${target.code}/`;
	return {
		source,
		dest,
		rsync: `rsync -rtv --delete "${source}" ${dest}`,
		scp: `scp -r "${source}." ${dest}`,
		url: `https://${target.user}-${target.project}.pgs.sh/${target.code}/`,
	};
}

function rsyncAvailable() {
	const result = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
	return !result.error && result.status === 0;
}

function publish(siteDir, target) {
	const commands = publishCommands(siteDir, target);
	if (!rsyncAvailable()) {
		console.error('rsync is not installed. Upload with scp (it does not delete files removed from the site):');
		console.error(`  ${commands.scp}`);
		return false;
	}
	console.error(`Uploading to ${commands.dest} ...`);
	const result = spawnSync('rsync', ['-rtv', '--delete', commands.source, commands.dest], { stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error('rsync failed. Check that your pico SSH key can log in to pgs.sh.');
	}
	return true;
}

async function mapPool(items, size, worker) {
	let next = 0;
	const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			await worker(items[index], index);
		}
	});
	await Promise.all(runners);
}

async function build(dir, options) {
	const rootInfo = await findRoot(dir);
	const rawDir = path.join(dir, 'raw');
	const rootHtml = await readFile(path.join(rawDir, `${rootInfo.guid}.html`), 'utf8');
	const analysis = core.analyse(rootHtml);
	const title = rootInfo.title || core.codeTitle(
		JSON.parse(await readFile(path.join(rawDir, `${rootInfo.guid}.json`), 'utf8')).title,
	);
	const sourceUrl = `${core.SITE}${rootInfo.guid}`;
	const articles = analysis.articles.filter((article) => article.guid);
	const idSet = articles.map((article) => article.id);
	const idByGuid = analysis.ids;
	const bodies = new Map();

	await mapPool(articles, 32, async (article) => {
		try {
			bodies.set(article.guid, await readFile(path.join(rawDir, `${article.guid}.html`), 'utf8'));
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			bodies.set(article.guid, null);
		}
	});

	const siteDir = path.join(dir, 'site');
	await rm(siteDir, { recursive: true, force: true });
	await mkdir(siteDir, { recursive: true });
	await writeFile(path.join(siteDir, 'style.css'), CSS);

	let markdownName = null;
	if (rootInfo.markdown) {
		markdownName = rootInfo.markdown;
		await copyFile(path.join(dir, rootInfo.markdown), path.join(siteDir, rootInfo.markdown));
	}

	const intro = analysis.root.intro
		? retarget(core.sanitizeHtml(core.rewriteLinks(analysis.root.intro, idByGuid)), null, idSet, idByGuid)
		: '';
	const download = markdownName
		? `<p class="meta"><a href="${escapeHtml(markdownName)}">Télécharger le Markdown</a></p>`
		: '';
	const indexBody = `<header><p class="doc-title">${escapeHtml(title)}</p></header>
<main class="wrap index">
<h1 class="prose">${escapeHtml(title)}</h1>
<p class="meta">${articles.length} articles · <a href="${escapeHtml(sourceUrl)}">Source FisconetPlus</a></p>
${download}
${intro ? `<div class="prose intro">${intro}</div>` : ''}
<p class="meta"><a href="toc.html">Ouvrir la table des matières</a></p>
${footer(sourceUrl, rootInfo.retrieved)}
</main>`;
	const items = analysis.root.items;
	await writeFile(path.join(siteDir, 'toc.html'), tocPage(title, items));
	await writeFile(path.join(siteDir, 'index.html'), pageShell(title, indexBody, renderToc(items)));

	const followed = new Map();
	await mapPool(articles, 32, async (article) => {
		const raw = bodies.get(article.guid);
		if (typeof raw !== 'string') return;
		const target = core.commentaryTarget(raw);
		if (!target) return;
		if (!idByGuid.has(target.guid)) idByGuid.set(target.guid, article.id);
		const htmlPath = path.join(rawDir, `${target.guid}.html`);
		try {
			followed.set(article.guid, await readFile(htmlPath, 'utf8'));
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			let meta = null;
			try {
				meta = JSON.parse(await readFile(path.join(rawDir, `${target.guid}.json`), 'utf8'));
			} catch (metaError) {
				if (metaError.code !== 'ENOENT') throw metaError;
			}
			followed.set(article.guid, meta?.type && meta.type !== 'HTML' ? false : null);
		}
	});

	const missing = [];
	let historyLeaks = 0;
	let followedCount = 0;
	for (let index = 0; index < articles.length; index++) {
		const article = articles[index];
		const heading = core.articleHeadingText(article.label);
		const raw = bodies.get(article.guid);
		let prose;
		if (!raw) {
			missing.push(heading);
			prose = '<p><em>(texte indisponible : fichier brut absent, relancez just fisconet)</em></p>';
		} else if (followed.get(article.guid) === null) {
			missing.push(heading);
			prose = '<p><em>(commentaire absent : relancez just fisconet pour suivre le lien)</em></p>';
		} else {
			const commentary = followed.get(article.guid);
			const prepared = core.rewriteLinks(
				commentary
					? core.composeArticle(raw, commentary, article.label, article.id)
					: core.prepareArticle(raw, article.label, article.id),
				idByGuid,
			);
			if (commentary) followedCount++;
			prose = retarget(prepared, article.id, idSet, idByGuid);
			if (/Historique des modifications/i.test(prose)) historyLeaks++;
		}
		const crumbs = core.sectionPath(analysis.root.items, article.id);
		const previous = articles[index - 1];
		const next = articles[index + 1];
		const pager = `<nav class="pager">${
			previous
				? `<a href="${previous.id}.html">← ${escapeHtml(core.articleHeadingText(previous.label))}</a>`
				: '<span></span>'
		}${
			next
				? `<a href="${next.id}.html">${escapeHtml(core.articleHeadingText(next.label))} →</a>`
				: '<span></span>'
		}</nav>`;
		const body = `<header>
<a class="brand" href="index.html">${escapeHtml(title)}</a>
<a href="toc.html">Table des matières</a>
</header>
<main class="wrap">
${crumbs.length ? `<p class="crumbs">${crumbs.map(escapeHtml).join(' · ')}</p>` : ''}
${pager}
<article class="prose">
<h1 id="${article.id}">${escapeHtml(heading)}</h1>
${prose}
</article>
${pager}
${footer(sourceUrl, rootInfo.retrieved)}
</main>`;
		await writeFile(
			path.join(siteDir, `${article.id}.html`),
			pageShell(`${heading} — ${title}`, body, renderToc(items, article.id), heading, title),
		);
	}

	const notFound = pageShell(
		`Introuvable — ${title}`,
		`<main class="wrap"><h1>Page introuvable</h1><p><a href="index.html">Retour au code</a> · <a href="toc.html">Table des matières</a></p></main>`,
		renderToc(items),
		'',
		title,
	);
	await writeFile(path.join(siteDir, '404.html'), notFound);

	const target = publishTarget(dir, options);
	const commands = publishCommands(siteDir, target);
	console.error(`Wrote ${siteDir}`);
	console.error(`  ${articles.length} articles, ${analysis.root.mode} layout, ${followedCount} with commentary text${missing.length ? `, ${missing.length} missing` : ''}`);
	if (historyLeaks) {
		console.error(`  warning: ${historyLeaks} page(s) still mention "Historique des modifications"`);
	}
	console.error('');
	console.error(`pico+ pages: ${commands.url}`);
	console.error(`SSH destination (project ${target.project}, this code only): ${commands.dest}`);
	console.error('Upload with your pico SSH key:');
	console.error(`  ${commands.rsync}`);
	console.error('Without rsync (does not delete removed files):');
	console.error(`  ${commands.scp}`);

	if (options.publish) {
		publish(siteDir, target);
		console.error(`Uploaded. Open ${commands.url}`);
	}
	if (missing.length) process.exitCode = 1;
}

async function main() {
	const { positional, options } = parseArguments(process.argv.slice(2));
	if (options.help || positional.length !== 1) {
		console.error(USAGE);
		process.exit(options.help ? 0 : 1);
	}
	await build(path.resolve(positional[0]), options);
}

main().catch((error) => {
	console.error(`Error: ${error.message}`);
	process.exit(1);
});
