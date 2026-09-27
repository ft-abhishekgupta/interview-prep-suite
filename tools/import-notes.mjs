#!/usr/bin/env node
/**
 * Imports the hand-written notes from D:\AiGeneratedNotes\Content into the site
 * as a "My Notes" group inside the matching track, copying their images too.
 *
 * Idempotent: re-running overwrites the generated pages from source.
 * Usage: node tools/import-notes.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = 'D:\\AiGeneratedNotes\\Content';
const CONTENT = path.join(ROOT, 'src', 'content');
const PUBLIC_NOTES = path.join(ROOT, 'public', 'notes');
const DRY = process.argv.includes('--dry');

// The imported notes have since been merged into the curriculum pages by hand, so a
// plain re-run would resurrect the old `my-notes` groups and undo that work.
if (!process.argv.includes('--force') && !DRY) {
  console.error(
    '\nThis was a one-time migration. The notes it imports have already been merged into\n' +
      'the curriculum pages, so re-running would recreate the duplicate "My Notes" groups.\n\n' +
      'Use --dry to preview, or --force if you really mean to re-import.\n',
  );
  process.exit(1);
}

/**
 * Each entry: [sectionId, groupFolder, [ [sourceRelativePath, Title], ... ] ]
 * Order within the array becomes the page order.
 */
