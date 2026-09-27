import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:content-manifest';
const RESOLVED_ID = '\0' + VIRTUAL_ID;
const SEARCH_ID = 'virtual:content-search';
const RESOLVED_SEARCH_ID = '\0' + SEARCH_ID;

export interface ManifestEntry {
  id: string;
  file: string;
  section: string;
  group: string;
  groupTitle: string;
  groupOrder: number;
  slug: string;
  order: number;
  title: string;
  description: string;
  difficulty: string;
  tags: string[];
  words: number;
  minutes: number;
  headings: { depth: number; text: string; id: string }[];
  questionCount: number;
  origin: string;
  search: string;
}

/** Tokens that keep conventional casing when a group title is generated. */
const ACRONYMS: Record<string, string> = {
  dsa: 'DSA', dp: 'DP', api: 'API', apis: 'APIs', sql: 'SQL', nosql: 'NoSQL',
  http: 'HTTP', os: 'OS', cs: 'CS', ci: 'CI', cd: 'CD', aws: 'AWS',
  llm: 'LLM', llms: 'LLMs', rag: 'RAG', mcp: 'MCP', ai: 'AI', oop: 'OOP',
  ood: 'OOD', lld: 'LLD', hld: 'HLD', solid: 'SOLID', uml: 'UML', jwt: 'JWT',
  oauth: 'OAuth', tls: 'TLS', dns: 'DNS', tcp: 'TCP', ip: 'IP', rest: 'REST',
  grpc: 'gRPC', aks: 'AKS', iac: 'IaC', slo: 'SLO', slos: 'SLOs', cqrs: 'CQRS',
  acid: 'ACID', cap: 'CAP', clr: 'CLR', jit: 'JIT', gc: 'GC', linq: 'LINQ',
  dotnet: '.NET', csharp: 'C#', js: 'JavaScript', ts: 'TypeScript', cicd: 'CI/CD',
  ux: 'UX', ui: 'UI', io: 'IO', db: 'DB', crud: 'CRUD', ddd: 'DDD',
};

/** Joining words that stay lowercase unless they start the title. */
const MINOR = new Set(['and', 'or', 'the', 'of', 'for', 'in', 'to', 'a', 'an', 'on', 'with', 'vs']);

export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      if (i > 0 && MINOR.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Minimal YAML-subset frontmatter parser (scalars + inline arrays). */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized };
  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');
  const data: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    value = value.replace(/^["']|["']$/g, '');
    data[key] = value;
  }
  return { data, body };
}

/** Strip fenced code, inline code and markdown syntax for search indexing. */
function toSearchText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitOrder(name: string): { order: number; slug: string } {
  const m = name.match(/^(\d+)[-_](.+)$/);
  return m ? { order: parseInt(m[1], 10), slug: m[2] } : { order: 999, slug: name };
}

function buildEntry(contentRoot: string, file: string): ManifestEntry | null {
  const rel = path.relative(contentRoot, file).replace(/\\/g, '/');
  const parts = rel.split('/');
  if (parts.length < 2 || parts.length > 3) return null;

  const section = parts[0];
  const { order, slug } = splitOrder(parts[parts.length - 1].replace(/\.md$/, ''));

  let group = '';
  let groupTitle = '';
  let groupOrder = 0;
  if (parts.length === 3) {
    const g = splitOrder(parts[1]);
    group = g.slug;
    groupOrder = g.order;
    groupTitle = titleFromSlug(g.slug);
  }

  const raw = fs.readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(raw);

  const headings: ManifestEntry['headings'] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (!h) continue;
    const text = h[2].replace(/\s*#+\s*$/, '').trim();
    let id = slugify(text);
    if (seen.has(id)) {
      const n = (seen.get(id) as number) + 1;
      seen.set(id, n);
      id = `${id}-${n}`;
    } else {
      seen.set(id, 0);
    }
    headings.push({ depth: h[1].length, text, id });
  }

  const searchText = toSearchText(body);
  const words = searchText ? searchText.split(' ').length : 0;
  const questionCount = (body.match(/^###\s+Q\d+/gim) || []).length;

  return {
    id: `${section}/${slug}`,
    file: rel,
    section,
    group,
    groupTitle: String(data.group ?? groupTitle),
    groupOrder,
    slug,
    order,
    title: String(data.title ?? titleFromSlug(slug)),
    description: String(data.description ?? ''),
    difficulty: String(data.difficulty ?? 'Core'),
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    words,
    minutes: Math.max(1, Math.round(words / 220)),
    headings,
    questionCount,
    origin: String(data.origin ?? 'curriculum'),
    search: searchText.slice(0, 1600).toLowerCase(),
  };
}

function walkMarkdown(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 2) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full, depth + 1));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function contentManifest(contentDir: string): Plugin {
  let root = '';
  const load = (): ManifestEntry[] => {
    const contentRoot = path.resolve(root, contentDir);
    if (!fs.existsSync(contentRoot)) return [];
    const entries: ManifestEntry[] = [];
    for (const file of walkMarkdown(contentRoot)) {
      try {
        const entry = buildEntry(contentRoot, file);
        if (entry) entries.push(entry);
      } catch {
        /* ignore unreadable file */
      }
    }
    entries.sort((a, b) => {
      if (a.section !== b.section) return a.section.localeCompare(b.section);
      if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
      return a.order - b.order;
    });
    return entries;
  };

  return {
    name: 'content-manifest',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (id === SEARCH_ID) return RESOLVED_SEARCH_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_ID) {
        // The full-text blob lives in a separate, lazily loaded module so the
        // initial bundle only carries navigation metadata.
        const nav = load().map(({ search, ...rest }) => rest);
        return `export const manifest = ${JSON.stringify(nav)};\nexport default manifest;`;
      }
      if (id === RESOLVED_SEARCH_ID) {
        const index = Object.fromEntries(load().map((e) => [e.id, e.search]));
        return `export const searchIndex = ${JSON.stringify(index)};\nexport default searchIndex;`;
      }
      return null;
    },
    configureServer(server) {
      const contentRoot = path.resolve(server.config.root, contentDir);
      server.watcher.add(contentRoot);
      const invalidate = (file: string) => {
        if (!file.endsWith('.md') || !file.startsWith(contentRoot)) return;
        let changed = false;
        for (const modId of [RESOLVED_ID, RESOLVED_SEARCH_ID]) {
          const mod = server.moduleGraph.getModuleById(modId);
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            changed = true;
          }
        }
        if (changed) server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', invalidate);
      server.watcher.on('unlink', invalidate);
      server.watcher.on('change', invalidate);
    },
  };
}
