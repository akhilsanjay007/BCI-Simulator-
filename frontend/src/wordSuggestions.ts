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

const STARTER_SUGGESTIONS = ["the", "I", "hello", "yes"] as const;

/** Letters-only prefix of the word currently being typed. */
export function currentWordPrefix(fullText: string): string {
  const m = fullText.match(/([A-Za-z]*)$/);
  return m ? m[1].toLowerCase() : "";
}

/** Up to `limit` suggestion chips for the current partial word. */
export function getWordSuggestions(fullText: string, limit = 4): string[] {
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