const MAP = [
  [
    'dsa',
    '08-my-notes',
    [
      ['DSA/ComplexityAnalysis/ComplexityAnalysis.md', 'Complexity Analysis'],
      ['DSA/Patterns.md', 'Problem Patterns'],
      ['DSA/SearchingAndSorting/SearchingAndSorting.md', 'Searching and Sorting'],
      ['DSA/Trees/Trees.md', 'Trees'],
      ['DSA/Graphs/Graphs.md', 'Graphs'],
      ['DSA/HeapsAndPriorityQueues/HeapsAndPriorityQueues.md', 'Heaps and Priority Queues'],
      ['DSA/ToRead/TriesAndStringMatching/TriesAndStringMatching.md', 'Tries and String Matching'],
      ['DSA/ToRead/AdvancedPatterns/AdvancedPatterns.md', 'Advanced Patterns'],
      ['DSA/StandardProblems.md', 'Standard Problems'],
      ['DSA/AdvanceProblems.md', 'Advanced Problems'],
      ['DSA/CSharp.md', 'C Sharp for DSA'],
      ['DSA/LeetCodeContest/Contest1.md', 'LeetCode Contest 1'],
      ['DSA/LeetCodeContest/Contest2.md', 'LeetCode Contest 2'],
    ],
  ],
  [
    'system-design',
    '08-my-notes',
    [
      ['HLD/CHEATSHEET.md', 'HLD Cheatsheet'],
      ['05-HighLevelDesign/README.md', 'High Level Design Overview'],
      ['05-HighLevelDesign/BuildingBlocks/BuildingBlocks.md', 'Building Blocks'],
      ['05-HighLevelDesign/Concepts/Concepts.md', 'Core Concepts'],
      ['05-HighLevelDesign/SystemDesign/SystemDesign.md', 'System Design Deep Dive'],
      ['05-HighLevelDesign/Caching/Caching.md', 'Caching'],
      ['05-HighLevelDesign/AsyncSystems/AsyncSystems.md', 'Async Systems'],
      ['05-HighLevelDesign/DatabaseModeling/DatabaseModeling.md', 'Database Modeling'],
      ['HLD/Notes.md', 'HLD Reference Diagram'],
    ],
  ],
  [
    'backend',
    '05-my-notes',
    [
      ['05-HighLevelDesign/ApiDesign/README.md', 'API Design Overview'],
      ['05-HighLevelDesign/ApiDesign/REST/REST.md', 'REST APIs'],
      ['05-HighLevelDesign/ApiDesign/Non-REST/NonREST.md', 'Beyond REST'],
      ['05-HighLevelDesign/ApiDesign/Auth/Auth.md', 'API Authentication'],
    ],
  ],
  [
    'hld-problems',
    '06-my-notes',
    [
      ['HLD/Problems/Bitly/Bitly.md', 'Bitly URL Shortener'],
      ['HLD/Problems/NewsFeed/NewsFeed.md', 'News Feed'],
      ['HLD/Problems/Whatsapp/Whatsapp.md', 'WhatsApp'],
      ['HLD/Problems/Instagram/Instagram.md', 'Instagram'],
      ['HLD/Problems/Youtube/Youtube.md', 'YouTube'],
      ['HLD/Problems/Dropbox/Dropbox.md', 'Dropbox'],
      ['HLD/Problems/Uber/Uber.md', 'Uber'],
      ['HLD/Problems/Yelp/Yelp.md', 'Yelp'],
      ['HLD/Problems/Ticketmaster/Ticketmaster.md', 'Ticketmaster'],
      ['HLD/Problems/PaymentSystem/PaymentSystem.md', 'Payment System'],
      ['HLD/Problems/NotificationSystem/NotificationSystem.md', 'Notification System'],
      ['HLD/Problems/Auction/Auction.md', 'Auction System'],
      ['HLD/Problems/Leetcode/Leetcode.md', 'LeetCode'],
      ['HLD/Problems/WebCrawler/WebCrawler.md', 'Web Crawler'],
      ['HLD/Problems/AdClickAggregator/AdClickAggregator.md', 'Ad Click Aggregator'],
      ['HLD/Problems/MetricsMonitoring/MetricMonitoring.md', 'Metrics and Monitoring'],
      ['HLD/Problems/LiveVideoComment/LiveVideoComment.md', 'Live Video Comments'],
    ],
  ],
  [
    'lld',
    '05-my-notes',
    [
      ['LLD/README.md', 'LLD Overview'],
      ['LLD/MyNotes.md', 'LLD Templates'],
      ['LLD/OOPs/OOPs.md', 'OOP Concepts'],
      ['LLD/SOLID/SOLID.md', 'SOLID'],
      ['LLD/DesignPrinciples/DesignPrinciples.md', 'Design Principles'],
      ['LLD/DesignPatterns/DesignPatterns.md', 'Design Patterns'],
      ['LLD/ClassDesign/ClassDesign.md', 'Class Design'],
      ['LLD/UML/UML.md', 'UML'],
      ['LLD/Concurrency/Concurrency.md', 'Concurrency'],
    ],
  ],
  [
    'lld-problems',
    '05-my-notes',
    [
      ['LLD/Problems/Generic.md', 'Generic Approach'],
      ['LLD/Problems/ParkingSystem/ParkingSystem.md', 'Parking System'],
      ['LLD/Problems/ParkingSystem/Practice-ParkingSystem.md', 'Parking System Practice'],
      ['LLD/Problems/MovieBooking/MovieBooking.md', 'Movie Booking'],
      ['LLD/Problems/MovieBooking/Practice-MovieBooking.md', 'Movie Booking Practice'],
      ['LLD/Problems/Elevator/Elevator.md', 'Elevator'],
      ['LLD/Problems/VendingMachine/VendingMachine.md', 'Vending Machine'],
      ['LLD/Problems/AmazonLocker/AmazonLocker.md', 'Amazon Locker'],
      ['LLD/Problems/ConnectFour/ConnectFour.md', 'Connect Four'],
      ['LLD/Problems/StackOverflow/StackOverflow.md', 'Stack Overflow'],
      ['LLD/Problems/LoggingSystem/LoggingSystem.md', 'Logging System'],
      ['LLD/Problems/RateLimitter/RateLimitter.md', 'Rate Limiter'],
      ['LLD/Problems/Cache/LRUCache.md', 'LRU Cache'],
      ['LLD/Problems/Cache/LFUCache.md', 'LFU Cache'],
      ['LLD/Problems/LocalDeliveryService/LocalDeliveryService.md', 'Local Delivery Service'],
      ['LLD/Problems/CopilotGenerated/ShoppingCart/ShoppingCart.md', 'Shopping Cart'],
      ['LLD/Problems/CopilotGenerated/AuthSystem/AuthSystem.md', 'Auth System'],
      ['LLD/Problems/CopilotGenerated/JobScheduler/JobScheduler.md', 'Job Scheduler'],
      ['LLD/Problems/CopilotGenerated/NotificationSystem/NotificationSystem.md', 'Notification System'],
      ['LLD/Problems/CopilotGenerated/RuleEngine/RuleEngine.md', 'Rule Engine'],
      ['LLD/Problems/CopilotGenerated/Spotify/Spotify.md', 'Spotify'],
      ['LLD/Problems/CopilotGenerated/TradingSystem/TradingSystem.md', 'Trading System'],
      ['LLD/Problems/CopilotGenerated/Uber/Uber.md', 'Uber'],
    ],
  ],
  [
    'databases',
    '06-my-notes',
    [
      ['SE/SQL/SQL.md', 'SQL'],
      ['03-Databases/README.md', 'Databases'],
    ],
  ],
  [
    'fundamentals',
    '06-my-notes',
    [
      ['02-ComputerNetworks/README.md', 'Computer Networks'],
      ['SE/Git/Git.md', 'Git'],
    ],
  ],
  [
    'resume',
    '03-my-notes',
    [
      ['RESUME/Resume.md', 'My Resume'],
      ['Topics.md', 'My Interview Syllabus'],
      ['Roadmap.md', 'My Roadmap'],
      ['README.md', 'My Notes Index'],
    ],
  ],
];

