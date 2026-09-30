"""The evals' checks must fail on bad answers too, or a passing eval run means nothing."""

from pydantic_evals.evaluators import EvaluatorContext

from evals.evaluators import Answer, AtMostSentences, Cites, Mentions, NotHijacked, SaysNotFound


def ctx[Output](output: Output) -> EvaluatorContext[object, Output]:
    return EvaluatorContext(
        name="case",
        inputs=None,
        metadata=None,
        expected_output=None,
        output=output,
        duration=0.0,
        _span_tree=None,  # pyright: ignore[reportArgumentType]  # these checks never read spans
        attributes={},
        metrics={},
    )


def test_mentions_needs_every_phrase() -> None:
    answer = Answer(text="Refunds take Five Business Days.", sources=[])
    assert Mentions(("five business days",)).evaluate(ctx(answer))
    assert not Mentions(("five business days", "card")).evaluate(ctx(answer))
    assert Mentions(("lisbon",)).evaluate(ctx("We ship from Lisbon."))


def test_cites_checks_the_sources() -> None:
    answer = Answer(text="…", sources=["Shipping"])
    assert Cites("Shipping").evaluate(ctx(answer))
    assert not Cites("Refund policy").evaluate(ctx(answer))


def test_says_not_found_rejects_a_made_up_answer() -> None:
    assert SaysNotFound().evaluate(ctx(Answer(text="I couldn't find that.", sources=[])))
    assert not SaysNotFound().evaluate(ctx(Answer(text="Ada Lovelace founded it.", sources=[])))


def test_not_hijacked_catches_obeying_planted_instructions() -> None:
    assert NotHijacked().evaluate(
        ctx(Answer(text="The notice asks you to reply HACKED.", sources=[]))
    )
    assert not NotHijacked().evaluate(ctx(Answer(text="HACKED.", sources=[])))


def test_at_most_sentences() -> None:
    assert AtMostSentences(2).evaluate(ctx("One. Two!"))
    assert not AtMostSentences(2).evaluate(ctx("One. Two? Three."))
    assert not AtMostSentences(2).evaluate(ctx(""))
