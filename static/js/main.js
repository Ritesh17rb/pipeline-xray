import { animateTimeSaved } from "./time_ticker.js";
import {
  specScanStart,
  specScanStop,
  renderSpecSummary,
  resetCodePanes,
  queueCodeTyping,
  updateCategoryCounts,
} from "./animation.js";
import { initGraph, handleXrayEvent, resetGraph } from "./graph.js";
import { renderCiSummary, renderMocks } from "./ci_view.js";

// ── State ──
let currentSessionId = null;
let codeSocket = null;
let xraySocket = null;
let xrayEventsHistory = [];
let isRunning = false;

// Pre-configured LLM credentials
let currentModel = "gpt-4.1-nano";
let currentBaseUrl = "https://llmfoundry.straivedemo.com/openai/v1";
let currentApiKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InJpdGVzaC5rdW1hckBncmFtZW5lci5jb20ifQ.XBK_lB_lzKPC3oBhDkjdKruOaj1A2jFt10qzpd2ap14";

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
};

function getWsUrl(path) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${path}`;
}

// ── Initialization ──
window.addEventListener("DOMContentLoaded", () => {
  initGraph();
  attachEventHandlers();
  prefillLlmConfig();
  loadDefaultScenario();

  // Re-render the graph when theme changes so SVG picks up new CSS variables
  const observer = new MutationObserver(() => {
    initGraph();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-bs-theme"],
  });
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
    xrayTimeline.addEventListener("input", () => {
      replayXrayToIndex(Number(xrayTimeline.value));
    });
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

  // Hide the floating "Time Saved" when any navbar dropdown opens
  const tsFloat = document.getElementById("time-saved-float");
  document.querySelectorAll(".navbar .dropdown").forEach((dd) => {
    dd.addEventListener("show.bs.dropdown", () => {
      if (tsFloat) tsFloat.classList.add("hidden-by-dropdown");
    });
    dd.addEventListener("hidden.bs.dropdown", () => {
      if (tsFloat) tsFloat.classList.remove("hidden-by-dropdown");
    });
  });
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
  if (textarea && SCENARIOS[scenario]) {
    textarea.value = SCENARIOS[scenario];
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

  closeExistingSockets();
  clearLog();
  resetCodePanes();
  resetGraph();
  xrayEventsHistory = [];

  const startTime = Date.now();

  try {
    // ── ACT 1: Scan the spec ──
    setPhase("scanning");
    appendLog("system", "ACT 1: Scanning the messy API specification...");
    specScanStart();

    const specText = document.getElementById("spec-text")?.value || "";
    await sleep(600);

    // Call LLM for real analysis
    appendLog("agent", "Reading spec... identifying endpoints, types, constraints, and known quirks.");
    const llmAnalysis = await callLlm(
      `You are an expert payments SRE. Analyze this API spec in 4-5 punchy bullet points. Focus on: schema drift risks, type mutation dangers, idempotency concerns, and what property-based tests you'd write. Be specific and technical.\n\n${specText}`,
    );
    if (llmAnalysis) {
      appendLog("agent", llmAnalysis);
    }

    // Parse via backend
    const previewRes = await fetch("/api/spec/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec_text: specText, spec_type: "openapi", name: "PG Data Pipe" }),
    });

    if (!previewRes.ok) throw new Error("Spec preview failed");
    const previewData = await previewRes.json();
    currentSessionId = previewData.session_id;
    renderSpecSummary(previewData.summary);

    appendLog("signal", `Found ${previewData.summary.endpoint_count} endpoints. Risks: ${previewData.summary.risk_flags.slice(0, 3).join(" | ")}`);
    specScanStop();
    await sleep(400);

    // ── ACT 2 & 3: Generate tests ──
    setPhase("generating");
    appendLog("system", "ACT 2: Generating expert-grade test suite...");
    appendLog("agent", "Building categories: Happy Path, Edge Cases, Malicious Inputs, Property-Based Testing.");

    const genRes = await fetch("/api/tests/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: currentSessionId, model: currentModel }),
    });

    if (!genRes.ok) throw new Error("Test generation failed");
    const genData = await genRes.json();
    updateCategoryCounts(genData.categories);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    showTimeSaved(genData.total_tests, genData.estimated_minutes_saved, elapsedSec);
    animateTimeSaved(genData.estimated_minutes_saved);

    appendLog("signal", `Generated ${genData.total_tests} tests across 4 categories in ${elapsedSec}s. Human equivalent: ${(genData.estimated_minutes_saved / 60).toFixed(1)} hours.`);

    // Ask LLM to narrate what it generated
    const genNarration = await callLlm(
      `You just generated ${genData.total_tests} tests for a payments API. The categories are: ${JSON.stringify(genData.categories)}. In 3 short bullet points, highlight the most interesting edge cases and why they matter for enterprise architects. Mention schema drift, idempotency, and property-based testing.`,
    );
    if (genNarration) {
      appendLog("agent", genNarration);
    }

    // Stream code
    await streamTestCode(currentSessionId);
    await sleep(300);

    // Preload CI + Mocks
    fetchCiSummary(currentSessionId);
    fetchMocks(currentSessionId);

    // ── ACT 4: Run X-Ray ──
    setPhase("xray");
    appendLog("system", "ACT 4: Running tests through the data pipe. Watch the X-Ray light up...");

    await streamXrayEvents(currentSessionId);

    appendLog("signal", "X-Ray complete. Click any red node to see the AI's explanation of the failure.");

    // Final LLM summary
    const summaryPrompt = `The X-Ray run is complete. Some tests passed, some failed. In 2-3 sentences, give a dramatic summary of what the X-Ray revealed about this data pipe's health. Mention specific failure types like schema drift or timestamp normalization. Sound like a confident SRE briefing a VP.`;
    const finalSummary = await callLlm(summaryPrompt);
    if (finalSummary) {
      appendLog("agent", finalSummary);
    }

    setPhase("idle");
    if (statusEl) statusEl.textContent = "X-Ray sequence complete.";
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