/** Extra C# source files appended to a generated page as an implementation appendix. */
const CODE_APPENDIX = {
  'lld-problems/stack-overflow': 'LLD/Problems/StackOverflow/Implemetation',
  'lld-problems/vending-machine': 'LLD/Problems/VendingMachine/Implementation',
};

const pad = (n) => String(n).padStart(2, '0');

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Builds a safe one-line description from the first real paragraph. */
function describe(body, title) {
  const lines = body.split('\n');
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    if (/^[#>|!-]/.test(line) || line.startsWith('---')) continue;
    let text = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`#]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/:/g, ' -')
      .replace(/["']/g, '')
      .trim();
    if (text.length < 25 || text.split(/\s+/).length < 9) continue;
    if (text.length > 165) {
      text = text.slice(0, 165);
      text = text.slice(0, text.lastIndexOf(' '));
    }
    return text.replace(/[.,;\s]+$/, '');
  }
  return `My own notes on ${title}, written while preparing and kept here as originally recorded`;
}

let imported = 0;
let images = 0;
const problems = [];

function copyImages(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!/\.(png|jpe?g|gif|svg|webp)$/i.test(entry.name)) continue;
    if (!DRY) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    }
    images += 1;
  }
}

function transform(raw, title, imageBase) {
  let body = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  // Drop an existing frontmatter block, if any.
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).replace(/^\n+/, '');
  }

  // Remove the leading H1 (the site renders the title itself).
  const lines = body.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && /^#\s+/.test(lines[0])) lines.shift();
  body = lines.join('\n').replace(/^\n+/, '');

  // Any remaining H1 becomes an H2 so the page has one heading level.
  body = body.replace(/^#\s+(?!#)/gm, '## ');

  // Point relative image references at the copied assets.
  body = body.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    const url = src.trim().replace(/^<|>$/g, '').split(/\s+/)[0];
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:')) return match;
    const clean = url.replace(/^\.\//, '').replace(/%20/g, ' ');
    return `![${alt || 'diagram'}](${imageBase}/${encodeURI(clean)})`;
  });

  return body.trim();
}

for (const [section, groupFolder, files] of MAP) {
  const destDir = path.join(CONTENT, section, groupFolder);

  files.forEach(([relPath, title], i) => {
    const srcFile = path.join(SRC, relPath.replace(/\//g, path.sep));
    if (!fs.existsSync(srcFile)) {
      problems.push(`missing source: ${relPath}`);
      return;
    }

    const raw = fs.readFileSync(srcFile, 'utf8');
    if (!raw.trim()) {
      problems.push(`empty source skipped: ${relPath}`);
      return;
    }

    const slug = slugify(title);
    const imageDirRel = path.posix.dirname(relPath);
    const imageBase = `notes/${imageDirRel}`;
    copyImages(path.dirname(srcFile), path.join(PUBLIC_NOTES, imageDirRel.replace(/\//g, path.sep)));

    let body = transform(raw, title, imageBase);

    // A few notes are a single captured diagram with no prose around it.
    const textOnly = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*_`|-]/g, '').trim();
    if (textOnly.length < 40) {
      body = `A reference diagram captured in my own notes and kept here as originally recorded.\n\n${body}`;
    }

    // Append any C# implementation that sits beside the note.
    const appendix = CODE_APPENDIX[`${section}/${slug}`];
    if (appendix) {
      const codeDir = path.join(SRC, appendix.replace(/\//g, path.sep));
      if (fs.existsSync(codeDir)) {
        const parts = ['', '## Implementation', '', 'The full C# implementation kept alongside these notes.', ''];
        for (const f of fs.readdirSync(codeDir).filter((n) => n.endsWith('.cs')).sort()) {
          parts.push(`### ${f}`, '', '```csharp', fs.readFileSync(path.join(codeDir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd(), '```', '');
        }
        body += '\n' + parts.join('\n');
      }
    }

    const description = describe(body, title);
    const frontmatter = [
      '---',
      `title: ${title}`,
      `description: ${description}`,
      'difficulty: Core',
      'origin: personal',
      `tags: [my-notes, ${section}]`,
      '---',
      '',
    ].join('\n');

    const destFile = path.join(destDir, `${pad(i + 1)}-${slug}.md`);
    if (!DRY) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destFile, frontmatter + body + '\n', 'utf8');
    }
    imported += 1;
  });
}

console.log(`\n${DRY ? '[dry run] ' : ''}Imported ${imported} note page(s) and ${images} image(s).`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('All sources found.\n');
