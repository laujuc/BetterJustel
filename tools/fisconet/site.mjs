#!/usr/bin/env node
// Build a minimalist static site from a folder produced by `just fisconet`.
//
//   node tools/fisconet/site.mjs <downloaded-dir> [--publish]
//
// Writes <dir>/site/index.html, one HTML page per article, site.css, a
// standalone toc.html, and a copy of the Markdown file when it exists. Article
// links become art-<id>.html (pico+ pages also serves that URL without the
// extension). The sidebar is inlined HTML and CSS: pgs sends
// X-Frame-Options: DENY, so an iframe of toc.html is refused. No script.
// Pages use the pico.sh stylesheets (absolute URLs) plus a small site.css.
//
// pico+ pages (pgs.sh) is a static-file host, not a Markdown CMS, so the
// readable site is HTML. Every code is uploaded into the same project, as a
// subdirectory, so one site holds all of them:
//
//   https://ljuc-laws.pgs.sh/cir92/
//   mounted at ~/pgs.sh/laws/cir92/   (sshfs of pgs.sh:/laws, project "laws")
//
// ljuc-laws.pgs.sh is the public hostname of user ljuc + project laws. It is
// not a folder named ljuc-laws (that name would be a different project, at
// https://ljuc-ljuc-laws.pgs.sh). --delete applies only to that code's
// subdirectory. The welcome index is written on its own, never with --delete
// on /laws/, or it would wipe the codes.
//
// Requires Node.js 18+. No npm dependencies. Works the same on Windows
// (PowerShell) and Unix: it is a Node script, not a shell script.

import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const core = createRequire(import.meta.url)('../../scripts/lib/fisconet-core.js');

const PICO_USER = 'ljuc';
const PICO_PROJECT = 'laws';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PICO_CSS = 'https://pico.sh/smol.css?v=6618';
const PICO_MAIN = 'https://pico.sh/main.css?v=6618';

const USAGE = `Usage:
  site.mjs <downloaded-dir> [--publish] [--project laws] [--user ljuc] [--mount DIR]
  site.mjs --index [--publish] [--project laws] [--mount DIR]

  <downloaded-dir>   A folder created by \`just fisconet\` (contains raw/ and usually a .md file)
  --project NAME     pico+ project (default: laws). Each code is a subdirectory.
  --user NAME        pico username used in the public URL (default: ljuc)
  --mount DIR        Home-folder mount of pgs.sh:/ (default: ~/pgs.sh)
  --publish          Copy site/ into the mount at <mount>/<project>/<folder>/ when that
                     directory exists; otherwise rsync to pgs.sh:/<project>/<folder>/
  --index            Write the welcome page (index.html) for the project root.
                     Never deletes code folders.

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
		else if (arg === '--index') options.index = true;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--project') options.project = argv[++i];
		else if (arg === '--user') options.user = argv[++i];
		else if (arg === '--mount') options.mount = argv[++i];
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

function displayTitle(title) {
	return String(title || '')
		.replace(/\s*-\s*Table des matières\s*$/i, '')
		.replace(/^Table des matières\s*-\s*/i, '')
		.trim();
}

function headNav(codes, currentSlug) {
	const home = currentSlug ? '' : ' aria-current="page"';
	const links = [`<a class="link-alt"${home} href="/">Accueil</a>`];
	for (const code of codes) {
		const current = code.slug === currentSlug ? ' aria-current="page"' : '';
		links.push(`<a class="link-alt"${current} href="/${escapeHtml(code.slug)}/">${escapeHtml(code.title)}</a>`);
	}
	return `<nav class="mk-nav flex flex-wrap items-center gap mono" aria-label="Codes">\n${links.join('\n')}\n</nav>`;
}

// tocHtml is the inlined list. null omits the sidebar (welcome page, full outline).
function pageShell({ title, body, tocHtml = null, codes = [], currentSlug = '', homeLabel = '' }) {
	const sidebar = tocHtml == null ? '' : `<aside class="toc-pane">
<div class="sidebar-header"><a class="link-alt" href="index.html">${escapeHtml(homeLabel || title)}</a></div>
<nav class="toc" aria-label="Table des matières">
${tocHtml}
</nav>
</aside>`;
	const group = sidebar
		? `<div class="post-group">\n${sidebar}\n<article class="post">\n${body}\n</article>\n</div>`
		: `<main class="container">\n${body}\n</main>`;
	return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${PICO_CSS}">
<link rel="stylesheet" href="${PICO_MAIN}">
<link rel="stylesheet" href="site.css">
</head>
<body>
${headNav(codes, currentSlug)}
${group}
</body>
</html>
`;
}

