#!/usr/bin/env node
/**
 * Loads the built site in real Chrome and reports what actually rendered
 * on a topic page: mermaid SVGs, fallback code blocks, and console errors.
 *
 * Usage: node tools/smoke.mjs [url] [...topicHashes]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(__dirname, '..', 'src', 'content');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('No Chrome or Edge found.');
  process.exit(2);
}

/** Every topic route, derived from the content folder. */
function allRoutes() {
  const out = [];
  for (const section of fs.readdirSync(CONTENT)) {
    const dir = path.join(CONTENT, section);
    if (!fs.statSync(dir).isDirectory()) continue;
    const visit = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith('.md')) {
          const slug = entry.name.replace(/\.md$/, '').replace(/^\d+[-_]/, '');
          out.push({ route: `#/topic/${section}/${slug}`, section });
        }
      }
    };
    visit(dir);
  }
  return out;
}

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http')) || 'http://localhost:4173';
const mode = args.includes('--all') ? 'all' : args.includes('--sample') ? 'sample' : 'explicit';
const explicit = args.filter((a) => a.startsWith('#/'));

let targets;
if (mode === 'all') {
  targets = allRoutes();
} else if (mode === 'sample') {
  // One page per section plus every page that has 3+ diagrams.
  const seen = new Set();
  targets = allRoutes().filter((t) => {
    if (seen.has(t.section)) return false;
    seen.add(t.section);
    return true;
  });
} else if (explicit.length) {
  targets = explicit.map((route) => ({ route, section: '' }));
} else {
  targets = allRoutes().slice(0, 3);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const problems = [];
let checked = 0;
let diagramsOk = 0;
let diagramsTotal = 0;

for (const { route } of targets) {
  // A fresh page per route: hash-only navigation would not reset module state,
  // which would let one page's failure mask or cause another's.
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));

  await page.goto(`${base}/${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction(
      () => {
        const blocks = document.querySelectorAll('.mermaid-block');
        const loading = document.querySelectorAll('.mermaid-block.loading');
        return document.querySelector('.topic-title') && loading.length === 0 && (blocks.length === 0 || document.querySelector('.mermaid-canvas svg'));
      },
      { timeout: 25000 },
    );
  } catch {
    /* fall through to the assertions below */
  }

  const stats = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.mermaid-block')];
    return {
      title: document.querySelector('.topic-title')?.textContent ?? '',
      personal: [...document.querySelectorAll('.topic-meta .chip')].some((c) => c.textContent.trim() === 'My notes'),
      blocks: blocks.length,
      rendered: blocks.filter((b) => b.querySelector('.mermaid-canvas svg')).length,
      loading: document.querySelectorAll('.mermaid-block.loading').length,
      fallbacks: [...document.querySelectorAll('.code-lang')].filter((e) => e.textContent === 'Diagram source').length,
      rawMermaid: [...document.querySelectorAll('.code-lang')].filter((e) => (e.textContent || '').toLowerCase() === 'mermaid').length,
      tables: document.querySelectorAll('.table-wrap').length,
      questions: document.querySelectorAll('.qa-item').length,
      brokenImages: [...document.querySelectorAll('.prose img')].filter((i) => !i.complete || i.naturalWidth === 0).length,
      prose: (document.querySelector('.prose')?.textContent ?? '').length,
    };
  });

  checked += 1;
  diagramsOk += stats.rendered;
  diagramsTotal += stats.blocks + stats.fallbacks;

  const issues = [];
  if (!stats.title) issues.push('page did not render');
  if (stats.prose < (stats.personal ? 50 : 500)) issues.push(`prose too short (${stats.prose})`);
  if (stats.rendered !== stats.blocks) issues.push(`${stats.blocks - stats.rendered}/${stats.blocks} diagrams blank`);
  if (stats.loading) issues.push(`${stats.loading} stuck loading`);
  if (stats.fallbacks) issues.push(`${stats.fallbacks} diagram(s) fell back to source`);
  if (stats.rawMermaid) issues.push(`${stats.rawMermaid} mermaid block(s) rendered as plain code`);
  if (stats.brokenImages) issues.push(`${stats.brokenImages} image(s) failed to load`);
  // Imported personal notes are kept as written, so they have no question block.
  if (!stats.personal && stats.questions === 0) issues.push('no questions rendered');
  if (errors.length) issues.push(`console: ${errors[0]}`);

  if (issues.length) {
    problems.push({ route, issues });
    console.log(`FAIL  ${route}\n        ${issues.join('\n        ')}`);
  } else if (mode !== 'all') {
    console.log(`OK    ${route}  (${stats.rendered} diagrams, ${stats.tables} tables, ${stats.questions} questions)`);
  }
  await page.close();
}

await browser.close();

console.log(`\nChecked ${checked} page(s) at ${base}`);
console.log(`Diagrams rendered: ${diagramsOk}/${diagramsTotal}`);
console.log(problems.length ? `${problems.length} page(s) with problems.\n` : 'All pages rendered cleanly.\n');
process.exit(problems.length ? 1 : 0);

