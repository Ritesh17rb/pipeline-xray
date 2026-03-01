// backend.js — All Python backend logic ported to client-side JavaScript
// Replaces: spec_parser.py, llm_mock.py, test_generator.py, execution_engine.py, ci_simulator.py, main.py endpoints

let _lastTestsByCategory = {};
let _lastTestsInOrder = [];

// ── Spec Preview (replaces /api/spec/preview) ──
export function specPreview(specText, specType, name) {
  const sessionId = crypto.randomUUID();
  return {
    session_id: sessionId,
    summary: {
      title: name || "Payments & Events API",
      description:
        "API that accepts high-volume payments and business events, fan-out to analytics and legacy mainframe mirrors, and must tolerate schema drift and upstream quirks.",
      endpoint_count: 3,
      risk_flags: [
        "Schema drift from undocumented fields like extra_marketing_flag",
        "Date field event_date may arrive as either YYYY-MM-DD or Unix timestamp",
        "Idempotency expectations on /events via event_id",
        "Downstream legacy emulator integration may be unavailable or slow",
      ],
    },
  };
}

// ── Test Generation (replaces /api/tests/generate) ──
export function generateTests(sessionId, model, chaosLevel, complianceTags) {
  const tests = _makeTests(chaosLevel, complianceTags);

  _lastTestsByCategory = {};
  tests.forEach((t) => {
    if (!_lastTestsByCategory[t.category]) _lastTestsByCategory[t.category] = [];
    _lastTestsByCategory[t.category].push(t);
  });
  Object.keys(_lastTestsByCategory).forEach((k) => {
    _lastTestsByCategory[k].sort((a, b) => a.name.localeCompare(b.name));
  });

  _lastTestsInOrder = [];
  Object.values(_lastTestsByCategory).forEach((arr) => _lastTestsInOrder.push(...arr));

  const categoryCounts = {};
  Object.entries(_lastTestsByCategory).forEach(([cat, items]) => {
    categoryCounts[cat] = items.length;
  });

  const totalTests = tests.length;
  const estimatedMinutesSaved = totalTests * 5;
  const riskMitigatedUsd = totalTests * 12000;

  return {
    session_id: sessionId,
    categories: categoryCounts,
    total_tests: totalTests,
    estimated_minutes_saved: estimatedMinutesSaved,
    risk_mitigated_usd: riskMitigatedUsd,
    pii_findings: [
      { field: "customer_name", type: "Name", risk: "medium", detail: "Customer name passed through to analytics feed unmasked." },
      { field: "ssn", type: "SSN", risk: "critical", detail: "Social Security Number detected in payload. Must be masked before logging." },
      { field: "card", type: "Credit Card", risk: "critical", detail: "Card number (Visa) in payload. PCI-DSS requires tokenization." },
      { field: "email", type: "Email", risk: "high", detail: "Email address leaking to non-prod downstream. GDPR violation risk." },
    ],
    flakiness_map: {
      "API Gateway": 0.02,
      Validator: 0.05,
      Transformer: 0.28,
      Database: 0.03,
      "Legacy Emulator": 0.35,
      "Risk Score API": 0.12,
    },
    compliance_tags: complianceTags || [],
  };
}

// ── Code Streaming (replaces /ws/tests/code-stream/) ──
export function streamCodeChunks(onChunk) {
  return new Promise((resolve) => {
    const entries = [];
    for (const [category, tests] of Object.entries(_lastTestsByCategory)) {
      for (const test of tests) {
        entries.push({ category, test_name: test.name, code: test.code });
      }
    }
    let i = 0;
    function next() {
      if (i >= entries.length) {
        resolve();
        return;
      }
      onChunk(entries[i]);
      i++;
      setTimeout(next, 50);
    }
    next();
  });
}

// ── X-Ray Streaming (replaces /ws/tests/xray-stream/) ──
const PIPELINE_NODES = ["Client", "APIGateway", "Validator", "Transformer", "DB", "LegacyEmulator", "RiskScoreAPI"];

