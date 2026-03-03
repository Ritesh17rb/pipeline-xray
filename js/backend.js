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

  const categoryCounts = {
    "Happy Path": 0,
    "Edge Cases": 0,
    "Malicious Inputs": 0,
    "Property-Based": 0,
  };
  Object.entries(_lastTestsByCategory).forEach(([cat, items]) => {
    if (categoryCounts.hasOwnProperty(cat)) categoryCounts[cat] = items.length;
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

// ── Expose last tests for CI/YAML generation ──
export function getLastTestsInOrder() {
  return _lastTestsInOrder;
}

// ── Code Streaming (replaces /ws/tests/code-stream/) ──
export function streamCodeChunks(onChunk) {
  return new Promise((resolve) => {
    const entries = [];
    for (const [category, tests] of Object.entries(_lastTestsByCategory)) {
      for (const test of tests) {
        entries.push({
          category,
          test_name: test.name,
          code: test.code,
          expertTag: test.expertTag || "",
          insightBeginner: test.insightBeginner || "",
          insightExpert: test.insightExpert || "",
          confidence: test.confidence != null ? test.confidence : 0.98,
        });
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
      setTimeout(next, 120);
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
      const delay = evt.event === "test_started" ? 350 : evt.event === "packet_flow" ? 200 : 500;
      setTimeout(next, delay);
    }
    next();
  });
}

// ── CI Summary (replaces /api/ci/summary) ──
export function getCiSummary(totalTests, testList) {
  const tests = testList || _lastTestsInOrder;
  const testNames = tests.map((t) => t.name);
  const failedCount = testNames.filter((n) => FAILURE_MAP[n]).length;
  const passedCount = totalTests - failedCount;
  const runTestsLog =
    "collected " +
    totalTests +
    " items\n" +
    testNames
      .map((name, i) => {
        const pct = Math.round(((i + 1) / totalTests) * 100);
        const result = FAILURE_MAP[name] ? "FAILED" : "PASSED";
        return `test_ai.py::${name} ${result}  [${pct}%]`;
      })
      .join("\n") +
    "\n========= " +
    passedCount +
    " passed, " +
    failedCount +
    " failed in 4.7s =========";

  const steps = [
    { name: "Checkout code", status: "queued", duration_seconds: 1, log_summary: "Fetching repository...", log_body: "git clone ...\nHEAD is at a1b2c3d" },
    { name: "Install dependencies", status: "queued", duration_seconds: 1.5, log_summary: "Installing Python deps...", log_body: "pip install -r requirements.txt\nSuccessfully installed pytest-7.4.3 ..." },
    { name: "Run AI-generated tests", status: "queued", duration_seconds: 2, log_summary: `Running ${totalTests} tests...`, log_body: runTestsLog },
    { name: "Schema drift analysis", status: "queued", duration_seconds: 1, log_summary: "Checking for undocumented fields...", log_body: "Schema drift check: 1 test (extra_marketing_flag)\nNo breaking drift detected." },
    { name: "Flakiness gate (98% threshold)", status: "queued", duration_seconds: 1, log_summary: "Determinism confidence check...", log_body: "Overall confidence: 98%\nThreshold: 98% — gate passed." },
    { name: "Deploy to staging", status: "queued", duration_seconds: 1.5, log_summary: "Publishing artifacts...", log_body: "X-Ray report uploaded.\nStaging deployment triggered." },
  ];

  const yaml_github =
    `name: data-pipe-xray

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
        run: pytest tests/ai/ -v
      - name: Schema drift analysis
        run: python -m tools.schema_drift_check
      - name: Flakiness gate
        run: python -m tools.flakiness_gate --threshold 0.98`;

  const yaml_gitlab =
    `# .gitlab-ci.yml — data-pipe-xray

stages:
  - test
  - deploy

test:ai:
  stage: test
  image: python:3.11
  script:
    - pip install -r requirements.txt
    - python -m tools.generate_ai_tests --spec openapi.yml --out tests/ai
    - pytest tests/ai/ -v
    - python -m tools.schema_drift_check
    - python -m tools.flakiness_gate --threshold 0.98`;

  const yaml_jenkins =
    `// Jenkinsfile — data-pipe-xray

pipeline {
  agent any
  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Test') {
      steps {
        sh 'pip install -r requirements.txt'
        sh 'python -m tools.generate_ai_tests --spec openapi.yml --out tests/ai'
        sh 'pytest tests/ai/ -v'
        sh 'python -m tools.flakiness_gate --threshold 0.98'
      }
    }
  }
}`;

  return {
    pipeline_name: "GitHub Actions \u2022 data-pipe-xray",
    steps,
    determinism: {
      confidence: 0.98,
      reasons: [
        "All external systems (RiskScoreAPI, LegacyEmulator) are mocked.",
        "No assertions depend on wall-clock time or random values.",
        "Property-based tests run with a fixed seed for reproducibility.",
      ],
    },
    yaml_snippet: yaml_github,
    yaml_github,
    yaml_gitlab,
    yaml_jenkins,
  };
}

// ── Mutation Score Analysis ──
export function getMutationScore(totalTests) {
  const mutations = [
    { operator: "Flip > to >=", target: "amount validation", killed: true, test: "test_create_payment_edge_amount_and_currency" },
    { operator: "Remove null check", target: "event_id idempotency", killed: true, test: "test_events_idempotent_on_event_id" },
    { operator: "Swap field name", target: "customer_name → cust_name", killed: true, test: "test_create_payment_happy_path" },
    { operator: "Drop date normalization", target: "event_date transformer", killed: true, test: "test_events_accepts_unix_timestamp_and_normalizes" },
    { operator: "Disable schema validation", target: "API Gateway strict mode", killed: true, test: "test_events_tolerates_extra_marketing_flag" },
    { operator: "Return 200 on error", target: "malformed date handler", killed: true, test: "test_events_rejects_malformed_date_string" },
    { operator: "Skip sanitization", target: "customer_name input filter", killed: true, test: "test_create_payment_malicious_customer_name" },
    { operator: "Remove mock fallback", target: "RiskScoreAPI circuit breaker", killed: true, test: "test_risk_score_api_fallback_when_down" },
    { operator: "Ignore sign bit", target: "unit_price parser", killed: false, test: null },
    { operator: "Allow duplicate writes", target: "ledger dedup check", killed: false, test: null },
    { operator: "Truncate to 255 chars", target: "counterparty field", killed: false, test: null },
  ];
  const killed = mutations.filter((m) => m.killed).length;
  const survived = mutations.length - killed;
  return { mutations, killed, survived, total: mutations.length, score: Math.round((killed / mutations.length) * 100) };
}

// ── Blast Radius Map ──
export function getBlastRadius() {
  return {
    nodes: [
      { id: "APIGateway", label: "API Gateway", tier: 0 },
      { id: "Validator", label: "Validator", tier: 1 },
      { id: "Transformer", label: "Transformer", tier: 1 },
      { id: "DB", label: "Database", tier: 2 },
      { id: "LegacyEmulator", label: "Legacy Emulator", tier: 2 },
      { id: "AnalyticsFeed", label: "Analytics Feed", tier: 2 },
      { id: "Ledger", label: "Ledger Service", tier: 3 },
      { id: "AuditLog", label: "Audit Log", tier: 3 },
    ],
    impacts: [
      { failNode: "Transformer", affected: ["DB", "LegacyEmulator", "AnalyticsFeed", "Ledger", "AuditLog"], exposure: "$2.1M/day", severity: "critical" },
      { failNode: "Validator", affected: ["Transformer", "DB", "LegacyEmulator", "AnalyticsFeed", "Ledger"], exposure: "$3.4M/day", severity: "critical" },
      { failNode: "DB", affected: ["Ledger", "AuditLog"], exposure: "$890K/day", severity: "high" },
      { failNode: "LegacyEmulator", affected: ["AuditLog"], exposure: "$320K/day", severity: "medium" },
    ],
  };
}

// ── Data Lineage Trace ──
export function getDataLineage() {
  return [
    { field: "event_date", stages: [
      { system: "CRM Producer", format: "Unix timestamp (1700000000)", color: "amber" },
      { system: "API Gateway", format: "Passed through (no validation)", color: "red" },
      { system: "Transformer", format: "Normalized → 2023-11-14 (ISO-8601)", color: "green" },
      { system: "Database", format: "Stored as DATE column", color: "green" },
      { system: "Legacy Emulator", format: "Converted → YYYYMMDD (20231114)", color: "amber" },
    ]},
    { field: "customer_name", stages: [
      { system: "Client App", format: "Raw user input (untrusted)", color: "red" },
      { system: "API Gateway", format: "UTF-8 validated, max 255 chars", color: "amber" },
      { system: "Validator", format: "Sanitized (bleach.clean)", color: "green" },
      { system: "Database", format: "VARCHAR(255), encrypted at rest", color: "green" },
      { system: "Analytics Feed", format: "Hashed (SHA-256) for GDPR", color: "green" },
    ]},
    { field: "amount", stages: [
      { system: "Client App", format: "Integer (minor units: 10000 = $100)", color: "green" },
      { system: "Validator", format: "Range check: 1 ≤ amount ≤ 10B", color: "green" },
      { system: "Transformer", format: "Currency conversion applied", color: "amber" },
      { system: "Ledger", format: "Debit/credit double-entry posted", color: "green" },
      { system: "Risk Score API", format: "Threshold check: flag if > $50K", color: "amber" },
    ]},
    { field: "extra_marketing_flag", stages: [
      { system: "CRM (undocumented)", format: "Boolean: true", color: "red" },
      { system: "API Gateway", format: "REJECTED in strict mode", color: "red" },
      { system: "Transformer", format: "Never reaches (blocked)", color: "red" },
    ]},
  ];
}

// ── Test Impact Ranking ──
export function getTestImpactRanking(testList) {
  const tests = testList || _lastTestsInOrder;
  const riskMap = {
    "test_create_payment_happy_path": { daily: 16500000, flow: "Core payment creation ($16.5M/day)", priority: "critical" },
    "test_cross_pipe_reconciliation_shares": { daily: 8200000, flow: "Equity reconciliation ($8.2M/day)", priority: "critical" },
    "test_events_idempotent_on_event_id": { daily: 5400000, flow: "Event dedup — duplicate charges ($5.4M/day)", priority: "critical" },
    "test_events_accepts_unix_timestamp_and_normalizes": { daily: 3100000, flow: "Timestamp normalization ($3.1M/day)", priority: "high" },
    "test_events_tolerates_extra_marketing_flag": { daily: 2800000, flow: "Schema drift tolerance ($2.8M/day)", priority: "high" },
    "test_create_payment_malicious_customer_name": { daily: 1200000, flow: "Input sanitization ($1.2M/day)", priority: "high" },
    "test_risk_score_api_fallback_when_down": { daily: 900000, flow: "Third-party fallback ($900K/day)", priority: "medium" },
    "test_customer_name_property_based": { daily: 600000, flow: "Fuzz testing coverage ($600K/day)", priority: "medium" },
    "test_pii_not_leaked_to_logs": { daily: 450000, flow: "PII compliance ($450K/day fine risk)", priority: "medium" },
    "test_create_payment_edge_amount_and_currency": { daily: 200000, flow: "Edge validation ($200K/day)", priority: "low" },
    "test_events_rejects_malformed_date_string": { daily: 150000, flow: "Malformed date rejection ($150K/day)", priority: "low" },
  };
  return tests.map((t) => {
    const risk = riskMap[t.name] || { daily: 50000, flow: `${t.category} test ($50K/day)`, priority: "low" };
    return { name: t.name, category: t.category, expertTag: t.expertTag, ...risk };
  }).sort((a, b) => b.daily - a.daily);
}

// ── Schema Version Diff ──
export function getSchemaDiff() {
  return {
    from: "v2.4.0",
    to: "v2.5.0",
    changes: [
      { type: "added", path: "/events.payload.metadata", desc: "New optional metadata object on events", impact: "3 new edge case tests needed" },
      { type: "modified", path: "/payments.amount", desc: "Type changed: integer → number (allows decimals)", impact: "2 existing tests will break, 1 new validation test" },
      { type: "removed", path: "/payments.legacy_ref", desc: "Deprecated field removed", impact: "1 test references this field — must update" },
      { type: "added", path: "/events.priority", desc: "New enum field: low|medium|high|critical", impact: "4 new parametrized tests for each priority level" },
      { type: "modified", path: "/payments.currency", desc: "Added 12 new ISO 4217 codes (crypto: BTC, ETH, ...)", impact: "Property-based test alphabet expanded" },
    ],
    newTestsNeeded: 11,
    breakingTests: 3,
  };
}

// ── Latency & Throughput Simulation ──
export function getLatencySimulation() {
  return {
    targetRps: 10000,
    targetP99Ms: 100,
    nodes: [
      { name: "API Gateway", avgMs: 8, p99Ms: 22, throughputPct: 100 },
      { name: "Validator", avgMs: 12, p99Ms: 35, throughputPct: 99.8 },
      { name: "Transformer", avgMs: 45, p99Ms: 120, throughputPct: 97.2, bottleneck: true },
      { name: "Database", avgMs: 18, p99Ms: 55, throughputPct: 96.8 },
      { name: "Legacy Emulator", avgMs: 85, p99Ms: 340, throughputPct: 91.5, bottleneck: true },
      { name: "Risk Score API", avgMs: 32, p99Ms: 95, throughputPct: 98.1 },
    ],
    overallP99: 142,
    overallThroughput: 8720,
    slaBreaches: [
      { node: "Transformer", metric: "p99", value: "120ms", threshold: "100ms", verdict: "BREACH" },
      { node: "Legacy Emulator", metric: "p99", value: "340ms", threshold: "100ms", verdict: "BREACH" },
      { node: "Legacy Emulator", metric: "throughput", value: "91.5%", threshold: "99%", verdict: "BREACH" },
    ],
  };
}

// ── Dead Letter Queue ──
export function getDlqData() {
  return {
    totalMessages: 47,
    poisonPills: 3,
    messages: [
      { id: "DLQ-001", test: "test_events_accepts_unix_timestamp_and_normalizes", reason: "Transformer: raw Unix timestamp not normalized", retries: 3, status: "exhausted", age: "4m 22s" },
      { id: "DLQ-002", test: "test_events_tolerates_extra_marketing_flag", reason: "API Gateway: strict schema rejected extra_marketing_flag", retries: 3, status: "exhausted", age: "3m 15s" },
      { id: "DLQ-003", test: "test_create_payment_malicious_customer_name", reason: "Validator: SQL injection detected, payload quarantined", retries: 0, status: "poison", age: "2m 48s" },
      { id: "DLQ-004", test: "test_cross_pipe_reconciliation_shares", reason: "DB: ledger mismatch — 100 shares traded, 90 posted", retries: 2, status: "retrying", age: "1m 30s" },
      { id: "DLQ-005", test: "test_redos_polynomial_regex_attack", reason: "Validator: regex timeout >5s — circuit breaker tripped", retries: 0, status: "poison", age: "58s" },
      { id: "DLQ-006", test: "test_risk_score_api_fallback_when_down", reason: "RiskScoreAPI: 503 Service Unavailable — fallback triggered", retries: 3, status: "exhausted", age: "45s" },
    ],
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
    expertTag: "",
    insightBeginner: "",
    insightExpert: "",
    confidence: 0.99,
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
    expertTag: "Edge Validation",
    insightBeginner: "A beginner tests one valid and one invalid amount.",
    insightExpert: "Parametrizes boundary values: zero, invalid currency, overflow, and valid EUR.",
    confidence: 0.98,
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
    expertTag: "Injection & Encoding",
    insightBeginner: "Checks that valid names are accepted.",
    insightExpert: "Sends SQL injection, emojis, and RTL spoofing to stress-test sanitization.",
    confidence: 0.97,
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
    expertTag: "Idempotency",
    insightBeginner: "Calls the API once and checks the response.",
    insightExpert: "Fires the same payload 3x and asserts dedup (single downstream record).",
    confidence: 0.98,
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
    expertTag: "Type Mutation",
    insightBeginner: "Checks that the date field is a string.",
    insightExpert: "Sends Unix timestamp to a YYYY-MM-DD endpoint to verify normalization.",
    confidence: 0.97,
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
    expertTag: "Type Mutation",
    insightBeginner: "Validates that date format is correct.",
    insightExpert: "Sends DD-MM-YYYY to a YYYY-MM-DD pipe to ensure rejection.",
    confidence: 0.98,
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
    expertTag: "Schema Drift",
    insightBeginner: "Tests if exact JSON matches the spec.",
    insightExpert: "Injects an undocumented field to verify the system degrades gracefully.",
    confidence: 0.97,
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
    expertTag: "Property-Based",
    insightBeginner: 'Hardcodes {"name": "John"}.',
    insightExpert: "Fuzzes 100+ variants: emojis, SQL injection, RTL text.",
    confidence: 0.94,
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
    expertTag: "Mock Resilience",
    insightBeginner: "Skips tests if the dependency is down.",
    insightExpert: "Generates mock, sets it down, and tests the fallback path.",
    confidence: 0.96,
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
      expertTag: "Chaos",
      insightBeginner: "Sends flat JSON.",
      insightExpert: "Recursive nesting to see if the pipe chokes.",
      confidence: 0.95,
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
      expertTag: "Chaos",
      insightBeginner: "Uses normal payload size.",
      insightExpert: "10MB payload to test size limits and timeouts.",
      confidence: 0.96,
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
      expertTag: "ReDoS",
      insightBeginner: "Validates regex with a few examples.",
      insightExpert: "Crafted input to trigger polynomial backtracking.",
      confidence: 0.95,
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
      expertTag: "XML Bomb",
      insightBeginner: "Sends small XML.",
      insightExpert: "Billion Laughs entity expansion to test parser limits.",
      confidence: 0.95,
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
    expertTag: "Cross-Pipe Integrity",
    insightBeginner: "Tests one system in isolation.",
    insightExpert: "Reconciles System A vs B ledger for discrepancy.",
    confidence: 0.97,
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
    expertTag: "PII Detection",
    insightBeginner: "Checks response code only.",
    insightExpert: "Regex-scans log output for SSN/email/card leaks.",
    confidence: 0.96,
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
