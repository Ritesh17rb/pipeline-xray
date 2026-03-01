import { animateTimeSaved } from "./time_ticker.js";
import {
  specScanStart,
  specScanStop,
  renderSpecSummary,
  resetCodePanes,
  queueCodeTyping,
  updateCategoryCounts,
} from "./animation.js";
import { initGraph, handleXrayEvent, resetGraph, paintNodeRisk, setExpectedTests } from "./graph.js";
import { renderCiSummary, renderMocks } from "./ci_view.js";
import { specPreview, generateTests, streamCodeChunks, streamXrayEvents, getCiSummary, getMocksData } from "./backend.js";

// ── State ──
let currentSessionId = null;
let xrayEventsHistory = [];
let isRunning = false;

let currentModel = "gpt-4.1-nano";
let currentBaseUrl = "https://llmfoundry.straivedemo.com/openai/v1";
let currentApiKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InJpdGVzaC5rdW1hckBncmFtZW5lci5jb20ifQ.XBK_lB_lzKPC3oBhDkjdKruOaj1A2jFt10qzpd2ap14";
let chaosLevel = 0;
let complianceTags = ["SOC2"];

const SCENARIOS = {
  payments: `openapi: 3.0.1
info:
  title: Payments & Events API
  version: 2.4.0
  description: |
    High-volume card payments, refunds, chargebacks, and business event
    ingestion into downstream ledgers and analytics feeds.
    Known quirks: upstream CRM occasionally injects an undocumented
    "extra_marketing_flag" boolean field. Some producers send event_date
    as a Unix timestamp instead of the documented YYYY-MM-DD string.
paths:
  /payments:
    post:
      summary: Create a new payment
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [amount, currency, customer_name]
              properties:
                amount: { type: integer, description: "Minor units" }
                currency: { type: string, description: "ISO 4217" }
                customer_name: { type: string }
  /payments/{payment_id}:
    get:
      summary: Retrieve payment by ID
  /events:
    post:
      summary: Ingest business event
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [event_type, event_date, payload]
              properties:
                event_id: { type: string, description: "Idempotency key" }
                event_type: { type: string }
                event_date: { type: string, format: date }
                payload: { type: object }`,

  ledger: `openapi: 3.0.1
info:
  title: Ledger Sync API
  version: 1.1.0
  description: |
    Double-entry postings into internal and legacy ledgers.
    Settlement batches arrive every 15 minutes. Balance queries
    must reflect T+0 consistency even during batch ingestion.
paths:
  /postings:
    post:
      summary: Post a batch of ledger movements
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [entries]
              properties:
                batch_id: { type: string }
                entries:
                  type: array
                  items:
                    type: object
                    required: [debit_account, credit_account, amount, currency]
                    properties:
                      debit_account: { type: string }
                      credit_account: { type: string }
                      amount: { type: integer }
                      currency: { type: string }
  /balances/{account_id}:
    get:
      summary: Fetch end-of-day balance`,

  "legacy-outage": `openapi: 3.0.1
info:
  title: Legacy Mirror Bridge
  version: 0.9.3
  description: |
    Writes events into a mainframe mirror with fallback queues.
    The legacy system has a 99.2% SLA and occasionally returns
    HTTP 503 for 30-60 seconds. Circuit breaker must trip after
    3 consecutive failures and route to the dead-letter queue.
paths:
  /mirror/events:
    post:
      summary: Push an event into the legacy mirror
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [event_type, payload]
              properties:
                event_type: { type: string }
                correlation_id: { type: string }
                payload: { type: object }
  /mirror/health:
    get:
      summary: Legacy system health check`,

  "legacy-cobol": `* COBOL-STYLE LEGACY DATA SPECIFICATION
* SYSTEM: PG TRADE SETTLEMENT ENGINE v3.2 (1997)
* FORMAT: FIXED-WIDTH MAINFRAME RECORDS
*
* RECORD LAYOUT: TRADE-SETTLEMENT-REC
*   PIC X(12)  TRADE-ID          Positions 1-12
*   PIC 9(8)   TRADE-DATE        Positions 13-20  (YYYYMMDD)
*   PIC X(6)   TICKER-SYMBOL     Positions 21-26
*   PIC 9(7)   SHARE-QTY         Positions 27-33
*   PIC S9(9)V99 UNIT-PRICE      Positions 34-44  (signed decimal)
*   PIC X(3)   CURRENCY-CODE     Positions 45-47  (ISO 4217)
*   PIC X(20)  COUNTERPARTY      Positions 48-67
*   PIC X(1)   SETTLEMENT-FLAG   Position 68      (S=settled, P=pending)
*   PIC 9(8)   SETTLEMENT-DATE   Positions 69-76  (YYYYMMDD or 00000000)
*   PIC X(4)   LEGACY-BRANCH     Positions 77-80
*
* VALIDATION RULES:
*   - TRADE-DATE must be <= SETTLEMENT-DATE (if settled)
*   - UNIT-PRICE * SHARE-QTY must reconcile with ledger
*   - CURRENCY-CODE must be one of: USD, GBP, EUR, JPY
*   - COUNTERPARTY must exist in COUNTERPARTY-MASTER
*   - Duplicate TRADE-ID within same TRADE-DATE = reject
*
* KNOWN ISSUES:
*   - Some records have TICKER padded with nulls (x'00')
*   - Japanese branch sends UNIT-PRICE without sign bit
*   - SETTLEMENT-FLAG sometimes contains 'X' (manual override)`,
};