const FAILURE_MAP = {
  test_events_accepts_unix_timestamp_and_normalizes: {
    node: "Transformer",
    explanation:
      'The Transformer persisted the raw Unix timestamp (1719792000) instead of normalizing to YYYY-MM-DD. Downstream ledger reconciliation will break because the legacy system expects ISO-8601 date strings.',
  },
  test_create_payment_malicious_customer_name: {
    node: "Validator",
    explanation:
      "SQL injection payload \"Robert'); DROP TABLE payments;--\" passed through the Validator without sanitization. The API Gateway accepted the request and forwarded it unescaped. This is a critical security gap.",
  },
  test_events_tolerates_extra_marketing_flag: {
    node: "APIGateway",
    explanation:
      "Schema drift detected: the undocumented 'extra_marketing_flag' boolean field caused a strict-mode JSON schema validation error at the API Gateway. The pipe rejected data that production systems already send.",
  },
  test_redos_polynomial_regex_attack: {
    node: "Validator",
    explanation:
      "ReDoS attack: the Validator's event_type regex took >5 seconds on the crafted input 'aaaaaa...!' — polynomial backtracking. An attacker could tie up all worker threads with a single request.",
  },
  test_cross_pipe_reconciliation_shares: {
    node: "DB",
    explanation:
      "Reconciliation FAILURE: Trade pipe recorded 100 shares of PG, but the ledger balance query returned 90. Silent data loss of 10 shares between the event ingestion and ledger posting. $16,500 discrepancy.",
  },
};

export function streamXrayEvents(onEvent) {
  return new Promise((resolve) => {
    const events = [];
    for (const test of _lastTestsInOrder) {
      const catLabel = test.category;
      events.push({ event: "test_started", test_name: test.name, category: catLabel });

      let prev = null;
      for (const node of PIPELINE_NODES) {
        if (prev !== null) {
          events.push({ event: "packet_flow", test_name: test.name, category: catLabel, node_from: prev, node_to: node });
        }
        prev = node;
      }

      const failure = FAILURE_MAP[test.name];
      if (failure) {
        events.push({ event: "test_finished", test_name: test.name, category: catLabel, node: failure.node, passed: false, explanation: failure.explanation });
      } else {
        events.push({ event: "test_finished", test_name: test.name, category: catLabel, node: "DB", passed: true, explanation: "Data pipe accepted payload and persisted it successfully." });
      }
    }

    let i = 0;
    function next() {
      if (i >= events.length) {
        resolve();
        return;
      }
      const evt = events[i];
      onEvent(evt);
      i++;
      const delay = evt.event === "test_started" ? 80 : evt.event === "packet_flow" ? 50 : 120;
      setTimeout(next, delay);
    }
    next();
  });
}

// ── CI Summary (replaces /api/ci/summary) ──
export function getCiSummary(totalTests) {
  return {
    pipeline_name: "GitHub Actions \u2022 data-pipe-xray",
    steps: [
      { name: "lint", status: "success", duration_seconds: 12.3, log_summary: "Black, isort, and static checks passed." },
      { name: "build", status: "success", duration_seconds: 35.1, log_summary: "Container image built and tagged." },
      { name: "generate-tests-ai", status: "success", duration_seconds: 4.2, log_summary: `LLM generated ${totalTests} tests across 4 categories.` },
      { name: "run-tests", status: "success", duration_seconds: 28.6, log_summary: "All deterministic tests passed; 1 known red X-Ray scenario for demo purposes." },
      { name: "publish-report", status: "success", duration_seconds: 6.4, log_summary: "X-Ray report and coverage uploaded as CI artifacts." },
    ],
    determinism: {
      confidence: 0.98,
      reasons: [
        "All external systems (RiskScoreAPI, LegacyEmulator) are mocked.",
        "No assertions depend on wall-clock time or random values.",
        "Property-based tests run with a fixed seed for reproducibility.",
      ],
    },
    yaml_snippet: `name: data-pipe-xray

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
        run: pytest -q`,
  };
}

// ── Mock Services (replaces /api/mocks) ──
export function getMocksData() {
  return {
    mocks: [
      { name: "RiskScoreAPI", status: "healthy", description: "Third-party risk scoring service used during payment creation." },
      { name: "LegacyEmulator", status: "healthy", description: "Emulates writes into a legacy mainframe mirror." },
    ],
  };
}

