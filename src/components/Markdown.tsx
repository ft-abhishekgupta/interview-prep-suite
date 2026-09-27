import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import { Mermaid } from './Mermaid';
import { copyText } from '../lib/utils';
import { IconCopy, IconCheck, IconAlert, IconInfo, IconZap, IconTarget, IconFlame } from './Icons';

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language || 'text'}</span>
        <button className={`code-copy${copied ? ' copied' : ''}`} onClick={onCopy} type="button">
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={language ? `hljs language-${language}` : 'hljs'}>{code}</code>
      </pre>
    </div>
  );
}

/** Syntax-highlighted variant that keeps rehype-highlight's generated spans. */
function HighlightedCodeBlock({ language, children, plain }: { language: string; children: ReactNode; plain: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(plain)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language || 'text'}</span>
        <button className={`code-copy${copied ? ' copied' : ''}`} onClick={onCopy} type="button">
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const CALLOUT_ICONS: Record<string, ReactNode> = {
  tip: <IconZap size={17} />,
  warning: <IconAlert size={17} />,
  danger: <IconFlame size={17} />,
  note: <IconInfo size={17} />,
  key: <IconTarget size={17} />,
};

const CALLOUT_LABELS: Record<string, string> = {
  tip: 'Tip',
  warning: 'Watch out',
  danger: 'Common mistake',
  note: 'Note',
  key: 'Key idea',
};

const ALIAS: Record<string, string> = {
  tip: 'tip',
  success: 'tip',
  info: 'note',
  note: 'note',
  warning: 'warning',
  caution: 'warning',
  danger: 'danger',
  error: 'danger',
  important: 'key',
  key: 'key',
  remember: 'key',
  'interview tip': 'key',
  'gotcha': 'danger',
  'pitfall': 'danger',
};

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  const el = node as { props?: { children?: unknown } };
  if (el.props?.children !== undefined) return textOf(el.props.children);
  return '';
}

/**
 * Renders a blockquote as a styled callout when it starts with a
 * `[!TIP]`, `**Tip:**` or `TIP:` marker; otherwise renders a plain quote.
 */
function Blockquote({ children }: { children?: ReactNode }) {
  const raw = textOf(children).trimStart();
  const gh = raw.match(/^\[!([A-Za-z ]+)\]\s*/);
  const inline = raw.match(/^([A-Za-z ]{3,16}):\s/);
  const keyword = (gh?.[1] ?? inline?.[1] ?? '').trim().toLowerCase();
  const kind = ALIAS[keyword];

  if (!kind) return <blockquote>{children}</blockquote>;

  const stripLead = (node: ReactNode): ReactNode => {
    if (typeof node === 'string') {
      return node.replace(/^\s*\[![A-Za-z ]+\]\s*/, '').replace(/^\s*[A-Za-z ]{3,16}:\s*/, '');
    }
    if (Array.isArray(node)) {
      const arr = [...node];
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string' && (arr[i] as string).trim() !== '') {
          arr[i] = stripLead(arr[i] as ReactNode);
          break;
        }
      }
      return arr;
    }
    return node;
  };

  const body = Array.isArray(children)
    ? children.map((c, i) => (i === 0 ? stripLead(c as ReactNode) : c))
    : stripLead(children as ReactNode);

  return (
    <div className={`callout ${kind}`}>
      <span className="callout-icon">{CALLOUT_ICONS[kind]}</span>
      <div className="callout-body">
        <div className="callout-title">{gh ? CALLOUT_LABELS[kind] : CALLOUT_LABELS[kind]}</div>
        {body}
      </div>
    </div>
  );
}

export interface MarkdownProps {
  children: string;
  /** Skip heading ids/anchors (used inside collapsible answers). */
  compact?: boolean;
}

function MarkdownInner({ children, compact = false }: MarkdownProps) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={compact ? [[rehypeHighlight, { detect: true, ignoreMissing: true }]] : [rehypeSlug, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre({ children }) {
            // The <code> child carries language + highlighted spans.
            const child = Array.isArray(children) ? children[0] : children;
            const el = child as { props?: { className?: string; children?: ReactNode } } | undefined;
            const className = el?.props?.className ?? '';
            const lang = /language-(\w[\w+-]*)/.exec(className)?.[1] ?? '';
            const plain = textOf(el?.props?.children).replace(/\n$/, '');
            if (lang === 'mermaid') return <Mermaid code={plain} />;
            return (
              <HighlightedCodeBlock language={lang} plain={plain}>
                {children}
              </HighlightedCodeBlock>
            );
          },
          code({ className, children, ...props }) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          table({ children }) {
            return (
              <div className="table-wrap">
                <table>{children}</table>
              </div>
            );
          },
          blockquote({ children }) {
            return <Blockquote>{children}</Blockquote>;
          },
          h2({ children, id }) {
            return (
              <h2 id={id}>
                {!compact && id && (
                  <a className="heading-anchor" href={`#${id}`} aria-label="Link to section">
                    #
                  </a>
                )}
                {children}
              </h2>
            );
          },
          h3({ children, id }) {
            return (
              <h3 id={id}>
                {!compact && id && (
                  <a className="heading-anchor" href={`#${id}`} aria-label="Link to section">
                    #
                  </a>
                )}
                {children}
              </h3>
            );
          },
          a({ href, children }) {
            const external = href?.startsWith('http');
            return (
              <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer noopener' : undefined}>
                {children}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownInner);
export { CodeBlock };
