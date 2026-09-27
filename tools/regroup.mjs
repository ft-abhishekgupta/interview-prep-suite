#!/usr/bin/env node
/**
 * Moves the flat per-section content files into ordered sub-group folders.
 * Idempotent: files already in the right place are left alone.
 *
 * Usage: node tools/regroup.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(__dirname, '..', 'src', 'content');
const DRY = process.argv.includes('--dry');

/**
 * section -> ordered list of [groupSlug, [topicSlug, ...]]
 * Topic slugs are the file name with the leading NN- stripped.
 */
const PLAN = {
  dsa: [
    ['foundations', ['complexity-analysis']],
    ['linear-structures', ['arrays-and-strings', 'hashing-maps-and-sets', 'linked-lists', 'stacks-queues-and-deques']],
    ['trees-and-heaps', ['heaps-and-priority-queues', 'binary-trees', 'binary-search-trees', 'tries']],
    ['graphs', ['graph-representations-and-traversal', 'union-find', 'topological-sort', 'shortest-path-algorithms', 'minimum-spanning-trees']],
    ['core-patterns', ['two-pointers', 'sliding-window', 'prefix-sum-and-difference-arrays', 'binary-search', 'sorting-algorithms', 'recursion-and-backtracking', 'greedy-algorithms', 'intervals-and-sweep-line', 'matrix-and-simulation', 'bit-manipulation']],
    ['dynamic-programming', ['dynamic-programming-foundations', 'dp-patterns']],
    ['interview-craft', ['coding-interview-playbook', 'must-solve-problem-list']],
  ],
  'system-design': [
    ['the-interview', ['how-to-run-a-system-design-interview', 'back-of-the-envelope-estimation']],
    ['building-blocks', ['load-balancing', 'api-gateway-and-reverse-proxy', 'cdn-and-edge', 'object-storage-and-file-systems', 'search-and-indexing', 'message-queues-and-pubsub', 'distributed-locks', 'job-scheduling-and-workflows']],
    ['caching', ['caching-strategies', 'cache-pitfalls-and-invalidation']],
    ['data-and-scale', ['choosing-a-database', 'scaling-and-statelessness', 'replication', 'sharding-and-partitioning']],
    ['distributed-systems-theory', ['cap-and-consistency-models', 'consensus-and-leader-election', 'distributed-transactions-and-saga', 'clocks-and-ordering']],
    ['reliability', ['availability-and-slos', 'latency-and-performance', 'fault-tolerance-and-disaster-recovery', 'multi-region-architecture']],
    ['architecture-styles', ['microservices-and-service-boundaries', 'event-driven-architecture-and-cqrs', 'architecture-patterns-cheatsheet']],
  ],
  'hld-problems': [
    ['foundational-designs', ['url-shortener', 'rate-limiter', 'distributed-cache']],
    ['social-and-messaging', ['news-feed', 'chat-system', 'notification-system']],
    ['commerce-and-transactions', ['ecommerce-platform', 'payment-system', 'ticket-booking']],
    ['location-and-media', ['ride-sharing', 'video-streaming', 'search-autocomplete']],
    ['data-and-pipelines', ['distributed-job-scheduler', 'content-moderation-pipeline', 'realtime-analytics-pipeline']],
  ],
  lld: [
    ['object-oriented-foundations', ['oop-fundamentals', 'composition-over-inheritance', 'solid-principles', 'uml-for-interviews']],
    ['design-patterns', ['creational-patterns', 'structural-patterns', 'behavioural-patterns-part-1', 'behavioural-patterns-part-2', 'design-patterns-cheatsheet']],
    ['designing-for-production', ['thread-safety-in-design', 'extensibility-and-testability']],
    ['the-interview', ['lld-interview-framework']],
  ],
  'lld-problems': [
    ['state-machines-and-hardware', ['parking-lot', 'elevator-system', 'vending-machine', 'atm']],
    ['games-and-catalogues', ['tic-tac-toe-and-chess', 'library-management']],
    ['booking-and-commerce', ['movie-ticket-booking', 'shopping-cart', 'order-matching-engine']],
    ['infrastructure-components', ['lru-and-lfu-cache', 'rate-limiter', 'logging-framework', 'task-scheduler', 'rule-engine', 'notification-service']],
  ],
  'csharp-dotnet': [
    ['type-system', ['value-and-reference-types', 'stack-heap-and-memory', 'classes-structs-and-records', 'interfaces-and-abstract-classes', 'keywords-that-get-asked', 'generics-boxing-and-collections']],
    ['functional-features', ['delegates-events-and-lambdas', 'linq-and-deferred-execution']],
    ['async-and-concurrency', ['async-await-fundamentals', 'task-cancellation-and-pitfalls', 'threads-tasks-and-the-threadpool', 'locks-and-synchronization', 'concurrent-collections-and-parallelism']],
    ['runtime-and-memory', ['exceptions-and-idisposable', 'garbage-collection', 'clr-jit-and-runtime-internals']],
  ],
  backend: [
    ['api-design', ['rest-principles', 'http-methods-status-codes-headers', 'api-versioning', 'pagination-filtering-and-sorting', 'openapi-and-api-contracts']],
    ['api-behaviour', ['idempotency', 'rate-limiting-implementation', 'validation-and-error-handling']],
    ['aspnet-core', ['aspnetcore-pipeline-and-middleware', 'controllers-and-minimal-apis', 'dependency-injection-lifetimes', 'authentication-and-authorization', 'configuration-logging-health-checks', 'background-services']],
    ['running-in-production', ['resilience-retries-and-circuit-breakers', 'production-readiness']],
  ],
  databases: [
    ['sql-craft', ['sql-joins-and-aggregation', 'window-functions', 'subqueries-and-ctes', 'sql-query-cheatsheet']],
    ['indexing-and-performance', ['indexes-explained', 'composite-indexes-and-query-design', 'execution-plans']],
    ['transactions-and-concurrency', ['transactions-and-acid', 'isolation-levels', 'locks-and-deadlocks']],
    ['data-modelling', ['normalization-and-denormalization', 'nosql-families', 'access-pattern-driven-modeling']],
    ['redis', ['redis-data-structures', 'redis-caching-patterns', 'redis-locks-streams-and-scaling']],
  ],
  azure: [
    ['platform-foundations', ['azure-fundamentals', 'networking-and-private-endpoints', 'traffic-routing-and-load-balancers', 'identity-managed-identity-and-key-vault']],
    ['compute', ['app-service-and-functions', 'aks-and-containers']],
    ['messaging', ['service-bus', 'event-hubs', 'event-grid', 'choosing-a-messaging-service']],
    ['cosmos-db-deep-dive', ['cosmos-db-fundamentals', 'cosmos-partitioning-and-request-units', 'cosmos-consistency-and-indexing', 'cosmos-change-feed-and-multi-region', 'cosmos-data-modeling']],
    ['data-services', ['azure-sql-and-redis', 'blob-storage-and-ai-search']],
  ],
  messaging: [
    ['models-and-guarantees', ['queues-topics-and-streams', 'delivery-semantics', 'ordering-and-partitioning']],
    ['building-reliable-consumers', ['idempotency-and-deduplication', 'retries-and-backoff', 'dead-letter-queues', 'consumer-groups-and-scaling', 'backpressure-and-flow-control']],
    ['distributed-data-patterns', ['outbox-and-inbox-patterns', 'saga-and-compensations', 'schema-evolution-and-versioning', 'replay-and-reprocessing']],
    ['putting-it-together', ['designing-a-production-pipeline']],
  ],
  'ai-engineering': [
    ['llm-foundations', ['llm-fundamentals', 'prompting-and-structured-output', 'tool-calling']],
    ['retrieval-and-rag', ['embeddings-and-vector-search', 'chunking-strategies', 'rag-architecture', 'retrieval-quality-and-reranking']],
    ['agents', ['ai-agents-fundamentals', 'agent-memory-and-planning', 'multi-agent-and-guardrails', 'model-context-protocol']],
    ['shipping-ai-systems', ['evaluating-llm-systems', 'ai-system-design-patterns', 'ai-system-design-case-studies']],
  ],
  frontend: [
    ['javascript-core', ['scope-closures-and-this', 'prototypes-and-inheritance', 'the-event-loop', 'promises-and-async-await', 'events-debounce-and-throttle']],
    ['typescript', ['typescript-type-system', 'typescript-generics-and-utility-types']],
    ['react', ['react-components-and-state', 'react-hooks', 'rendering-and-reconciliation', 'react-performance', 'state-management']],
    ['frontend-architecture', ['csr-ssr-and-code-splitting', 'frontend-security', 'frontend-testing']],
  ],
  security: [
    ['identity-and-access', ['authentication-vs-authorization', 'oauth2-and-openid-connect', 'jwt-deep-dive', 'access-control-models', 'workload-identity-and-secrets']],
    ['application-security', ['owasp-and-injection', 'xss-csrf-and-cors', 'passwords-and-sessions']],
    ['infrastructure-security', ['tls-and-certificates', 'cloud-and-network-security']],
    ['security-practice', ['vulnerability-management', 'threat-modelling-and-secure-design']],
  ],
  devops: [
    ['containers', ['docker-fundamentals', 'dockerfiles-and-builds', 'docker-networking-and-storage']],
    ['kubernetes', ['kubernetes-architecture', 'workloads-and-scheduling', 'services-ingress-and-config', 'autoscaling-and-resource-limits']],
    ['delivery', ['deployment-strategies', 'ci-cd-pipeline-design', 'gitops-and-platform-practices']],
    ['infrastructure-as-code', ['terraform-fundamentals', 'terraform-state-and-modules']],
  ],
  observability: [
    ['telemetry', ['logs-metrics-and-traces', 'distributed-tracing', 'dashboards-and-alerting']],
    ['reliability-targets', ['sli-slo-and-error-budgets', 'percentiles-and-saturation', 'capacity-planning']],
    ['operating-production', ['incident-management', 'production-debugging-playbook']],
  ],
  testing: [
    ['strategy', ['test-strategy-and-the-pyramid']],
    ['writing-tests', ['unit-testing-principles', 'test-doubles', 'integration-testing', 'contract-testing', 'end-to-end-testing']],
    ['testing-at-scale', ['load-and-performance-testing', 'chaos-and-resilience-testing']],
  ],
  fundamentals: [
    ['engineering-craft', ['clean-code-and-principles', 'code-review', 'git-and-branching']],
    ['evolving-systems', ['versioning-and-compatibility', 'schema-and-api-evolution', 'zero-downtime-deployments', 'migration-strategies']],
    ['performance', ['performance-profiling']],
    ['computer-science', ['processes-threads-and-scheduling', 'memory-and-virtual-memory']],
    ['networking', ['networking-tcp-and-ip', 'http-versions-and-protocols', 'dns-and-connection-setup', 'serialization-and-data-formats']],
  ],
  behavioural: [
    ['the-method', ['star-and-your-story-bank', 'leadership-principles-mapping']],
    ['story-themes', ['leadership-and-mentoring', 'conflict-and-disagreement', 'execution-and-delivery', 'ownership-and-initiative', 'failure-and-learning']],
    ['the-conversation', ['hiring-manager-round', 'questions-to-ask-and-company-prep']],
  ],
  resume: [
    ['preparation-framework', ['resume-deep-dive-framework', 'architecture-walkthrough-template', 'project-story-templates']],
    ['defending-the-detail', ['defending-your-numbers', 'trade-off-justification-bank', 'failure-scenario-drills']],
  ],
};

