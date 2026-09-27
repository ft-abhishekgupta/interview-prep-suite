#!/usr/bin/env node
/**
 * Normalises the NN- prefixes inside every content group so they run 01..N with no
 * gaps, preserving the current ordering. Use `00-` on a new file to make it sort first.
 *
 * Usage: node tools/renumber.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(__dirname, '..', 'src', 'content');
const DRY = process.argv.includes('--dry');

const pad = (n) => String(n).padStart(2, '0');
let renamed = 0;

function order(name) {
  const m = name.match(/^(\d+)[-_]/);
  return m ? parseInt(m[1], 10) : 999;
}

function normaliseDir(dir, kind) {
  const entries =
    kind === 'file'
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
      : fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  entries.sort((a, b) => order(a) - order(b) || a.localeCompare(b));

  // Two passes via a temporary name so a rename can never clobber a sibling.
  const plan = [];
  entries.forEach((name, i) => {
    const base = name.replace(/^\d+[-_]/, '');
    const next = `${pad(i + 1)}-${base}`;
    if (next !== name) plan.push([name, next]);
  });
  if (plan.length === 0) return;

  if (!DRY) {
    for (const [from] of plan) {
      fs.renameSync(path.join(dir, from), path.join(dir, `__tmp__${from}`));
    }
    for (const [from, to] of plan) {
      fs.renameSync(path.join(dir, `__tmp__${from}`), path.join(dir, to));
    }
  }
  renamed += plan.length;
  for (const [from, to] of plan) console.log(`  ${path.relative(CONTENT, dir).replace(/\\/g, '/')}/${from}  ->  ${to}`);
}

for (const section of fs.readdirSync(CONTENT)) {
  const sectionDir = path.join(CONTENT, section);
  if (!fs.statSync(sectionDir).isDirectory()) continue;

  const groups = fs.readdirSync(sectionDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (groups.length > 0) {
    normaliseDir(sectionDir, 'dir');
    for (const g of fs.readdirSync(sectionDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      normaliseDir(path.join(sectionDir, g.name), 'file');
    }
  } else {
    normaliseDir(sectionDir, 'file');
  }
}

console.log(`\n${DRY ? '[dry run] ' : ''}Renumbered ${renamed} entr${renamed === 1 ? 'y' : 'ies'}.\n`);
