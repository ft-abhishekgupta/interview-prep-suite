import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ACTIVE_SECTIONS,
  TOPICS_BY_SECTION,
  extractSection,
  loadMarkdown,
  stripFrontmatter,
  type Topic,
} from '../lib/content';
import { getSection } from '../lib/sections';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';
import { copyText, downloadText } from '../lib/utils';
import {
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconZap,
  SectionIcon,
} from '../components/Icons';

const CHEAT_HEADING = /cheat\s*sheet/i;
const SUMMARY_HEADING = /^summary\b/i;

interface Extract {
  topic: Topic;
  cheat: string | null;
  summary: string | null;
}

export function CheatsheetsPage() {
  const [params, setParams] = useSearchParams();
  const sectionId = params.get('s') ?? '';
  const [items, setItems] = useState<Extract[] | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [mode, setMode] = useState<'cheat' | 'summary'>('cheat');
  const toast = useToast();

  const topics = useMemo(() => TOPICS_BY_SECTION[sectionId] ?? [], [sectionId]);

  useEffect(() => {
    if (!sectionId) {
      setItems(null);
      return;
    }
    let cancelled = false;
    setItems(null);
    setLoaded(0);

    (async () => {
      const out: Extract[] = [];
      const batch = 10;
      for (let i = 0; i < topics.length; i += batch) {
        if (cancelled) return;
        const slice = topics.slice(i, i + batch);
        const parsed = await Promise.all(
          slice.map(async (topic) => {
            try {
              const body = stripFrontmatter(await loadMarkdown(topic));
              return {
                topic,
                cheat: extractSection(body, CHEAT_HEADING),
                summary: extractSection(body, SUMMARY_HEADING),
              };
            } catch {
              return { topic, cheat: null, summary: null };
            }
          }),
        );
        out.push(...parsed);
        if (!cancelled) setLoaded(Math.min(i + batch, topics.length));
      }
      if (!cancelled) setItems(out);
    })();

    return () => {
      cancelled = true;
    };
  }, [sectionId, topics]);

  const buildMarkdown = () => {
    const sec = getSection(sectionId);
    const parts = [`# ${sec.title} — ${mode === 'cheat' ? 'Cheat Sheets' : 'Summaries'}`, ''];
    for (const item of items ?? []) {
      const text = mode === 'cheat' ? item.cheat : item.summary;
      if (!text) continue;
      parts.push(`## ${item.topic.title}`, '', text, '');
    }
    return parts.join('\n');
  };

  if (!sectionId) {
    return (
      <div className="page wrap">
        <div className="block-head">
          <div>
            <h2>
              <IconZap size={21} style={{ verticalAlign: '-2px', marginRight: 8 }} />
              Revision sheets
            </h2>
            <p>
              Every cheat sheet from a track on one page — the fastest way to refresh a whole area the morning of an
              interview. Copy or download the lot as markdown.
            </p>
          </div>
        </div>
        <div className="card-grid">
          {ACTIVE_SECTIONS.map((sec) => {
            const list = TOPICS_BY_SECTION[sec.id] ?? [];
            return (
              <button
                className="sec-card"
                key={sec.id}
                style={{ ['--sec-hue' as string]: sec.hue, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setParams({ s: sec.id })}
                type="button"
              >
                <div className="sec-card-top">
                  <span className="sec-icon">
                    <SectionIcon name={sec.icon} size={20} />
                  </span>
                  <div>
                    <h3>{sec.short}</h3>
                    <span className="chip">{list.length} topics</span>
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

  const sec = getSection(sectionId);

  return (
    <div className="page wrap">
      <div className="filter-bar">
        <button className="btn btn-ghost" onClick={() => setParams({})} type="button">
          <IconChevronLeft size={15} /> All tracks
        </button>
        <div className="seg" style={{ width: 'auto' }}>
          <button className={mode === 'cheat' ? 'active' : ''} onClick={() => setMode('cheat')} type="button">
            Cheat sheets
          </button>
          <button className={mode === 'summary' ? 'active' : ''} onClick={() => setMode('summary')} type="button">
            Summaries
          </button>
        </div>
        <div className="spacer" />
        <button
          className="btn"
          disabled={!items}
          onClick={async () => {
            const ok = await copyText(buildMarkdown());
            toast(ok ? 'Revision sheet copied' : 'Copy failed');
          }}
          type="button"
        >
          <IconCopy size={15} /> Copy all
        </button>
        <button
          className="btn"
          disabled={!items}
          onClick={() => {
            downloadText(`${sectionId}-${mode === 'cheat' ? 'cheatsheets' : 'summaries'}.md`, buildMarkdown());
            toast('Downloaded');
          }}
          type="button"
        >
          <IconDownload size={15} /> Download
        </button>
      </div>

      <div className="block-head" style={{ marginTop: 0 }}>
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="sec-icon" style={{ ['--sec-hue' as string]: sec.hue }}>
              <SectionIcon name={sec.icon} size={20} />
            </span>
            {sec.title}
          </h2>
          <p>{mode === 'cheat' ? 'Points to remember from every topic in this track.' : 'The one-paragraph summary of every topic in this track.'}</p>
        </div>
      </div>

      {!items ? (
        <div className="loader">
          <span className="spinner" /> Gathering sheets… {loaded}/{topics.length}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {items.map((item) => {
            const text = mode === 'cheat' ? item.cheat : item.summary;
            if (!text) return null;
            return (
              <div className="panel" key={item.topic.id}>
                <h3 style={{ justifyContent: 'space-between' }}>
                  <span>{item.topic.title}</span>
                  <Link className="btn btn-ghost" to={item.topic.path} style={{ fontSize: '0.76rem' }}>
                    Read topic <IconChevronRight size={13} />
                  </Link>
                </h3>
                <Markdown compact>{text}</Markdown>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
