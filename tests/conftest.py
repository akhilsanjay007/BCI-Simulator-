"""Pytest configuration: exclude manual WebSocket smoke scripts (run with `python tests/...`)."""

collect_ignore = ["test_client.py", "test_decoder_client.py"]