function welcomePage(codes) {
	const cards = codes.map((code) => `<a class="sitemap-card link-alt" href="/${escapeHtml(code.slug)}/">
<div class="sidebar-header">${escapeHtml(code.slug)}</div>
<div>${escapeHtml(code.title)}</div>
</a>`).join('\n');
	const body = `<h1>Codes</h1>
<p>Textes en vigueur, repris de <a href="https://www.minfin.fgov.be/myminfin-web/pages/public/fisconet">FisconetPlus</a> (SPF Finances). Ce n'est pas une publication officielle.</p>
<div class="sitemap-grid">
${cards || '<p>Aucun code publié.</p>'}
</div>`;
	return pageShell({ title: 'Codes', body, codes });
}

function footer(sourceUrl, retrieved) {
	const when = retrieved ? ` Récupéré le ${escapeHtml(retrieved)}.` : '';
	return `<footer><p>Texte en vigueur, sans l'historique des modifications. Repris de <a href="${escapeHtml(sourceUrl)}">FisconetPlus</a> (SPF Finances).${when} Ce n'est pas une publication officielle.</p></footer>`;
}

const SITE_CSS = `/* Small overrides on top of https://pico.sh/styles. pico hides .toc-pane below 800px. */
.mk-nav a[aria-current="page"] { color: var(--green); }
.toc li::before { content: none; }
.toc details { border: 0; padding: 0; margin: 0; }
.toc summary { font-weight: bold; }
.toc a[aria-current="page"] { color: var(--green); font-weight: bold; }
nav.pager { display: flex; justify-content: space-between; gap: 1rem; width: 100%; min-width: 0; }
.post-group { align-items: flex-start; }
.toc-pane { position: sticky; top: 0; max-height: 100vh; overflow: auto; }
@media (max-width: 800px) {
  .toc-pane { display: block; width: 100%; }
  .toc { height: auto; max-height: 16rem; }
  .post { height: auto; overflow: visible; border: 0; padding: 0; }
}
@media print {
  .mk-nav, .toc-pane, .pager, footer { display: none; }
  .post { height: auto; overflow: visible; border: 0; }
}
`;

function slashPath(value) {
	return path.resolve(value).replace(/\\/g, '/').replace(/\/?$/, '/');
}

function publishCommands(siteDir, target) {
	const source = slashPath(siteDir);
	// pgs.sh:/<project>/<code>/ is the SSH destination. The public host is
	// https://<user>-<project>.pgs.sh/<code>/. The home-folder mount of that
	// project is ~/pgs.sh/<project>/<code>/, not ~/pgs.sh/ljuc-laws.
	const dest = `pgs.sh:/${target.project}/${target.code}/`;
	return {
		source,
		dest,
		rsync: `rsync -rtv --delete "${source}" ${dest}`,
		scp: `scp -r "${source}." ${dest}`,
		url: `https://${target.user}-${target.project}.pgs.sh/${target.code}/`,
		home: `https://${target.user}-${target.project}.pgs.sh/`,
	};
}

function mountRoot(options) {
	return options.mount ? path.resolve(options.mount) : path.join(os.homedir(), 'pgs.sh');
}

async function mountProjectDir(options) {
	const project = options.project || PICO_PROJECT;
	const dir = path.join(mountRoot(options), project);
	try {
		if ((await stat(dir)).isDirectory()) return dir;
	} catch {
		// mount absent (typical on Windows); SSH rsync remains the fallback
	}
	return null;
}

function rsyncAvailable() {
	const result = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
	return !result.error && result.status === 0;
}

function rsyncDelete(source, dest) {
	const from = slashPath(source);
	const to = slashPath(dest);
	// pico rejects names that start with ".", so rsync must not create a
	// hidden temp file on the mount. --inplace writes the destination directly.
	const result = spawnSync('rsync', ['-rt', '--delete', '--inplace', from, to], { stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`rsync failed (${from} -> ${to})`);
	}
}

async function syncDirectory(source, dest) {
	await mkdir(dest, { recursive: true });
	const sourceNames = new Set(await readdir(source));
	let destNames = [];
	try {
		destNames = await readdir(dest);
	} catch {
		destNames = [];
	}
	for (const name of destNames) {
		if (!sourceNames.has(name)) await rm(path.join(dest, name), { recursive: true, force: true });
	}
	for (const name of sourceNames) {
		const from = path.join(source, name);
		const to = path.join(dest, name);
		if ((await stat(from)).isDirectory()) await syncDirectory(from, to);
		else await copyFile(from, to);
	}
}

