import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TOPICS, loadSearchIndex, type Topic } from '../lib/content';
import { getSection } from '../lib/sections';
import { IconSearch, IconArrowRight, SectionIcon } from './Icons';

interface Hit {
  topic: Topic;
  score: number;
  snippet?: string;
}

function score(topic: Topic, q: string, fullText: string): Hit | null {
  const title = topic.title.toLowerCase();
  const desc = topic.description.toLowerCase();
  const tags = topic.tags.join(' ').toLowerCase();
  const sec = topic.sectionTitle.toLowerCase();
  const headings = topic.headings.map((h) => h.text).join(' · ').toLowerCase();

  let s = 0;
  if (title === q) s += 1000;
  else if (title.startsWith(q)) s += 500;
  else if (title.includes(q)) s += 300;

  if (desc.includes(q)) s += 90;
  if (tags.includes(q)) s += 70;
  if (headings.includes(q)) s += 60;
  if (sec.includes(q)) s += 40;

  // Fuzzy: every query word must appear somewhere in the metadata.
  const words = q.split(/\s+/).filter(Boolean);
  if (s === 0 && words.length) {
    const hay = `${title} ${desc} ${tags} ${sec} ${headings}`;
    if (words.every((w) => hay.includes(w))) s += 120;
  }

  let snippet: string | undefined;
  if (s === 0 && fullText) {
    const idx = fullText.indexOf(q);
    if (idx >= 0) {
      s += 25;
      const start = Math.max(0, idx - 40);
      snippet = (start > 0 ? '…' : '') + fullText.slice(start, idx + q.length + 90).trim() + '…';
    }
  } else if (s > 0 && headings.includes(q) && !title.includes(q)) {
    const match = topic.headings.find((h) => h.text.toLowerCase().includes(q));
    if (match) snippet = `§ ${match.text}`;
  }

  return s > 0 ? { topic, score: s, snippet } : null;
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [index, setIndex] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 30);
      loadSearchIndex().then(setIndex);
    }
  }, [open]);

  const results = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return TOPICS.slice(0, 8).map((topic) => ({ topic, score: 0 }));
    }
    return TOPICS.map((t) => score(t, q, index[t.id] ?? ''))
      .filter((h): h is Hit => h !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }, [query, index]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector('.palette-item.selected');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const go = (t: Topic) => {
    navigate(t.path);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[cursor]) go(results[cursor].topic);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const q = query.trim().toLowerCase();

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="dialog" aria-modal="true" aria-label="Search topics">
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <IconSearch size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search topics, concepts, interview questions…"
            aria-label="Search"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" ref={listRef}>
          {results.length === 0 ? (
            <div className="palette-empty">No topics match “{query}”.</div>
          ) : (
            <>
              <div className="palette-group">{q ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'Start here'}</div>
              {results.map((hit, i) => {
                const sec = getSection(hit.topic.section);
                return (
                  <button
                    key={hit.topic.id}
                    className={`palette-item${i === cursor ? ' selected' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(hit.topic)}
                    type="button"
                  >
                    <SectionIcon name={sec.icon} size={17} />
                    <span className="pi-body">
                      <span className="pi-title">
                        <Highlight text={hit.topic.title} q={q} />
                      </span>
                      <span className="pi-sub">
                        {sec.short} · {hit.snippet ?? hit.topic.description}
                      </span>
                    </span>
                    {i === cursor && <IconArrowRight size={15} />}
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