let lastGenData = null;

// ── Initialization ──
window.addEventListener("DOMContentLoaded", () => {
  initGraph();
  attachEventHandlers();
  prefillLlmConfig();
  loadDefaultScenario();
  initSectionNav();

  const observer = new MutationObserver(() => { initGraph(); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-bs-theme"] });
});

function attachEventHandlers() {
  const launchBtn = document.getElementById("launch-btn");
  if (launchBtn) launchBtn.addEventListener("click", launchXray);

  document.querySelectorAll(".scenario-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".scenario-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      loadScenario(btn.dataset.scenario);
    });
  });

  const xrayTimeline = document.getElementById("xray-timeline");
  if (xrayTimeline) {
    xrayTimeline.addEventListener("input", () => { replayXrayToIndex(Number(xrayTimeline.value)); });
  }

  const saveBtn = document.getElementById("llm-config-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const sel = document.getElementById("llm-model-select");
      const url = document.getElementById("llm-base-url");
      const key = document.getElementById("llm-api-key");
      if (sel) currentModel = sel.value;
      if (url && url.value) currentBaseUrl = url.value;
      if (key && key.value) currentApiKey = key.value;
      appendLog("system", `Config updated: model=${currentModel}`);
    });
  }

  const metricsFloat = document.getElementById("floating-metrics");
  document.querySelectorAll(".navbar .dropdown").forEach((dd) => {
    dd.addEventListener("show.bs.dropdown", () => { if (metricsFloat) metricsFloat.classList.add("hidden-by-dropdown"); });
    dd.addEventListener("hidden.bs.dropdown", () => { if (metricsFloat) metricsFloat.classList.remove("hidden-by-dropdown"); });
  });

  const chaosDial = document.getElementById("chaos-dial");
  if (chaosDial) {
    chaosDial.addEventListener("input", () => {
      chaosLevel = Number(chaosDial.value);
      const label = document.getElementById("chaos-level-label");
      const labels = ["LOW", "MEDIUM", "HIGH"];
      if (label) { label.textContent = labels[chaosLevel]; label.className = "badge chaos-level-badge chaos-" + labels[chaosLevel].toLowerCase(); }
    });
  }

  document.querySelectorAll(".compliance-tag").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      complianceTags = [...document.querySelectorAll(".compliance-tag.active")].map((b) => b.dataset.tag);
    });
  });

  const toggleBtn = document.getElementById("toggle-spec-code");
  if (toggleBtn) toggleBtn.addEventListener("click", () => toggleSpecCode());

  const exportBtn = document.getElementById("export-report-btn");
  if (exportBtn) exportBtn.addEventListener("click", () => exportReport());
}

function prefillLlmConfig() {
  const sel = document.getElementById("llm-model-select");
  const url = document.getElementById("llm-base-url");
  if (sel) sel.value = currentModel;
  if (url) url.value = currentBaseUrl;
}

function loadDefaultScenario() {
  loadScenario("payments");
  const first = document.querySelector('.scenario-btn[data-scenario="payments"]');
  if (first) first.classList.add("active");
}

function loadScenario(scenario) {
  const textarea = document.getElementById("spec-text");
  if (textarea && SCENARIOS[scenario]) textarea.value = SCENARIOS[scenario];
  const archBadge = document.getElementById("spec-kind-badge");
  const archSection = document.getElementById("archaeology-section");
  if (scenario === "legacy-cobol") {
    if (archBadge) archBadge.textContent = "COBOL Legacy";
    if (archSection) archSection.classList.remove("d-none");
  } else {
    if (archBadge) archBadge.textContent = "OpenAPI";
    if (archSection) archSection.classList.add("d-none");
  }
}

