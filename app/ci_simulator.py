from __future__ import annotations

from . import models


def build_ci_summary(suite: models.TestSuite) -> models.CiSummary:
    """
    Construct a mock GitHub Actions-style pipeline with determinism insights.
    """
    total_tests = suite.total_tests

    determinism = models.CiDeterminismInsight(
        confidence=0.98,
        reasons=[
            "All external systems (RiskScoreAPI, LegacyEmulator) are mocked.",
            "No assertions depend on wall-clock time or random values.",
            "Property-based tests run with a fixed seed for reproducibility.",
        ],
    )

    steps = [
        models.CiStep(
            name="lint",
            status="success",
            duration_seconds=12.3,
            log_summary="Black, isort, and static checks passed.",
        ),
        models.CiStep(
            name="build",
            status="success",
            duration_seconds=35.1,
            log_summary="Container image built and tagged.",
        ),
        models.CiStep(
            name="generate-tests-ai",
            status="success",
            duration_seconds=4.2,
            log_summary=f"LLM generated {total_tests} tests across 4 categories.",
        ),
        models.CiStep(
            name="run-tests",
            status="success",
            duration_seconds=28.6,
            log_summary="All deterministic tests passed; 1 known red X-Ray scenario for demo purposes.",
        ),
        models.CiStep(
            name="publish-report",
            status="success",
            duration_seconds=6.4,
            log_summary="X-Ray report and coverage uploaded as CI artifacts.",
        ),
    ]

    yaml_snippet = """\
name: data-pipe-xray

on:
  pull_request:
    paths:
      - 'services/data-pipe/**'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: Install dependencies
        run: pip install -r requirements.txt
      - name: Generate AI tests
        run: python -m tools.generate_ai_tests --spec openapi.yml --out tests/ai
      - name: Run tests
        run: pytest -q
""".rstrip()

    return models.CiSummary(
        pipeline_name="GitHub Actions • data-pipe-xray",
        steps=steps,
        determinism=determinism,
        yaml_snippet=yaml_snippet,
    )

