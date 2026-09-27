import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getTopic, loadMarkdown, neighbours, splitQuestions, stripFrontmatter, type Topic } from '../lib/content';
import { getSection } from '../lib/sections';
import { useBookmarks, useCompleted, useLastVisited, useNote } from '../lib/progress';
import { copyText, downloadText } from '../lib/utils';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';
import {
  IconBookmark,
  IconBookmarkFilled,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconDownload,
  IconHelp,
  IconNote,
  IconPrint,
  SectionIcon,
} from '../components/Icons';
function useScrollSpy(ids: string[]) {
  const [active, setActive] = useState('');
  useEffect(() => {
    if (ids.length === 0) return;
    const onScroll = () => {
      const top = window.scrollY + 140;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.offsetTop <= top) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 60) {
        current = ids[ids.length - 1];
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [ids.join('|')]);
  return active;
}

function ReadingBar() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      setPct(h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);
  return <div className="read-bar" style={{ width: `${pct}%` }} />;
}

function QuestionList({ questions }: { questions: { question: string; answer: string; index: number }[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const allOpen = open.size === questions.length;

  const toggleAll = () => {
    setOpen(allOpen ? new Set() : new Set(questions.map((q) => q.index)));
  };

  return (
    <section className="qa-block" id="interview-questions">
      <div className="qa-head">
        <h2>
          <IconHelp size={21} />
          Top Interview Questions
          <span className="chip chip-accent">{questions.length}</span>
        </h2>
        <button className="btn" onClick={toggleAll} type="button">
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <div className="qa-list">
        {questions.map((qa) => {
          const isOpen = open.has(qa.index);
          return (
            <div className={`qa-item${isOpen ? ' open' : ''}`} key={qa.index}>
              <button
                className="qa-q"
                type="button"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpen((s) => {
                    const next = new Set(s);
                    if (next.has(qa.index)) next.delete(qa.index);
                    else next.add(qa.index);
                    return next;
                  })
                }
              >
                <span className="qa-num">{qa.index}</span>
                <span className="qa-q-text">{qa.question}</span>
                <IconChevronDown size={16} className="qa-caret" />
              </button>
              {isOpen && (
                <div className="qa-a">
                  <Markdown compact>{qa.answer}</Markdown>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NotesBox({ topicId }: { topicId: string }) {
  const { note, setNote } = useNote(topicId);
  const [value, setValue] = useState(note);
  const timer = useRef<number>();

  useEffect(() => setValue(note), [topicId]);

  const onChange = (v: string) => {
    setValue(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(v), 400);
  };

  return (
    <div className="note-box">
      <div className="note-box-head">
        <IconNote size={15} />
        My notes
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-faint)', fontWeight: 400 }}>
          Saved locally in this browser
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Jot down your own framing, a story from your experience, or the parts you keep forgetting…"
      />
    </div>
  );
}

export function TopicPage() {
  const { section = '', slug = '' } = useParams();
  const topic = getTopic(section, slug);
  const toast = useToast();
  const { isDone, toggle, markDone } = useCompleted();
  const { isBookmarked, toggle: toggleMark } = useBookmarks();
  const { setLast } = useLastVisited();

  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRaw(null);
    setError(false);
    if (!topic) return;
    let cancelled = false;
    loadMarkdown(topic)
      .then((md) => !cancelled && setRaw(md))
      .catch(() => !cancelled && setError(true));
    window.scrollTo({ top: 0 });
    setLast({ id: topic.id, title: topic.title, at: Date.now() });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic?.id]);

  const parsed = useMemo(() => {
    if (!raw) return null;
    const body = stripFrontmatter(raw);
    return splitQuestions(body);
  }, [raw]);

  const tocIds = useMemo(() => {
    const ids = topic?.headings.filter((h) => h.depth <= 3).map((h) => h.id) ?? [];
    return parsed?.questions.length ? [...ids, 'interview-questions'] : ids;
  }, [topic?.id, parsed?.questions.length]);

  const activeHeading = useScrollSpy(tocIds);

  if (!topic) {
    return (
      <div className="wrap">
        <div className="empty">
          <h3>Topic not found</h3>
          <p>
            That page does not exist yet. <Link to="/">Back to the dashboard</Link>.
          </p>
        </div>
      </div>
    );
  }

  const sec = getSection(topic.section);
  const { prev, next } = neighbours(topic);
  const done = isDone(topic.id);
  const marked = isBookmarked(topic.id);

  const filename = `${topic.section}-${topic.slug}.md`;

  const onCopy = async () => {
    if (!raw) return;
    const ok = await copyText(stripFrontmatter(raw));
    toast(ok ? 'Markdown copied to clipboard' : 'Copy failed — try the download button');
  };

  const onDownload = () => {
    if (!raw) return;
    const header = `# ${topic.title}\n\n> ${topic.description}\n> Section: ${sec.title} · Source: Senior Interview Prep\n\n---\n\n`;
    const body = stripFrontmatter(raw);
    downloadText(filename, body.startsWith('# ') ? body : header + body);
    toast(`Downloaded ${filename}`);
  };

  const visibleHeadings = topic.headings.filter((h) => h.depth <= 3);

  return (
    <>
      <ReadingBar />
      <div className="topic-layout page">
        <article className="topic-main">
          <header className="topic-head">
            <div className="breadcrumb">
              <Link to="/">Home</Link>
              <IconChevronRight size={12} />
              <Link to={`/section/${sec.id}`}>{sec.title}</Link>
              {topic.groupTitle && (
                <>
                  <IconChevronRight size={12} />
                  <span>{topic.groupTitle}</span>
                </>
              )}
              <IconChevronRight size={12} />
              <span>{topic.title}</span>
            </div>
            <h1 className="topic-title">{topic.title}</h1>
            {topic.description && <p className="topic-desc">{topic.description}</p>}
            <div className="topic-meta">
              <span className="chip" style={{ ['--sec-hue' as string]: sec.hue }}>
                <SectionIcon name={sec.icon} size={12} />
                {sec.short}
              </span>
              <span className="chip">
                <IconClock size={12} />
                {topic.minutes} min read
              </span>
              {topic.difficulty && <span className="chip">{topic.difficulty}</span>}
              {topic.questionCount > 0 && (
                <span className="chip">
                  <IconHelp size={12} />
                  {topic.questionCount} questions
                </span>
              )}
              {topic.tags.slice(0, 4).map((tag) => (
                <span className="chip" key={tag}>
                  #{tag}
                </span>
              ))}
            </div>

            <div className="topic-toolbar">
              <button className={`btn${done ? ' is-active' : ''}`} onClick={() => toggle(topic.id)} type="button">
                {done ? <IconCheckCircle size={15} /> : <IconCheck size={15} />}
                {done ? 'Completed' : 'Mark complete'}
              </button>
              <button className={`btn${marked ? ' is-active' : ''}`} onClick={() => toggleMark(topic.id)} type="button">
                {marked ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
                {marked ? 'Saved' : 'Save'}
              </button>
              <button className="btn" onClick={onCopy} disabled={!raw} type="button">
                <IconCopy size={15} /> Copy markdown
              </button>
              <button className="btn" onClick={onDownload} disabled={!raw} type="button">
                <IconDownload size={15} /> Download .md
              </button>
              <button className="btn btn-ghost" onClick={() => window.print()} type="button" title="Print / save as PDF">
                <IconPrint size={15} /> Print
              </button>
            </div>
          </header>

          {error && (
            <div className="empty">
              <h3>Could not load this topic</h3>
              <p>The markdown file failed to load. Try refreshing the page.</p>
            </div>
          )}

          {!raw && !error && (
            <div className="loader">
              <span className="spinner" /> Loading topic…
            </div>
          )}

          {parsed && (
            <>
              <Markdown>{parsed.article}</Markdown>
              {parsed.questions.length > 0 && <QuestionList questions={parsed.questions} />}
              <NotesBox topicId={topic.id} />

              {!done && (
                <div style={{ marginTop: 26, display: 'flex', justifyContent: 'center' }}>
                  <button className="btn btn-primary" style={{ padding: '10px 20px' }} onClick={() => markDone(topic.id)} type="button">
                    <IconCheckCircle size={16} /> Mark this topic complete
                  </button>
                </div>
              )}

              <nav className="pager" aria-label="Topic navigation">
                {prev ? (
                  <Link className="pager-card prev" to={prev.path}>
                    <span className="pager-label">
                      <IconChevronLeft size={11} /> Previous
                    </span>
                    <span className="pager-title">{prev.title}</span>
                    <span className="faint" style={{ fontSize: '0.74rem' }}>
                      {prev.sectionTitle}
                    </span>
                  </Link>
                ) : (
                  <span />
                )}
                {next && (
                  <Link className="pager-card next" to={next.path}>
                    <span className="pager-label">
                      Next <IconChevronRight size={11} />
                    </span>
                    <span className="pager-title">{next.title}</span>
                    <span className="faint" style={{ fontSize: '0.74rem' }}>
                      {next.sectionTitle}
                    </span>
                  </Link>
                )}
              </nav>
            </>
          )}
        </article>

        <aside className="toc" aria-label="On this page">
          {visibleHeadings.length > 0 && (
            <>
              <div className="toc-title">On this page</div>
              <ul className="toc-list">
                {visibleHeadings.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`} className={`depth-${h.depth}${activeHeading === h.id ? ' active' : ''}`}>
                      {h.text}
                    </a>
                  </li>
                ))}
                {parsed && parsed.questions.length > 0 && (
                  <li>
                    <a href="#interview-questions" className={`depth-2${activeHeading === 'interview-questions' ? ' active' : ''}`}>
                      Top Interview Questions
                    </a>
                  </li>
                )}
              </ul>
            </>
          )}
          <div className="toc-actions">
            <button className="btn" onClick={onCopy} disabled={!raw} type="button">
              <IconCopy size={14} /> Copy as markdown
            </button>
            <button className="btn" onClick={onDownload} disabled={!raw} type="button">
              <IconDownload size={14} /> Download .md
            </button>
            <Link className="btn" to={`/section/${sec.id}`}>
              <SectionIcon name={sec.icon} size={14} /> All {sec.short} topics
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}
