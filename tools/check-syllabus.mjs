#!/usr/bin/env node
/**
 * Curriculum completeness check.
 *
 * A senior software-engineering loop draws from a fairly stable pool of topics. This walks that
 * pool and reports which are covered by a page, which are only mentioned in passing, and which
 * are missing entirely — so gaps are found deliberately rather than by accident.
 *
 * "Covered" means the term appears in a page title, or appears in the body of 2+ pages with at
 * least one of those being a substantial treatment (a section heading containing the term).
 *
 * Usage: node tools/check-syllabus.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(__dirname, '..', 'src', 'content');
const VERBOSE = process.argv.includes('--verbose');

/** topic -> regex alternatives that count as a mention */
const SYLLABUS = {
  'Coding — data structures': [
    ['Arrays and strings', /\barrays?\b.*\bstrings?\b|\bstring manipulation\b/i],
    ['Hash maps and sets', /\bhash (map|table|set)\b|\bdictionary\b/i],
    ['Linked lists', /\blinked list\b/i],
    ['Stacks and queues', /\bstack\b.*\bqueue\b|\bmonotonic stack\b/i],
    ['Heaps and priority queues', /\b(heap|priority queue)\b/i],
    ['Binary trees and BSTs', /\bbinary (search )?tree\b/i],
    ['Tries', /\btrie\b/i],
    ['Graphs', /\bgraph\b/i],
    ['Union-Find', /\bunion[- ]find\b|\bdisjoint set\b/i],
    ['Segment / Fenwick trees', /\bsegment tree\b|\bfenwick\b|\bbinary indexed tree\b/i],
    ['Bloom filters', /\bbloom filter\b/i],
    ['LRU / LFU cache', /\bLRU\b|\bLFU\b/],
  ],
  'Coding — algorithms': [
    ['Complexity analysis', /\bbig[- ]o\b|\btime complexity\b/i],
    ['Two pointers', /\btwo pointers?\b/i],
    ['Sliding window', /\bsliding window\b/i],
    ['Prefix sums', /\bprefix sum\b/i],
    ['Binary search', /\bbinary search\b/i],
    ['Sorting algorithms', /\b(quicksort|merge ?sort|heapsort|timsort)\b/i],
    ['Recursion and backtracking', /\bbacktrack/i],
    ['Greedy', /\bgreedy\b/i],
    ['Dynamic programming', /\bdynamic programming\b|\bmemoi[sz]/i],
    ['Intervals / sweep line', /\bsweep line\b|\bmerge intervals\b/i],
    ['Bit manipulation', /\bbit manipulation\b|\bbitmask\b/i],
    ['Topological sort', /\btopological sort\b/i],
    ['Shortest path', /\bdijkstra\b|\bbellman[- ]ford\b/i],
    ['Minimum spanning tree', /\b(kruskal|prim)\b|\bminimum spanning tree\b/i],
    ['String algorithms', /\bKMP\b|\brabin[- ]karp\b|\bmanacher\b/i],
    ['Math and number theory', /\bsieve\b|\bmodular arithmetic\b|\bgcd\b/i],
  ],
  'System design — building blocks': [
    ['Load balancing', /\bload balanc/i],
    ['API gateway / reverse proxy', /\bapi gateway\b|\breverse proxy\b/i],
    ['CDN', /\bCDN\b|\bcontent delivery network\b/i],
    ['Caching strategies', /\bcache[- ]aside\b|\bwrite[- ]through\b/i],
    ['Message queues / pub-sub', /\bmessage queue\b|\bpub\/?sub\b/i],
    ['Object storage', /\bobject storage\b|\bblob storage\b/i],
    ['Search and indexing', /\binverted index\b|\belasticsearch\b/i],
    ['Distributed locks', /\bdistributed lock\b/i],
    ['Rate limiting', /\brate limit/i],
    ['Job scheduling / workflows', /\bjob schedul|\bdurable execution\b|\bworkflow engine\b/i],
    ['Consistent hashing', /\bconsistent hashing\b/i],
    ['Service discovery', /\bservice discovery\b/i],
  ],
  'System design — distributed systems': [
    ['CAP and PACELC', /\bCAP theorem\b|\bPACELC\b/i],
    ['Consistency models', /\blinearizab|\beventual consistency\b|\bcausal consistency\b/i],
    ['Consensus (Raft/Paxos)', /\braft\b|\bpaxos\b/i],
    ['Leader election', /\bleader election\b/i],
    ['Quorums', /\bquorum\b/i],
    ['Replication', /\breplication\b/i],
    ['Sharding / partitioning', /\bshard/i],
    ['Distributed transactions / saga', /\bsaga\b|\btwo[- ]phase commit\b|\b2PC\b/i],
    ['Idempotency', /\bidempoten/i],
    ['Outbox pattern', /\boutbox\b/i],
    ['Event sourcing and CQRS', /\bevent sourcing\b|\bCQRS\b/i],
    ['Clocks and ordering', /\blamport\b|\bvector clock\b|\bhybrid logical clock\b/i],
    ['Backpressure', /\bbackpressure\b/i],
    ['Circuit breaker', /\bcircuit breaker\b/i],
    ['Bulkhead', /\bbulkhead\b/i],
    ['Multi-region', /\bmulti[- ]region\b/i],
    ['Disaster recovery (RPO/RTO)', /\bRPO\b|\bRTO\b/],
  ],
  'Data': [
    ['SQL joins and aggregation', /\binner join\b|\bleft join\b/i],
    ['Window functions', /\bwindow function\b|\bROW_NUMBER\b/i],
    ['CTEs', /\bcommon table expression\b|\bCTE\b/],
    ['Indexes (B-tree, composite)', /\bB[+-]?tree\b|\bcomposite index\b/i],
    ['Execution plans', /\bexecution plan\b|\bquery plan\b/i],
    ['ACID and transactions', /\bACID\b/],
    ['Isolation levels', /\bisolation level\b|\bread committed\b/i],
    ['Locking and deadlocks', /\bdeadlock\b/i],
    ['MVCC', /\bMVCC\b|\bmulti[- ]version concurrency\b/i],
    ['Normalisation', /\bnormali[sz]ation\b|\b3NF\b/i],
    ['NoSQL families', /\bdocument (store|database)\b|\bwide[- ]column\b|\bkey[- ]value store\b/i],
    ['Redis', /\bredis\b/i],
    ['Schema migration', /\bschema migration\b|\bexpand.{0,10}contract\b/i],
    ['Backup and restore', /\bpoint[- ]in[- ]time restore\b|\bbackup\b/i],
    ['Multi-tenancy', /\bmulti[- ]tenan/i],
  ],
  'Languages and runtimes': [
    ['Java language and collections', /\bArrayList\b|\bHashMap\b/],
    ['Java concurrency and JMM', /\bjava memory model\b|\bhappens[- ]before\b/i],
    ['JVM internals and GC', /\bJVM\b.*\bgarbage\b|\bG1\b|\bmetaspace\b/i],
    ['Virtual threads', /\bvirtual thread\b|\bproject loom\b/i],
    ['C# type system', /\bvalue type\b.*\breference type\b|\bboxing\b/i],
    ['C# async/await', /\basync\b.*\bawait\b/i],
    ['CLR and .NET GC', /\bCLR\b|\blarge object heap\b/i],
    ['LINQ', /\bLINQ\b/],
    ['JavaScript event loop', /\bevent loop\b|\bmicrotask\b/i],
    ['TypeScript type system', /\bstructural typing\b|\butility types?\b/i],
    ['React hooks and rendering', /\buseState\b|\buseEffect\b/],
    ['Python', /\bpython\b/i],
    ['C++ RAII and smart pointers', /\bRAII\b|\bunique_ptr\b/],
    ['Node.js runtime', /\blibuv\b|\bnode\.js\b/i],
  ],
  'Engineering craft': [
    ['SOLID', /\bSOLID\b/],
    ['Design patterns', /\bstrategy pattern\b|\bfactory (method|pattern)\b/i],
    ['Clean / hexagonal architecture', /\bhexagonal\b|\bclean architecture\b|\bports and adapters\b/i],
    ['Domain-driven design', /\bbounded context\b|\bubiquitous language\b|\baggregate root\b/i],
    ['Repository / unit of work', /\bunit of work\b|\brepository pattern\b/i],
    ['UML', /\bUML\b/],
    ['Clean code and refactoring', /\brefactor/i],
    ['Code review', /\bcode review\b/i],
    ['Git and branching', /\brebase\b|\bgit\b/i],
    ['SDLC and agile', /\bscrum\b|\bkanban\b/i],
    ['Design docs and ADRs', /\bADR\b|\barchitecture decision record\b|\bdesign doc/i],
    ['Build and dependency management', /\bmaven\b|\bgradle\b|\blockfile\b/i],
  ],
  'Quality and operations': [
    ['Test pyramid and strategy', /\btest pyramid\b/i],
    ['Unit testing and test doubles', /\btest double\b|\bmock\b/i],
    ['Integration testing', /\bintegration test/i],
    ['Contract testing', /\bcontract test/i],
    ['End-to-end testing', /\bend[- ]to[- ]end test|\be2e\b/i],
    ['TDD', /\bred[- ]green[- ]refactor\b|\btest[- ]driven development\b/i],
    ['Load and performance testing', /\bload test/i],
    ['Chaos engineering', /\bchaos (engineering|testing)\b/i],
    ['Logs, metrics, traces', /\bdistributed tracing\b/i],
    ['SLI/SLO/error budgets', /\berror budget\b/i],
    ['Percentiles', /\bp99\b|\bpercentile\b/i],
    ['Incident management', /\bpostmortem\b|\bincident (management|response)\b/i],
    ['Capacity planning', /\bcapacity planning\b/i],
    ['Profiling and debugging', /\bprofil(er|ing)\b|\bflame ?graph\b/i],
  ],
  'Platform': [
    ['Docker', /\bdocker\b/i],
    ['Kubernetes', /\bkubernetes\b|\bk8s\b/i],
    ['CI/CD', /\bCI\/CD\b|\bcontinuous (integration|delivery)\b/i],
    ['Deployment strategies', /\bblue[- ]green\b|\bcanary\b/i],
    ['Infrastructure as code', /\bterraform\b|\binfrastructure as code\b/i],
    ['Cloud fundamentals', /\bavailability zone\b|\bregion\b/i],
    ['Managed identity / secrets', /\bmanaged identity\b|\bkey vault\b|\bsecret manage/i],
    ['Serverless', /\bserverless\b|\bazure functions\b|\blambda\b/i],
    ['Feature flags', /\bfeature flag\b/i],
  ],
  'Security': [
    ['AuthN vs AuthZ', /\bauthentication\b.*\bauthorization\b/i],
    ['OAuth 2.0 and OIDC', /\bOAuth\b|\bOpenID Connect\b/i],
    ['JWT', /\bJWT\b/],
    ['RBAC / ABAC', /\bRBAC\b|\bABAC\b/],
    ['OWASP and injection', /\bOWASP\b|\bSQL injection\b/i],
    ['XSS / CSRF / CORS', /\bXSS\b|\bCSRF\b|\bCORS\b/],
    ['Password hashing', /\bbcrypt\b|\bargon2\b|\bscrypt\b/i],
    ['TLS and certificates', /\bTLS\b|\bmTLS\b/],
    ['Threat modelling', /\bSTRIDE\b|\bthreat model/i],
    ['Supply chain / SBOM', /\bSBOM\b|\bsupply[- ]chain\b/i],
  ],
  'Networking and OS': [
    ['TCP/IP and handshake', /\bthree[- ]way handshake\b|\bTCP\b/i],
    ['HTTP versions', /\bHTTP\/2\b|\bHTTP\/3\b|\bQUIC\b/],
    ['DNS', /\bDNS\b/],
    ['WebSockets / SSE', /\bwebsocket\b|\bserver[- ]sent events\b/i],
    ['gRPC', /\bgRPC\b/],
    ['GraphQL', /\bGraphQL\b/],
    ['Processes and threads', /\bcontext switch\b/i],
    ['Virtual memory', /\bvirtual memory\b|\bpage fault\b/i],
    ['I/O models and epoll', /\bepoll\b|\bnon[- ]blocking I\/O\b/i],
    ['Linux CLI and triage', /\bstrace\b|\bjournalctl\b|\blsof\b/i],
  ],
  'AI engineering': [
    ['LLM fundamentals', /\btokeni[sz]ation\b|\bcontext window\b/i],
    ['Prompting and structured output', /\bfew[- ]shot\b|\bstructured output\b/i],
    ['Embeddings and vector search', /\bembedding\b|\bvector (search|database)\b/i],
    ['RAG', /\bRAG\b|\bretrieval[- ]augmented\b/i],
    ['Chunking', /\bchunking\b/i],
    ['Reranking', /\brerank/i],
    ['Agents and tool calling', /\btool calling\b|\bfunction calling\b/i],
    ['MCP', /\bmodel context protocol\b|\bMCP\b/],
    ['Guardrails and prompt injection', /\bprompt injection\b|\bguardrail/i],
    ['LLM evaluation', /\bevaluat.{0,20}LLM\b|\bfaithfulness\b/i],
  ],
  'The loop': [
    ['System design interview framework', /\brequirements gathering\b|\b45[- ]minute\b/i],
    ['Back-of-the-envelope estimation', /\bback[- ]of[- ]the[- ]envelope\b/i],
    ['Coding interview playbook', /\bthink (out loud|aloud)\b/i],
    ['Machine coding round', /\bmachine coding\b/i],
    ['LLD interview framework', /\bLLD (round|interview)\b/i],
    ['STAR and story bank', /\bSTAR\b.*\bsituation\b|\bstory bank\b/i],
    ['Resume deep dive', /\br[ée]sum[ée] (bullet|deep)|\bresume bullet\b/i],
    ['Levelling and offers', /\blevell?ing\b|\bnegotiat/i],
    ['Revision plan', /\brevision plan\b|\bstudy plan\b/i],
  ],
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const pages = walk(CONTENT).map((f) => {
  const raw = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const rel = path.relative(CONTENT, f).replace(/\\/g, '/');
  const title = (raw.match(/^title:\s*(.+)$/m) || ['', ''])[1];
  const headings = (raw.match(/^#{2,3}\s+.+$/gm) || []).join('\n');
  return { rel, title, headings, raw };
});

let missing = 0;
let weak = 0;
let strong = 0;
const report = [];

for (const [area, topics] of Object.entries(SYLLABUS)) {
  report.push(`\n## ${area}`);
  for (const [name, re] of topics) {
    const inTitle = pages.filter((p) => re.test(p.title));
    const inHeading = pages.filter((p) => re.test(p.headings));
    const inBody = pages.filter((p) => re.test(p.raw));
    let status;
    if (inTitle.length) status = 'PAGE';
    else if (inHeading.length) status = 'SECTION';
    else if (inBody.length >= 2) status = 'mention';
    else if (inBody.length === 1) status = 'WEAK';
    else status = 'MISSING';
    if (status === 'MISSING') missing++;
    else if (status === 'WEAK') weak++;
    else strong++;
    const where = (inTitle[0] || inHeading[0] || inBody[0] || {}).rel || '-';
    if (VERBOSE || status === 'MISSING' || status === 'WEAK') {
      report.push(`  ${status.padEnd(8)} ${name.padEnd(34)} ${inBody.length} page(s)  ${where}`);
    }
  }
}

console.log(report.join('\n'));
console.log(`\n${strong} topic(s) well covered, ${weak} weakly covered, ${missing} missing.\n`);
process.exit(missing ? 1 : 0);
