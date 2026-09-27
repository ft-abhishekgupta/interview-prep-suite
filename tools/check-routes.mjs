#!/usr/bin/env node
/** Checks the non-topic routes and the copy/download affordances on a topic page. */
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
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 180)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text().slice(0, 180));
  });
  await page.goto(`${base}/${route}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  const result = await page.evaluate(assertions);
  const fails = Object.entries(result).filter(([, v]) => v === false || v === 0).map(([k]) => k);
  if (errors.length) fails.push('console: ' + errors[0]);
  if (fails.length) problems.push(`${name}: ${fails.join(', ')}`);
  console.log(`${fails.length ? 'FAIL' : 'OK  '}  ${name.padEnd(22)} ${JSON.stringify(result)}`);
  await page.close();
}

await check('home', '#/', () => ({
  hero: !!document.querySelector('.hero h1'),
  sectionCards: document.querySelectorAll('.sec-card').length,
  stats: document.querySelectorAll('.stat').length,
}));

await check('section page', '#/section/azure', () => ({
  title: !!document.querySelector('.sec-hero h1'),
  rows: document.querySelectorAll('.topic-row').length,
}));

await check('roadmap', '#/roadmap', () => ({
  items: document.querySelectorAll('.rm-item').length,
}));

await check('practice picker', '#/practice', () => ({
  cards: document.querySelectorAll('.sec-card').length,
}));

await check('revise picker', '#/revise', () => ({
  cards: document.querySelectorAll('.sec-card').length,
}));

await check('progress', '#/progress', () => ({
  panels: document.querySelectorAll('.panel').length,
  bars: document.querySelectorAll('.bar-row').length,
}));

await check('topic toolbar', '#/topic/messaging/dead-letter-queues', () => {
  const labels = [...document.querySelectorAll('.topic-toolbar .btn')].map((b) => b.textContent.trim());
  return {
    copyMarkdown: labels.some((l) => /copy markdown/i.test(l)),
    downloadMd: labels.some((l) => /download \.md/i.test(l)),
    markComplete: labels.some((l) => /mark complete/i.test(l)),
    save: labels.some((l) => /save/i.test(l)),
    print: labels.some((l) => /print/i.test(l)),
    tocLinks: document.querySelectorAll('.toc-list a').length,
    codeCopyButtons: document.querySelectorAll('.code-copy').length,
    notesBox: !!document.querySelector('.note-box textarea'),
    pager: document.querySelectorAll('.pager-card').length,
  };
});

// Revise view actually extracts cheat sheets.
await check('revise content', '#/revise?s=messaging', () => ({
  panels: document.querySelectorAll('.panel').length,
  bullets: document.querySelectorAll('.panel .prose li').length,
}));

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n  ` + problems.join('\n  ') + '\n' : '\nAll routes healthy.\n');
process.exit(problems.length ? 1 : 0);
