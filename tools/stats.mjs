#!/usr/bin/env node
/** Prints a summary of the curriculum: pages, groups, questions, diagrams, tables, words. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'src', 'content');
const FENCE = /```[\s\S]*?```/g;

const rows = [];
const tot = { pages: 0, groups: 0, questions: 0, diagrams: 0, tables: 0, words: 0, images: 0 };

function measure(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return {
    questions: (raw.match(/^###[ \t]+Q\d+\./gm) || []).length,
    diagrams: (raw.match(/```mermaid/g) || []).length,
    tables: (raw.match(/^[ \t]*\|[\s:|-]+\|[ \t]*$/gm) || []).length,
    words: raw.replace(FENCE, ' ').split(/\s+/).filter(Boolean).length,
    images: (raw.match(/!\[[^\]]*\]\(notes\//g) || []).length,
  };
}

for (const section of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, section);
  if (!fs.statSync(dir).isDirectory()) continue;
  const s = { section, pages: 0, groups: 0, questions: 0, diagrams: 0, tables: 0, words: 0, images: 0 };

  const add = (file) => {
    const m = measure(file);
    s.pages += 1;
    s.questions += m.questions;
    s.diagrams += m.diagrams;
    s.tables += m.tables;
    s.words += m.words;
    s.images += m.images;
  };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      s.groups += 1;
      for (const f of fs.readdirSync(full)) if (f.endsWith('.md')) add(path.join(full, f));
    } else if (entry.name.endsWith('.md')) {
      add(full);
    }
  }

  if (s.pages === 0) continue;
  rows.push(s);
  for (const k of Object.keys(tot)) tot[k] += s[k];
}

rows.sort((a, b) => b.pages - a.pages);
const pad = (v, n) => String(v).padStart(n);
const padr = (v, n) => String(v).padEnd(n);
const num = (v) => v.toLocaleString('en-GB');

const header = `${padr('Section', 16)}${pad('Groups', 7)}${pad('Pages', 7)}${pad('Questions', 11)}${pad('Diagrams', 10)}${pad('Images', 8)}${pad('Tables', 8)}${pad('Words', 11)}`;
console.log('');
console.log(header);
console.log('-'.repeat(header.length));
for (const r of rows) {
  console.log(
    `${padr(r.section, 16)}${pad(r.groups, 7)}${pad(r.pages, 7)}${pad(r.questions, 11)}${pad(r.diagrams, 10)}${pad(r.images || '-', 8)}${pad(r.tables, 8)}${pad(num(r.words), 11)}`,
  );
}
console.log('-'.repeat(header.length));
console.log(
  `${padr('TOTAL', 16)}${pad(tot.groups, 7)}${pad(tot.pages, 7)}${pad(tot.questions, 11)}${pad(tot.diagrams, 10)}${pad(tot.images, 8)}${pad(tot.tables, 8)}${pad(num(tot.words), 11)}`,
);
console.log('\n"Images" are the hand-drawn diagrams carried over from the original notes.');
console.log(`Estimated reading time: ${(tot.words / 220 / 60).toFixed(1)} hours at 220 wpm.\n`);
