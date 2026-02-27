from __future__ import annotations

from typing import List

from . import models


def generate_tests_from_spec(
    spec: models.ParsedSchema,
    model_name: str,
) -> models.TestPlan:
    """
    Deterministic, hand-crafted \"LLM\" that emits expert-level tests.

    The goal is to *look* like a powerful model reasoning over the spec, while
    remaining fully contained and predictable for the demo.
    """
    tests: List[models.TestCaseDescriptor] = []

    # Happy path for POST /payments
    tests.append(
        models.TestCaseDescriptor(
            name="test_create_payment_happy_path",
            category=models.TestCategory.HAPPY_PATH,
            endpoint_path="/payments",
            method="POST",
            description=(
                "Creates a payment with a normal amount and supported currency, "
                "asserting a 201 response and a well-formed body."
            ),
            tags=["payments", "happy-path"],
            code="""
import pytest


def test_create_payment_happy_path(api_client):
    payload = {
        "amount": 10_000,
        "currency": "USD",
        "customer_name": "Jane Doe",
    }
    resp = api_client.post("/payments", json=payload)
    assert resp.status_code == 201
    body = resp.json()
    assert body["amount"] == payload["amount"]
    assert body["currency"] == payload["currency"]
    assert "payment_id" in body
""".strip(),
        )
    )

    # Edge cases for POST /payments – large amounts, unsupported currencies, etc.
    tests.append(
        models.TestCaseDescriptor(
            name="test_create_payment_edge_amount_and_currency",
            category=models.TestCategory.EDGE_CASE,
            endpoint_path="/payments",
            method="POST",
            description=(
                "Sends extreme amounts and edge currencies to make sure limits and "
                "validation rules are enforced."
            ),
            tags=["payments", "edge-case", "limits"],
            code="""
import pytest


@pytest.mark.parametrize(
    "amount,currency,expected_status",
    [
        (0, "USD", 400),
        (1, "ZZZ", 400),
        (10_000_000_000, "USD", 400),
        (99_99, "EUR", 201),
    ],
)
def test_create_payment_edge_amount_and_currency(api_client, amount, currency, expected_status):
    payload = {
        "amount": amount,
        "currency": currency,
        "customer_name": "Edge Case Customer",
    }
    resp = api_client.post("/payments", json=payload)
    assert resp.status_code == expected_status
""".strip(),
        )
    )

    # Malicious inputs on customer_name: SQL injection, emojis, RTL text, etc.
    tests.append(
        models.TestCaseDescriptor(
            name="test_create_payment_malicious_customer_name",
            category=models.TestCategory.MALICIOUS,
            endpoint_path="/payments",
            method="POST",
            description=(
                "Attempts SQL injection, emojis, and RTL text in customer_name to "
                "ensure the pipe and downstream sinks are hardened."
            ),
            tags=["payments", "security", "sql-injection"],
            code="""
import pytest


@pytest.mark.parametrize(
    "customer_name",
    [
        "Robert'); DROP TABLE payments;--",
        "😀💳✨",
        "\\u202EMORF_TUO_DIAP",  # RTL-ish spoofing
    ],
)
def test_create_payment_malicious_customer_name(api_client, customer_name):
    payload = {
        "amount": 1234,
        "currency": "USD",
        "customer_name": customer_name,
    }
    resp = api_client.post("/payments", json=payload)
    assert resp.status_code in (201, 400)
""".strip(),
        )
    )

    # Idempotency & state for POST /events via event_id.
    tests.append(
        models.TestCaseDescriptor(
            name="test_events_idempotent_on_event_id",
            category=models.TestCategory.EDGE_CASE,
            endpoint_path="/events",
            method="POST",
            description=(
                "Sends the same event three times and asserts that only one row is "
                "materialized downstream while responses remain stable."
            ),
            tags=["events", "idempotency", "state"],
            code="""
def test_events_idempotent_on_event_id(api_client, read_downstream_events):
    payload = {
        "event_id": "INV-123",
        "event_type": "invoice_created",
        "event_date": "2025-12-31",
        "payload": {"amount": 2500},
    }

    for _ in range(3):
        resp = api_client.post("/events", json=payload)
        assert resp.status_code in (200, 201)

    downstream = read_downstream_events("INV-123")
    assert len(downstream) == 1
""".strip(),
        )
    )

    # Data type mutation on event_date: string vs Unix timestamp.
    tests.append(
        models.TestCaseDescriptor(
            name="test_events_accepts_unix_timestamp_and_normalizes",
            category=models.TestCategory.EDGE_CASE,
            endpoint_path="/events",
            method="POST",
            description=(
                "Sends event_date as a Unix timestamp and verifies that the pipe "
                "normalizes it to YYYY-MM-DD."
            ),
            tags=["events", "date-type-mutation"],
            code="""
def test_events_accepts_unix_timestamp_and_normalizes(api_client):
    payload = {
        "event_id": "EVT-TS-001",
        "event_type": "subscription_renewed",
        "event_date": 1_700_000_000,
        "payload": {},
    }
    resp = api_client.post("/events", json=payload)
    assert resp.status_code in (200, 201)
    body = resp.json()
    assert body["event_date"] == "2023-11-14"  # normalized date
""".strip(),
        )
    )

    tests.append(
        models.TestCaseDescriptor(
            name="test_events_rejects_malformed_date_string",
            category=models.TestCategory.EDGE_CASE,
            endpoint_path="/events",
            method="POST",
            description="Rejects nonsense strings for event_date with a clear error message.",
            tags=["events", "date-validation"],
            code="""
def test_events_rejects_malformed_date_string(api_client):
    payload = {
        "event_id": "EVT-BAD-DATE",
        "event_type": "subscription_renewed",
        "event_date": "31-12-2025",
        "payload": {},
    }
    resp = api_client.post("/events", json=payload)
    assert resp.status_code == 400
    assert "event_date" in resp.text
""".strip(),
        )
    )

    # Schema drift tolerance – extra_marketing_flag should not break the pipe.
    tests.append(
        models.TestCaseDescriptor(
            name="test_events_tolerates_extra_marketing_flag",
            category=models.TestCategory.EDGE_CASE,
            endpoint_path="/events",
            method="POST",
            description=(
                "Injects undocumented extra_marketing_flag to prove that the pipe "
                "treats unknown fields as non-breaking."
            ),
            tags=["events", "schema-drift"],
            code="""
def test_events_tolerates_extra_marketing_flag(api_client):
    payload = {
        "event_id": "EVT-MARKETING",
        "event_type": "marketing_opt_in",
        "event_date": "2025-06-01",
        "extra_marketing_flag": True,
        "payload": {},
    }
    resp = api_client.post("/events", json=payload)
    assert resp.status_code in (200, 201)
""".strip(),
        )
    )

    # Property-based testing for customer_name using Hypothesis-style properties.
    tests.append(
        models.TestCaseDescriptor(
            name="test_customer_name_property_based",
            category=models.TestCategory.PROPERTY_BASED,
            endpoint_path="/payments",
            method="POST",
            description=(
                "Generates 100+ variations of customer_name (including emojis and "
                "SQL-looking strings) to assert invariants on the pipe."
            ),
            tags=["payments", "property-based", "hypothesis"],
            code="""
from hypothesis import given, strategies as st


@given(
    customer_name=st.text(
        min_size=1,
        max_size=64,
        alphabet=st.characters(blacklist_categories=["Cs"]),
    )
)
def test_customer_name_property_based(api_client, customer_name):
    payload = {
        "amount": 1234,
        "currency": "USD",
        "customer_name": customer_name,
    }
    resp = api_client.post("/payments", json=payload)
    assert resp.status_code in (201, 400)
""".strip(),
        )
    )

    # Mocking unmockable third-party service (RiskScoreAPI).
    tests.append(
        models.TestCaseDescriptor(
            name="test_risk_score_api_fallback_when_down",
            category=models.TestCategory.MALICIOUS,
            endpoint_path="/payments",
            method="POST",
            description=(
                "Simulates RiskScoreAPI being down and asserts that the pipe "
                "falls back gracefully instead of failing hard."
            ),
            tags=["payments", "third-party", "resilience"],
            code="""
def test_risk_score_api_fallback_when_down(api_client, risk_score_mock):
    risk_score_mock.set_state("down")
    payload = {
        "amount": 5000,
        "currency": "USD",
        "customer_name": "Risky Business",
    }
    resp = api_client.post("/payments", json=payload)
    assert resp.status_code in (200, 201)
""".strip(),
        )
    )

    return models.TestPlan(
        spec_title=spec.title,
        tests=tests,
    )

