import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { ACTIVE_SECTIONS, TOPICS, TOPICS_BY_SECTION, TOTAL_TOPICS, TOPIC_MAP } from '../lib/content';
import { exportProgress, importProgress, useAllNotes, useBookmarks, useCompleted } from '../lib/progress';
import { downloadText, formatMinutes } from '../lib/utils';
import { useToast } from '../components/Toast';
import { ProgressRing } from './HomePage';
import {
  IconBookmarkFilled,
  IconChevronRight,
  IconDownload,
  IconNote,
  IconTrash,
  IconUpload,
  SectionIcon,
} from '../components/Icons';

export function ProgressPage() {
  const { count, isDone, completed, reset } = useCompleted();
  const { bookmarks } = useBookmarks();
  const notes = useAllNotes();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const pct = TOTAL_TOPICS ? Math.round((count / TOTAL_TOPICS) * 100) : 0;
  const minutesDone = TOPICS.filter((t) => isDone(t.id)).reduce((n, t) => n + t.minutes, 0);
  const minutesLeft = TOPICS.filter((t) => !isDone(t.id)).reduce((n, t) => n + t.minutes, 0);
  const noteIds = Object.keys(notes);

  const onExport = () => {
    downloadText('interview-prep-progress.json', exportProgress(), 'application/json');
    toast('Progress exported');
  };

  const onImport = (file: File) => {
    file.text().then((text) => {
      try {
        importProgress(text);
        toast('Progress imported');
      } catch {
        toast('That file could not be read');
      }
    });
  };

  return (
    <div className="page wrap">
      <div className="block-head">
        <div>
          <h2>Your progress</h2>
          <p>Everything is stored in this browser only. Export it if you switch machines.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={onExport} type="button">
            <IconDownload size={15} /> Export
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} type="button">
            <IconUpload size={15} /> Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = '';
            }}
          />
          <button
            className="btn"
            onClick={() => {
              if (confirm('Reset all completed topics? Notes and bookmarks are kept.')) {
                reset();
                toast('Progress reset');
              }
            }}
            type="button"
          >
            <IconTrash size={15} /> Reset
          </button>
        </div>
      </div>

      <div className="dash-grid">
        <div className="panel panel-center">
          <ProgressRing pct={pct} size={112} />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
              {count} / {TOTAL_TOPICS} topics
            </div>
            <div className="muted" style={{ fontSize: '0.82rem' }}>
              {formatMinutes(minutesDone)} read · {formatMinutes(minutesLeft)} remaining
            </div>
          </div>
        </div>

        <div className="panel">
          <h3>
            <IconBookmarkFilled size={15} /> Saved topics ({bookmarks.length})
          </h3>
          {bookmarks.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
              Use the <strong>Save</strong> button on any topic to build a shortlist for the night before.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {bookmarks.slice(0, 12).map((id) => {
                const t = TOPIC_MAP[id];
                if (!t) return null;
                return (
                  <Link key={id} to={t.path} className="nav-item">
                    <span className="ni-text">{t.title}</span>
                    <IconChevronRight size={13} />
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="panel">
          <h3>
            <IconNote size={15} /> Your notes ({noteIds.length})
          </h3>
          {noteIds.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
              Notes you write at the bottom of a topic show up here.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {noteIds.slice(0, 12).map((id) => {
                const t = TOPIC_MAP[id];
                if (!t) return null;
                return (
                  <Link key={id} to={t.path} className="nav-item">
                    <span className="ni-text">{t.title}</span>
                    <IconChevronRight size={13} />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="block-head">
        <div>
          <h2>By track</h2>
        </div>
      </div>
      <div className="panel">
        <div className="bar-list">
          {ACTIVE_SECTIONS.map((sec) => {
            const topics = TOPICS_BY_SECTION[sec.id] ?? [];
            const done = topics.filter((t) => completed.has(t.id)).length;
            const p = topics.length ? Math.round((done / topics.length) * 100) : 0;
            return (
              <div className="bar-row" key={sec.id} style={{ ['--sec-hue' as string]: sec.hue }}>
                <Link className="bar-name" to={`/section/${sec.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
                  <SectionIcon name={sec.icon} size={14} />
                  {sec.title}
                </Link>
                <span className="bar-val">
                  {done}/{topics.length} · {p}%
                </span>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${p}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
