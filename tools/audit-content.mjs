#!/usr/bin/env node
/**
 * Deep content audit — the checks validate-content.mjs does not do.
 *
 * Structural linting is already covered by tools/validate-content.mjs. This looks for
 * problems that only show up when you compare pages against each other, or read inside
 * the prose: duplicated explanations, repeated interview questions, code fences in the
 * wrong language for a track, truncated or placeholder text, malformed tables, and
 * answers too thin to say out loud.
 *
 * Usage: node tools/audit-content.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'src', 'content');
const JSON_OUT = process.argv.includes('--json');

/** Primary code language each track should be written in. */
const TRACK_LANG = {
  java: ['java'],
  'spring-boot': ['java'],
  'csharp-dotnet': ['csharp'],
  backend: ['csharp'],
  dsa: ['java', 'csharp'],
  lld: ['java'],
  'lld-problems': ['java'],
  frontend: ['typescript', 'javascript', 'html', 'css', 'jsx', 'tsx'],
  languages: ['python', 'cpp', 'javascript', 'typescript'],
  databases: ['sql', 'csharp'],
  devops: ['bash', 'yaml', 'dockerfile', 'hcl', 'terraform'],
};

const KNOWN_LANGS = new Set([
  'csharp', 'java', 'sql', 'typescript', 'javascript', 'python', 'cpp', 'c', 'go', 'rust',
  'bash', 'shell', 'powershell', 'yaml', 'json', 'xml', 'html', 'css', 'scss', 'jsx', 'tsx',
  'mermaid', 'text', 'diff', 'ini', 'toml', 'dockerfile', 'hcl', 'terraform', 'kusto',
  'graphql', 'protobuf', 'proto', 'http', 'makefile', 'groovy', 'kotlin', 'plaintext', 'md', 'properties', 'conf',
  'lua', 'redis', 'nginx', 'sh',
]);

// Only genuine authoring markers. Words like "placeholder row" are ordinary prose.
const PLACEHOLDER = /(\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b|lorem ipsum|coming soon|Not Yet Written|\[insert [a-z]+\])/;
const SELF_REF = /\b(as (?:mentioned|discussed|noted|described) (?:above|earlier|previously|below)|see above|see below|in the previous (?:section|page|chapter)|from my notes|originally I wrote|on this (?:website|site)|elsewhere on this)\b/i;
const EXTERNAL_URL = /\bhttps?:\/\/(?!localhost|example\.com|example\.org|127\.0\.0\.1|0\.0\.0\.0)[^\s)"'`]+/;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function parse(raw) {
  const norm = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!norm.startsWith('---')) return { data: {}, body: norm };
  const end = norm.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: norm };
  const data = {};
  for (const line of norm.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { data, body: norm.slice(end + 4).replace(/^\n/, '') };
}

/** Split a body into fenced blocks and prose, preserving order. */
function fences(body) {
  const out = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push({ lang: m[1], code: m[2], at: m.index });
  return out;
}

