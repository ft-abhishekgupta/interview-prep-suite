import { Link } from 'react-router-dom';
import {
  ACTIVE_SECTIONS,
  TOPICS,
  TOPICS_BY_SECTION,
  TOTAL_MINUTES,
  TOTAL_QUESTIONS,
  TOTAL_TOPICS,
} from '../lib/content';
import { SECTION_GROUPS } from '../lib/sections';
import { useCompleted, useLastVisited } from '../lib/progress';
import { formatMinutes } from '../lib/utils';
import {
  IconArrowRight,
  IconCards,
  IconCopy,
  IconHelp,
  IconLayers,
  IconSearch,
  IconTarget,
  IconZap,
  SectionIcon,
} from '../components/Icons';

function ProgressRing({ pct, size = 96 }: { pct: number; size?: number }) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(var(--a-500))" />
            <stop offset="100%" stopColor="hsl(var(--a-400))" />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="8" />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth="8"
          strokeDasharray={c}
          strokeDashoffset={c - (c * pct) / 100}
        />
      </svg>
      <span className="ring-label" style={{ fontSize: size / 4.2 }}>
        {pct}%
      </span>
    </div>
  );
}

export function HomePage({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { count, isDone } = useCompleted();
  const { last } = useLastVisited();
  const pct = TOTAL_TOPICS ? Math.round((count / TOTAL_TOPICS) * 100) : 0;
  const lastTopic = last ? TOPICS.find((t) => t.id === last.id) : undefined;
  const nextTopic = TOPICS.find((t) => !isDone(t.id));

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-inner">
          <span className="hero-badge">
            <span className="hb-pill">{TOTAL_TOPICS} topics</span>
            Built for SDE II · Senior · Tech Lead loops
          </span>
          <h1>
            Everything you need for a <span className="grad">senior engineering</span> interview.
          </h1>
          <p className="lede">
            A complete, opinionated curriculum — algorithms, distributed systems, Java and Spring Boot, .NET, Azure,
            data, messaging, AI engineering and the human rounds. Short readable pages, diagrams and tables instead of
            walls of text, and the questions interviewers actually ask at the bottom of every page.
          </p>
          <div className="hero-cta">
            <Link className="btn btn-primary" to={nextTopic?.path ?? '/section/dsa'}>
              <IconZap size={16} />
              {count > 0 ? 'Continue learning' : 'Start the curriculum'}
              <IconArrowRight size={15} />
            </Link>
            <Link className="btn" to="/roadmap">
              <IconTarget size={15} /> See the study plan
            </Link>
            <button className="btn" onClick={onOpenPalette} type="button">
              <IconSearch size={15} /> Search topics
            </button>
          </div>

          <div className="stat-row">
            <div className="stat">
              <div className="stat-value">{TOTAL_TOPICS}</div>
              <div className="stat-label">Focused topic pages</div>
            </div>
            <div className="stat">
              <div className="stat-value">{TOTAL_QUESTIONS.toLocaleString()}</div>
              <div className="stat-label">Interview questions</div>
            </div>
            <div className="stat">
              <div className="stat-value">{ACTIVE_SECTIONS.length}</div>
              <div className="stat-label">Curriculum tracks</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatMinutes(TOTAL_MINUTES)}</div>
              <div className="stat-label">Total reading time</div>
            </div>
          </div>
        </div>
      </section>

      <div className="wrap">
        {(count > 0 || lastTopic) && (
          <div className="dash-grid">
            <div className="panel panel-center">
              <ProgressRing pct={pct} />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>
                  {count} of {TOTAL_TOPICS} topics complete
                </div>
                <div className="muted" style={{ fontSize: '0.82rem' }}>
                  {TOTAL_TOPICS - count} to go
                </div>
              </div>
              <Link className="btn" to="/progress">
                View detailed progress
              </Link>
            </div>

            {lastTopic && (
              <div className="panel">
                <h3>
                  <IconLayers size={16} /> Pick up where you left off
                </h3>
                <Link className="topic-row" to={lastTopic.path} style={{ borderRadius: 'var(--radius-sm)', padding: '10px 0' }}>
                  <span className="tr-num">{String(lastTopic.order).padStart(2, '0')}</span>
                  <span className="tr-body">
                    <span className="tr-title">{lastTopic.title}</span>
                    <span className="tr-desc">{lastTopic.sectionTitle}</span>
                  </span>
                  <IconArrowRight size={16} />
                </Link>
              </div>
            )}

            {nextTopic && (
              <div className="panel">
                <h3>
                  <IconTarget size={16} /> Next unread topic
                </h3>
                <Link className="topic-row" to={nextTopic.path} style={{ borderRadius: 'var(--radius-sm)', padding: '10px 0' }}>
                  <span className="tr-num">{String(nextTopic.order).padStart(2, '0')}</span>
                  <span className="tr-body">
                    <span className="tr-title">{nextTopic.title}</span>
                    <span className="tr-desc">{nextTopic.sectionTitle}</span>
                  </span>
                  <IconArrowRight size={16} />
                </Link>
              </div>
            )}
          </div>
        )}

        {SECTION_GROUPS.map((group) => {
          const sections = ACTIVE_SECTIONS.filter((s) => s.group === group);
          if (sections.length === 0) return null;
          return (
            <div key={group}>
              <div className="block-head">
                <div>
                  <h2>{group}</h2>
                </div>
              </div>
              <div className="card-grid">
                {sections.map((sec) => {
                  const topics = TOPICS_BY_SECTION[sec.id] ?? [];
                  const done = topics.filter((t) => isDone(t.id)).length;
                  const p = topics.length ? Math.round((done / topics.length) * 100) : 0;
                  return (
                    <Link
                      className="sec-card"
                      to={`/section/${sec.id}`}
                      key={sec.id}
                      style={{ ['--sec-hue' as string]: sec.hue }}
                    >
                      <div className="sec-card-top">
                        <span className="sec-icon">
                          <SectionIcon name={sec.icon} size={20} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <h3>{sec.title}</h3>
                          <span
                            className={`chip ${
                              sec.priority === 'Critical' ? 'chip-danger' : sec.priority === 'High' ? 'chip-warn' : ''
                            }`}
                          >
                            {sec.priority}
                          </span>
                        </div>
                      </div>
                      <p className="sec-blurb">{sec.blurb}</p>
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${p}%` }} />
                      </div>
                      <div className="sec-card-foot">
                        <span>
                          {topics.length} topics ·{' '}
                          {formatMinutes(topics.reduce((n, t) => n + t.minutes, 0))}
                        </span>
                        <span className="pct">{p}%</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="block-head">
          <div>
            <h2>How to use this site</h2>
            <p>Built to be skimmed before an interview and studied properly in the weeks before it.</p>
          </div>
        </div>
        <div className="feature-grid">
          <div className="feature">
            <IconSearch size={19} />
            <div>
              <h4>Instant search</h4>
              <p>
                Press <kbd>Ctrl</kbd> <kbd>K</kbd> anywhere to jump to a topic by name, tag or a phrase inside the page.
              </p>
            </div>
          </div>
          <div className="feature">
            <IconCopy size={19} />
            <div>
              <h4>Copy or download any page</h4>
              <p>Every topic exports as clean markdown — paste it into Obsidian, Notion or your own notes.</p>
            </div>
          </div>
          <div className="feature">
            <IconHelp size={19} />
            <div>
              <h4>Questions on every page</h4>
              <p>The most-asked interview questions sit at the bottom of each topic as collapsible flashcards.</p>
            </div>
          </div>
          <div className="feature">
            <IconCards size={19} />
            <div>
              <h4>Practice mode</h4>
              <p>Shuffle every question in the curriculum into a flashcard drill for last-minute revision.</p>
            </div>
          </div>
          <div className="feature">
            <IconZap size={19} />
            <div>
              <h4>Revision sheets</h4>
              <p>Every cheat sheet from a whole track on one page — the fastest refresh before a round.</p>
            </div>
          </div>
          <div className="feature">
            <IconTarget size={19} />
            <div>
              <h4>Progress that sticks</h4>
              <p>Mark topics complete, bookmark pages and keep private notes — all saved in your browser.</p>
            </div>
          </div>
          <div className="feature">
            <IconLayers size={19} />
            <div>
              <h4>Diagrams, not walls of text</h4>
              <p>Mermaid architecture diagrams, comparison tables and cheat sheets on almost every page.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { ProgressRing };
