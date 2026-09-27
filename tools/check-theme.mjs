#!/usr/bin/env node
/** Verifies diagrams re-render (and recolour) when the theme is toggled. */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const base = process.argv[2] || 'http://localhost:4173';
const route = process.argv[3] || '#/topic/hld-problems/url-shortener';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const settled = () =>
  page.waitForFunction(
    () => {
      const blocks = document.querySelectorAll('.mermaid-block').length;
      const svgs = document.querySelectorAll('.mermaid-canvas svg').length;
      const loading = document.querySelectorAll('.mermaid-block.loading').length;
      return blocks > 0 && loading === 0 && svgs === blocks;
    },
    { timeout: 30000 },
  );

await page.goto(`${base}/${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await settled();

const snapshot = () =>
  page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    svgs: document.querySelectorAll('.mermaid-canvas svg').length,
    blocks: document.querySelectorAll('.mermaid-block').length,
    loading: document.querySelectorAll('.mermaid-block.loading').length,
    // Sample a node fill so we can prove the diagram actually recoloured.
    fill: (() => {
      const n = document.querySelector('.mermaid-canvas svg .node rect, .mermaid-canvas svg rect');
      return n ? getComputedStyle(n).fill : '(none)';
    })(),
  }));

const before = await snapshot();

// Toggle the theme through the header button, exactly as a user would.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.header button')].find((b) =>
    (b.getAttribute('aria-label') || '').startsWith('Switch to'),
  );
  btn?.click();
});
await settled();
const after = await snapshot();

console.log('before toggle:', JSON.stringify(before));
console.log('after  toggle:', JSON.stringify(after));

const ok =
  before.svgs === before.blocks &&
  after.svgs === after.blocks &&
  after.blocks > 0 &&
  after.loading === 0 &&
  before.theme !== after.theme &&
  before.fill !== after.fill;

console.log(ok ? '\nOK: diagrams survive and recolour on theme change.\n' : '\nFAIL: diagrams did not re-render correctly on theme change.\n');
if (errors.length) console.log('errors:', errors);
await browser.close();
process.exit(ok ? 0 : 1);