async function publish(siteDir, target, options) {
	const commands = publishCommands(siteDir, target);
	const mounted = await mountProjectDir(options);
	const mountDest = mounted ? path.join(mounted, target.code) : null;
	// Upload over SSH to pgs.sh:/<project>/<code>/. That is the same folder as
	// ~/pgs.sh/<project>/<code>/ when pgs.sh:/ is mounted at home. Writing
	// through the sshfs mount is not used: pico rejects rsync's hidden temp
	// files, and an in-place copy of a whole code stalls.
	if (rsyncAvailable()) {
		console.error(`Uploading to ${commands.dest} ...`);
		if (mountDest) console.error(`Mounted view of that folder: ${mountDest}`);
		const result = spawnSync('rsync', ['-rt', '--delete', commands.source, commands.dest], { stdio: 'inherit' });
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error('rsync failed. Check that your pico SSH key can log in to pgs.sh.');
		}
		return true;
	}
	if (mountDest) {
		console.error(`rsync is not installed. Copying in place to ${mountDest} ...`);
		await syncDirectory(siteDir, mountDest);
		return true;
	}
	console.error('rsync is not installed and the pico mount was not found. Upload with scp (it does not delete removed files):');
	console.error(`  ${commands.scp}`);
	return false;
}

function decodeEntities(text) {
	return String(text)
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

async function titleFromIndex(indexPath) {
	try {
		const html = await readFile(indexPath, 'utf8');
		const match = html.match(/<title>([^<]*)<\/title>/i);
		if (!match) return null;
		return displayTitle(decodeEntities(match[1]).replace(/\s*—\s.*$/, '').replace(/\s+-\s+Table des matières\s*$/i, ''));
	} catch {
		return null;
	}
}

async function scanDownloads(root) {
	const found = [];
	let names;
	try {
		names = await readdir(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of names) {
		if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_index') continue;
		const dir = path.join(root, entry.name);
		try {
			const info = await findRoot(dir);
			found.push({
				slug: picoSlug(core.slugify(entry.name) || 'code', 'code name'),
				title: displayTitle(info.title || entry.name),
			});
		} catch {
			// not a downloaded code
		}
	}
	return found;
}

async function scanMountCodes(projectDir) {
	const found = [];
	if (!projectDir) return found;
	let names;
	try {
		names = await readdir(projectDir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of names) {
		if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
		const slug = picoSlug(entry.name, 'code name');
		const title = await titleFromIndex(path.join(projectDir, entry.name, 'index.html'));
		if (!title) continue;
		found.push({ slug, title: displayTitle(title) });
	}
	return found;
}

async function collectCodes(options, current) {
	const bySlug = new Map();
	const add = (entry) => {
		if (!entry?.slug) return;
		const prev = bySlug.get(entry.slug);
		bySlug.set(entry.slug, {
			slug: entry.slug,
			title: prev?.title || entry.title || entry.slug,
		});
	};
	for (const entry of await scanDownloads(path.join(REPO_ROOT, 'fisconet'))) add(entry);
	for (const entry of await scanMountCodes(await mountProjectDir(options))) add(entry);
	if (current) add(current);
	return [...bySlug.values()].sort((a, b) => a.title.localeCompare(b.title, 'fr'));
}

async function buildWelcome(options) {
	const codes = await collectCodes(options);
	const html = welcomePage(codes);
	const localDir = path.join(REPO_ROOT, 'fisconet', '_index');
	await mkdir(localDir, { recursive: true });
	await writeFile(path.join(localDir, 'index.html'), html);
	await writeFile(path.join(localDir, 'site.css'), SITE_CSS);
	const mounted = await mountProjectDir(options);
	const user = picoSlug(options.user || PICO_USER, 'username');
	const project = picoSlug(options.project || PICO_PROJECT, 'project');
	const home = `https://${user}-${project}.pgs.sh/`;
	if (mounted) {
		await writeFile(path.join(mounted, 'index.html'), html);
		await writeFile(path.join(mounted, 'site.css'), SITE_CSS);
		console.error(`Wrote welcome page to ${mounted}/index.html`);
		console.error(`Open ${home}`);
		console.error('Only index.html and site.css were written. Code folders were not deleted.');
		return;
	}
	console.error(`Wrote ${localDir}`);
	console.error('Mount not found. Upload these two files only (do not rsync --delete pgs.sh:/laws/):');
	console.error(`  scp "${path.join(localDir, 'index.html')}" pgs.sh:/${options.project || PICO_PROJECT}/index.html`);
	console.error(`  scp "${path.join(localDir, 'site.css')}" pgs.sh:/${options.project || PICO_PROJECT}/site.css`);
	console.error(`Public URL: ${home}`);
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
	const title = displayTitle(rootInfo.title || core.codeTitle(
		JSON.parse(await readFile(path.join(rawDir, `${rootInfo.guid}.json`), 'utf8')).title,
	));
	const target = publishTarget(dir, options);
	const codes = await collectCodes(options, { slug: target.code, title });
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
	await writeFile(path.join(siteDir, 'site.css'), SITE_CSS);

	let markdownName = null;
	if (rootInfo.markdown) {
		markdownName = rootInfo.markdown;
		await copyFile(path.join(dir, rootInfo.markdown), path.join(siteDir, rootInfo.markdown));
	}

	const intro = analysis.root.intro
		? retarget(core.sanitizeHtml(core.rewriteLinks(analysis.root.intro, idByGuid)), null, idSet, idByGuid)
		: '';
	const download = markdownName
		? `<p><a class="btn-link" href="${escapeHtml(markdownName)}">Télécharger le Markdown</a></p>`
		: '';
	const indexBody = `<h1>${escapeHtml(title)}</h1>
<p class="text-sm">${articles.length} articles · <a href="${escapeHtml(sourceUrl)}">Source FisconetPlus</a></p>
${download}
${intro ? `<div class="md">${intro}</div>` : ''}
<p class="text-sm"><a href="toc.html">Table des matières complète</a></p>
${footer(sourceUrl, rootInfo.retrieved)}`;
	const items = analysis.root.items;
	const shell = (pageTitle, body, tocHtml = null) => pageShell({
		title: pageTitle,
		body,
		tocHtml,
		codes,
		currentSlug: target.code,
		homeLabel: title,
	});
	await writeFile(path.join(siteDir, 'toc.html'), shell(
		`Table des matières — ${title}`,
		`<h1>Table des matières</h1>\n<nav class="toc" aria-label="Table des matières">\n${renderToc(items, null, true)}\n</nav>`,
	));
	await writeFile(path.join(siteDir, 'index.html'), shell(title, indexBody, renderToc(items)));

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
		const body = `${crumbs.length ? `<p class="text-sm">${crumbs.map(escapeHtml).join(' · ')}</p>` : ''}
${pager}
<div class="md">
<h1 id="${article.id}">${escapeHtml(heading)}</h1>
${prose}
</div>
${pager}
${footer(sourceUrl, rootInfo.retrieved)}`;
		await writeFile(
			path.join(siteDir, `${article.id}.html`),
			shell(`${heading} — ${title}`, body, renderToc(items, article.id)),
		);
	}

	const notFound = shell(
		`Introuvable — ${title}`,
		`<h1>Page introuvable</h1><p><a href="index.html">Retour au code</a> · <a href="toc.html">Table des matières</a></p>`,
		renderToc(items),
	);
	await writeFile(path.join(siteDir, '404.html'), notFound);

	const commands = publishCommands(siteDir, target);
	const mounted = await mountProjectDir(options);
	console.error(`Wrote ${siteDir}`);
	console.error(`  ${articles.length} articles, ${analysis.root.mode} layout, ${followedCount} with commentary text${missing.length ? `, ${missing.length} missing` : ''}`);
	if (historyLeaks) {
		console.error(`  warning: ${historyLeaks} page(s) still mention "Historique des modifications"`);
	}
	console.error('');
	console.error(`pico+ pages: ${commands.url}`);
	console.error(`SSH destination (this code only): ${commands.dest}`);
	console.error(`  ${commands.rsync}`);
	if (mounted) {
		console.error(`Same folder on the home mount: ${path.join(mounted, target.code)}`);
	}

	if (options.publish) {
		await publish(siteDir, target, options);
		console.error(`Uploaded. Open ${commands.url}`);
	}
	if (missing.length) process.exitCode = 1;
}

async function main() {
	const { positional, options } = parseArguments(process.argv.slice(2));
	if (options.help || (!options.index && positional.length !== 1)) {
		console.error(USAGE);
		process.exit(options.help ? 0 : 1);
	}
	if (options.index) {
		await buildWelcome(options);
		return;
	}
	await build(path.resolve(positional[0]), options);
}

main().catch((error) => {
	console.error(`Error: ${error.message}`);
	process.exit(1);
});
