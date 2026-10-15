/**
 * KLI — Code block + message content renderer
 *
 * Parses fenced code blocks (```lang … ```) out of a model reply and renders
 * them with line numbers, a copy button and lightweight syntax colouring.
 * The tokenizer is deliberately dependency-free and line-based: it colours
 * comments, strings, numbers and keywords — it is not a full parser, and it
 * never blocks the stream while a fence is still open (a partial reply ends
 * in an unclosed fence, which renders as a live code block).
 */

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ── Segment parsing ────────────────────────────────────────────────────── */

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language?: string };

/**
 * Splits markdown-ish content into text and fenced code segments.
 * An unclosed fence (streaming) yields the remainder as a code segment.
 */
export function parseMessageSegments(content: string): MessageSegment[] {
  const lines = content.split('\n');
  const segments: MessageSegment[] = [];
  let textBuffer: string[] = [];
  let codeLines: string[] = [];
  let language: string | undefined;
  let inCode = false;

  const flushText = () => {
    if (textBuffer.length > 0) {
      segments.push({ type: 'text', text: textBuffer.join('\n') });
      textBuffer = [];
    }
  };

  for (const line of lines) {
    if (!inCode) {
      if (line.startsWith('```')) {
        flushText();
        inCode = true;
        codeLines = [];
        const inline = line.slice(3).trim();
        language = inline.length > 0 ? inline : undefined;
      } else {
        textBuffer.push(line);
      }
    } else if (line.trim() === '```') {
      segments.push({ type: 'code', code: codeLines.join('\n'), ...(language ? { language } : {}) });
      inCode = false;
      codeLines = [];
      language = undefined;
    } else {
      codeLines.push(line);
    }
  }

  if (inCode) {
    segments.push({ type: 'code', code: codeLines.join('\n'), ...(language ? { language } : {}) });
  } else {
    flushText();
  }

  return segments;
}

/* ── Syntax colouring ───────────────────────────────────────────────────── */

const HASH_LANGS = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'rb', 'ruby', 'toml']);
const SQL_LIKE = new Set(['sql', 'lua']);

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends',
  'new', 'this', 'super', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch',
  'finally', 'throw', 'typeof', 'instanceof', 'interface', 'type', 'enum', 'implements', 'private',
  'public', 'protected', 'readonly', 'static', 'as', 'in', 'of', 'switch', 'case', 'break',
  'continue', 'do', 'yield', 'delete', 'void', 'null', 'undefined', 'true', 'false',
]);
const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'pass',
  'break', 'continue', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'global',
  'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'async',
  'await',
]);
const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function',
  'return', 'export', 'local', 'echo', 'exit', 'set', 'source', 'cd', 'read',
]);
const GENERIC_KEYWORDS = new Set([
  'func', 'package', 'import', 'return', 'if', 'else', 'for', 'while', 'struct', 'enum', 'impl',
  'trait', 'fn', 'let', 'mut', 'pub', 'use', 'match', 'const', 'static', 'class', 'new', 'this',
  'void', 'int', 'string', 'bool', 'true', 'false', 'null', 'nil', 'select', 'defer', 'go', 'try',
  'catch', 'throw', 'final', 'abstract', 'extends', 'implements',
]);

function keywordsFor(language?: string): ReadonlySet<string> {
  const lang = (language ?? '').toLowerCase();
  if (lang.startsWith('py')) return PY_KEYWORDS;
  if (HASH_LANGS.has(lang)) return SH_KEYWORDS;
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'java', 'c', 'cpp', 'cs', 'go'].includes(lang)) {
    return JS_KEYWORDS;
  }
  if (SQL_LIKE.has(lang)) return new Set(['select', 'from', 'where', 'insert', 'update', 'delete', 'create', 'table', 'join', 'on', 'and', 'or', 'not', 'null']);
  return GENERIC_KEYWORDS;
}

const TOKEN_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\w.%]*\b)|([A-Za-z_$][\w$]*)/g;

