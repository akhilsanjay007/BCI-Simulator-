"""Offline evaluation suite for the decoder (pytest; no live server)."""

from app.offline_eval import confusion_counts_offline, evaluate_decoder_offline


def test_offline_accuracy_above_chance() -> None:
    r = evaluate_decoder_offline(batches_per_intent=35, seed=7)
    assert r["n_samples"] == 5 * 35
    assert r["accuracy"] >= 0.45


def test_offline_accuracy_trained_on_synthetic() -> None:
    r = evaluate_decoder_offline(batches_per_intent=50, seed=42)
    assert r["accuracy"] >= 0.75


def test_offline_confusion_diagonal_dominates() -> None:
    table = confusion_counts_offline(batches_per_intent=40, seed=99)
    for true, preds in table.items():
        row_total = sum(preds.values())
        assert preds[true] >= row_total * 0.55