// ── Internal: build all test descriptors (port of llm_mock.py) ──
function _makeTests(chaosLevel, complianceTags) {
  const tests = [];

  tests.push({
    name: "test_create_payment_happy_path",
    category: "Happy Path",
    code: `import pytest


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
    assert "payment_id" in body`,
  });

  tests.push({
    name: "test_create_payment_edge_amount_and_currency",
    category: "Edge Cases",
    code: `import pytest


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
    assert resp.status_code == expected_status`,
  });

  tests.push({
    name: "test_create_payment_malicious_customer_name",
    category: "Malicious Inputs",
    code: `import pytest


@pytest.mark.parametrize(
    "customer_name",
    [
        "Robert'); DROP TABLE payments;--",
        "\\u{1F600}\\u{1F4B3}\\u{2728}",
        "\\\\u202EMORF_TUO_DIAP",  # RTL-ish spoofing
    ],
)
def test_create_payment_malicious_customer_name(api_client, customer_name):
    payload = {
        "amount": 1234,
        "currency": "USD",
        "customer_name": customer_name,
    }
    resp = api_client.post("/payments", json=payload)
    assert resp.status_code in (201, 400)`,
  });

  tests.push({
    name: "test_events_idempotent_on_event_id",
    category: "Edge Cases",
    code: `def test_events_idempotent_on_event_id(api_client, read_downstream_events):
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
    assert len(downstream) == 1`,
  });

  tests.push({
    name: "test_events_accepts_unix_timestamp_and_normalizes",
    category: "Edge Cases",
    code: `def test_events_accepts_unix_timestamp_and_normalizes(api_client):
    payload = {
        "event_id": "EVT-TS-001",
        "event_type": "subscription_renewed",
        "event_date": 1_700_000_000,
        "payload": {},
    }
    resp = api_client.post("/events", json=payload)
    assert resp.status_code in (200, 201)
    body = resp.json()
    assert body["event_date"] == "2023-11-14"  # normalized date`,
  });

  tests.push({
    name: "test_events_rejects_malformed_date_string",
    category: "Edge Cases",
    code: `def test_events_rejects_malformed_date_string(api_client):
    payload = {
        "event_id": "EVT-BAD-DATE",
        "event_type": "subscription_renewed",
        "event_date": "31-12-2025",
        "payload": {},
    }
    resp = api_client.post("/events", json=payload)
    assert resp.status_code == 400
    assert "event_date" in resp.text`,
  });

  tests.push({
    name: "test_events_tolerates_extra_marketing_flag",
    category: "Edge Cases",
    code: `def test_events_tolerates_extra_marketing_flag(api_client):
    payload = {
        "event_id": "EVT-MARKETING",
        "event_type": "marketing_opt_in",
        "event_date": "2025-06-01",
        "extra_marketing_flag": True,
        "payload": {},
    }
    resp = api_client.post("/events", json=payload)
    assert resp.status_code in (200, 201)`,
  });

  tests.push({
    name: "test_customer_name_property_based",
    category: "Property-Based",
    code: `from hypothesis import given, strategies as st


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
    assert resp.status_code in (201, 400)`,
  });

  tests.push({
    name: "test_risk_score_api_fallback_when_down",
    category: "Malicious Inputs",
    code: `def test_risk_score_api_fallback_when_down(api_client, risk_score_mock):
    risk_score_mock.set_state("down")
    payload = {
        "amount": 5000,
        "currency": "USD",
        "customer_name": "Risky Business",
    }
    resp = api_client.post("/payments", json=payload)
    assert resp.status_code in (200, 201)`,
  });

  // Chaos Level: Medium
  if (chaosLevel >= 1) {
    tests.push({
      name: "test_deeply_nested_json_payload",
      category: "Malicious Inputs",
      code: `def test_deeply_nested_json_payload(api_client):
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
    assert resp.status_code in (200, 201, 400, 413)`,
    });
    tests.push({
      name: "test_oversized_payload_10mb",
      category: "Malicious Inputs",
      code: `def test_oversized_payload_10mb(api_client):
    huge_name = "A" * (10 * 1024 * 1024)
    resp = api_client.post("/payments", json={
        "amount": 100,
        "currency": "USD",
        "customer_name": huge_name,
    })
    assert resp.status_code in (400, 413)`,
    });
  }

  // Chaos Level: High
  if (chaosLevel >= 2) {
    tests.push({
      name: "test_redos_polynomial_regex_attack",
      category: "Malicious Inputs",
      code: `def test_redos_polynomial_regex_attack(api_client):
    evil_string = "a" * 30 + "!"
    resp = api_client.post("/events", json={
        "event_id": "CHAOS-REDOS",
        "event_type": evil_string,
        "event_date": "2025-06-01",
        "payload": {},
    })
    assert resp.elapsed.total_seconds() < 5, "Regex took >5s — potential ReDoS"`,
    });
    tests.push({
      name: "test_billion_laughs_xml_bomb",
      category: "Malicious Inputs",
      code: `def test_billion_laughs_xml_bomb(api_client):
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
    assert resp.status_code in (200, 400, 413)`,
    });
  }

  // Financial Integrity
  tests.push({
    name: "test_cross_pipe_reconciliation_shares",
    category: "Edge Cases",
    code: `def test_cross_pipe_reconciliation_shares(api_client, ledger_client):
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
    )`,
  });

  // PII Leak Detection
  tests.push({
    name: "test_pii_not_leaked_to_logs",
    category: "Property-Based",
    code: `import re

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
        assert not pattern.search(logs), f"PII leaked to logs: {pattern.pattern}"`,
  });

  return tests;
}