const pad = (n) => String(n).padStart(2, '0');
let moved = 0;
const problems = [];

for (const [section, groups] of Object.entries(PLAN)) {
  const sectionDir = path.join(CONTENT, section);
  if (!fs.existsSync(sectionDir)) {
    problems.push(`missing section folder: ${section}`);
    continue;
  }

  // Index every markdown file currently in the section (flat or already grouped).
  const index = new Map();
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full);
      else if (e.name.endsWith('.md')) {
        const slug = e.name.replace(/\.md$/, '').replace(/^\d+[-_]/, '');
        index.set(slug, full);
      }
    }
  };
  scan(sectionDir);

  const planned = new Set(groups.flatMap(([, slugs]) => slugs));
  for (const slug of index.keys()) {
    if (!planned.has(slug)) problems.push(`${section}: "${slug}" is not in the plan`);
  }

  groups.forEach(([groupSlug, slugs], gi) => {
    const groupDir = path.join(sectionDir, `${pad(gi + 1)}-${groupSlug}`);
    slugs.forEach((slug, ti) => {
      const src = index.get(slug);
      if (!src) {
        problems.push(`${section}/${groupSlug}: missing file for "${slug}"`);
        return;
      }
      const dest = path.join(groupDir, `${pad(ti + 1)}-${slug}.md`);
      if (path.resolve(src) === path.resolve(dest)) return;
      if (!DRY) {
        fs.mkdirSync(groupDir, { recursive: true });
        fs.renameSync(src, dest);
      }
      moved += 1;
    });
  });
}

// Remove any directories left empty by the moves.
function prune(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    prune(full);
    if (fs.readdirSync(full).length === 0 && !DRY) fs.rmdirSync(full);
  }
}
prune(CONTENT);

console.log(`\n${DRY ? '[dry run] ' : ''}Moved ${moved} file(s) into sub-groups.`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('Every file was accounted for.\n');