// ── The 4-Act Orchestrated Flow ──
async function launchXray() {
  if (isRunning) return;
  isRunning = true;

  const launchBtn = document.getElementById("launch-btn");
  const statusEl = document.getElementById("launch-status");
  if (launchBtn) launchBtn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span class="spinner-neon me-2"></span>Running the X-Ray sequence...';

  clearLog();
  resetCodePanes();
  resetGraph();
  xrayEventsHistory = [];
  lastGenData = null;
  hideExecSummary();
  expandSpecCode();

  const startTime = Date.now();

  try {
    // ── ACT 1: Scan the spec ──
    setPhase("scanning");
    scrollToSection("console-section");
    appendLog("system", "ACT 1: Scanning the messy API specification...");
    specScanStart();

    const specText = document.getElementById("spec-text")?.value || "";
    const isCobolScenario = specText.includes("COBOL") || specText.includes("PIC X");
    await sleep(600);

    if (isCobolScenario) {
      appendLog("system", "LEGACY ARCHAEOLOGY: Detected COBOL fixed-width record layout. Transpiling to Pydantic...");
      runArchaeologyTranspilation();
    }

    appendLog("agent", "Reading spec... identifying endpoints, types, constraints, and known quirks.");
    const llmAnalysis = await callLlm(
      `You are an expert payments SRE. Analyze this API spec in 4-5 punchy bullet points. Focus on: schema drift risks, type mutation dangers, idempotency concerns, and what property-based tests you'd write. Be specific and technical.\n\n${specText}`,
    );
    if (llmAnalysis) appendLog("agent", llmAnalysis);

    // Parse via in-memory backend
    const previewData = specPreview(specText, "openapi", "PG Data Pipe");
    currentSessionId = previewData.session_id;
    renderSpecSummary(previewData.summary);

    appendLog("signal", `Found ${previewData.summary.endpoint_count} endpoints. Risks: ${previewData.summary.risk_flags.slice(0, 3).join(" | ")}`);
    specScanStop();
    await sleep(400);

    // ── ACT 2 & 3: Generate tests ──
    setPhase("generating");
    scrollToSection("ai-strategy-section");
    showAiStrategy();
    appendLog("system", "ACT 2: Generating expert-grade test suite...");
    appendLog("agent", "Building categories: Happy Path, Edge Cases, Malicious Inputs, Property-Based Testing.");

    const genData = generateTests(currentSessionId, currentModel, chaosLevel, complianceTags);
    lastGenData = genData;
    updateCategoryCounts(genData.categories);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    showTimeSaved(genData.total_tests, genData.estimated_minutes_saved, elapsedSec);
    animateTimeSaved(genData.estimated_minutes_saved);

    appendLog("signal", `Generated ${genData.total_tests} tests across 4 categories in ${elapsedSec}s. Human equivalent: ${(genData.estimated_minutes_saved / 60).toFixed(1)} hours.`);
    if (chaosLevel > 0) {
      appendLog("warning", `Chaos Level ${["LOW","MEDIUM","HIGH"][chaosLevel]}: injected ${chaosLevel === 2 ? "ReDoS, XML bombs, recursive nesting" : "deep nesting, oversized payloads"} tests.`);
    }
    if (complianceTags.length > 0) {
      appendLog("signal", `Compliance overlay active: ${complianceTags.join(", ")}. Tests tagged with regulatory mappings.`);
      const badge = document.getElementById("compliance-active-badge");
      if (badge) { badge.textContent = complianceTags.join(" + "); badge.classList.remove("d-none"); }
    }

    showRiskMitigated(genData.risk_mitigated_usd || 0);
    renderPiiFindings(genData.pii_findings || []);
    renderFlakinessHeatmap(genData.flakiness_map || {});
    renderSyntheticTwin(genData.total_tests);
    renderSelfHealingPreview();
    paintNodeRisk(genData.flakiness_map || {});
    setExpectedTests(genData.total_tests);

    const genNarration = await callLlm(
      `You just generated ${genData.total_tests} tests for a payments API at chaos level ${chaosLevel}/2. Categories: ${JSON.stringify(genData.categories)}. Compliance: ${complianceTags.join(",")}. In 3 bullet points, highlight the most dangerous findings: schema drift, ReDoS, cross-pipe reconciliation failures, PII leaks, and why they matter for enterprise architects.`,
    );
    if (genNarration) appendLog("agent", genNarration);

    // Stream code via in-memory backend
    await streamCodeChunks((chunk) => {
      queueCodeTyping(chunk.category, chunk.test_name, chunk.code);
    });
    await sleep(300);

    // CI + Mocks (in-memory)
    renderCiSummary(getCiSummary(genData.total_tests));
    renderMocks(getMocksData());

    // ── ACT 4: Run X-Ray ──
    setPhase("xray");
    collapseSpecCode();
    await sleep(200);
    scrollToSection("xray-section");
    appendLog("system", "ACT 4: Running tests through the data pipe. Watch the X-Ray light up...");

    const timeline = document.getElementById("xray-timeline");
    await streamXrayEvents((evt) => {
      if (evt.event && evt.event !== "done") {
        xrayEventsHistory.push(evt);
        if (timeline) { timeline.max = String(Math.max(0, xrayEventsHistory.length - 1)); timeline.value = timeline.max; }
        handleXrayEvent(evt);
      }
    });

    appendLog("signal", "X-Ray complete. Click any red node to see the AI's explanation and auto-repair suggestion.");

    const finalSummary = await callLlm(
      `The X-Ray run is complete. Some tests passed, some failed. In 2-3 sentences, give a dramatic summary of what the X-Ray revealed about this data pipe's health. Mention specific failure types like schema drift, timestamp normalization, cross-pipe reconciliation, or ReDoS. Sound like a confident SRE briefing a VP.`,
    );
    if (finalSummary) appendLog("agent", finalSummary);

    appendAutoRepairSuggestions();
    setPhase("complete");
    if (statusEl) statusEl.textContent = "X-Ray sequence complete.";
    showExecSummary();
    scrollToSection("exec-summary-section");
  } catch (err) {
    console.error(err);
    appendLog("warning", `Error: ${err.message}`);
    specScanStop();
    setPhase("idle");
    if (statusEl) statusEl.textContent = "Sequence failed. Check console.";
  } finally {
    isRunning = false;
    if (launchBtn) launchBtn.disabled = false;
  }
}

