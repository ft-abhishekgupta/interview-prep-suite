#!/usr/bin/env node
/** Checks the group hierarchy renders and that imported note images actually load. */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const base = process.argv[2] || 'http://localhost:4173';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const problems = [];

async function check(name, route, assertions) {
  const page = await browser.newPage();
  const errors = [];
  const badImages = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 180)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text().slice(0, 180));
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) badImages.push(`${r.status()} ${r.url().slice(-70)}`);
  });

  await page.goto(`${base}/${route}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  const result = await page.evaluate(assertions);

  const fails = Object.entries(result)
    .filter(([, v]) => v === false || v === 0)
    .map(([k]) => k);
  if (errors.length) fails.push('console: ' + errors[0]);
  if (badImages.length) fails.push('failed request: ' + badImages[0]);
  if (fails.length) problems.push(`${name}: ${fails.join(', ')}`);
  console.log(`${fails.length ? 'FAIL' : 'OK  '}  ${name.padEnd(26)} ${JSON.stringify(result)}`);
  await page.close();
}

// An originally-authored page that now carries the author's own diagrams.
await check('merged page + diagrams', '#/topic/hld-problems/url-shortener', () => {
  const imgs = [...document.querySelectorAll('.prose img')];
  return {
    title: !!document.querySelector('.topic-title'),
    noMyNotesBadge: ![...document.querySelectorAll('.topic-meta .chip')].some((c) => /my notes/i.test(c.textContent)),
    images: imgs.length,
    imagesLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    questions: document.querySelectorAll('.qa-item').length,
    prose: (document.querySelector('.prose')?.textContent ?? '').length > 2000,
  };
});

await check('merged networking page', '#/topic/fundamentals/networking-tcp-and-ip', () => {
  const imgs = [...document.querySelectorAll('.prose img')];
  return {
    images: imgs.length,
    imagesLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    questions: document.querySelectorAll('.qa-item').length,
    prose: (document.querySelector('.prose')?.textContent ?? '').length > 2000,
  };
});

await check('merged UML page', '#/topic/lld/uml-for-interviews', () => {
  const imgs = [...document.querySelectorAll('.prose img')];
  return {
    images: imgs.length,
    imagesLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    questions: document.querySelectorAll('.qa-item').length,
  };
});

await check('promoted page', '#/topic/dsa/pattern-recognition', () => ({
  title: !!document.querySelector('.topic-title'),
  questions: document.querySelectorAll('.qa-item').length,
  tables: document.querySelectorAll('.table-wrap').length,
  prose: (document.querySelector('.prose')?.textContent ?? '').length > 2000,
}));

await check('xbox guide page', '#/topic/xbox-systems/news-feed-system', () => ({
  title: !!document.querySelector('.topic-title'),
  diagrams: document.querySelectorAll('.mermaid-canvas svg').length,
  questions: document.querySelectorAll('.qa-item').length,
  prose: (document.querySelector('.prose')?.textContent ?? '').length > 1000,
}));

await check('no my-notes groups left', '#/section/dsa', () => {
  const titles = [...document.querySelectorAll('.group-head h2')].map((h) => h.textContent);
  return {
    groupBlocks: titles.length,
    noMyNotesGroup: !titles.some((t) => /my notes/i.test(t)),
    rows: document.querySelectorAll('.topic-row').length,
  };
});

await check('sidebar hierarchy', '#/topic/dsa/binary-search', () => {
  const secBtn = [...document.querySelectorAll('.nav-section-btn')].find((b) => b.textContent.includes('DSA'));
  secBtn?.click();
  return {
    sectionButtons: document.querySelectorAll('.nav-section-btn').length,
    groupButtons: document.querySelectorAll('.nav-group-btn').length,
    activeItem: !!document.querySelector('.nav-item.active'),
    breadcrumbHasGroup: (document.querySelector('.breadcrumb')?.textContent || '').includes('Core Patterns'),
  };
});

await check('home lists all tracks', '#/', () => ({
  cards: document.querySelectorAll('.sec-card').length,
  xbox: !!document.body.textContent.includes('Xbox Systems'),
}));

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n  ` + problems.join('\n  ') + '\n' : '\nMerged hierarchy is healthy.\n');
process.exit(problems.length ? 1 : 0);
