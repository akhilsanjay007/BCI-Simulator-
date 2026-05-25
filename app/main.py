"""Compatibility entrypoint for FastAPI app after module reorganization."""

from app.core.main import app, decoder, generator, manual_decoder

__all__ = ["app", "decoder", "generator", "manual_decoder"]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
