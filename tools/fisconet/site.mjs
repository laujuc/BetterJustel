#!/usr/bin/env node
// Build a minimalist static site from a folder produced by `just fisconet`.
//
//   node tools/fisconet/site.mjs <downloaded-dir> [--project law-cir] [--publish]
//
// Writes <dir>/site/index.html, one HTML page per article, style.css, and a
// copy of the Markdown file when it exists. Article links become art-<id>.html
// (pico+ pages also serves that URL without the extension).
//
// pico+ pages (pgs.sh) is a static-file host, not a Markdown CMS, so the
// readable site is HTML. --publish runs rsync when it is installed; otherwise
// it prints an scp command. The upload uses your pico SSH key. This script
// does not know your pico username: the live URL is
// https://<username>-law-<slug>.pgs.sh
//
// Requires Node.js 18+. No npm dependencies. Works the same on Windows
// (PowerShell) and Unix: it is a Node script, not a shell script.

import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const core = createRequire(import.meta.url)('../../scripts/lib/fisconet-core.js');

const USAGE = `Usage:
  site.mjs <downloaded-dir> [--project NAME] [--publish]

  <downloaded-dir>   A folder created by \`just fisconet\` (contains raw/ and usually a .md file)
  --project NAME     pico+ project name (default: law-<folder name>)
  --publish          Upload site/ to pgs.sh with rsync when rsync is installed

The site is always written to <downloaded-dir>/site/ before any upload.
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
		else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
		else positional.push(arg);
	}
	return { positional, options };
}

function projectName(dir, override) {
	const raw = override || `law-${core.slugify(path.basename(dir)) || 'code'}`;
	const name = String(raw)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!name || !/^[a-z0-9]/.test(name)) {
		throw new Error(`Invalid pico+ project name "${override ?? name}"`);
	}
	return name.startsWith('law-') ? name : `law-${name}`;
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

function renderToc(items) {
	const parts = ['<ul>'];
	const stack = [0];
	const closeTo = (depth) => {
		while (stack.length > 1 && stack[stack.length - 1] >= depth) {
			parts.push('</ul></li>');
			stack.pop();
		}
	};
	for (const item of items) {
		if (item.kind === 'section') {
			closeTo(item.depth);
			parts.push(`<li class="section"><span class="section-label">${escapeHtml(item.label)}</span><ul>`);
			stack.push(item.depth);
		} else {
			const heading = core.articleHeadingText(item.label);
			parts.push(`<li><a href="${item.id}.html">${escapeHtml(heading)}</a></li>`);
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

function pageShell(title, body) {
	return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
${body}
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
.toc ul { list-style: none; margin: 0.2rem 0; padding-left: 1rem; }
.toc > ul { padding-left: 0; }
	.toc .section-label { display: block; margin-top: 0.85rem; font-weight: 600; color: var(--ink); }
.toc a { text-decoration: none; }
.toc a:hover { text-decoration: underline; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); }
@media print {
	header, .pager, footer { display: none; }
	body { background: #fff; }
	.wrap { max-width: none; }
}
`;

function publishCommands(siteDir, project) {
	const source = path.resolve(siteDir).replace(/\\/g, '/').replace(/\/?$/, '/');
	const dest = `pgs.sh:/${project}/`;
	return {
		source,
		dest,
		rsync: `rsync -rtv --delete "${source}" ${dest}`,
		scp: `scp -r "${source}." ${dest}`,
		url: `https://<username>-${project}.pgs.sh`,
	};
}

function rsyncAvailable() {
	const result = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
	return !result.error && result.status === 0;
}

function publish(siteDir, project) {
	const commands = publishCommands(siteDir, project);
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
	const indexBody = `<header><span class="brand">Better Justel</span><p class="doc-title">${escapeHtml(title)}</p></header>
<main class="wrap index">
<h1 class="prose">${escapeHtml(title)}</h1>
<p class="meta">${articles.length} articles · <a href="${escapeHtml(sourceUrl)}">Source FisconetPlus</a></p>
${download}
${intro ? `<div class="prose intro">${intro}</div>` : ''}
<nav class="toc" aria-label="Table des matières">
${renderToc(analysis.root.items)}
</nav>
${footer(sourceUrl, rootInfo.retrieved)}
</main>`;
	await writeFile(path.join(siteDir, 'index.html'), pageShell(title, indexBody));

	const missing = [];
	let historyLeaks = 0;
	for (let index = 0; index < articles.length; index++) {
		const article = articles[index];
		const heading = core.articleHeadingText(article.label);
		const raw = bodies.get(article.guid);
		let prose;
		if (!raw) {
			missing.push(heading);
			prose = '<p><em>(texte indisponible : fichier brut absent, relancez just fisconet)</em></p>';
		} else {
			const prepared = core.rewriteLinks(core.prepareArticle(raw, article.label, article.id), idByGuid);
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
<a href="index.html">Table des matières</a>
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
		await writeFile(path.join(siteDir, `${article.id}.html`), pageShell(`${heading} — ${title}`, body));
	}

	const notFound = pageShell(`Introuvable — ${title}`, `<main class="wrap"><h1>Page introuvable</h1><p><a href="index.html">Retour à la table des matières</a></p></main>`);
	await writeFile(path.join(siteDir, '404.html'), notFound);

	const project = projectName(dir, options.project);
	const commands = publishCommands(siteDir, project);
	console.error(`Wrote ${siteDir}`);
	console.error(`  ${articles.length} articles, ${analysis.root.mode} layout${missing.length ? `, ${missing.length} missing` : ''}`);
	if (historyLeaks) {
		console.error(`  warning: ${historyLeaks} page(s) still mention "Historique des modifications"`);
	}
	console.error('');
	console.error(`pico+ pages project: ${project}`);
	console.error(`Live URL (replace <username> with your pico name): ${commands.url}`);
	console.error('Upload with your pico SSH key:');
	console.error(`  ${commands.rsync}`);
	console.error('Without rsync (does not delete removed files):');
	console.error(`  ${commands.scp}`);

	if (options.publish) {
		publish(siteDir, project);
		console.error(`Uploaded. Open ${commands.url} once you know your pico username.`);
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
