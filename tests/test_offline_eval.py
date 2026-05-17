"""Offline evaluation suite for the decoder (pytest; no live server)."""

from app.offline_eval import evaluate_decoder_offline, velocity_error_histogram_offline


def test_offline_accuracy_above_chance() -> None:
    r = evaluate_decoder_offline(batches_per_target=35, seed=7)
    assert r["n_samples"] == 8 * 35
    assert r["accuracy"] >= 0.35


def test_offline_accuracy_trained_on_synthetic() -> None:
    r = evaluate_decoder_offline(batches_per_target=50, seed=42)
    assert r["accuracy"] >= 0.55


def test_offline_mean_velocity_error_reasonable() -> None:
    h = velocity_error_histogram_offline(batches=120, seed=99)
    assert h["mean_l2_error"] <= 0.82
