import { h, render } from 'preact';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from './SafeMarkdown';
describe('safe minutes rendering', () => {
  it('renders headings, lists and emphasis while treating HTML and links as text', () => {
    const root = document.createElement('div');
    render(h(SafeMarkdown, { text: '# Overview\n**Decision**\n- Next action\n<script>window.bad = true</script>\n[link](javascript:alert(1))' }), root);
    expect(root.querySelector('h3')?.textContent).toBe('Overview');
    expect(root.querySelector('strong')?.textContent).toBe('Decision');
    expect(root.querySelector('li')?.textContent).toBe('Next action');
    expect(root.querySelector('script')).toBeNull(); expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('<script>');
    render(null, root);
  });
});
