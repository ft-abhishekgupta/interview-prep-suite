#!/usr/bin/env node
/**
 * Validates every content markdown file against the authoring spec.
 * Usage:  node tools/validate-content.mjs [--fix]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'src', 'content');
const FIX = process.argv.includes('--fix');
const MERMAID_RESERVED = new Set(['end', 'graph', 'subgraph', 'class', 'click', 'style', 'linkStyle', 'default']);

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function parseFrontmatter(raw) {
  const norm = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!norm.startsWith('---')) return { data: null, body: norm };
  const end = norm.indexOf('\n---', 3);
  if (end === -1) return { data: null, body: norm };
  const block = norm.slice(4, end);
  const body = norm.slice(end + 4).replace(/^\n/, '');
  const data = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { data, body };
}

const stripFences = (body) => body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, ' ');

function extractMermaid(body) {
  const blocks = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(body)) !== null) blocks.push(m[1]);
  return blocks;
}

function checkMermaid(code, issues) {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    issues.push(['error', 'empty mermaid block']);
    return;
  }
  const header = lines[0];
  const known = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|block-beta|xychart-beta)\b/;
  if (!known.test(header)) {
    issues.push(['error', `mermaid header not recognised: "${header.slice(0, 40)}"`]);
  }

  if (/^(flowchart|graph)\b/.test(header)) {
    for (const line of lines.slice(1)) {
      if (/^(subgraph|end|style|classDef|class |click|linkStyle|direction)\b/.test(line)) continue;
      const labels = line.match(/\[[^\]]*\]/g) || [];
      for (const label of labels) {
        const inner = label.slice(1, -1);
        if (!inner) continue;
        if (/^["([/\\|]/.test(inner)) continue;
        if (/[(),:;{}<>|]/.test(inner)) {
          issues.push(['warn', `mermaid label may break: ${label.slice(0, 46)}`]);
        }
      }
      const idMatch = line.match(/^([A-Za-z_][\w-]*)\s*[[({]/);
      if (idMatch && MERMAID_RESERVED.has(idMatch[1])) {
        issues.push(['error', `mermaid reserved word as node id: ${idMatch[1]}`]);
      }
    }
  }
}

const results = [];
let fixedCount = 0;
const all = walk(CONTENT);
const PUBLIC_DIR = path.join(ROOT, 'public');

for (const file of all) {
  const rel = path.relative(CONTENT, file).replace(/\\/g, '/');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // A file can vanish mid-scan while content is being regenerated.
    continue;
  }
  const issues = [];
  const { data, body } = parseFrontmatter(raw);

  // Hand-written personal notes are imported as they were written, so the
  // curriculum page structure does not apply to them.
  const personal = data?.origin === 'personal';

  if (!data) {
    issues.push(['error', 'missing frontmatter']);
  } else {
    for (const key of ['title', 'description', 'difficulty', 'tags']) {
      if (!data[key]) issues.push(['error', `frontmatter missing "${key}"`]);
    }
    if (data.title && data.title.length > 48) issues.push(['warn', `title too long (${data.title.length} chars)`]);
    if (data.description) {
      const words = data.description.split(/\s+/).length;
      if (words < 8) issues.push(['warn', `description too short (${words} words)`]);
      if (words > 45) issues.push(['warn', `description too long (${words} words)`]);
    }
    if (data.tags && !/^\[.*\]$/.test(data.tags)) issues.push(['warn', 'tags not an inline array']);
    if (data.difficulty && !['Foundational', 'Core', 'Advanced'].includes(data.difficulty)) {
      issues.push(['warn', `unexpected difficulty "${data.difficulty}"`]);
    }
  }

  const noFences = stripFences(body);

  const h1 = noFences.split('\n').filter((l) => /^#\s+\S/.test(l));
  if (h1.length) {
    if (FIX) {
      raw = raw.replace(/^#\s+(.*)$/gm, '## $1');
      fixedCount++;
      issues.push(['fixed', `${h1.length} level-1 heading(s) demoted`]);
    } else {
      issues.push(['error', `${h1.length} level-1 heading(s): ${h1[0].slice(0, 40)}`]);
    }
  }

  // Image references must resolve to a real asset under public/.
  for (const m of noFences.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = decodeURI(m[1].trim().split(/\s+/)[0]);
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:')) continue;
    if (!fs.existsSync(path.join(PUBLIC_DIR, url))) {
      issues.push(['error', `image not found in public/: ${url.slice(0, 70)}`]);
      break;
    }
  }

  const tableSeps = (noFences.match(/^\s*\|[\s:|-]+\|\s*$/gm) || []).length;
  const diagrams = extractMermaid(body);
  diagrams.forEach((d) => checkMermaid(d, issues));

  if (!personal) {
    if (tableSeps < 2) issues.push(['warn', `only ${tableSeps} table(s)`]);
    if (diagrams.length === 0) issues.push(['warn', 'no mermaid diagram']);
    if (!/^##\s+.*\bcheat\s*sheet\b/im.test(body)) issues.push(['warn', 'no "Cheat sheet" section']);
    if (!/^##\s+.*\bsummary\b/im.test(body)) issues.push(['warn', 'no "Summary" section']);
    if (!/^##\s+.*\bmistakes\b/im.test(body) && !/^##\s+.*\bpitfalls\b/im.test(body)) {
      issues.push(['warn', 'no "Common mistakes" section']);
    }

    const qHeading = body.match(/^##\s+.*interview questions.*$/im);
    if (!qHeading) {
      issues.push(['error', 'no "Top Interview Questions" section']);
    } else {
      const headingAt = qHeading.index ?? body.indexOf(qHeading[0]);
      const after = body.slice(headingAt + qHeading[0].length);
      const qs = after.match(/^###\s+Q\d+\./gm) || [];
      if (qs.length < 8) issues.push(['error', `only ${qs.length} questions (need 8+)`]);
      else if (qs.length > 14) issues.push(['warn', `${qs.length} questions`]);
      const nums = qs.map((s) => parseInt(s.match(/Q(\d+)/)[1], 10));
      const outOfSequence = nums.some((n, i) => n !== i + 1);
      if (outOfSequence) {
        if (FIX) {
          // Operate on `raw` directly so offsets cannot drift from frontmatter handling.
          const at = raw.lastIndexOf(qHeading[0]);
          const head = raw.slice(0, at + qHeading[0].length);
          let n = 0;
          const body2 = raw.slice(at + qHeading[0].length).replace(/^###[ \t]+Q\d+\.[ \t]*/gm, () => `### Q${++n}. `);
          raw = head + body2;
          fixedCount++;
          issues.push(['fixed', `renumbered ${n} questions sequentially`]);
        } else {
          issues.push(['warn', `question numbering out of sequence (${nums.join(',')})`]);
        }
      }
      if (/^##\s+(?!#)/m.test(stripFences(after))) {
        issues.push(['warn', 'a "##" section appears after the questions block']);
      }
    }

    const words = noFences.replace(/[#>|*_`-]/g, ' ').split(/\s+/).filter(Boolean).length;
    if (words < 900) issues.push(['warn', `short page (${words} words)`]);

    if (/<(div|span|table|img|p|b|i)\b[^>]*>/i.test(noFences)) issues.push(['warn', 'raw HTML found']);
  }

  if (FIX && issues.some(([lvl]) => lvl === 'fixed')) fs.writeFileSync(file, raw, 'utf8');

  if (issues.length) results.push({ rel, issues });
}

