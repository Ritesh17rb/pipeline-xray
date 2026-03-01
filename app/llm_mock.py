from __future__ import annotations

from typing import List

from . import models


def generate_tests_from_spec(
    spec: models.ParsedSchema,
    model_name: str,
    chaos_level: int = 0,
    compliance_tags: list | None = None,
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

    # ── Chaos Level: Medium ──
    if chaos_level >= 1:
        tests.append(
            models.TestCaseDescriptor(
                name="test_deeply_nested_json_payload",
                category=models.TestCategory.MALICIOUS,
                endpoint_path="/events",
                method="POST",
                description="Sends a 50-level deep nested JSON to test stack overflow / recursion limits.",
                tags=["chaos", "recursion", "DoS"],
                code="""
def test_deeply_nested_json_payload(api_client):
    payload = {"payload": {}}
    current = payload["payload"]
    for i in range(50):
        current["nested"] = {}
        current = current["nested"]
    current["value"] = "deep"
    resp = api_client.post("/events", json={
        "event_id": "CHAOS-NEST",
        "event_type": "stress_test",
        "event_date": "2025-06-01",
        "payload": payload,
    })
    assert resp.status_code in (200, 201, 400, 413)
""".strip(),
            )
        )
        tests.append(
            models.TestCaseDescriptor(
                name="test_oversized_payload_10mb",
                category=models.TestCategory.MALICIOUS,
                endpoint_path="/payments",
                method="POST",
                description="Sends a 10MB customer_name to test size limits and memory safety.",
                tags=["chaos", "size-limit", "DoS"],
                code="""
def test_oversized_payload_10mb(api_client):
    huge_name = "A" * (10 * 1024 * 1024)
    resp = api_client.post("/payments", json={
        "amount": 100,
        "currency": "USD",
        "customer_name": huge_name,
    })
    assert resp.status_code in (400, 413)
""".strip(),
            )
        )

    # ── Chaos Level: High ──
    if chaos_level >= 2:
        tests.append(
            models.TestCaseDescriptor(
                name="test_redos_polynomial_regex_attack",
                category=models.TestCategory.MALICIOUS,
                endpoint_path="/events",
                method="POST",
                description="Sends ReDoS payload to test regex catastrophic backtracking in validators.",
                tags=["chaos", "ReDoS", "security"],
                code="""
def test_redos_polynomial_regex_attack(api_client):
    evil_string = "a" * 30 + "!"
    resp = api_client.post("/events", json={
        "event_id": "CHAOS-REDOS",
        "event_type": evil_string,
        "event_date": "2025-06-01",
        "payload": {},
    })
    assert resp.elapsed.total_seconds() < 5, "Regex took >5s — potential ReDoS"
""".strip(),
            )
        )
        tests.append(
            models.TestCaseDescriptor(
                name="test_billion_laughs_xml_bomb",
                category=models.TestCategory.MALICIOUS,
                endpoint_path="/events",
                method="POST",
                description="Sends XML Billion Laughs entity expansion payload to test parser limits.",
                tags=["chaos", "XML-bomb", "security"],
                code="""
def test_billion_laughs_xml_bomb(api_client):
    bomb = '<?xml version="1.0"?><!DOCTYPE lolz ['
    bomb += '<!ENTITY lol "lol">'
    for i in range(1, 10):
        bomb += f'<!ENTITY lol{i} "{("&lol" + str(i-1) + ";") * 10}">'
    bomb += ']><root>&lol9;</root>'
    resp = api_client.post("/events", json={
        "event_id": "CHAOS-XMLBOMB",
        "event_type": "xml_stress",
        "event_date": "2025-06-01",
        "payload": {"raw_xml": bomb},
    })
    assert resp.status_code in (200, 400, 413)
""".strip(),
            )
        )

    # ── Financial Integrity (Cross-Pipe Reconciliation) ──
    tests.append(
        models.TestCaseDescriptor(
            name="test_cross_pipe_reconciliation_shares",
            category=models.TestCategory.EDGE_CASE,
            endpoint_path="/events",
            method="POST",
            description=(
                "Cross-pipe semantic check: if System A records 100 shares purchased, "
                "the ledger balance in System B must match. Catches silent data loss."
            ),
            tags=["financial-integrity", "reconciliation", "semantic"],
            code="""
def test_cross_pipe_reconciliation_shares(api_client, ledger_client):
    trade = api_client.post("/events", json={
        "event_id": "TRADE-001",
        "event_type": "equity_purchase",
        "event_date": "2025-06-15",
        "payload": {"ticker": "PG", "shares": 100, "price_cents": 16500},
    })
    assert trade.status_code == 201
    balance = ledger_client.get("/balances/EQUITY-PG")
    assert balance.json()["shares"] == 100, (
        "Reconciliation FAILED: Trade pipe says 100 shares "
        f"but ledger shows {balance.json().get('shares')}"
    )
""".strip(),
        )
    )

    # ── PII Leak Detection ──
    tests.append(
        models.TestCaseDescriptor(
            name="test_pii_not_leaked_to_logs",
            category=models.TestCategory.PROPERTY_BASED,
            endpoint_path="/payments",
            method="POST",
            description=(
                "Verifies that PII (SSN, email, card numbers) in payloads is NOT "
                "echoed into application logs or downstream analytics feeds."
            ),
            tags=["pii", "security", "GDPR", "SOC2"],
            code="""
import re

PII_PATTERNS = [
    re.compile(r"\\b\\d{3}-\\d{2}-\\d{4}\\b"),  # SSN
    re.compile(r"\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b"),
    re.compile(r"\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\\b"),  # Visa/MC
]

def test_pii_not_leaked_to_logs(api_client, capture_logs):
    api_client.post("/payments", json={
        "amount": 5000,
        "currency": "USD",
        "customer_name": "John Doe",
        "ssn": "123-45-6789",
        "email": "john@example.com",
        "card": "4111111111111111",
    })
    logs = capture_logs()
    for pattern in PII_PATTERNS:
        assert not pattern.search(logs), f"PII leaked to logs: {pattern.pattern}"
""".strip(),
        )
    )

    return models.TestPlan(
        spec_title=spec.title,
        tests=tests,
    )

