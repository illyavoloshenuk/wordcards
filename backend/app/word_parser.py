"""Turn a pasted list of words into cards.

One word per line: word and translation separated by a dash, tab, "=" or ";".
Under a word you can add an example and its translation on their own lines:

    der Hund - собака
    -- Der Hund schläft im Garten.
    ... Собака спит в саду.
    laufen - бегать

    a line starting with "--"  is the example for the word above
    a line starting with "..." is the translation of that example

The same can be written on one line:

    der Hund - собака -- Der Hund schläft. ... Собака спит.

The older short form "word - translation - example" still works.
"""
import re
from dataclasses import dataclass

# A dash only counts as a separator when it has spaces around it,
# so words like "E-Mail" stay whole.
_SEPARATOR = re.compile(r"\s+[-–—=]\s+|\t|\s*;\s*")

# "--" (Mac often turns it into "—" or "–") at the start of a line = example.
_EXAMPLE_LINE = re.compile(r"^(?:-{2,}|[—–])\s*(.+)$")
# "..." (or "…") at the start of a line = translation of the example.
_EXAMPLE_TRANSLATION_LINE = re.compile(r"^(?:\.{3,}|…)\s*(.+)$")

# The same markers in the middle of a line, with spaces around them.
_INLINE_EXAMPLE = re.compile(r"\s+-{2,}\s+")
_INLINE_TRANSLATION = re.compile(r"\s+(?:\.{3,}|…)\s+")


@dataclass
class ParsedWord:
    front: str
    back: str
    example: str | None = None
    example_translation: str | None = None


@dataclass
class ParseResult:
    words: list[ParsedWord]
    errors: list[str]  # lines that could not be understood


def _add(current: str | None, extra: str) -> str:
    """A word can have several examples - keep them on separate lines."""
    return f"{current}\n{extra}" if current else extra


def _split_example(text: str) -> tuple[str, str | None]:
    """'Der Hund schläft. ... Собака спит.' -> (example, translation)."""
    parts = _INLINE_TRANSLATION.split(text, maxsplit=1)
    translation = parts[1].strip() if len(parts) == 2 and parts[1].strip() else None
    return parts[0].strip(), translation


def parse_word_list(text: str) -> ParseResult:
    words: list[ParsedWord] = []
    errors: list[str] = []
    last: ParsedWord | None = None  # the word that example lines belong to

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        # Example line: "-- Der Hund schläft."
        m = _EXAMPLE_LINE.match(line)
        if m:
            if last is None:
                errors.append(line)
                continue
            example, translation = _split_example(m.group(1))
            last.example = _add(last.example, example)
            if translation:
                last.example_translation = _add(last.example_translation, translation)
            continue

        # Translation of the example: "... Собака спит."
        m = _EXAMPLE_TRANSLATION_LINE.match(line)
        if m:
            if last is None or not last.example:
                errors.append(line)
                continue
            last.example_translation = _add(last.example_translation, m.group(1).strip())
            continue

        # A word line, maybe with an example on the same line after " -- ".
        main, *rest = _INLINE_EXAMPLE.split(line, maxsplit=1)
        parts = [p.strip() for p in _SEPARATOR.split(main, maxsplit=2)]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            errors.append(line)
            last = None
            continue

        word = ParsedWord(front=parts[0][:200], back=parts[1][:200])
        example_text = rest[0].strip() if rest else (parts[2] if len(parts) == 3 else "")
        if example_text:
            word.example, word.example_translation = _split_example(example_text)
        words.append(word)
        last = word

    return ParseResult(words=words, errors=errors)