// ── WebSocket Streams ──
function closeExistingSockets() {
  if (codeSocket) { try { codeSocket.close(); } catch {} codeSocket = null; }
  if (xraySocket) { try { xraySocket.close(); } catch {} xraySocket = null; }
}

function streamTestCode(sessionId) {
  return new Promise((resolve) => {
    if (codeSocket) { try { codeSocket.close(); } catch {} }
    const timeout = setTimeout(resolve, 30000);
    const url = getWsUrl(`/ws/tests/code-stream/${sessionId}`);
    codeSocket = new WebSocket(url);
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); } };

    codeSocket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || !msg.event) return;
      if (msg.event === "code_chunk") {
        queueCodeTyping(msg.category, msg.test_name, msg.code);
      } else if (msg.event === "done") {
        done();
      }
    };
    codeSocket.onclose = () => { codeSocket = null; done(); };
    codeSocket.onerror = () => done();
  });
}

function streamXrayEvents(sessionId) {
  return new Promise((resolve) => {
    if (xraySocket) { try { xraySocket.close(); } catch {} }
    const timeout = setTimeout(resolve, 30000);
    const url = getWsUrl(`/ws/tests/xray-stream/${sessionId}`);
    xraySocket = new WebSocket(url);
    const timeline = document.getElementById("xray-timeline");
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); } };

    xraySocket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.event && msg.event !== "done") {
        xrayEventsHistory.push(msg);
        if (timeline) {
          timeline.max = String(Math.max(0, xrayEventsHistory.length - 1));
          timeline.value = timeline.max;
        }
        handleXrayEvent(msg);
      } else if (msg.event === "done") {
        done();
      }
    };
    xraySocket.onclose = () => { xraySocket = null; done(); };
    xraySocket.onerror = () => done();
  });
}

function replayXrayToIndex(targetIndex) {
  if (!xrayEventsHistory.length) return;
  const clamped = Math.max(0, Math.min(targetIndex, xrayEventsHistory.length - 1));
  resetGraph();
  for (let i = 0; i <= clamped; i++) {
    handleXrayEvent(xrayEventsHistory[i]);
  }
}

// ── LLM Integration ──
async function callLlm(prompt) {
  if (!currentBaseUrl || !currentApiKey) return null;
  const base = currentBaseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentApiKey}`,
      },
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
  } catch {
    return null;
  }
}

// ── CI/CD & Mocks ──
async function fetchCiSummary(sessionId) {
  try {
    const res = await fetch(`/api/ci/summary?session_id=${encodeURIComponent(sessionId)}`);
    if (res.ok) renderCiSummary(await res.json());
  } catch {}
}

async function fetchMocks(sessionId) {
  try {
    const res = await fetch(`/api/mocks?session_id=${encodeURIComponent(sessionId)}`);
    if (res.ok) renderMocks(await res.json());
  } catch {}
}

// ── Time Saved Display ──
function showTimeSaved(testCount, minutesSaved, elapsedSec) {
  const float = document.getElementById("time-saved-float");
  const testsEl = document.getElementById("time-saved-tests");
  const secsEl = document.getElementById("time-saved-seconds");
  if (float) float.style.display = "block";
  if (testsEl) testsEl.textContent = String(testCount);
  if (secsEl) secsEl.textContent = String(elapsedSec);
}

// ── Agent Console Helpers ──
function setPhase(phase) {
  const pill = document.getElementById("agent-phase-pill");
  if (!pill) return;
  pill.classList.remove("idle", "scanning", "generating", "xray");
  const labels = { idle: "Idle", scanning: "Scanning Spec", generating: "Generating Tests", xray: "Running X-Ray" };
  pill.classList.add(phase);
  pill.textContent = labels[phase] || "Idle";
}

function clearLog() {
  const log = document.getElementById("agent-console-log");
  if (log) log.innerHTML = "";
}

function appendLog(kind, text) {
  const log = document.getElementById("agent-console-log");
  if (!log) return;

  const lines = text.split("\n").filter((l) => l.trim());
  lines.forEach((line) => {
    const div = document.createElement("div");
    div.classList.add("agent-console-log-line", kind);
    const prefix = kind === "system" ? "SYS" : kind === "agent" ? "AI" : kind === "signal" ? ">>>" : "!!!";
    div.textContent = `[${prefix}] ${line}`;
    log.appendChild(div);
  });

  while (log.childNodes.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
