import { manifest, type ManifestEntry } from 'virtual:content-manifest';
import { SECTIONS, getSection } from './sections';

export type Topic = ManifestEntry & {
  path: string;
  sectionTitle: string;
};

const loaders = import.meta.glob('../content/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const sectionOrder = new Map(SECTIONS.map((s, i) => [s.id, i]));

export const TOPICS: Topic[] = manifest
  .map((entry) => ({
    ...entry,
    path: `/topic/${entry.section}/${entry.slug}`,
    sectionTitle: getSection(entry.section).title,
  }))
  .sort((a, b) => {
    const sa = sectionOrder.get(a.section) ?? 999;
    const sb = sectionOrder.get(b.section) ?? 999;
    if (sa !== sb) return sa - sb;
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    return a.order - b.order;
  });

export const TOPIC_MAP: Record<string, Topic> = Object.fromEntries(TOPICS.map((t) => [t.id, t]));

export const TOPICS_BY_SECTION: Record<string, Topic[]> = TOPICS.reduce(
  (acc, topic) => {
    (acc[topic.section] ||= []).push(topic);
    return acc;
  },
  {} as Record<string, Topic[]>,
);

export interface TopicGroup {
  id: string;
  title: string;
  order: number;
  topics: Topic[];
}

const groupCache = new Map<string, TopicGroup[]>();

/** Topics of a section split into their sub-groups, in curriculum order. */
export function groupsOf(sectionId: string): TopicGroup[] {
  const cached = groupCache.get(sectionId);
  if (cached) return cached;

  const topics = TOPICS_BY_SECTION[sectionId] ?? [];
  const groups: TopicGroup[] = [];
  for (const topic of topics) {
    const id = topic.group || '_';
    let g = groups.find((x) => x.id === id);
    if (!g) {
      g = {
        id,
        title: topic.groupTitle || getSection(sectionId).title,
        order: topic.groupOrder,
        topics: [],
      };
      groups.push(g);
    }
    g.topics.push(topic);
  }
  groups.sort((a, b) => a.order - b.order);
  groupCache.set(sectionId, groups);
  return groups;
}

/** True when a section is organised into more than one sub-group. */
export function hasGroups(sectionId: string): boolean {
  const g = groupsOf(sectionId);
  return g.length > 1 || (g.length === 1 && g[0].id !== '_');
}

/** Sections that actually have content, in curriculum order. */
export const ACTIVE_SECTIONS = SECTIONS.filter((s) => (TOPICS_BY_SECTION[s.id]?.length ?? 0) > 0);

export const TOTAL_TOPICS = TOPICS.length;
export const TOTAL_QUESTIONS = TOPICS.reduce((n, t) => n + t.questionCount, 0);
export const TOTAL_MINUTES = TOPICS.reduce((n, t) => n + t.minutes, 0);

export function getTopic(section: string, slug: string): Topic | undefined {
  return TOPIC_MAP[`${section}/${slug}`];
}

export function neighbours(topic: Topic): { prev?: Topic; next?: Topic } {
  const i = TOPICS.findIndex((t) => t.id === topic.id);
  return { prev: TOPICS[i - 1], next: TOPICS[i + 1] };
}

const cache = new Map<string, string>();

let searchIndexPromise: Promise<Record<string, string>> | null = null;

/** Full-text index, fetched on demand so it stays out of the initial bundle. */
export function loadSearchIndex(): Promise<Record<string, string>> {
  if (!searchIndexPromise) {
    searchIndexPromise = import('virtual:content-search')
      .then((m) => m.searchIndex)
      .catch(() => ({}));
  }
  return searchIndexPromise;
}

export async function loadMarkdown(topic: Topic): Promise<string> {
  const cached = cache.get(topic.id);
  if (cached) return cached;
  // `file` is the manifest-recorded path relative to the content root, so this
  // stays correct no matter how deeply the content is nested.
  const key = Object.keys(loaders).find((k) => k.replace(/\\/g, '/').endsWith(`/content/${topic.file}`));
  if (!key) throw new Error(`Markdown not found for ${topic.id} (${topic.file})`);
  const raw = await loaders[key]();
  cache.set(topic.id, raw);
  return raw;
}

/** Removes the YAML frontmatter block so the page renders clean prose. */export function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return normalized;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return normalized;
  return normalized.slice(end + 4).replace(/^\n+/, '');
}

export interface QA {
  question: string;
  answer: string;
  index: number;
}

const QUESTION_HEADING = /^##\s+(?:.*\b)?(?:interview questions|top interview questions|questions asked)\b.*$/im;

/**
 * Splits a topic body into the main article and the trailing interview-question
 * block so the UI can render questions as interactive flashcards.
 */
export function splitQuestions(body: string): { article: string; questions: QA[] } {
  const match = body.match(QUESTION_HEADING);
  if (!match || match.index === undefined) return { article: body, questions: [] };

  const article = body.slice(0, match.index).trimEnd();
  const rest = body.slice(match.index + match[0].length);

  const questions: QA[] = [];
  const lines = rest.split('\n');
  let current: { question: string; buffer: string[] } | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^###\s+(?:\*\*)?(?:Q\s*\d+[.):]?\s*)?(.*?)(?:\*\*)?\s*$/);
    if (h) {
      if (current) questions.push({ question: current.question, answer: current.buffer.join('\n').trim(), index: questions.length + 1 });
      current = { question: h[1].trim(), buffer: [] };
      continue;
    }
    if (current) current.buffer.push(line);
  }
  if (current) questions.push({ question: current.question, answer: current.buffer.join('\n').trim(), index: questions.length + 1 });

  if (questions.length === 0) return { article: body, questions: [] };
  return { article, questions };
}

/**
 * Pulls a single `## Heading` block (up to the next `##`) out of a body.
 * Used to build the revision view from every page's cheat sheet.
 */
export function extractSection(body: string, headingPattern: RegExp): string | null {
  const lines = body.split('\n');
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    if (start === -1) {
      if (/^##\s+/.test(lines[i]) && headingPattern.test(lines[i].replace(/^##\s+/, ''))) start = i + 1;
    } else if (/^##\s+(?!#)/.test(lines[i])) {
      return lines.slice(start, i).join('\n').trim() || null;
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n').trim() || null;
}
