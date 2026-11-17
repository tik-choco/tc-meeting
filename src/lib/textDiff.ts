export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };

// CJK characters are separate tokens; elsewhere keep words and their inner apostrophes/hyphens together.
const TOKENS = /\s+|[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]|(?:(?![\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}])[\p{L}\p{N}])+(?:['’-](?:(?![\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}])[\p{L}\p{N}])+)*|[^\s]/gu;
const SPACE = /^\s+$/u;
const MAX_CELLS = 250000;
/** Inputs longer than this are never diffed token by token (bounds per-cell token work too). */
const MAX_CHARS = 20000;

export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  if (before.length + after.length > MAX_CHARS) return [{ kind: 'removed', text: before }, { kind: 'added', text: after }];
  const left = before.match(TOKENS) ?? [];
  const right = after.match(TOKENS) ?? [];
  if (!left.length) return [{ kind: 'added', text: after }];
  if (!right.length) return [{ kind: 'removed', text: before }];
  if (left.length * right.length > MAX_CELLS) return [{ kind: 'removed', text: before }, { kind: 'added', text: after }];

  // Compare interned token ids (all whitespace runs share one id), never strings, inside the O(n·m) loop.
  const ids = new Map<string, number>();
  const id = (token: string) => {
    const key = SPACE.test(token) ? ' ' : token;
    let value = ids.get(key);
    if (value === undefined) { value = ids.size; ids.set(key, value); }
    return value;
  };
  const leftIds = Int32Array.from(left, id);
  const rightIds = Int32Array.from(right, id);
  const width = right.length + 1;
  const lcs = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lcs[i * width + j] = leftIds[i] === rightIds[j] ? 1 + lcs[(i + 1) * width + j + 1] : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  function append(kind: DiffPart['kind'], text: string) {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  }
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (leftIds[i] === rightIds[j]) {
      // Different whitespace matches for alignment, but needs both forms for exact reconstruction.
      if (left[i] === right[j]) append('same', left[i]);
      else { append('removed', left[i]); append('added', right[j]); }
      i++; j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) append('removed', left[i++]);
    else append('added', right[j++]);
  }
  while (i < left.length) append('removed', left[i++]);
  while (j < right.length) append('added', right[j++]);
  return parts;
}
