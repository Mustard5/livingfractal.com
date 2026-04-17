#!/usr/bin/env python3
"""
Canonical keyword tokenizer for Living Fractal RAG retrieval.

Reads domain_stopwords.txt from the same directory and merges with
a built-in generic English stopword list. Provides:
  - tokenize(intent: str) -> list[str]   — importable function
  - CLI: python3 tokenize.py "intent text"  — prints space-separated tokens

Tokenization pipeline:
  1. Lowercase
  2. Strip punctuation except alphanumerics, dots, and hyphens
  3. Split on whitespace
  4. Strip leading/trailing dots and hyphens from each token (sentence boundaries)
  5. Split remaining intra-word hyphens into separate tokens
     — FTS5 unicode61 tokenizer splits on hyphens during indexing, so
       compound tokens like "low-latency" must be split here to avoid
       FTS5 MATCH treating "-" as a column-specifier operator
  6. Drop tokens < 3 chars
  7. Drop tokens starting with a digit (hardware specs: "8gb", "32gb", "4080")
  8. Drop purely numeric tokens
  9. Drop generic English stopwords
  10. Drop domain stopwords (from domain_stopwords.txt)
  11. Deduplicate, preserving first-occurrence order
  12. Return first 8 tokens
"""
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Generic English stopwords
# ---------------------------------------------------------------------------
ENGLISH_STOPWORDS = {
    'a', 'an', 'the',
    'i', 'me', 'my', 'we', 'our', 'you', 'your',
    'he', 'she', 'it', 'its', 'they', 'their',
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'shall', 'should', 'may', 'might', 'can', 'could',
    'to', 'of', 'in', 'on', 'at', 'by', 'for', 'from', 'with',
    'and', 'or', 'but', 'not', 'nor', 'so', 'yet', 'both',
    'if', 'as', 'up', 'out', 'go', 'no', 'into',
    'that', 'this', 'these', 'those',
    'all', 'any', 'each', 'few', 'more', 'most', 'other',
    'some', 'such', 'than', 'too', 'very',
    'just', 'also', 'only', 'even', 'what', 'how', 'when',
    'use', 'get', 'set', 'make', 'run',
    'nothing', 'everything', 'something', 'anything',
}

_DOMAIN_STOPWORDS: set[str] | None = None

def _load_domain_stopwords() -> set[str]:
    global _DOMAIN_STOPWORDS
    if _DOMAIN_STOPWORDS is not None:
        return _DOMAIN_STOPWORDS
    path = Path(__file__).parent / 'domain_stopwords.txt'
    words: set[str] = set()
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                words.add(line.lower())
    _DOMAIN_STOPWORDS = words
    return words


def tokenize(intent: str, max_tokens: int = 8) -> list[str]:
    """
    Extract retrieval keywords from a plain-language NixOS config intent.

    Returns up to max_tokens tokens, ordered by first appearance.
    """
    domain_sw = _load_domain_stopwords()
    all_stopwords = ENGLISH_STOPWORDS | domain_sw

    # Lowercase
    text = intent.lower()

    # Strip punctuation — keep alphanumeric, dots, and hyphens.
    text = re.sub(r"[^\w\s.\-]", ' ', text)

    raw_tokens = text.split()

    # Expand each raw token: strip boundary punctuation, then split on
    # intra-word hyphens. Produces a flat stream of candidate tokens.
    candidates: list[str] = []
    for raw in raw_tokens:
        stripped = raw.strip('.-')
        if not stripped:
            continue
        # Split on hyphens so "low-latency" → ["low", "latency"].
        # This matches how FTS5 unicode61 tokenizes the indexed text.
        parts = stripped.split('-')
        candidates.extend(p for p in parts if p)

    seen: set[str] = set()
    result: list[str] = []

    for tok in candidates:
        # Drop short tokens
        if len(tok) < 3:
            continue
        # Drop tokens starting with a digit (hardware specs: "8gb", "32gb")
        if tok[0].isdigit():
            continue
        # Drop purely numeric
        if tok.isdigit():
            continue
        # Drop stopwords
        if tok in all_stopwords:
            continue
        # Deduplicate
        if tok in seen:
            continue
        seen.add(tok)
        result.append(tok)
        if len(result) >= max_tokens:
            break

    return result


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 tokenize.py "intent text here"', file=sys.stderr)
        sys.exit(1)
    intent_text = ' '.join(sys.argv[1:])
    tokens = tokenize(intent_text)
    print(' '.join(tokens))
