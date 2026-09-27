#!/usr/bin/env node
/**
 * Converts the hand-written Xbox Services Guide (a small static HTML site) into
 * markdown pages so it lives alongside the rest of the curriculum.
 *
 * Usage: node tools/import-xbox-guide.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = 'D:\\AiGeneratedNotes\\Content\\xbox-services-guide';
const DEST = path.join(ROOT, 'src', 'content', 'xbox-systems');
const DRY = process.argv.includes('--dry');

// The converted pages have since been rewritten by hand, so a plain re-run would
// overwrite that work with the raw machine conversion.
if (!process.argv.includes('--force') && !DRY) {
  console.error(
    '\nThis was a one-time conversion. The pages it produces have since been rewritten\n' +
      'in place, so re-running would discard that work.\n\n' +
      'Use --dry to preview, or --force if you really mean to re-convert.\n',
  );
  process.exit(1);
}

/** [file, groupFolder, order, title] */
const PAGES = [
  ['index.html', '01-orientation', 1, 'Guide Overview'],
  ['architecture.html', '01-orientation', 2, 'How It All Fits Together'],
  ['concepts.html', '01-orientation', 3, 'Concepts A to Z'],
  ['interview.html', '01-orientation', 4, 'Project and Behavioural Q and A'],
  ['systems/xevents-xguide.html', '02-systems-and-tools', 1, 'XEvents and XGuide'],
  ['systems/xevents-newsfeed.html', '02-systems-and-tools', 2, 'News Feed System'],
  ['systems/certextensibility.html', '02-systems-and-tools', 3, 'CertExtensibility'],
  ['systems/xservicesinsights.html', '02-systems-and-tools', 4, 'XServicesInsights'],
  ['systems/nexus-hub.html', '02-systems-and-tools', 5, 'Nexus Hub'],
  ['systems/xsale-web.html', '02-systems-and-tools', 6, 'XSale Web'],
  ['systems/xgem-productconfiguration.html', '02-systems-and-tools', 7, 'XGeM and Product Configuration'],
  ['systems/xsale-selfserve.html', '02-systems-and-tools', 8, 'XSale Self Serve'],
];

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NAV', 'ASIDE', 'BUTTON', 'SVG', 'NOSCRIPT', 'INPUT', 'SELECT']);
const SKIP_CLASSES = ['sidebar', 'topbar', 'scrim', 'crumb', 'nav-link', 'nav-group-title', 'brand', 'toc', 'filter'];

const pad = (n) => String(n).padStart(2, '0');
const slugify = (t) => t.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function clean(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function shouldSkip(el) {
  if (SKIP_TAGS.has(el.tagName)) return true;
  const cls = (el.getAttribute?.('class') || '').toLowerCase();
  return SKIP_CLASSES.some((c) => cls.split(/\s+/).includes(c));
}

/** Inline markdown for a node's children. */
function inline(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += child.textContent.replace(/\s+/g, ' ');
      continue;
    }
    if (child.nodeType !== 1 || shouldSkip(child)) continue;
    const t = child.tagName;
    if (t === 'BR') out += '\n';
    else if (t === 'B' || t === 'STRONG') out += `**${clean(inline(child))}**`;
    else if (t === 'I' || t === 'EM') out += `*${clean(inline(child))}*`;
    else if (t === 'CODE') out += `\`${clean(child.textContent)}\``;
    else if (t === 'A') {
      const text = clean(inline(child));
      const href = child.getAttribute('href') || '';
      // Internal links point at other HTML files that no longer exist here.
      out += /^https?:/i.test(href) ? `[${text}](${href})` : text;
    } else out += inline(child);
  }
  return out;
}

function tableToMarkdown(table) {
  const rows = [...table.querySelectorAll('tr')];
  if (rows.length === 0) return '';
  const cellsOf = (tr) => [...tr.children].map((td) => clean(inline(td)).replace(/\|/g, '\\|') || ' ');
  const head = cellsOf(rows[0]);
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const tr of rows.slice(1)) {
    const cells = cellsOf(tr);
    while (cells.length < head.length) cells.push(' ');
    lines.push(`| ${cells.slice(0, head.length).join(' | ')} |`);
  }
  return lines.join('\n');
}

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'PRE',
  'BLOCKQUOTE', 'HR', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER',
  'FIGURE', 'DL', 'DT', 'DD', 'FORM', 'DETAILS',
]);

/** True when an element contains no block-level descendants of its own. */
function isInlineOnly(el) {
  for (const child of el.children) {
    if (shouldSkip(child)) continue;
    if (BLOCK_TAGS.has(child.tagName)) return false;
    if (!isInlineOnly(child)) return false;
  }
  return true;
}