function replayXrayToIndex(targetIndex) {
  if (!xrayEventsHistory.length) return;
  const clamped = Math.max(0, Math.min(targetIndex, xrayEventsHistory.length - 1));
  resetGraph();
  for (let i = 0; i <= clamped; i++) handleXrayEvent(xrayEventsHistory[i]);
}

// ── LLM Integration ──
async function callLlm(prompt) {
  if (!currentBaseUrl || !currentApiKey) return null;
  const base = currentBaseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentApiKey}` },
      body: JSON.stringify({
        model: currentModel,
        messages: [
          { role: "system", content: "You are a senior payments SRE who speaks in punchy, technical language. You are narrating a live X-Ray demo of a data pipe for enterprise architects. Be specific, confident, and concise." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 400,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

// ── Time Saved Display ──
function showTimeSaved(testCount, minutesSaved, elapsedSec) {
  const metrics = document.getElementById("floating-metrics");
  const testsEl = document.getElementById("time-saved-tests");
  const secsEl = document.getElementById("time-saved-seconds");
  if (metrics) metrics.style.display = "flex";
  if (testsEl) testsEl.textContent = String(testCount);
  if (secsEl) secsEl.textContent = String(elapsedSec);
}

// ── Agent Console Helpers ──
const ACT_SEQUENCE = ["idle", "scanning", "generating", "xray", "complete"];

function setPhase(phase) {
  const pill = document.getElementById("agent-phase-pill");
  if (!pill) return;
  pill.classList.remove("idle", "scanning", "generating", "xray");
  const labels = { idle: "Idle", scanning: "Scanning Spec", generating: "Generating Tests", xray: "Running X-Ray" };
  pill.classList.add(phase === "complete" ? "idle" : phase);
  pill.textContent = phase === "complete" ? "Complete" : labels[phase] || "Idle";
  updateActProgress(phase);
}

function updateActProgress(currentPhase) {
  const steps = document.querySelectorAll(".act-step");
  const phaseIndex = ACT_SEQUENCE.indexOf(currentPhase);
  steps.forEach((step) => {
    const actIndex = ACT_SEQUENCE.indexOf(step.dataset.act);
    step.classList.remove("active", "completed");
    if (actIndex < phaseIndex) step.classList.add("completed");
    else if (actIndex === phaseIndex) step.classList.add("active");
  });
  for (let i = 1; i <= 4; i++) {
    const fill = document.getElementById(`conn-${i}`);
    if (fill) fill.style.width = i < phaseIndex ? "100%" : i === phaseIndex ? "50%" : "0%";
  }
}

function clearLog() {
  const log = document.getElementById("agent-console-log");
  if (log) log.innerHTML = "";
}

let typewriterQueue = Promise.resolve();

function appendLog(kind, text) {
  const log = document.getElementById("agent-console-log");
  if (!log) return;
  if (kind === "agent") { typewriterQueue = typewriterQueue.then(() => typewriteLines(log, text)); return; }
  const lines = text.split("\n").filter((l) => l.trim());
  lines.forEach((line) => {
    const div = document.createElement("div");
    div.classList.add("agent-console-log-line", kind);
    const prefix = kind === "system" ? "SYS" : kind === "signal" ? ">>>" : "!!!";
    div.textContent = `[${prefix}] ${line}`;
    log.appendChild(div);
  });
  while (log.childNodes.length > 80) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function typewriteLines(log, text) {
  return new Promise((resolve) => {
    const lines = text.split("\n").filter((l) => l.trim());
    let lineIndex = 0;
    function nextLine() {
      if (lineIndex >= lines.length) { resolve(); return; }
      const line = lines[lineIndex]; lineIndex++;
      const div = document.createElement("div");
      div.classList.add("agent-console-log-line", "agent");
      div.textContent = "[AI] ";
      log.appendChild(div);
      const cursor = document.createElement("span");
      cursor.className = "typewriter-cursor";
      div.appendChild(cursor);
      let charIdx = 0;
      function typeChar() {
        if (charIdx < line.length) {
          const chunk = line.slice(charIdx, charIdx + 3); charIdx += 3;
          div.textContent = `[AI] ${line.slice(0, charIdx)}`;
          div.appendChild(cursor);
          log.scrollTop = log.scrollHeight;
          setTimeout(typeChar, 12);
        } else {
          div.textContent = `[AI] ${line}`;
          while (log.childNodes.length > 80) log.removeChild(log.firstChild);
          log.scrollTop = log.scrollHeight;
          setTimeout(nextLine, 80);
        }
      }
      typeChar();
    }
    nextLine();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Risk Mitigated Counter ──
function showRiskMitigated(usd) {
  const el = document.getElementById("risk-mitigated-value");
  if (!el) return;
  const target = Math.round(usd);
  const duration = 2000;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── PII Leak Detection ──
function renderPiiFindings(findings) {
  const container = document.getElementById("pii-results");
  if (!container || !findings.length) return;
  container.innerHTML = findings.map((f) => {
    const riskClass = f.risk === "critical" || f.risk === "high" ? "badge-glow-red" : "badge-glow-blue";
    const icon = f.risk === "critical" ? "bi-exclamation-octagon-fill" : f.risk === "high" ? "bi-exclamation-triangle-fill" : "bi-info-circle";
    return `<div class="col-12 col-md-6"><div class="pii-card"><div class="d-flex align-items-center gap-2 mb-1"><i class="bi ${icon}" style="color:var(--neon-red)"></i><span class="fw-semibold small">${f.field}</span><span class="badge ${riskClass}" style="font-size:0.6rem">${f.risk.toUpperCase()}</span></div><div class="small" style="color:var(--text-secondary)">${f.type} detected</div><div class="small mt-1" style="color:var(--text-primary)">${f.detail}</div></div></div>`;
  }).join("");
}

// ── Flakiness Heatmap ──
function renderFlakinessHeatmap(flakinessMap) {
  const container = document.getElementById("flakiness-view");
  if (!container) return;
  const entries = Object.entries(flakinessMap).sort((a, b) => b[1] - a[1]);
  container.innerHTML = `<div class="mb-3 small" style="color:var(--text-secondary)">Estimated flakiness rate per pipeline node. High values indicate "Technical Debt Hotspots".</div>${entries.map(([node, rate]) => {
    const pct = (rate * 100).toFixed(0);
    const color = rate > 0.25 ? "var(--neon-red)" : rate > 0.1 ? "var(--neon-amber)" : "var(--neon-green)";
    const label = rate > 0.25 ? "HOTSPOT" : rate > 0.1 ? "WATCH" : "STABLE";
    return `<div class="d-flex align-items-center gap-3 mb-2"><div class="fw-semibold small" style="min-width:130px">${node}</div><div class="flex-fill"><div class="flakiness-bar-bg"><div class="flakiness-bar" style="width:${pct}%;background:${color}"></div></div></div><div class="small fw-bold" style="color:${color};min-width:50px">${pct}%</div><span class="badge" style="background:${color}20;color:${color};font-size:0.6rem;min-width:60px">${label}</span></div>`;
  }).join("")}`;
}

// ── Legacy Archaeology Transpilation ──
function runArchaeologyTranspilation() {
  const codeEl = document.getElementById("arch-pydantic-code");
  if (!codeEl) return;
  const pydanticCode = `from pydantic import BaseModel, Field, validator
