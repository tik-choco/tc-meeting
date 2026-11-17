import { describe, expect, it } from 'vitest';
import { diffWords } from './textDiff';
import type { DiffPart } from './textDiff';

function reconstruct(parts: DiffPart[], side: 'before' | 'after') {
  return parts.filter(part => part.kind === 'same' || part.kind === (side === 'before' ? 'removed' : 'added')).map(part => part.text).join('');
}
function expectReconstruction(before: string, after: string) {
  const parts = diffWords(before, after);
  expect(reconstruct(parts, 'before')).toBe(before);
  expect(reconstruct(parts, 'after')).toBe(after);
  for (let i = 1; i < parts.length; i++) expect(parts[i].kind).not.toBe(parts[i - 1].kind);
  return parts;
}

describe('word diff', () => {
  it('highlights words while keeping contractions and hyphenated words together', () => {
    const parts = expectReconstruction("We can't ship the half-built version.", "We can ship the well-built version.");
    expect(parts).toContainEqual({ kind: 'removed', text: "can't" });
    expect(parts).toContainEqual({ kind: 'added', text: 'can' });
    expect(parts).toContainEqual({ kind: 'removed', text: 'half-built' });
    expect(parts).toContainEqual({ kind: 'added', text: 'well-built' });
  });
  it('diffs Han, kana and hangul at character boundaries', () => {
    const parts = expectReconstruction('今日は良い天気です。한글', '今日は素晴らしい天気です。한국');
    expect(parts).toContainEqual({ kind: 'removed', text: '良' });
    expect(parts).toContainEqual({ kind: 'added', text: '素晴らし' });
    expect(parts).toContainEqual({ kind: 'removed', text: '글' });
    expect(parts).toContainEqual({ kind: 'added', text: '국' });
    const mixed = expectReconstruction('サーバーtest', 'サーバーtrial');
    expect(mixed).toContainEqual({ kind: 'same', text: 'サーバー' });
    expect(mixed).toContainEqual({ kind: 'removed', text: 'test' });
    expect(mixed).toContainEqual({ kind: 'added', text: 'trial' });
  });
  it('aligns whitespace changes without marking unchanged words', () => {
    const parts = expectReconstruction('Hello  world\nagain', 'Hello\tworld again');
    expect(parts.filter(part => part.kind !== 'same').every(part => !part.text.trim())).toBe(true);
    expect(parts.filter(part => part.kind === 'same').map(part => part.text)).toEqual(['Hello', 'world', 'again']);
  });
  it('handles identical and empty strings', () => {
    expect(expectReconstruction('同じ text', '同じ text')).toEqual([{ kind: 'same', text: '同じ text' }]);
    expect(expectReconstruction('', '')).toEqual([]);
    expect(expectReconstruction('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
    expect(expectReconstruction('old', '')).toEqual([{ kind: 'removed', text: 'old' }]);
  });
  it('falls back to whole strings above the token product limit', () => {
    const before = `${'one '.repeat(251)}old`;
    const after = `${'one '.repeat(251)}new`;
    expect(expectReconstruction(before, after)).toEqual([{ kind: 'removed', text: before }, { kind: 'added', text: after }]);
    const boundedBefore = `${'one '.repeat(249)}old `;
    const boundedAfter = `${'one '.repeat(249)}new `;
    const withinLimit = expectReconstruction(boundedBefore, boundedAfter);
    expect(withinLimit.some(part => part.kind === 'same')).toBe(true);
  });
  it('reconstructs both sides across mixed edits, repeats and Unicode', () => {
    const samples = ['', 'a a b', 'a\nb', 'a  b!', 'a-b can’t', '你好世界', '今日🙂です', '한 글', 'e\u0301', ' \n'];
    for (const before of samples) for (const after of samples) expectReconstruction(before, after);
  });
  it("stays fast on pathological whitespace-heavy input", () => {
    const before = "a" + " ".repeat(1_000_000) + "b", after = "x ".repeat(10_000) + "y";
    const started = performance.now();
    const parts = diffWords(before, after);
    expect(performance.now() - started).toBeLessThan(500);
    expect(parts.filter(p => p.kind !== "added").map(p => p.text).join("")).toBe(before);
    expect(parts.filter(p => p.kind !== "removed").map(p => p.text).join("")).toBe(after);
  });
});
