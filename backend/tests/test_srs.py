from datetime import datetime, timedelta

from app import srs
from app.word_parser import parse_word_list

NOW = datetime(2026, 1, 1, 12, 0)


def test_known_word_moves_up_one_box():
    r = srs.review(box=0, known=True, now=NOW)
    assert (r.box, r.status) == (1, srs.LEARNING)
    assert r.due_at == NOW + timedelta(days=1)


def test_intervals_grow_until_learned():
    box, days = 0, []
    for _ in range(5):
        r = srs.review(box, known=True, now=NOW)
        box = r.box
        days.append((r.due_at - NOW).days)
    assert days == [1, 3, 7, 14, 30]
    assert r.status == srs.LEARNED


def test_learned_word_stays_learned():
    r = srs.review(box=5, known=True, now=NOW)
    assert (r.box, r.status) == (5, srs.LEARNED)


def test_forgotten_word_drops_to_box_one_and_is_due_now():
    r = srs.review(box=4, known=False, now=NOW)
    assert (r.box, r.status, r.due_at) == (1, srs.FORGOTTEN, NOW)


def test_parser_handles_separators_and_examples():
    result = parse_word_list(
        "der Hund - собака\n"
        "laufen — бегать — Ich laufe jeden Morgen.\n"
        "hello = привет\n"
        "die E-Mail\tписьмо\n"
        "\n"
        "просто строка без перевода\n"
    )
    assert [(w.front, w.back) for w in result.words] == [
        ("der Hund", "собака"),
        ("laufen", "бегать"),
        ("hello", "привет"),
        ("die E-Mail", "письмо"),
    ]
    assert result.words[1].example == "Ich laufe jeden Morgen."
    assert result.errors == ["просто строка без перевода"]


def test_parser_example_lines_belong_to_word_above():
    result = parse_word_list(
        "der Hund - собака\n"
        "-- Der Hund schläft im Garten.\n"
        "... Собака спит в саду.\n"
        "laufen - бегать\n"
        "— Ich laufe jeden Morgen.\n"  # Mac turns -- into a long dash
        "… Я бегаю каждое утро.\n"  # and ... into one symbol
        "die Straße - улица\n"
    )
    assert [(w.front, w.back, w.example, w.example_translation) for w in result.words] == [
        ("der Hund", "собака", "Der Hund schläft im Garten.", "Собака спит в саду."),
        ("laufen", "бегать", "Ich laufe jeden Morgen.", "Я бегаю каждое утро."),
        ("die Straße", "улица", None, None),
    ]
    assert result.errors == []


def test_parser_example_on_the_same_line():
    result = parse_word_list("das Haus - дом -- Das Haus ist groß. ... Дом большой.")
    w = result.words[0]
    assert (w.front, w.back, w.example, w.example_translation) == (
        "das Haus", "дом", "Das Haus ist groß.", "Дом большой."
    )


def test_parser_example_without_word_is_an_error():
    result = parse_word_list("-- Ein Satz ohne Wort.\n... Перевод.")
    assert result.words == []
    assert len(result.errors) == 2


def test_parser_ellipsis_inside_a_sentence_is_kept():
    result = parse_word_list("warten - ждать\n-- Ich warte... und warte.")
    assert result.words[0].example == "Ich warte... und warte."
    assert result.words[0].example_translation is None
