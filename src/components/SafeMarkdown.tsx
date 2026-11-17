import type { ComponentChildren } from 'preact';
// Model output is always rendered as text nodes; HTML and links stay inert.
function inline(text: string): ComponentChildren {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}
export function SafeMarkdown({ text }: { text: string }) {
  return <div class="markdown">{text.split(/\r?\n/).map((line, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) return heading[1].length === 1 ? <h3 key={index}>{inline(heading[2])}</h3> : <h4 key={index}>{inline(heading[2])}</h4>;
    const bullet = /^\s*(?:[-*+] |\d+\. )(.+)$/.exec(line);
    if (bullet) return <ul key={index}><li>{inline(bullet[1])}</li></ul>;
    return line.trim() ? <p key={index}>{inline(line)}</p> : <div key={index} class="markdown-space" />;
  })}</div>;
}
