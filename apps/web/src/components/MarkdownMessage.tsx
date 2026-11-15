import { memo } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];
function safeUrl(url: string, key: string): string | undefined {
  if (key !== 'href') return undefined;
  const safe = defaultUrlTransform(url);
  try {
    return safe && ['http:', 'https:', 'mailto:'].includes(new URL(safe, 'https://vela.invalid').protocol) ? safe : undefined;
  } catch { return undefined; }
}
const components: Components = {
  a: ({ href, children, title }) => !href ? <span>{children}</span> : (
    <a href={href} title={title} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">
      {children}{!href.startsWith('#') && <span className="sr-only">（在新窗口打开）</span>}
    </a>
  ),
  img: ({ alt }) => <span className="text-muted">[图片：{alt || '未提供描述'}]</span>,
  table: ({ node: _node, ...props }) => (
    <div className="vela-markdown-table" role="region" aria-label="消息表格，可横向滚动" tabIndex={0}><table {...props} /></div>
  ),
  pre: ({ node: _node, ...props }) => <pre {...props} tabIndex={0} role="region" aria-label="代码块，可横向滚动" />,
};

export default memo(function MarkdownMessage({ text }: { text: string }) {
  return <div className="vela-markdown" data-testid="markdown-message">
    <Markdown remarkPlugins={plugins} skipHtml urlTransform={safeUrl} components={components}>{text}</Markdown>
  </div>;
});