from datetime import date
from enum import Enum
from typing import Optional

class Currency(str, Enum):
    USD = "USD"
    GBP = "GBP"
    EUR = "EUR"
    JPY = "JPY"

class SettlementFlag(str, Enum):
    SETTLED = "S"
    PENDING = "P"
    MANUAL_OVERRIDE = "X"

class TradeSettlement(BaseModel):
    trade_id: str = Field(max_length=12)
    trade_date: date
    ticker_symbol: str = Field(max_length=6)
    share_qty: int = Field(ge=0, le=9999999)
    unit_price: float
    currency_code: Currency
    counterparty: str = Field(max_length=20)
    settlement_flag: SettlementFlag
    settlement_date: Optional[date] = None
    legacy_branch: str = Field(max_length=4)

    @validator("ticker_symbol", pre=True)
    def strip_null_padding(cls, v):
        return v.replace("\\\\x00", "").strip()

    @validator("settlement_date", pre=True)
    def parse_zero_date(cls, v):
        if v == "00000000" or v is None:
            return None
        return v`;
  let idx = 0;
  codeEl.textContent = "";
  function type() {
    if (idx < pydanticCode.length) {
      idx += 4;
      codeEl.textContent = pydanticCode.slice(0, idx);
      if (window.hljs) { try { codeEl.innerHTML = window.hljs.highlight(codeEl.textContent, { language: "python" }).value; codeEl.classList.add("hljs"); } catch {} }
      setTimeout(type, 8);
    }
  }
  type();
}

// ── Synthetic Data Twin ──
function renderSyntheticTwin(testCount) {
  const container = document.getElementById("synthetic-twin-view");
  if (!container) return;
  const rows = Math.round(testCount * 12500);
  const tables = [
    { name: "payments", rows: Math.round(rows * 0.4), cols: 8, pii: "masked" },
    { name: "events", rows: Math.round(rows * 0.35), cols: 6, pii: "tokenized" },
    { name: "ledger_entries", rows: Math.round(rows * 0.15), cols: 5, pii: "none" },
    { name: "counterparties", rows: Math.round(rows * 0.1), cols: 4, pii: "masked" },
  ];
  container.innerHTML = `<div class="small mb-2" style="color:var(--text-secondary)">Shadow database generated from production schema. <strong>${rows.toLocaleString()}</strong> realistic rows across <strong>${tables.length}</strong> tables. Zero real PII.</div>${tables.map((t) => `<div class="d-flex align-items-center gap-2 mb-2"><i class="bi bi-table" style="color:var(--neon-blue)"></i><span class="fw-semibold small" style="min-width:120px">${t.name}</span><div class="flex-fill"><div class="flakiness-bar-bg"><div class="flakiness-bar" style="width:${(t.rows / rows * 100).toFixed(0)}%;background:var(--neon-blue)"></div></div></div><span class="small" style="min-width:70px;color:var(--text-secondary)">${t.rows.toLocaleString()} rows</span><span class="badge" style="font-size:0.55rem;background:rgba(0,255,153,0.1);color:var(--neon-green)">${t.pii}</span></div>`).join("")}<div class="mt-2 d-flex gap-2"><span class="badge badge-glow-green" style="font-size:0.6rem"><i class="bi bi-check-circle me-1"></i>GDPR Safe</span><span class="badge badge-glow-green" style="font-size:0.6rem"><i class="bi bi-check-circle me-1"></i>PCI-DSS Compliant</span><span class="badge badge-glow-blue" style="font-size:0.6rem"><i class="bi bi-clock me-1"></i>Generated in 2.1s</span></div>`;
}

// ── Self-Healing Preview ──
function renderSelfHealingPreview() {
  const container = document.getElementById("self-healing-view");
  if (!container) return;
  const repairs = [
    { field: "user_id \u2192 uuid", type: "Field Rename", icon: "bi-arrow-left-right", status: "fix-ready" },
    { field: "event_date: Unix \u2192 ISO", type: "Type Coercion", icon: "bi-calendar-event", status: "fix-ready" },
    { field: "customer_name: XSS", type: "Input Sanitization", icon: "bi-shield-exclamation", status: "fix-ready" },
    { field: "extra_marketing_flag", type: "Schema Drift", icon: "bi-plus-square", status: "auto-adapted" },
    { field: "regex: ReDoS vuln", type: "Timeout Guard", icon: "bi-clock-history", status: "fix-ready" },
  ];
  container.innerHTML = `<div class="small mb-2" style="color:var(--text-secondary)">The AI detected <strong>${repairs.length}</strong> fixable issues. Click any failed node in the X-Ray to see and apply the auto-repair.</div>${repairs.map((r) => `<div class="d-flex align-items-center gap-2 mb-1"><i class="bi ${r.icon}" style="color:var(--neon-amber);font-size:0.8rem"></i><span class="small fw-semibold" style="min-width:160px">${r.field}</span><span class="small text-secondary">${r.type}</span><span class="badge ms-auto" style="font-size:0.55rem;background:rgba(245,158,11,0.12);color:var(--neon-amber)">${r.status}</span></div>`).join("")}`;
}

// ── Auto-Repair Suggestions ──
const REPAIRS_DB = {
  test_events_accepts_unix_timestamp_and_normalizes: { fix: "Add a normalizer in the Transformer stage:\n\nif isinstance(event_date, int):\n    event_date = datetime.utcfromtimestamp(event_date).strftime('%Y-%m-%d')", desc: "The Transformer needs a type-coercion layer for event_date." },
  test_create_payment_malicious_customer_name: { fix: "Add input sanitization in the Validator:\n\nimport bleach\ncustomer_name = bleach.clean(customer_name, strip=True)", desc: "The Validator lacks input sanitization." },
  test_events_tolerates_extra_marketing_flag: { fix: "Switch the API Gateway from strict to permissive schema mode:\n\nschema_validation: 'warn'  # was: 'strict'", desc: "Change schema validation to tolerate upstream drift." },
  test_cross_pipe_reconciliation_shares: { fix: "Add an idempotent reconciliation check after ledger posting:\n\nassert_ledger_balance(ticker, expected_shares, tolerance=0)", desc: "Add post-write reconciliation assertion." },
  test_redos_polynomial_regex_attack: { fix: "Replace vulnerable regex with atomic grouping or set a 100ms timeout:\n\nimport regex\nregex.match(pattern, input, timeout=0.1)", desc: "Replace standard re with timeout-protected regex." },
};

function appendAutoRepairSuggestions() {
  const detail = document.getElementById("xray-detail");
  if (!detail) return;
  const existing = detail.innerHTML;
  let html = "";
  for (const [testName, repair] of Object.entries(REPAIRS_DB)) {
    html += `<div class="auto-repair-card mt-2"><div class="d-flex align-items-center gap-2 mb-1"><i class="bi bi-wrench" style="color:var(--neon-amber)"></i><span class="fw-semibold small">Self-Healing Suggestion</span><span class="badge text-bg-secondary" style="font-size:0.6rem">${testName}</span><button class="btn btn-repair ms-auto" onclick="this.innerHTML='<i class=\\'bi bi-check\\'></i> Applied';this.disabled=true;"><i class="bi bi-magic me-1"></i>Apply Fix</button></div><div class="small mb-2" style="color:var(--text-secondary)">${repair.desc}</div><pre class="auto-repair-code small p-2 rounded mb-0"><code class="language-python">${repair.fix}</code></pre></div>`;
  }
  detail.innerHTML = existing + html;
  detail.querySelectorAll(".auto-repair-code code").forEach((el) => {
    if (window.hljs) { try { el.innerHTML = window.hljs.highlight(el.textContent, { language: "python" }).value; el.classList.add("hljs"); } catch {} }
  });
  renderSelfHealingPreview();
}

// ── Section Navigation ──
function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function initSectionNav() {
  const sections = ["hero-section", "console-section", "spec-code-section", "xray-section", "insights-section"];
  const dots = document.querySelectorAll(".section-nav-dot");
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        dots.forEach((d) => d.classList.toggle("active", d.getAttribute("href") === `#${entry.target.id}`));
      }
    });
  }, { threshold: 0.3 });
  sections.forEach((id) => { const el = document.getElementById(id); if (el) observer.observe(el); });
  dots.forEach((dot) => { dot.addEventListener("click", (e) => { e.preventDefault(); scrollToSection(dot.getAttribute("href").slice(1)); }); });
}

