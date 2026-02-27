# Data Pipe X-Ray Demo

This is a FastAPI-based prototype that turns invisible data-pipe testing into a **visual X-Ray** for backend systems. It is designed as a cinematic demo for enterprise teams with complex APIs, data transformations, and legacy integration layers.

The backend is fully mocked: it does **not** connect to any real databases or third-party systems. Instead, it simulates:

- Parsing messy OpenAPI / mapping documents.
- Having an \"LLM\" generate rich Python tests (happy paths, edge cases, malicious inputs, and property-based checks).
- Running those tests against a fake data pipeline and streaming events to the front-end.

The front-end (served by FastAPI) visualizes:

- The messy input spec on the left.
- Streaming, categorized Python tests on the right.
- An animated \"X-Ray\" graph showing data packets flowing through stages and lighting up green/red.
- A CI/CD view and a \"time saved\" ticker that quantify impact.

## Running locally

```bash
python -m venv .venv
.venv\Scripts\activate  # On Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open `http://127.0.0.1:8000/` in your browser.

## Notes

- All data, tests, and CI/CD outputs are synthetic and deterministic, optimized for a reliable live demo.
- The `assets/` folder is **not** used by this app; it only contains generic scaffolding from another system.
