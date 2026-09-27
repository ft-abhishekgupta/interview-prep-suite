import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TOPICS_BY_SECTION, groupsOf, type Topic } from '../lib/content';
import { getSection } from '../lib/sections';
import { useBookmarks, useCompleted } from '../lib/progress';
import { formatMinutes } from '../lib/utils';
import {
  IconArrowRight,
  IconBookmarkFilled,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconHelp,
  IconLayers,
  SectionIcon,
} from '../components/Icons';

export function SectionPage() {
  const { section = '' } = useParams();
  const sec = getSection(section);
  const topics = TOPICS_BY_SECTION[section] ?? [];
  const { isDone, toggle } = useCompleted();
  const { isBookmarked } = useBookmarks();
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all');

  const allGroups = groupsOf(section);

  const visibleGroups = useMemo(() => {
    const keep = (t: Topic) => (filter === 'all' ? true : filter === 'done' ? isDone(t.id) : !isDone(t.id));
    return allGroups.map((g) => ({ ...g, topics: g.topics.filter(keep) })).filter((g) => g.topics.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, filter, isDone]);

  const doneCount = topics.filter((t) => isDone(t.id)).length;
  const pct = topics.length ? Math.round((doneCount / topics.length) * 100) : 0;
  const totalMinutes = topics.reduce((n, t) => n + t.minutes, 0);
  const totalQuestions = topics.reduce((n, t) => n + t.questionCount, 0);
  const nextTopic = topics.find((t) => !isDone(t.id)) ?? topics[0];
  const grouped = allGroups.length > 1 || (allGroups.length === 1 && allGroups[0].id !== '_');

  if (topics.length === 0) {
    return (
      <div className="wrap">
        <div className="empty">
          <h3>Nothing here yet</h3>
          <p>
            This track has no topics. <Link to="/">Back to the dashboard</Link>.
          </p>
        </div>
      </div>
    );
  }

  const row = (t: Topic) => {
    const done = isDone(t.id);
    return (
      <Link className={`topic-row${done ? ' done' : ''}`} to={t.path} key={t.id}>
        <span
          className="tr-num"
          role="button"
          tabIndex={0}
          title={done ? 'Mark as unread' : 'Mark as complete'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggle(t.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              toggle(t.id);
            }
          }}
        >
          {done ? <IconCheck size={14} /> : String(t.order).padStart(2, '0')}
        </span>
        <span className="tr-body">
          <span className="tr-title">
            {t.title}
            {isBookmarked(t.id) && <IconBookmarkFilled size={12} style={{ color: 'var(--accent)' }} />}
          </span>
          <span className="tr-desc">{t.description}</span>
        </span>
        <span className="tr-meta">
          {t.questionCount > 0 && (
            <span className="tr-hide">
              <IconHelp size={12} /> {t.questionCount}
            </span>
          )}
          <span className="tr-hide">{t.minutes} min</span>
          <IconChevronRight size={15} />
        </span>
      </Link>
    );
  };

  return (
    <div className="page" style={{ ['--sec-hue' as string]: sec.hue }}>
      <section className="sec-hero" style={{ ['--sec-hue' as string]: sec.hue }}>
        <div className="sec-hero-inner">
          <div className="breadcrumb">
            <Link to="/">Home</Link>
            <IconChevronRight size={12} />
            <span>{sec.title}</span>
          </div>
          <h1>
            <span className="sec-icon" style={{ width: 44, height: 44 }}>
              <SectionIcon name={sec.icon} size={23} />
            </span>
            {sec.title}
          </h1>
          <p>{sec.blurb}</p>
          <div className="topic-meta" style={{ marginBottom: 16 }}>
            <span className={`chip ${sec.priority === 'Critical' ? 'chip-danger' : sec.priority === 'High' ? 'chip-warn' : ''}`}>
              {sec.priority} priority
            </span>
            <span className="chip">{topics.length} topics</span>
            {grouped && (
              <span className="chip">
                <IconLayers size={12} /> {allGroups.length} groups
              </span>
            )}
            <span className="chip">
              <IconClock size={12} /> {formatMinutes(totalMinutes)}
            </span>
            {totalQuestions > 0 && (
              <span className="chip">
                <IconHelp size={12} /> {totalQuestions} questions
              </span>
            )}
            <span className="chip chip-ok">{pct}% complete</span>
          </div>
          <div className="progress-track" style={{ maxWidth: 420 }}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          {nextTopic && (
            <div style={{ marginTop: 18 }}>
              <Link className="btn btn-primary" to={nextTopic.path}>
                {doneCount === 0 ? 'Start this track' : doneCount === topics.length ? 'Review from the top' : 'Continue'}
                <IconArrowRight size={15} />
              </Link>
            </div>
          )}
        </div>
      </section>

      <div className="wrap">
        <div className="filter-bar">
          <div className="seg" style={{ width: 'auto' }}>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')} type="button">
              All ({topics.length})
            </button>
            <button className={filter === 'todo' ? 'active' : ''} onClick={() => setFilter('todo')} type="button">
              To read ({topics.length - doneCount})
            </button>
            <button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')} type="button">
              Done ({doneCount})
            </button>
          </div>
        </div>

        {visibleGroups.length === 0 ? (
          <div className="empty">
            <h3>Nothing in this filter</h3>
            <p>Switch the filter above to see the rest of the track.</p>
          </div>
        ) : grouped ? (
          <div className="group-stack">
            {visibleGroups.map((g, i) => {
              const gDone = g.topics.filter((t) => isDone(t.id)).length;
              return (
                <section className="group-block" key={g.id}>
                  <header className="group-head">
                    <span className="group-index">{String(i + 1).padStart(2, '0')}</span>
                    <div className="group-head-body">
                      <h2>{g.title}</h2>
                      <span className="group-meta">
                        {g.topics.length} {g.topics.length === 1 ? 'topic' : 'topics'} ·{' '}
                        {formatMinutes(g.topics.reduce((n, t) => n + t.minutes, 0))}
                        {gDone > 0 ? ` · ${gDone} done` : ''}
                      </span>
                    </div>
                    <div className="group-bar">
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.round((gDone / g.topics.length) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </header>
                  <div className="topic-rows">{g.topics.map(row)}</div>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="topic-rows">{visibleGroups.flatMap((g) => g.topics).map(row)}</div>
        )}
      </div>
    </div>
  );
}
