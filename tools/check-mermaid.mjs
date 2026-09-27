#!/usr/bin/env node
/**
 * Parses every mermaid block in the content with the real mermaid parser so that
 * broken diagrams are caught at build time rather than in the browser.
 * Usage: node tools/check-mermaid.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(__dirname, '..', 'src', 'content');

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator ?? { userAgent: 'node' };
globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGElement = window.SVGElement ?? window.Element;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DOMParser = window.DOMParser;
globalThis.getComputedStyle = window.getComputedStyle ?? (() => ({ getPropertyValue: () => '' }));
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'base' });

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

let total = 0;
const failures = [];

for (const file of walk(CONTENT)) {
  const rel = path.relative(CONTENT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m;
  let n = 0;
  while ((m = re.exec(raw)) !== null) {
    n += 1;
    total += 1;
    const code = m[1].trim();
    try {
      await mermaid.parse(code);
    } catch (err) {
      const msg = String(err?.message ?? err).split('\n').slice(0, 3).join(' ').slice(0, 220);
      failures.push({ rel, n, msg, first: code.split('\n')[0] });
    }
  }
}

console.log(`\nParsed ${total} mermaid diagrams across the content.`);
if (failures.length === 0) {
  console.log('All diagrams are valid.\n');
  process.exit(0);
}

console.log(`${failures.length} diagram(s) failed to parse:\n`);
for (const f of failures) {
  console.log(`  ${f.rel}  [diagram #${f.n}]  (${f.first})`);
  console.log(`     ${f.msg}`);
}
console.log('');
process.exit(1);