function highlightLine(line: string, keywords: ReadonlySet<string>, commentStyle: 'slash' | 'hash' | 'dash'): ReactNode {
  // Comment prefix first so tokens inside comments keep the comment colour.
  const commentIndex =
    commentStyle === 'hash' ? line.indexOf('#') : commentStyle === 'dash' ? line.indexOf('--') : line.indexOf('//');
  const codePart = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const commentPart = commentIndex >= 0 ? line.slice(commentIndex) : '';

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  TOKEN_RE.lastIndex = 0;
  let match = TOKEN_RE.exec(codePart);
  while (match !== null) {
    if (match.index > lastIndex) nodes.push(codePart.slice(lastIndex, match.index));
    const full = match[0] ?? '';
    const stringToken = match[1];
    const numberToken = match[2];
    const word = match[3];
    if (stringToken !== undefined) {
      nodes.push(
        <span key={key++} className="text-emerald-600 dark:text-emerald-400">
          {full}
        </span>,
      );
    } else if (numberToken !== undefined) {
      nodes.push(
        <span key={key++} className="text-cyan-700 dark:text-cyan-300">
          {full}
        </span>,
      );
    } else if (word !== undefined && keywords.has(word)) {
      nodes.push(
        <span key={key++} className="text-violet-600 dark:text-violet-400">
          {full}
        </span>,
      );
    } else {
      nodes.push(full);
    }
    lastIndex = match.index + full.length;
    match = TOKEN_RE.exec(codePart);
  }
  if (lastIndex < codePart.length) nodes.push(codePart.slice(lastIndex));
  if (commentPart) {
    nodes.push(
      <span key="comment" className="italic text-muted-foreground">
        {commentPart}
      </span>,
    );
  }
  return nodes;
}

/* ── CodeBlock ──────────────────────────────────────────────────────────── */

export interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
}

export const CodeBlock = memo(function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => code.split('\n'), [code]);
  const keywords = useMemo(() => keywordsFor(language), [language]);
  const commentStyle: 'slash' | 'hash' | 'dash' = useMemo(() => {
    const lang = (language ?? '').toLowerCase();
    if (HASH_LANGS.has(lang)) return 'hash';
    if (SQL_LIKE.has(lang)) return 'dash';
    return 'slash';
  }, [language]);

  const copy = useCallback(() => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked — ignore */
      });
  }, [code]);

  return (
    <div className={cn('group/code overflow-hidden rounded-lg border border-border bg-background', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {language || 'código'}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Código copiado' : 'Copiar código'}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <pre className="min-w-full py-2 font-mono text-xs leading-relaxed">
          <code>
            {lines.map((line, index) => (
              <span key={index} className="flex px-2">
                <span
                  aria-hidden="true"
                  className="mr-3 w-8 shrink-0 select-none text-right text-muted-foreground/60"
                >
                  {index + 1}
                </span>
                <span className="whitespace-pre">{highlightLine(line, keywords, commentStyle)}</span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
});

/* ── MessageContent ─────────────────────────────────────────────────────── */

export interface MessageContentProps {
  content: string;
  className?: string;
  /** Rendered after the last segment while the reply is still streaming. */
  streaming?: boolean;
}

/** Renders text segments verbatim and code segments as `CodeBlock`s. */
export function MessageContent({ content, className, streaming = false }: MessageContentProps) {
  const segments = useMemo(() => parseMessageSegments(content), [content]);
  return (
    <div className={cn('space-y-2', className)}>
      {segments.map((segment, index) =>
        segment.type === 'code' ? (
          <CodeBlock
            key={index}
            code={segment.code}
            {...(segment.language ? { language: segment.language } : {})}
          />
        ) : (
          <p key={index} className="whitespace-pre-wrap break-words leading-relaxed">
            {segment.text}
            {streaming && index === segments.length - 1 ? (
              <span className="ml-0.5 animate-pulse">▌</span>
            ) : null}
          </p>
        ),
      )}
      {streaming && segments.length > 0 && segments[segments.length - 1]?.type === 'code' ? (
        <span className="inline-block animate-pulse font-mono text-xs text-muted-foreground">▌</span>
      ) : null}
    </div>
  );
}
