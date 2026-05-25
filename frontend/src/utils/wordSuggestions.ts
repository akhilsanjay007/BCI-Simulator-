/**
 * Word bank + autocomplete for the BCI virtual keyboard.
 *
 * - Prefix chips while typing (`getWordSuggestions`)
 * - Swipe-to-type prediction on release (`predictSwipeWords`) via path / edit-distance scoring
 */

/** Common vocabulary for BCI typing (prefix match + swipe prediction). */
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
  "work",
  "try",
  "start",
  "stop",
  "open",
  "close",
  "left",
  "right",
  "monkey",
  "mind",
  "pong",
];

/** Max suggestion chips rendered above the keyboard (prefix + swipe). */
export const MAX_SUGGESTIONS = 5;

const STARTER_SUGGESTIONS = ["the", "I", "hello", "yes", "please"] as const;

/** UI + typed output always uses uppercase (word bank stays lowercase for matching). */
function displayWord(word: string): string {
  return word.toUpperCase();
}

/** Letters-only prefix of the word currently being typed. */
export function currentWordPrefix(fullText: string): string {
  const m = fullText.match(/([A-Za-z]*)$/);
  return m ? m[1].toLowerCase() : "";
}

/** Up to `limit` suggestion chips for the current partial word. */
export function getWordSuggestions(fullText: string, limit = MAX_SUGGESTIONS): string[] {
  const prefix = currentWordPrefix(fullText);
  if (prefix.length === 0) {
    return [...STARTER_SUGGESTIONS].slice(0, limit).map(displayWord);
  }

  const matches: string[] = [];
  for (const w of WORD_BANK) {
    if (w.length <= prefix.length) continue;
    if (w.startsWith(prefix)) {
      matches.push(displayWord(w));
      if (matches.length >= limit) break;
    }
  }

  if (matches.length > 0) return matches;

  return [...STARTER_SUGGESTIONS].slice(0, limit).map(displayWord);
}

/** Append the chosen suggestion to existing text (no leading/trailing space). */
export function applyWordSuggestion(fullText: string, word: string): string {
  return `${fullText}${displayWord(word)}`;
}

// ---------------------------------------------------------------------------
// Swipe path → word prediction (edit distance + path alignment)
// ---------------------------------------------------------------------------

/** Standard Levenshtein edit distance (insert / delete / substitute). */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}

/**
 * Ordered letter path from key ids: drop modifiers/digits, uppercase, and
 * collapse consecutive duplicates (gliding across the same key twice).
 */
function letterPathFromKeyIds(keyPath: readonly string[]): string[] {
  const path: string[] = [];
  for (const id of keyPath) {
    if (id.length !== 1 || !/[A-Za-z]/.test(id)) continue;
    const up = id.toUpperCase();
    if (path.length === 0 || path[path.length - 1] !== up) {
      path.push(up);
    }
  }
  return path;
}

/**
 * Score how well a swipe letter path matches a candidate word.
 *
 * Primary signal: normalized Levenshtein distance between the path string and
 * the target word (handles skipped / doubled keys on the glide).
 *
 * Secondary signals: endpoint letter match, length proximity, and a light bonus
 * when the path is a subsequence of the word (classic swipe-typing constraint).
 *
 * Returns `null` when the match is too weak to surface.
 */
function scoreSwipePath(path: readonly string[], word: string): number | null {
  if (path.length < 2) return null;

  const target = word.toUpperCase();
  const pathStr = path.join("");
  const maxLen = Math.max(pathStr.length, target.length);
  if (maxLen === 0) return null;

  const editDist = levenshteinDistance(pathStr, target);
  const maxEdit = Math.max(2, Math.ceil(maxLen * 0.55));
  if (editDist > maxEdit) return null;

  // Base score: 1 at perfect match, falling off with normalized edit distance.
  let score = 1 - editDist / maxLen;

  if (pathStr[0] === target[0]) score += 0.12;
  if (pathStr[pathStr.length - 1] === target[target.length - 1]) score += 0.12;
  score -= Math.abs(target.length - pathStr.length) * 0.06;

  if (isSwipeSubsequence(target, path)) score += 0.08;

  return score;
}

/**
 * Subsequence check with doubled-letter collapse on the word side
 * (path "HELO" can still align with word "HELLO").
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
 * Predict the top matching full words from an ordered swipe path of key ids.
 * Non-letter keys are ignored; results are ranked by composite path score.
 */
export function predictSwipeWords(keyPath: readonly string[], limit = MAX_SUGGESTIONS): string[] {
  const path = letterPathFromKeyIds(keyPath);
  if (path.length < 2) return [];

  type Scored = { word: string; score: number; idx: number };
  const scored: Scored[] = [];

  for (let idx = 0; idx < WORD_BANK.length; idx++) {
    const word = WORD_BANK[idx];
    if (word.length < 2) continue;
    const score = scoreSwipePath(path, word);
    if (score == null) continue;
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
    out.push(displayWord(s.word));
    if (out.length >= limit) return out;
  }

  return out;
}
