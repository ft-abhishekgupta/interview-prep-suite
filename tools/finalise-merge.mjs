#!/usr/bin/env node
/**
 * Finalises the merge of the hand-written notes into the curriculum:
 *   1. deletes the now-empty `NN-my-notes` groups whose content has been folded in
 *   2. strips the `origin: personal` marker so every page reads as one voice
 *   3. removes dangling links to files that only existed in the old notes tree
 *
 * Run `node tools/renumber.mjs` afterwards to tidy the NN- prefixes.
 * Usage: node tools/finalise-merge.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(__dirname, '..', 'src', 'content');
const DRY = process.argv.includes('--dry');

let removedGroups = 0;
let removedFiles = 0;
let cleanedFrontmatter = 0;
let cleanedLinks = 0;

// 1. Drop the my-notes groups — their content now lives in the curriculum pages.
for (const section of fs.readdirSync(CONTENT)) {
  const sectionDir = path.join(CONTENT, section);
  if (!fs.statSync(sectionDir).isDirectory()) continue;
  for (const entry of fs.readdirSync(sectionDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/my-notes$/.test(entry.name)) continue;
    const dir = path.join(sectionDir, entry.name);
    const count = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
    console.log(`  removing ${section}/${entry.name} (${count} merged file${count === 1 ? '' : 's'})`);
    removedFiles += count;
    removedGroups += 1;
    if (!DRY) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Normalise the remaining pages.
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

for (const file of walk(CONTENT)) {
  const original = fs.readFileSync(file, 'utf8');
  let text = original;

  // The pages are no longer split into "curriculum" and "mine".
  if (/^origin:\s*personal\s*$/m.test(text)) {
    text = text.replace(/^origin:\s*personal\s*\r?\n/m, '');
    cleanedFrontmatter += 1;
  }
  // The `my-notes` tag described the old grouping.
  text = text.replace(/^(tags:\s*\[)my-notes,\s*/m, '$1').replace(/^(tags:\s*\[[^\]]*?),\s*my-notes(\s*\])/m, '$1$2');

  // Links to .md files from the old notes tree cannot resolve on the site.
  const before = text;
  text = text.replace(/\[([^\]]+)\]\((?!https?:|#|notes\/)[^)]*?\.md\)/g, '$1');
  if (text !== before) cleanedLinks += 1;

  if (text !== original && !DRY) fs.writeFileSync(file, text, 'utf8');
}

console.log(`\n${DRY ? '[dry run] ' : ''}Removed ${removedGroups} my-notes group(s) holding ${removedFiles} merged file(s).`);
console.log(`Cleared the personal marker on ${cleanedFrontmatter} page(s) and fixed dead links on ${cleanedLinks} page(s).`);
console.log('Now run: node tools/renumber.mjs\n');
