from __future__ import annotations

import asyncio
from typing import AsyncIterator, Dict, List, Tuple

from . import models


PIPELINE_NODES: List[str] = [
    "Client",
    "APIGateway",
    "Validator",
    "Transformer",
    "DB",
    "LegacyEmulator",
    "RiskScoreAPI",
]


def build_execution_plan(suite: models.TestSuite) -> models.ExecutionPlan:
    """
    Flatten tests into an execution order and define mock external services.
    """
    tests_in_order: List[models.TestCaseDescriptor] = []
    for category, tests in suite.tests_by_category.items():
        tests_in_order.extend(tests)

    mocks = [
        models.MockServiceState(
            name="RiskScoreAPI",
            status="healthy",
            description="Third-party risk scoring service used during payment creation.",
        ),
        models.MockServiceState(
            name="LegacyEmulator",
            status="healthy",
            description="Emulates writes into a legacy mainframe mirror.",
        ),
    ]

    return models.ExecutionPlan(
        tests_in_order=tests_in_order,
        mocks=mocks,
    )


def _failure_mapping() -> Dict[str, Tuple[str, str]]:
    """
    Map specific tests to a failing node and explanation.
    """
    return {
        "test_events_accepts_unix_timestamp_and_normalizes": (
            "Transformer",
            "The Transformer persisted the raw Unix timestamp (1719792000) instead of "
            "normalizing to YYYY-MM-DD. Downstream ledger reconciliation will break "
            "because the legacy system expects ISO-8601 date strings.",
        ),
        "test_create_payment_malicious_customer_name": (
            "Validator",
            "SQL injection payload \"Robert'); DROP TABLE payments;--\" passed through "
            "the Validator without sanitization. The API Gateway accepted the request "
            "and forwarded it unescaped. This is a critical security gap.",
        ),
        "test_events_tolerates_extra_marketing_flag": (
            "APIGateway",
            "Schema drift detected: the undocumented 'extra_marketing_flag' boolean "
            "field caused a strict-mode JSON schema validation error at the API "
            "Gateway. The pipe rejected data that production systems already send.",
        ),
    }


async def stream_execution_events(
    plan: models.ExecutionPlan,
) -> AsyncIterator[Dict[str, object]]:
    """
    Simulate running tests through the data pipe and emit X-Ray events.
    """
    failures = _failure_mapping()

    for test in plan.tests_in_order:
        category_label = test.category.value

        # Test start
        start_event = models.ExecutionEvent(
            event="test_started",
            test_name=test.name,
            category=category_label,
        )
        yield start_event.model_dump()
        await asyncio.sleep(0.08)

        # Packet flowing through pipeline nodes
        previous = None
        for node in PIPELINE_NODES:
            if previous is not None:
                flow_event = models.ExecutionEvent(
                    event="packet_flow",
                    test_name=test.name,
                    category=category_label,
                    node_from=previous,
                    node_to=node,
                )
                yield flow_event.model_dump()
                await asyncio.sleep(0.05)
            previous = node

        failed_node = None
        explanation = ""
        if test.name in failures:
            failed_node, explanation = failures[test.name]

        if failed_node:
            finished = models.ExecutionEvent(
                event="test_finished",
                test_name=test.name,
                category=category_label,
                node=failed_node,
                passed=False,
                explanation=explanation,
            )
        else:
            finished = models.ExecutionEvent(
                event="test_finished",
                test_name=test.name,
                category=category_label,
                node="DB",
                passed=True,
                explanation="Data pipe accepted payload and persisted it successfully.",
            )

        yield finished.model_dump()
        await asyncio.sleep(0.12)