const stripFences = (b) => b.replace(/```[\s\S]*?```/g, '\n').replace(/`[^`\n]*`/g, ' ');

function normaliseSentence(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function shingles(text, k = 12) {
  const w = normaliseSentence(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}

// ---------------------------------------------------------------- gather
const files = walk(CONTENT);
const pages = files.map((file) => {
  const rel = path.relative(CONTENT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  const { data, body } = parse(raw);
  // Line numbers are reported against the file, not the frontmatter-stripped body.
  const lineOffset = raw.replace(/\r\n/g, '\n').split('\n').length - body.split('\n').length;
  const track = rel.split('/')[0];
  const qIdx = body.search(/^##\s+.*interview questions.*$/im);
  const prose = qIdx === -1 ? body : body.slice(0, qIdx);
  const qBlock = qIdx === -1 ? '' : body.slice(qIdx);
  const questions = [];
  const qre = /^###\s+(Q\d+)\.\s*(.+)$/gm;
  let m;
  const marks = [];
  while ((m = qre.exec(qBlock)) !== null) marks.push({ num: m[1], text: m[2], at: m.index, len: m[0].length });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : qBlock.length;
    questions.push({ num: mk.num, text: mk.text, answer: qBlock.slice(mk.at + mk.len, end).trim() });
  });
  return { file, rel, track, data, body, prose, qBlock, questions, raw, lineOffset };
});

const issues = [];
const add = (sev, rel, msg) => issues.push({ sev, rel, msg });

// ---------------------------------------------------------------- per page
for (const p of pages) {
  const noFences = stripFences(p.prose);

  // frontmatter quality
  const d = p.data.description || '';
  if (d.includes(':')) add('error', p.rel, `description contains a colon: ${d.slice(0, 60)}`);
  if (/["\[\]]/.test(d)) add('error', p.rel, 'description contains a quotation mark or square bracket');
  const dw = d.split(/\s+/).filter(Boolean).length;
  if (dw && (dw < 12 || dw > 34)) add('warn', p.rel, `description is ${dw} words (target 15-30)`);
  const tags = (p.data.tags || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (tags.length < 2 || tags.length > 5) add('warn', p.rel, `${tags.length} tags (want 2-5)`);
  for (const t of tags) if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)) add('warn', p.rel, `tag not lowercase-hyphenated: "${t}"`);
  if ((p.data.title || '').length > 42) add('warn', p.rel, `title long: ${p.data.title}`);

  // prose hygiene
  if (PLACEHOLDER.test(noFences)) add('error', p.rel, `placeholder text: ${noFences.match(PLACEHOLDER)[0]}`);
  const sr = noFences.match(SELF_REF);
  if (sr) add('warn', p.rel, `self-reference / cross-reference: "${sr[0]}"`);
  const url = stripFences(p.body).match(EXTERNAL_URL);
  if (url) add('warn', p.rel, `external URL in prose: ${url[0].slice(0, 60)}`);
  if (/[^\S\n]\n/.test(p.body) === false) { /* noop */ }
  if (/\n#{4,}\s/.test(p.prose)) add('warn', p.rel, 'heading deeper than ### outside the questions block');

  // truncation / dangling
  const tail = p.body.trimEnd().slice(-160);
  if (/[a-z,]$/.test(tail.trim()) && !/[.!?)`|]$/.test(tail.trim())) {
    add('warn', p.rel, `page may end mid-sentence: ...${tail.trim().slice(-60)}`);
  }
  const fenceCount = (p.body.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) add('error', p.rel, `unbalanced code fences (${fenceCount})`);

  // code fences
  for (const f of fences(p.body)) {
    if (!f.lang) { add('error', p.rel, 'code fence without a language'); continue; }
    if (!KNOWN_LANGS.has(f.lang)) add('warn', p.rel, `unusual fence language "${f.lang}"`);
    if (f.code.trim().length < 6) add('warn', p.rel, `near-empty ${f.lang} fence`);
  }
  const langs = fences(p.body).map((f) => f.lang).filter((l) => l && l !== 'mermaid' && l !== 'text');
  const expect = TRACK_LANG[p.track];
  if (expect && langs.length) {
    const off = [...new Set(langs)].filter((l) => !expect.includes(l) && !['bash', 'yaml', 'json', 'xml', 'sql', 'http', 'diff', 'ini', 'shell', 'powershell', 'dockerfile', 'hcl', 'terraform', 'kusto', 'graphql', 'protobuf', 'html', 'css', 'lua', 'properties', 'conf', 'text'].includes(l));
    if (off.length) add('warn', p.rel, `unexpected code language for ${p.track}: ${off.join(', ')}`);
  }

  // tables well-formed: every separator row's column count must match its header
  const lines = p.body.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]) && i > 0) {
      // A cell may legitimately contain an escaped pipe (`\|`), which is not a separator.
      const cols = (s) =>
        s.trim().replace(/\\\|/g, '\u0000').replace(/^\||\|$/g, '').split('|').length;
      const head = cols(lines[i - 1]);
      const sep = cols(lines[i]);
      if (!/^\s*\|/.test(lines[i - 1])) continue;
      if (head !== sep) add('error', p.rel, `table header/separator column mismatch at line ${i + 1 + p.lineOffset} (${head} vs ${sep})`);
      let j = i + 1;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        if (cols(lines[j]) !== head) {
          add('warn', p.rel, `table row has ${cols(lines[j])} cells, header has ${head}, at line ${j + 1 + p.lineOffset}`);
          break;
        }
        j++;
      }
    }
  }

  // questions
  if (p.questions.length) {
    p.questions.forEach((q, i) => {
      const expectNum = `Q${i + 1}`;
      if (q.num !== expectNum) add('error', p.rel, `question numbering: found ${q.num}, expected ${expectNum}`);
      const aw = stripFences(q.answer).split(/\s+/).filter(Boolean).length;
      if (aw < 55) add('warn', p.rel, `${q.num} answer only ${aw} words (target 80-180)`);
      if (aw > 320) add('warn', p.rel, `${q.num} answer ${aw} words (long)`);
      if (!/[.?]$/.test(q.text.trim()) && q.text.trim().length < 15) add('warn', p.rel, `${q.num} question text looks truncated`);
    });
    const texts = p.questions.map((q) => normaliseSentence(q.text));
    const dupe = texts.find((t, i) => texts.indexOf(t) !== i);
    if (dupe) add('error', p.rel, `duplicate question on the same page: ${dupe.slice(0, 60)}`);
  }

  // diagrams
  const mer = fences(p.body).filter((f) => f.lang === 'mermaid');
  if (mer.length === 0) add('warn', p.rel, 'no mermaid diagram');
  for (const f of mer) {
    // Node-label quoting only applies to flowchart/graph syntax. In a sequenceDiagram
    // the brackets appear inside message text, where they are harmless.
    if (!/^\s*(flowchart|graph)\b/.test(f.code.trim())) continue;
    // Mirror validate-content.mjs: a label already opening with a quote, bracket or
    // paren (cylinder/stadium shapes) is fine.
    for (const label of f.code.match(/\[[^\]]*\]/g) || []) {
      const inner = label.slice(1, -1);
      if (!inner || /^["([/\\|]/.test(inner)) continue;
      if (/[(),:;{}<>|]/.test(inner)) add('warn', p.rel, `mermaid label may need quoting: ${label.slice(0, 40)}`);
    }
  }

  const words = noFences.replace(/[#>|*_`-]/g, ' ').split(/\s+/).filter(Boolean).length;
  if (words < 900) add('warn', p.rel, `thin page: ${words} prose words`);
  if (words > 4200) add('warn', p.rel, `very long page: ${words} prose words`);
}

// ------------------------------------------------- cross-page duplication
// duplicate question text across different pages
const qIndex = new Map();
for (const p of pages) {
  for (const q of p.questions) {
    const key = normaliseSentence(q.text);
    if (key.length < 25) continue;
    if (!qIndex.has(key)) qIndex.set(key, []);
    qIndex.get(key).push(`${p.rel} ${q.num}`);
  }
}
const dupQ = [...qIndex.entries()].filter(([, v]) => v.length > 1);
for (const [k, v] of dupQ) {
  add('warn', v[0].split(' ')[0], `question repeated on ${v.length} pages: "${k.slice(0, 55)}" -> ${v.join(', ')}`);
}

// near-duplicate prose between pages (12-word shingles)
const shingleIndex = new Map();
for (const p of pages) {
  p._sh = shingles(stripFences(p.prose));
  for (const s of p._sh) {
    if (!shingleIndex.has(s)) shingleIndex.set(s, []);
    const arr = shingleIndex.get(s);
    if (arr.length < 6) arr.push(p.rel);
  }
}
const pairCount = new Map();
for (const [, arr] of shingleIndex) {
  if (arr.length < 2 || arr.length > 4) continue;
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i] === arr[j]) continue;
      const key = [arr[i], arr[j]].sort().join(' || ');
      pairCount.set(key, (pairCount.get(key) || 0) + 1);
    }
}
const dupPairs = [...pairCount.entries()].filter(([, n]) => n >= 12).sort((a, b) => b[1] - a[1]);
for (const [key, n] of dupPairs.slice(0, 60)) {
  add('warn', key.split(' || ')[0], `${n} shared 12-word phrases with ${key.split(' || ')[1]}`);
}

// ---------------------------------------------------------------- report
const bySev = { error: [], warn: [] };
for (const i of issues) bySev[i.sev].push(i);

if (JSON_OUT) {
  console.log(JSON.stringify({ pages: pages.length, issues }, null, 1));
} else {
  const grouped = new Map();
  for (const i of issues) {
    if (!grouped.has(i.rel)) grouped.set(i.rel, []);
    grouped.get(i.rel).push(i);
  }
  console.log(`\nAudited ${pages.length} pages.`);
  console.log(`  ${bySev.error.length} error(s), ${bySev.warn.length} warning(s), across ${grouped.size} file(s).\n`);
  const counts = new Map();
  for (const i of issues) {
    const kind = i.msg.replace(/[:"].*$/, '').replace(/\d+/g, 'N').trim().slice(0, 58);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  console.log('By kind:');
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  console.log('');
  for (const [rel, list] of grouped) {
    if (!list.some((l) => l.sev === 'error')) continue;
    console.log(`ERROR  ${rel}`);
    for (const l of list) console.log(`       [${l.sev}] ${l.msg}`);
  }
}
process.exit(bySev.error.length ? 1 : 0);


