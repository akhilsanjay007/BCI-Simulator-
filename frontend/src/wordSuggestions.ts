/** Common vocabulary for BCI typing autocomplete (prefix match). */
const WORD_BANK: readonly string[] = [
  "the",
  "and",
  "I",
  "to",
  "a",
  "is",
  "it",
  "you",
  "that",
  "he",
  "was",
  "for",
  "on",
  "are",
  "with",
  "as",
  "his",
  "they",
  "be",
  "at",
  "one",
  "have",
  "this",
  "from",
  "or",
  "had",
  "by",
  "not",
  "word",
  "but",
  "what",
  "all",
  "were",
  "we",
  "when",
  "your",
  "can",
  "said",
  "there",
  "use",
  "an",
  "each",
  "which",
  "she",
  "do",
  "how",
  "their",
  "if",
  "will",
  "up",
  "other",
  "about",
  "out",
  "many",
  "then",
  "them",
  "these",
  "so",
  "some",
  "her",
  "would",
  "make",
  "like",
  "into",
  "him",
  "time",
  "has",
  "look",
  "two",
  "more",
  "write",
  "go",
  "see",
  "number",
  "no",
  "way",
  "could",
  "people",
  "my",
  "than",
  "first",
  "water",
  "been",
  "call",
  "who",
  "oil",
  "its",
  "now",
  "find",
  "long",
  "down",
  "day",
  "did",
  "get",
  "come",
  "made",
  "may",
  "part",
  "hello",
  "yes",
  "no",
  "please",
  "thanks",
  "help",
  "brain",
  "neural",
  "signal",
  "decode",
  "cursor",
  "think",
  "thought",
  "text",
  "type",
  "control",
  "move",
  "click",
  "active",
  "idle",
  "fast",
  "slow",
  "good",
  "bad",
  "need",
  "want",
  "feel",
  "know",
  "think",
  "work",
  "try",
  "start",
  "stop",
  "open",
  "close",
  "left",
  "right",
  "up",
  "down",
];

/** Max suggestion chips rendered above the keyboard (used for both prefix + swipe). */
export const MAX_SUGGESTIONS = 5;

const STARTER_SUGGESTIONS = ["the", "I", "hello", "yes", "please"] as const;

/** Letters-only prefix of the word currently being typed. */
export function currentWordPrefix(fullText: string): string {
  const m = fullText.match(/([A-Za-z]*)$/);
  return m ? m[1].toLowerCase() : "";
}

/** Up to `limit` suggestion chips for the current partial word. */
export function getWordSuggestions(fullText: string, limit = MAX_SUGGESTIONS): string[] {
  const prefix = currentWordPrefix(fullText);
  if (prefix.length === 0) {
    return [...STARTER_SUGGESTIONS].slice(0, limit);
  }

  const matches: string[] = [];
  for (const w of WORD_BANK) {
    if (w.length <= prefix.length) continue;
    if (w.startsWith(prefix)) {
      matches.push(w);
      if (matches.length >= limit) break;
    }
  }

  if (matches.length > 0) return matches;

  return [...STARTER_SUGGESTIONS].slice(0, limit);
}

/** Replace the trailing partial word with the chosen suggestion plus a space. */
export function applyWordSuggestion(fullText: string, word: string): string {
  const prefix = currentWordPrefix(fullText);
  const base = prefix.length > 0 ? fullText.slice(0, -prefix.length) : fullText;
  return `${base}${word} `;
}

/**
 * Subsequence match allowing one path letter to satisfy consecutive doubled
 * letters in the word (so "hello" matches an "H-E-L-O" swipe path).
 */
function isSwipeSubsequence(word: string, path: readonly string[]): boolean {
  let j = 0;
  for (let i = 0; i < word.length; i++) {
    if (i > 0 && word[i] === word[i - 1]) continue;
    while (j < path.length && path[j] !== word[i]) j++;
    if (j >= path.length) return false;
    j++;
  }
  return true;
}

/**
 * Predict the most likely full words from an ordered swipe path of key ids.
 * Non-letter keys (space / backspace / digits / enter) are filtered out before
 * matching, so a glide that brushes them does not break the prediction.
 */
export function predictSwipeWords(keyPath: readonly string[], limit = MAX_SUGGESTIONS): string[] {
  const path: string[] = [];
  for (const id of keyPath) {
    if (id.length !== 1) continue;
    if (!/[A-Za-z]/.test(id)) continue;
    const up = id.toUpperCase();
    if (path.length === 0 || path[path.length - 1] !== up) {
      path.push(up);
    }
  }
  if (path.length < 2) return [];

  type Scored = { word: string; score: number; idx: number };
  const scored: Scored[] = [];

  for (let idx = 0; idx < WORD_BANK.length; idx++) {
    const word = WORD_BANK[idx];
    if (word.length < 2) continue;
    const upper = word.toUpperCase();
    if (!isSwipeSubsequence(upper, path)) continue;

    let score = 1.0;
    if (path[0] === upper[0]) score += 0.6;
    if (path[path.length - 1] === upper[upper.length - 1]) score += 0.6;
    score -= Math.abs(upper.length - path.length) * 0.08;
    scored.push({ word, score, idx });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });

  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (seen.has(s.word)) continue;
    seen.add(s.word);
    out.push(s.word);
    if (out.length >= limit) return out;
  }

  return out;
}