// ── Collapsible Spec & Code ──
function collapseSpecCode() {
  const body = document.getElementById("spec-code-body");
  const icon = document.getElementById("toggle-spec-code-icon");
  const text = document.getElementById("toggle-spec-code-text");
  if (body) body.classList.add("collapsed");
  if (icon) icon.className = "bi bi-chevron-down";
  if (text) text.textContent = "Expand";
}
function expandSpecCode() {
  const body = document.getElementById("spec-code-body");
  const icon = document.getElementById("toggle-spec-code-icon");
  const text = document.getElementById("toggle-spec-code-text");
  if (body) body.classList.remove("collapsed");
  if (icon) icon.className = "bi bi-chevron-up";
  if (text) text.textContent = "Collapse";
}
function toggleSpecCode() {
  const body = document.getElementById("spec-code-body");
  if (!body) return;
  body.classList.contains("collapsed") ? expandSpecCode() : collapseSpecCode();
}

// ── AI Test Strategy ──
function showAiStrategy() {
  const section = document.getElementById("ai-strategy-section");
  const grid = document.getElementById("ai-strategy-grid");
  if (!section || !grid) return;
  const strategies = [
    { icon: "bi-check-circle", label: "Happy Path", count: "3", reason: "Verify basic CRUD operations return expected status codes" },
    { icon: "bi-exclamation-triangle", label: "Edge Cases", count: "4+", reason: "Schema drift, timestamp mutation, idempotency, reconciliation" },
    { icon: "bi-bug", label: "Malicious", count: `${chaosLevel >= 2 ? "5+" : chaosLevel >= 1 ? "3+" : "1+"}`, reason: chaosLevel >= 2 ? "SQL injection + ReDoS + XML bombs + deep nesting" : "SQL injection and input sanitization attacks" },
    { icon: "bi-diagram-3", label: "Property-Based", count: "2+", reason: "Fuzz customer_name with emojis, RTL text, huge strings + PII leak scan" },
  ];
  grid.innerHTML = strategies.map((s) => `<div class="col-6 col-md-3"><div class="strategy-item text-center"><div class="strategy-item-icon mb-1"><i class="bi ${s.icon}" style="color:var(--neon-purple)"></i></div><div class="strategy-item-count">${s.count}</div><div class="strategy-item-label">${s.label}</div><div class="strategy-item-reason mt-1">${s.reason}</div></div></div>`).join("");
  section.classList.remove("d-none");
}

