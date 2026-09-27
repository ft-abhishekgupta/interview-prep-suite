import { Link } from 'react-router-dom';
import { TOPICS_BY_SECTION } from '../lib/content';
import { getSection } from '../lib/sections';
import { useCompleted } from '../lib/progress';
import { IconArrowRight, IconTarget, SectionIcon } from '../components/Icons';

interface Phase {
  label: string;
  title: string;
  goal: string;
  sections: string[];
}

const PLAN: Phase[] = [
  {
    label: 'Week 1–2',
    title: 'Rebuild the coding muscle',
    goal: 'Get fluent in patterns before anything else — coding rounds are the most common filter and the slowest skill to recover.',
    sections: ['dsa'],
  },
  {
    label: 'Week 2–3',
    title: 'Own your résumé',
    goal: 'Every bullet on your CV is an interview question. Write the architecture, the trade-offs and the numbers down before you are asked — your own systems guide is the raw material.',
    sections: ['resume', 'xbox-systems'],
  },
  {
    label: 'Week 3–5',
    title: 'System design foundations',
    goal: 'Learn the building blocks and distributed-systems vocabulary, then work case studies until the framework is automatic.',
    sections: ['system-design', 'hld-problems'],
  },
  {
    label: 'Week 5–6',
    title: 'Depth in your stack',
    goal: 'Senior backend loops go deep. Work the track that matches your stack — Java and Spring Boot, or C# and ASP.NET Core — covering language semantics, memory, concurrency, the framework pipeline and production API concerns.',
    sections: ['java', 'spring-boot', 'csharp-dotnet', 'backend'],
  },
  {
    label: 'Week 6–7',
    title: 'Data and the cloud',
    goal: 'SQL craft, indexing and isolation; then Azure services and a Cosmos DB deep dive that most candidates cannot match.',
    sections: ['databases', 'azure'],
  },
  {
    label: 'Week 7–8',
    title: 'Async systems',
    goal: 'Delivery semantics, idempotency, retries, DLQs, outbox and saga — the questions that separate senior from mid-level.',
    sections: ['messaging'],
  },
  {
    label: 'Week 8–9',
    title: 'Object-oriented design',
    goal: 'SOLID and patterns, then machine-coding problems under time pressure with clean, extensible class models.',
    sections: ['lld', 'lld-problems'],
  },
  {
    label: 'Week 9–10',
    title: 'Modern and supporting skills',
    goal: 'AI engineering is now a differentiator; security, DevOps, observability and testing round out the senior profile.',
    sections: ['ai-engineering', 'observability', 'security', 'devops', 'testing', 'frontend', 'fundamentals'],
  },
  {
    label: 'Week 10+',
    title: 'The human rounds',
    goal: 'Build a STAR story bank, rehearse leadership and failure narratives, and prepare for the hiring-manager conversation.',
    sections: ['behavioural'],
  },
];

export function RoadmapPage() {
  const { isDone } = useCompleted();

  return (
    <div className="page wrap wrap-narrow">
      <div className="block-head">
        <div>
          <h2>
            <IconTarget size={21} style={{ verticalAlign: '-2px', marginRight: 8 }} />
            A 10-week study plan
          </h2>
          <p>
            A sensible order through the curriculum for a backend-leaning senior engineer. Compress it if your loop is
            sooner — the ordering matters more than the calendar.
          </p>
        </div>
      </div>

      <div className="roadmap">
        {PLAN.map((phase) => {
          const topics = phase.sections.flatMap((s) => TOPICS_BY_SECTION[s] ?? []);
          const done = topics.filter((t) => isDone(t.id)).length;
          const complete = topics.length > 0 && done === topics.length;
          const first = topics.find((t) => !isDone(t.id)) ?? topics[0];
          return (
            <div className={`rm-item${complete ? ' done' : ''}`} key={phase.label}>
              <div className="rm-week">{phase.label}</div>
              <h4>{phase.title}</h4>
              <p>{phase.goal}</p>
              <div className="rm-tags">
                {phase.sections.map((id) => {
                  const sec = getSection(id);
                  const list = TOPICS_BY_SECTION[id] ?? [];
                  const d = list.filter((t) => isDone(t.id)).length;
                  return (
                    <Link className="chip" to={`/section/${id}`} key={id}>
                      <SectionIcon name={sec.icon} size={11} />
                      {sec.short} {list.length > 0 && `· ${d}/${list.length}`}
                    </Link>
                  );
                })}
                {first && (
                  <Link className="chip chip-accent" to={first.path}>
                    {done === 0 ? 'Start' : complete ? 'Review' : 'Continue'} <IconArrowRight size={11} />
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="block-head">
        <div>
          <h2>How to study each topic</h2>
        </div>
      </div>
      <div className="feature-grid">
        <div className="feature">
          <IconTarget size={18} />
          <div>
            <h4>1. Read for the model, not the words</h4>
            <p>Skim the diagram and the cheat sheet first, then read the prose to fill in the gaps.</p>
          </div>
        </div>
        <div className="feature">
          <IconTarget size={18} />
          <div>
            <h4>2. Answer the questions out loud</h4>
            <p>Cover the answer, speak yours, then compare. Speaking is the skill being tested, not recognition.</p>
          </div>
        </div>
        <div className="feature">
          <IconTarget size={18} />
          <div>
            <h4>3. Attach it to your experience</h4>
            <p>For every concept, write one line in the notes box connecting it to something you actually built.</p>
          </div>
        </div>
        <div className="feature">
          <IconTarget size={18} />
          <div>
            <h4>4. Revisit with practice mode</h4>
            <p>A week later, shuffle that track's questions in practice mode. What you cannot answer, re-read.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
