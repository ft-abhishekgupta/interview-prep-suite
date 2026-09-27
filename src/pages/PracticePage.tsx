import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ACTIVE_SECTIONS, TOPICS, TOPICS_BY_SECTION, loadMarkdown, splitQuestions, stripFrontmatter, type Topic } from '../lib/content';
import { getSection } from '../lib/sections';
import { Markdown } from '../components/Markdown';
import { IconArrowRight, IconCards, IconChevronLeft, IconChevronRight, IconShuffle, SectionIcon } from '../components/Icons';

interface Card {
  question: string;
  answer: string;
  topic: Topic;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function PracticePage() {
  const [sectionId, setSectionId] = useState<string>('');
  const [cards, setCards] = useState<Card[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());

  const pool = useMemo(() => (sectionId === 'all' ? TOPICS : TOPICS_BY_SECTION[sectionId] ?? []), [sectionId]);

  useEffect(() => {
    if (!sectionId) return;
    let cancelled = false;
    setLoading(true);
    setCards(null);
    setLoaded(0);
    setIndex(0);
    setRevealed(false);
    setKnown(new Set());

    (async () => {
      const collected: Card[] = [];
      const batchSize = 12;
      for (let i = 0; i < pool.length; i += batchSize) {
        if (cancelled) return;
        const batch = pool.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(async (topic) => {
            try {
              const raw = await loadMarkdown(topic);
              const { questions } = splitQuestions(stripFrontmatter(raw));
              return questions.map((q) => ({ question: q.question, answer: q.answer, topic }));
            } catch {
              return [];
            }
          }),
        );
        results.forEach((r) => collected.push(...r));
        if (!cancelled) setLoaded(Math.min(i + batchSize, pool.length));
      }
      if (!cancelled) {
        setCards(shuffle(collected));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sectionId, pool]);

  useEffect(() => {
    if (!cards) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        setRevealed((r) => !r);
      } else if (e.key === 'ArrowRight') {
        setIndex((i) => Math.min(i + 1, cards.length - 1));
        setRevealed(false);
      } else if (e.key === 'ArrowLeft') {
        setIndex((i) => Math.max(i - 1, 0));
        setRevealed(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards]);

  if (!sectionId) {
    return (
      <div className="page wrap wrap-narrow">
        <div className="block-head">
          <div>
            <h2>
              <IconCards size={22} style={{ verticalAlign: '-3px', marginRight: 8 }} />
              Practice mode
            </h2>
            <p>
              Turn every interview question in a track into a shuffled flashcard drill. Reveal with <kbd>Space</kbd>, move
              with <kbd>←</kbd> <kbd>→</kbd>.
            </p>
          </div>
        </div>
        <div className="card-grid">
          <button
            className="sec-card"
            style={{ ['--sec-hue' as string]: 258, textAlign: 'left', cursor: 'pointer' }}
            onClick={() => setSectionId('all')}
            type="button"
          >
            <div className="sec-card-top">
              <span className="sec-icon">
                <IconShuffle size={20} />
              </span>
              <div>
                <h3>Everything, shuffled</h3>
                <span className="chip chip-accent">Full mock drill</span>
              </div>
            </div>
            <p className="sec-blurb">Every question across all {ACTIVE_SECTIONS.length} tracks in random order. Takes a moment to load.</p>
          </button>
          {ACTIVE_SECTIONS.map((sec) => {
            const topics = TOPICS_BY_SECTION[sec.id] ?? [];
            const qs = topics.reduce((n, t) => n + t.questionCount, 0);
            return (
              <button
                className="sec-card"
                key={sec.id}
                style={{ ['--sec-hue' as string]: sec.hue, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setSectionId(sec.id)}
                type="button"
              >
                <div className="sec-card-top">
                  <span className="sec-icon">
                    <SectionIcon name={sec.icon} size={20} />
                  </span>
                  <div>
                    <h3>{sec.short}</h3>
                    <span className="chip">{qs} questions</span>
                  </div>
                </div>
                <p className="sec-blurb">{sec.blurb}</p>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (loading || !cards) {
    return (
      <div className="page wrap wrap-narrow">
        <div className="loader">
          <span className="spinner" /> Building your deck… {loaded}/{pool.length} topics
        </div>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="page wrap wrap-narrow">
        <div className="empty">
          <h3>No questions in this track yet</h3>
          <p>Pick another track to practise.</p>
          <button className="btn" onClick={() => setSectionId('')} type="button">
            Back to tracks
          </button>
        </div>
      </div>
    );
  }

  const card = cards[index];
  const sec = getSection(card.topic.section);

  return (
    <div className="page wrap wrap-narrow">
      <div className="filter-bar">
        <button className="btn btn-ghost" onClick={() => setSectionId('')} type="button">
          <IconChevronLeft size={15} /> All tracks
        </button>
        <div className="spacer" />
        <span className="chip">
          {index + 1} / {cards.length}
        </span>
        <span className="chip chip-ok">{known.size} known</span>
        <button className="btn" onClick={() => { setCards(shuffle(cards)); setIndex(0); setRevealed(false); }} type="button">
          <IconShuffle size={15} /> Reshuffle
        </button>
      </div>

      <div className="progress-track" style={{ marginBottom: 18 }}>
        <div className="progress-fill" style={{ width: `${((index + 1) / cards.length) * 100}%` }} />
      </div>

      <div className="flash">
        <div className="flash-meta">
          <Link to={card.topic.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SectionIcon name={sec.icon} size={13} /> {sec.short} · {card.topic.title}
          </Link>
          <span>
            <kbd>Space</kbd> reveal · <kbd>←</kbd> <kbd>→</kbd> navigate
          </span>
        </div>

        <div className="flash-q">{card.question}</div>

        {revealed ? (
          <div className="flash-a">
            <Markdown compact>{card.answer}</Markdown>
          </div>
        ) : (
          <div className="flash-hint" onClick={() => setRevealed(true)} role="button" tabIndex={0}>
            Answer it out loud, then press Space to reveal
          </div>
        )}
      </div>

      <div className="flash-controls">
        <button
          className="btn"
          disabled={index === 0}
          onClick={() => {
            setIndex((i) => Math.max(0, i - 1));
            setRevealed(false);
          }}
          type="button"
        >
          <IconChevronLeft size={15} /> Previous
        </button>
        <button
          className="btn"
          onClick={() => {
            setKnown((k) => new Set(k).add(index));
            setIndex((i) => Math.min(cards.length - 1, i + 1));
            setRevealed(false);
          }}
          type="button"
        >
          I knew this
        </button>
        <button
          className="btn btn-primary"
          disabled={index === cards.length - 1}
          onClick={() => {
            setIndex((i) => Math.min(cards.length - 1, i + 1));
            setRevealed(false);
          }}
          type="button"
        >
          Next <IconArrowRight size={15} />
        </button>
        <Link className="btn btn-ghost" to={card.topic.path}>
          Read the topic <IconChevronRight size={14} />
        </Link>
      </div>
    </div>
  );
}