function block(node, out, depth = 0) {
  // A row of short sibling chips reads better as one line than as many paragraphs.
  const kids = [...node.childNodes].filter((c) => c.nodeType === 1 && !shouldSkip(c));
  const chipRow =
    kids.length >= 2 &&
    kids.every((c) => BLOCK_TAGS.has(c.tagName) && c.tagName !== 'LI' && isInlineOnly(c) && clean(c.textContent).length <= 44) &&
    [...node.childNodes].every((c) => c.nodeType !== 3 || !clean(c.textContent));
  if (chipRow) {
    const parts = kids.map((c) => clean(inline(c))).filter(Boolean);
    if (parts.length) out.push(parts.join(' · '), '');
    return;
  }

  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = clean(child.textContent);
      if (text) out.push(text, '');
      continue;
    }
    if (child.nodeType !== 1 || shouldSkip(child)) continue;
    const t = child.tagName;
    const cls = child.getAttribute('class') || '';

    if (t === 'H1') {
      // Page title comes from frontmatter.
      continue;
    }
    if (/^H[2-6]$/.test(t)) {
      const level = Math.min(3, Number(t[1]));
      const text = clean(inline(child));
      if (text) out.push(`${'#'.repeat(level)} ${text}`, '');
      continue;
    }
    if (t === 'PRE') {
      const code = child.textContent.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
      if (!code.trim()) continue;
      const lang = cls.includes('mermaid') ? 'mermaid' : '';
      out.push('```' + lang, code, '```', '');
      continue;
    }
    if (t === 'TABLE') {
      const md = tableToMarkdown(child);
      if (md) out.push(md, '');
      continue;
    }
    if (t === 'UL' || t === 'OL') {
      const ordered = t === 'OL';
      let i = 1;
      for (const li of [...child.children].filter((c) => c.tagName === 'LI')) {
        const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
        nested.forEach((n) => n.remove());
        const text = clean(inline(li));
        if (text) out.push(`${'  '.repeat(depth)}${ordered ? `${i++}.` : '-'} ${text}`);
        for (const n of nested) block({ childNodes: [n] }, out, depth + 1);
      }
      out.push('');
      continue;
    }
    if (t === 'DL') {
      for (const c of child.children) {
        const text = clean(inline(c));
        if (!text) continue;
        out.push(c.tagName === 'DT' ? `**${text}**` : text, '');
      }
      continue;
    }
    if (t === 'BLOCKQUOTE') {
      const text = clean(inline(child));
      if (text) out.push(`> ${text}`, '');
      continue;
    }
    if (t === 'P') {
      const text = inline(child).replace(/[ \t]+\n/g, '\n').trim();
      if (text) out.push(text, '');
      continue;
    }
    if (t === 'IMG') continue;
    if (t === 'HR') {
      out.push('---', '');
      continue;
    }
    // A container with no block children is really just a paragraph.
    if (isInlineOnly(child)) {
      const text = clean(inline(child));
      if (text) out.push(text, '');
      continue;
    }
    block(child, out, depth);
  }
}

function describe(md, title) {
  for (const line of md.split('\n')) {
    const text = line.trim();
    if (!text || /^[#>|`-]/.test(text)) continue;
    let d = text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/:/g, ' -')
      .replace(/["']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (d.length < 25 || d.split(/\s+/).length < 9) continue;
    if (d.length > 165) {
      // Prefer a sentence boundary, but only when it leaves a useful summary.
      const stop = d.slice(0, 165).lastIndexOf('. ');
      const sentence = stop > 50 ? d.slice(0, stop) : '';
      d = sentence.split(/\s+/).length >= 12 ? sentence : d.slice(0, 165).replace(/\s\S*$/, '');
    } else {
      const stop = d.indexOf('. ');
      const sentence = stop > 50 ? d.slice(0, stop) : '';
      if (sentence.split(/\s+/).length >= 12) d = sentence;
    }
    return d.replace(/[.,;\s—-]+$/, '');
  }
  return `My own field guide notes on ${title} from the systems I built and operated`;
}

let written = 0;
const problems = [];

for (const [file, group, order, title] of PAGES) {
  const srcFile = path.join(SRC, file.replace(/\//g, path.sep));
  if (!fs.existsSync(srcFile)) {
    problems.push(`missing: ${file}`);
    continue;
  }
  const { document } = parseHTML(fs.readFileSync(srcFile, 'utf8'));
  const main = document.querySelector('main.content') || document.querySelector('main') || document.body;

  const out = [];
  block(main, out);

  let md = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .trimEnd();

  if (md.length < 200) {
    problems.push(`converted content too short: ${file}`);
    continue;
  }

  const frontmatter = [
    '---',
    `title: ${title}`,
    `description: ${describe(md, title)}`,
    'difficulty: Core',
    'origin: personal',
    'tags: [my-notes, xbox, systems]',
    '---',
    '',
  ].join('\n');

  const destDir = path.join(DEST, group);
  if (!DRY) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, `${pad(order)}-${slugify(title)}.md`), frontmatter + md + '\n', 'utf8');
  }
  written += 1;
}

console.log(`\n${DRY ? '[dry run] ' : ''}Converted ${written} Xbox guide page(s).`);
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('');