// ── Executive Summary ──
function hideExecSummary() { const s = document.getElementById("exec-summary-section"); if (s) s.classList.add("d-none"); }
function showExecSummary() {
  const section = document.getElementById("exec-summary-section");
  if (!section) return;
  const passed = parseInt(document.getElementById("xray-pass-count")?.textContent) || 0;
  const failed = parseInt(document.getElementById("xray-fail-count")?.textContent) || 0;
  const totalTests = lastGenData?.total_tests || (passed + failed);
  document.getElementById("exec-total-tests").textContent = totalTests;
  document.getElementById("exec-passed").textContent = passed;
  document.getElementById("exec-failed").textContent = failed;
  document.getElementById("exec-coverage").textContent = document.getElementById("coverage-pct")?.textContent || "0%";
  document.getElementById("exec-risk").textContent = Math.round(lastGenData?.risk_mitigated_usd || 0).toLocaleString();
  document.getElementById("exec-time").textContent = ((lastGenData?.estimated_minutes_saved || 0) / 60).toFixed(1);
  section.classList.remove("d-none");
}

// ── Export Report ──
function exportReport() {
  const passed = parseInt(document.getElementById("xray-pass-count")?.textContent) || 0;
  const failed = parseInt(document.getElementById("xray-fail-count")?.textContent) || 0;
  const chaosLabel = ["LOW", "MEDIUM", "HIGH"][chaosLevel];
  let report = `DATA PIPE X-RAY \u2014 EXECUTIVE REPORT\n${"=".repeat(50)}\n\nDate: ${new Date().toLocaleString()}\nScenario: PG Data Pipe\nChaos Level: ${chaosLabel}\nCompliance: ${complianceTags.join(", ") || "None"}\n\nSUMMARY\n${"-".repeat(30)}\nTests Generated: ${lastGenData?.total_tests || 0}\nPassed: ${passed}\nFailed: ${failed}\nPipeline Coverage: ${document.getElementById("coverage-pct")?.textContent || "0%"}\nRisk Mitigated: $${Math.round(lastGenData?.risk_mitigated_usd || 0).toLocaleString()}\nTime Saved: ${((lastGenData?.estimated_minutes_saved || 0) / 60).toFixed(1)} hours\n`;
  const blob = new Blob([report], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `xray-report-${Date.now()}.txt`; a.click();
  URL.revokeObjectURL(url);
}
