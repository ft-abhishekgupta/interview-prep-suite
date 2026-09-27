import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ACTIVE_SECTIONS, TOPICS_BY_SECTION, TOTAL_TOPICS, groupsOf, type Topic } from '../lib/content';
import { useCompleted } from '../lib/progress';
import { IconSearch, IconChevronRight, SectionIcon, IconCheck } from './Icons';

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const location = useLocation();
  const { isDone, count } = useCompleted();
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentSection = useMemo(() => {
    const m = location.pathname.match(/^\/(?:topic|section)\/([^/]+)/);
    return m?.[1] ?? '';
  }, [location.pathname]);

  const currentTopicSlug = useMemo(() => {
    const m = location.pathname.match(/^\/topic\/[^/]+\/([^/]+)/);
    return m?.[1] ?? '';
  }, [location.pathname]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // Reveal the branch containing the page being read.
  useEffect(() => {
    if (!currentSection) return;
    setOpenSections((s) => ({ ...s, [currentSection]: true }));
    if (!currentTopicSlug) return;
    const topic = (TOPICS_BY_SECTION[currentSection] ?? []).find((t) => t.slug === currentTopicSlug);
    if (topic?.group) setOpenGroups((g) => ({ ...g, [`${currentSection}/${topic.group}`]: true }));
  }, [currentSection, currentTopicSlug]);

  useEffect(() => {
    const el = scrollRef.current?.querySelector('.nav-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [location.pathname]);

  const q = filter.trim().toLowerCase();
  const matches = (t: Topic) =>
    !q ||
    t.title.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    t.groupTitle.toLowerCase().includes(q) ||
    t.tags.some((tag) => tag.toLowerCase().includes(q));

  const navGroups = useMemo(() => {
    const out: { group: string; sections: typeof ACTIVE_SECTIONS }[] = [];
    for (const sec of ACTIVE_SECTIONS) {
      let g = out.find((x) => x.group === sec.group);
      if (!g) {
        g = { group: sec.group, sections: [] };
        out.push(g);
      }
      g.sections.push(sec);
    }
    return out;
  }, []);

  const pct = TOTAL_TOPICS ? Math.round((count / TOTAL_TOPICS) * 100) : 0;
  let anyVisible = false;

  const renderTopic = (t: Topic, deep: boolean) => (
    <NavLink
      key={t.id}
      to={t.path}
      className={({ isActive }) => `nav-item${isActive ? ' active' : ''}${deep ? ' nav-item-deep' : ''}`}
      onClick={onNavigate}
      title={t.title}
    >
      <span className="ni-text">{t.title}</span>
      {isDone(t.id) && <IconCheck size={12} style={{ color: 'var(--ok)', flexShrink: 0 }} />}
    </NavLink>
  );

  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Curriculum navigation">
      <div className="sidebar-head">
        <div className="sidebar-filter">
          <IconSearch size={14} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter topics…"
            aria-label="Filter topics"
          />
        </div>
        <div className="sidebar-progress">
          <div className="sidebar-progress-row">
            <span>Progress</span>
            <span>
              {count} / {TOTAL_TOPICS} · {pct}%
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <div className="sidebar-scroll" ref={scrollRef}>
        {navGroups.map(({ group, sections }) => {
          const visibleSections = sections
            .map((sec) => ({
              sec,
              subGroups: groupsOf(sec.id)
                .map((g) => ({ ...g, topics: g.topics.filter(matches) }))
                .filter((g) => g.topics.length > 0),
            }))
            .filter((x) => x.subGroups.length > 0);

          if (visibleSections.length === 0) return null;
          anyVisible = true;

          return (
            <div key={group}>
              <div className="nav-group-label">{group}</div>
              {visibleSections.map(({ sec, subGroups }) => {
                const sectionOpen = q ? true : (openSections[sec.id] ?? false);
                const all = subGroups.flatMap((g) => g.topics);
                const doneCount = all.filter((t) => isDone(t.id)).length;
                const flat = subGroups.length === 1 && subGroups[0].id === '_';

                return (
                  <div className="nav-section" key={sec.id} style={{ ['--sec-hue' as string]: sec.hue }}>
                    <button
                      className={`nav-section-btn${currentSection === sec.id ? ' has-current' : ''}`}
                      aria-expanded={sectionOpen}
                      onClick={() => setOpenSections((s) => ({ ...s, [sec.id]: !sectionOpen }))}
                      type="button"
                    >
                      <span className="ns-icon">
                        <SectionIcon name={sec.icon} size={14} />
                      </span>
                      <span className="ns-title">{sec.short}</span>
                      <span className="ns-count">
                        {doneCount}/{all.length}
                      </span>
                      <IconChevronRight size={14} className="ns-caret" />
                    </button>

                    {sectionOpen && (
                      <div className="nav-items">
                        {flat
                          ? subGroups[0].topics.map((t) => renderTopic(t, false))
                          : subGroups.map((g) => {
                              const key = `${sec.id}/${g.id}`;
                              const groupOpen = q ? true : (openGroups[key] ?? false);
                              const gDone = g.topics.filter((t) => isDone(t.id)).length;
                              const hasCurrent =
                                currentSection === sec.id && g.topics.some((t) => t.slug === currentTopicSlug);
                              return (
                                <div className="nav-subgroup" key={key}>
                                  <button
                                    className={`nav-group-btn${hasCurrent ? ' has-current' : ''}`}
                                    aria-expanded={groupOpen}
                                    onClick={() => setOpenGroups((s) => ({ ...s, [key]: !groupOpen }))}
                                    type="button"
                                  >
                                    <IconChevronRight size={12} className="ng-caret" />
                                    <span className="ng-title">{g.title}</span>
                                    <span className="ng-count">
                                      {gDone}/{g.topics.length}
                                    </span>
                                  </button>
                                  {groupOpen && (
                                    <div className="nav-group-items">{g.topics.map((t) => renderTopic(t, true))}</div>
                                  )}
                                </div>
                              );
                            })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {q && !anyVisible && (
          <div style={{ padding: '20px 10px', fontSize: '0.82rem', color: 'var(--text-faint)' }}>
            Nothing matches “{filter}”. Press <kbd>Ctrl</kbd> <kbd>K</kbd> for full-text search.
          </div>
        )}
      </div>
    </aside>
  );
}
