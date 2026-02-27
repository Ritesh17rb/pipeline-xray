from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, AsyncIterator, Dict, List

from . import models


def build_test_suite(plan: models.TestPlan) -> models.TestSuite:
    """
    Group tests by category, attach demo-friendly metadata.
    """
    grouped: Dict[models.TestCategory, List[models.TestCaseDescriptor]] = defaultdict(list)
    for test in plan.tests:
        grouped[test.category].append(test)

    # Ensure deterministic ordering for the demo
    for category in list(grouped.keys()):
        grouped[category] = sorted(grouped[category], key=lambda t: t.name)

    return models.TestSuite(
        tests_by_category=dict(grouped),
        estimated_minutes_saved_per_test=5.0,
    )


async def stream_code_chunks(suite: models.TestSuite) -> AsyncIterator[Dict[str, Any]]:
    """
    Yield JSON messages that let the front-end simulate the AI typing tests out.

    We send whole tests at a time per category; the browser is responsible for
    rendering them character-by-character for a cinematic effect.
    """
    for category, tests in suite.tests_by_category.items():
        yield {
            "event": "category_start",
            "category": category.value,
            "count": len(tests),
        }
        await asyncio.sleep(0.05)

        for test in tests:
            yield {
                "event": "code_chunk",
                "category": category.value,
                "test_name": test.name,
                "code": test.code,
                "description": test.description,
            }
            # Brief pause between tests so the UI has time to animate
            await asyncio.sleep(0.05)