const errors = results.filter((r) => r.issues.some(([l]) => l === 'error'));
const warns = results.filter((r) => r.issues.every(([l]) => l !== 'error'));

// Routes are /topic/<section>/<slug>, so a repeated slug inside a section is fatal.
const slugs = new Map();
for (const file of all) {
  const rel = path.relative(CONTENT, file).replace(/\\/g, '/');
  const parts = rel.split('/');
  const slug = parts[parts.length - 1].replace(/\.md$/, '').replace(/^\d+[-_]/, '');
  const key = `${parts[0]}/${slug}`;
  if (!slugs.has(key)) slugs.set(key, []);
  slugs.get(key).push(rel);
}
const collisions = [...slugs.entries()].filter(([, files]) => files.length > 1);
for (const [key, files] of collisions) {
  console.log(`\nERROR  duplicate route "${key}"`);
  for (const f of files) console.log(`       ${f}`);
}

console.log(`\nScanned ${all.length} content files.`);
console.log(`  ${errors.length + collisions.length} with errors, ${warns.length} with warnings only.\n`);

for (const r of errors) {
  console.log(`ERROR  ${r.rel}`);
  for (const [lvl, msg] of r.issues) console.log(`       [${lvl}] ${msg}`);
}
if (errors.length && warns.length) console.log('');
for (const r of warns) {
  console.log(`warn   ${r.rel}`);
  for (const [lvl, msg] of r.issues) console.log(`       [${lvl}] ${msg}`);
}

if (FIX) console.log(`\nAuto-fixed ${fixedCount} file(s).`);
console.log('');
process.exit(errors.length + collisions.length ? 1 : 0);
