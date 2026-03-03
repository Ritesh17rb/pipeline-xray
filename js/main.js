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
import { specPreview, generateTests, streamCodeChunks, streamXrayEvents, getCiSummary, getMocksData, getLastTestsInOrder, getMutationScore, getBlastRadius, getDataLineage, getTestImpactRanking, getSchemaDiff, getLatencySimulation, getDlqData } from "./backend.js";
import { initParticles, setParticlePhase } from "./particles.js";

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
  initParticles();
  attachEventHandlers();
  prefillLlmConfig();
  loadDefaultScenario();
  initSectionNav();
  initFullscreenXray();

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

// ── Step Narration Overlay ──
function showStepNarration(title, subtitle, icon = "bi-lightning-charge-fill") {
  let overlay = document.getElementById("step-narration-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "step-narration-overlay";
    overlay.className = "step-narration-overlay";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="step-narration-content">
    <i class="bi ${icon} step-narration-icon"></i>
    <div class="step-narration-title">${title}</div>
    <div class="step-narration-subtitle">${subtitle}</div>
    <div class="step-narration-progress"><div class="step-narration-bar"></div></div>
  </div>`;
  overlay.classList.add("visible");
  return new Promise(r => setTimeout(() => { overlay.classList.remove("visible"); setTimeout(r, 400); }, 2800));
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
  const expertSection = document.getElementById("expert-comparison");
  if (expertSection) expertSection.classList.add("d-none");
  expandSpecCode();
  hideAnalyticsPanels();

  // Launch ignition animation
  if (launchBtn) {
    launchBtn.classList.add("launching");
    setTimeout(() => launchBtn.classList.remove("launching"), 800);
  }
  flashPhaseVignette();

  const startTime = Date.now();

  try {
    // ── ACT 1: Scan the spec ──
    await showStepNarration("ACT 1 — Scanning Spec", "The AI reads your messy API spec, identifies endpoints, risks, and quirks.", "bi-search");
    setPhase("scanning");
    setParticlePhase("scanning");
    showActSubStep("Parsing API specification...");
    appendLog("system", "ACT 1: Scanning the messy API specification...");
    specScanStart();

    const specText = document.getElementById("spec-text")?.value || "";
    const isCobolScenario = specText.includes("COBOL") || specText.includes("PIC X");
    await sleep(1200);

    if (isCobolScenario) {
      appendLog("system", "LEGACY ARCHAEOLOGY: Detected COBOL fixed-width record layout. Transpiling to Pydantic...");
      runArchaeologyTranspilation();
      await sleep(1500);
    }

    showActSubStep("Identifying endpoints and risk hotspots...");
    appendLog("agent", "Reading spec... identifying endpoints, types, constraints, and known quirks.");
    await sleep(800);
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
    await sleep(1200);

    // ── ACT 2: Generate tests ──
    await showStepNarration("ACT 2 — Generating Tests", "Building expert-grade test suite using validator chain: Schema → Type → Security → Business Logic.", "bi-code-slash");
    setPhase("generating");
    setParticlePhase("generating");
    flashPhaseVignette();
    showActSubStep("Building test strategy...");
    showAiStrategy();
    await sleep(600);
    appendLog("system", "ACT 2: Generating expert-grade test suite...");
    appendLog("agent", "Building categories: Happy Path, Edge Cases, Malicious Inputs, Property-Based Testing.");
    await sleep(1000);

    // Show validator pipeline steps
    showActSubStep("Running validator chain: Schema → Type → Security → Logic");
    await showValidatorPipeline();

    showActSubStep("Generating test code...");
    const genData = generateTests(currentSessionId, currentModel, chaosLevel, complianceTags);
    lastGenData = genData;
    updateCategoryCounts(genData.categories);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    showTimeSaved(genData.total_tests, genData.estimated_minutes_saved, elapsedSec);
    animateTimeSaved(genData.estimated_minutes_saved);

    appendLog("signal", `Generated ${genData.total_tests} tests across 4 categories in ${elapsedSec}s. Human equivalent: ${(genData.estimated_minutes_saved / 60).toFixed(1)} hours.`);
    await sleep(600);
    if (chaosLevel > 0) {
      appendLog("warning", `Chaos Level ${["LOW","MEDIUM","HIGH"][chaosLevel]}: injected ${chaosLevel === 2 ? "ReDoS, XML bombs, recursive nesting" : "deep nesting, oversized payloads"} tests.`);
      await sleep(400);
    }
    if (complianceTags.length > 0) {
      appendLog("signal", `Compliance overlay active: ${complianceTags.join(", ")}. Tests tagged with regulatory mappings.`);
      const badge = document.getElementById("compliance-active-badge");
      if (badge) { badge.textContent = complianceTags.join(" + "); badge.classList.remove("d-none"); }
      await sleep(400);
    }

    showRiskMitigated(genData.risk_mitigated_usd || 0);
    renderPiiFindings(genData.pii_findings || []);
    renderFlakinessHeatmap(genData.flakiness_map || {});
    renderSyntheticTwin(genData.total_tests);
    renderSelfHealingPreview();
    renderMutationScore(genData.total_tests);
    renderBlastRadius();
    renderDataLineage();
    renderTestImpactRanking();
    renderSchemaDiff();
    renderLatencySimulation();
    renderDlq();
    paintNodeRisk(genData.flakiness_map || {});
    setExpectedTests(genData.total_tests);

    const genNarration = await callLlm(
      `You just generated ${genData.total_tests} tests for a payments API at chaos level ${chaosLevel}/2. Categories: ${JSON.stringify(genData.categories)}. Compliance: ${complianceTags.join(",")}. In 3 bullet points, highlight the most dangerous findings: schema drift, ReDoS, cross-pipe reconciliation failures, PII leaks, and why they matter for enterprise architects.`,
    );
    if (genNarration) appendLog("agent", genNarration);

    await sleep(800);
    // Stream code via in-memory backend
    await streamCodeChunks((chunk) => {
      queueCodeTyping(chunk.category, chunk.test_name, chunk.code, {
        expertTag: chunk.expertTag,
        insightBeginner: chunk.insightBeginner,
        insightExpert: chunk.insightExpert,
        confidence: chunk.confidence,
      });
    });
    await sleep(800);

    renderExpertComparison();

    // CI + Mocks (in-memory)
    renderCiSummary(getCiSummary(genData.total_tests, getLastTestsInOrder()));
    renderMocks(getMocksData());
    await sleep(600);

    // ── ACT 3: Run X-Ray ──
    await showStepNarration("ACT 3 — Pipeline X-Ray", "Running every test through the data pipe. Watch nodes light up green or red in real time.", "bi-activity");
    setPhase("xray");
    setParticlePhase("xray");
    flashPhaseVignette();
    collapseSpecCode();
    await sleep(600);
    showActSubStep("Flowing data through pipeline nodes...");
    appendLog("system", "ACT 3: Running tests through the data pipe. Watch the X-Ray light up...");

    const timeline = document.getElementById("xray-timeline");
    await streamXrayEvents((evt) => {
      if (evt.event && evt.event !== "done") {
        xrayEventsHistory.push(evt);
        if (timeline) { timeline.max = String(Math.max(0, xrayEventsHistory.length - 1)); timeline.value = timeline.max; }
        handleXrayEvent(evt);
      }
    });
    await sleep(600);

    appendLog("signal", "X-Ray complete. Click any red node to see the AI's explanation and auto-repair suggestion.");

    const finalSummary = await callLlm(
      `The X-Ray run is complete. Some tests passed, some failed. In 2-3 sentences, give a dramatic summary of what the X-Ray revealed about this data pipe's health. Mention specific failure types like schema drift, timestamp normalization, cross-pipe reconciliation, or ReDoS. Sound like a confident SRE briefing a VP.`,
    );
    if (finalSummary) appendLog("agent", finalSummary);

    await sleep(500);
    appendAutoRepairSuggestions();

    // ── ACT 4: Results ──
    await showStepNarration("ACT 4 — Analysis Complete", "Review findings, apply fixes, and drill down into test reasoning.", "bi-check-lg");
    hideActSubStep();
    setPhase("complete");
    setParticlePhase("complete");
    if (statusEl) statusEl.textContent = "X-Ray sequence complete.";
    showExecSummary();
    revealAnalyticsPanels();
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
  spawnTimeSparks();
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

// ── Act Sub-Step Display ──
function showActSubStep(text) {
  let container = document.getElementById("act-substep-display");
  if (!container) {
    container = document.createElement("div");
    container.id = "act-substep-display";
    container.className = "act-substep-display";
    const actProgress = document.getElementById("act-progress");
    if (actProgress) actProgress.parentNode.insertBefore(container, actProgress.nextSibling);
  }
  container.innerHTML = `<span class="act-substep-dot"></span><span class="act-substep-text">${text}</span>`;
  container.classList.add("visible");
}

function hideActSubStep() {
  const container = document.getElementById("act-substep-display");
  if (container) container.classList.remove("visible");
}

function clearLog() {
  const log = document.getElementById("agent-console-log");
  if (log) log.innerHTML = "";
}

let typewriterQueue = Promise.resolve();

function appendLog(kind, text) {
  const log = document.getElementById("agent-console-log");
  if (!log) return;
  if (kind === "agent") {
    typewriterQueue = typewriterQueue.then(() => showThinkingBubble(log)).then(() => typewriteLines(log, text));
    return;
  }
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

// ── AI Thinking Bubble ──
function showThinkingBubble(log) {
  return new Promise((resolve) => {
    const bubble = document.createElement("div");
    bubble.className = "agent-thinking-bubble";
    bubble.innerHTML = '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-label">AI analyzing</span>';
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    setTimeout(() => {
      if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
      resolve();
    }, 1200 + Math.random() * 600);
  });
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

// ── Beginner vs Expert comparison card ──
function renderExpertComparison() {
  const container = document.getElementById("expert-comparison-ai-list");
  const section = document.getElementById("expert-comparison");
  if (!container || !section) return;
  const tests = getLastTestsInOrder();
  if (!tests.length) {
    section.classList.add("d-none");
    return;
  }
  container.innerHTML = tests
    .map((t) => {
      const tag = t.expertTag ? `<span class="badge expert-tag-badge me-1">${t.expertTag}</span>` : "";
      return `<span class="d-inline-flex align-items-center mb-1">${tag}<span class="text-break">${t.name}</span></span>`;
    })
    .join("");
  section.classList.remove("d-none");
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

// ── Validator Pipeline Visualization ──
async function showValidatorPipeline() {
  const section = document.getElementById("ai-strategy-section");
  if (!section) return;
  const grid = document.getElementById("ai-strategy-grid");
  if (!grid) return;

  const steps = [
    { icon: "bi-file-earmark-code", label: "Schema Analysis", desc: "Parsing OpenAPI spec for required fields, types, and constraints", color: "var(--neon-blue)" },
    { icon: "bi-shuffle", label: "Type Mutation Scan", desc: "Identifying fields where upstream sends unexpected types (Unix timestamps, booleans as strings)", color: "var(--neon-amber)" },
    { icon: "bi-shield-exclamation", label: "Security Assessment", desc: "Checking for injection vectors, PII exposure, and regex vulnerabilities", color: "var(--neon-red)" },
    { icon: "bi-diagram-3", label: "Business Logic Mapping", desc: "Cross-referencing endpoints for reconciliation gaps, idempotency, downstream impact", color: "var(--neon-green)" },
  ];

  // Show steps progressively
  let pipelineHtml = '<div class="col-12"><div class="validator-pipeline">';
  pipelineHtml += '<div class="validator-pipeline-title"><i class="bi bi-cpu me-1"></i>AI Validator Chain — How the test suite was decided</div>';
  pipelineHtml += '<div class="validator-steps" id="validator-steps"></div></div></div>';
  grid.insertAdjacentHTML("beforeend", pipelineHtml);

  const stepsContainer = document.getElementById("validator-steps");
  if (!stepsContainer) return;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    await sleep(700);
    const stepEl = document.createElement("div");
    stepEl.className = "validator-step entering";
    stepEl.innerHTML = `
      <div class="validator-step-number" style="background:${step.color}20;color:${step.color};border:1px solid ${step.color}40">${i + 1}</div>
      <div class="validator-step-body">
        <div class="d-flex align-items-center gap-2">
          <i class="bi ${step.icon}" style="color:${step.color}"></i>
          <span class="fw-semibold small">${step.label}</span>
          <span class="validator-step-spinner"></span>
        </div>
        <div class="small text-secondary mt-1">${step.desc}</div>
      </div>`;
    stepsContainer.appendChild(stepEl);
    requestAnimationFrame(() => stepEl.classList.remove("entering"));

    await sleep(600);
    // Mark as complete
    const spinner = stepEl.querySelector(".validator-step-spinner");
    if (spinner) spinner.innerHTML = '<i class="bi bi-check-circle-fill" style="color:var(--neon-green)"></i>';
  }
  await sleep(400);
}

// ── Auto-Repair Suggestions (Deep Simulation) ──
const REPAIRS_DB = {
  test_events_accepts_unix_timestamp_and_normalizes: {
    fix: "if isinstance(event_date, int):\n    event_date = datetime.utcfromtimestamp(event_date).strftime('%Y-%m-%d')",
    before: "event_date = payload.get('event_date')  # Raw pass-through",
    after: "event_date = payload.get('event_date')\nif isinstance(event_date, int):\n    event_date = datetime.utcfromtimestamp(event_date).strftime('%Y-%m-%d')",
    desc: "The Transformer needs a type-coercion layer for event_date.",
    node: "Transformer",
    rootCause: "Upstream CRM sends Unix timestamps (1719792000) but the Transformer blindly passes them through. The downstream ledger expects ISO-8601 strings.",
    impact: "All timestamp-dependent reconciliation reports would contain raw integers instead of dates, breaking T+0 settlement checks.",
  },
  test_create_payment_malicious_customer_name: {
    fix: "import bleach\ncustomer_name = bleach.clean(customer_name, strip=True)",
    before: "customer_name = payload['customer_name']  # No sanitization",
    after: "import bleach\ncustomer_name = bleach.clean(payload['customer_name'], strip=True)",
    desc: "The Validator lacks input sanitization.",
    node: "Validator",
    rootCause: "The Validator passes customer_name directly to the SQL query without escaping. SQL injection payload like Robert'); DROP TABLE payments; would execute.",
    impact: "Critical security vulnerability — an attacker could drop database tables or exfiltrate PII via crafted customer names.",
  },
  test_events_tolerates_extra_marketing_flag: {
    fix: "schema_validation: 'warn'  # was: 'strict'",
    before: "schema_validation: 'strict'  # Rejects unknown fields",
    after: "schema_validation: 'warn'  # Logs but accepts unknown fields",
    desc: "Change schema validation to tolerate upstream drift.",
    node: "APIGateway",
    rootCause: "The API Gateway is in strict mode, rejecting any JSON with undocumented fields. The CRM upstream started sending extra_marketing_flag without updating the spec.",
    impact: "100% of marketing opt-in events are silently dropped, causing $2.8M/day in lost attribution data.",
  },
  test_cross_pipe_reconciliation_shares: {
    fix: "assert_ledger_balance(ticker, expected_shares, tolerance=0)",
    before: "# No post-write verification",
    after: "balance = ledger.get_balance(ticker)\nassert_ledger_balance(ticker, expected_shares, tolerance=0)",
    desc: "Add post-write reconciliation assertion.",
    node: "DB",
    rootCause: "The trade pipe writes shares but never verifies the ledger received all of them. A race condition during batch ingestion can silently drop records.",
    impact: "Silent data loss: 100 shares traded but only 90 posted. $16,500 discrepancy per occurrence.",
  },
  test_redos_polynomial_regex_attack: {
    fix: "import regex\nregex.match(pattern, input, timeout=0.1)",
    before: "import re\nre.match(r'^(a+)+$', event_type)  # Vulnerable",
    after: "import regex  # Drop-in replacement with timeout\nregex.match(r'^(a+)+$', event_type, timeout=0.1)",
    desc: "Replace standard re with timeout-protected regex.",
    node: "Validator",
    rootCause: "The event_type regex uses nested quantifiers (a+)+$ which cause polynomial backtracking on crafted input. A single request with 'aaa...!' ties up a worker thread for >5 seconds.",
    impact: "Denial of Service: an attacker could exhaust all worker threads with just a few requests, bringing down the entire pipeline.",
  },
};

// Deep Apply Fix simulation
window._applyFixDeep = async function(testName, btnEl) {
  const repair = REPAIRS_DB[testName];
  if (!repair) return;

  const card = btnEl.closest(".auto-repair-card");
  if (!card) return;

  // Disable button immediately
  btnEl.disabled = true;
  btnEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Analyzing...';

  // Step 1: Root cause analysis
  const stepsContainer = document.createElement("div");
  stepsContainer.className = "fix-simulation-steps mt-3";
  card.appendChild(stepsContainer);

  await sleep(800);
  stepsContainer.innerHTML = `
    <div class="fix-step fix-step-active">
      <div class="fix-step-header"><i class="bi bi-search" style="color:var(--neon-blue)"></i><span>Step 1: Root Cause Analysis</span></div>
      <div class="fix-step-body">${repair.rootCause}</div>
      <div class="fix-step-impact"><i class="bi bi-exclamation-triangle me-1"></i>${repair.impact}</div>
    </div>`;

  // Step 2: Before/After diff
  await sleep(1500);
  btnEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Generating fix...';
  stepsContainer.innerHTML += `
    <div class="fix-step fix-step-active">
      <div class="fix-step-header"><i class="bi bi-file-diff" style="color:var(--neon-amber)"></i><span>Step 2: Code Diff</span></div>
      <div class="fix-diff-panels">
        <div class="fix-diff-panel fix-diff-before">
          <div class="fix-diff-label">BEFORE</div>
          <pre class="fix-diff-code"><code class="language-python">${repair.before}</code></pre>
        </div>
        <div class="fix-diff-arrow"><i class="bi bi-arrow-right"></i></div>
        <div class="fix-diff-panel fix-diff-after">
          <div class="fix-diff-label">AFTER</div>
          <pre class="fix-diff-code"><code class="language-python">${repair.after}</code></pre>
        </div>
      </div>
    </div>`;

  // Highlight code
  stepsContainer.querySelectorAll(".fix-diff-code code").forEach((el) => {
    if (window.hljs) { try { el.innerHTML = window.hljs.highlight(el.textContent, { language: "python" }).value; el.classList.add("hljs"); } catch {} }
  });

  // Step 3: Re-run verification
  await sleep(1800);
  btnEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Re-running test...';
  stepsContainer.innerHTML += `
    <div class="fix-step fix-step-active">
      <div class="fix-step-header"><i class="bi bi-play-circle" style="color:var(--neon-green)"></i><span>Step 3: Verification Re-run</span></div>
      <div class="fix-step-body">
        <div class="fix-rerun-progress"><div class="fix-rerun-bar"></div></div>
        <div class="fix-rerun-log small font-monospace mt-2">
          <div>Applying patch to ${repair.node}...</div>
        </div>
      </div>
    </div>`;

  await sleep(800);
  const log = stepsContainer.querySelector(".fix-rerun-log");
  if (log) log.innerHTML += `<div style="color:var(--neon-amber)">Re-running ${testName}...</div>`;
  await sleep(1000);
  if (log) log.innerHTML += `<div style="color:var(--neon-green)">✓ PASSED — fix verified successfully</div>`;

  // Step 4: Update button and add metrics
  await sleep(500);
  btnEl.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i>Fix Verified';
  btnEl.classList.add("btn-repair-applied");
  stepsContainer.innerHTML += `
    <div class="fix-step fix-step-success">
      <div class="fix-step-header"><i class="bi bi-check-circle-fill" style="color:var(--neon-green)"></i><span>Fix Applied Successfully</span></div>
      <div class="fix-metrics">
        <span class="fix-metric"><i class="bi bi-shield-check"></i> Node: ${repair.node} → Healthy</span>
        <span class="fix-metric"><i class="bi bi-arrow-down-circle"></i> Risk reduced</span>
        <span class="fix-metric"><i class="bi bi-clock-history"></i> Auto-heal time: ${(Math.random() * 2 + 1).toFixed(1)}s</span>
      </div>
    </div>`;

  appendLog("signal", `Fix applied: ${testName} at ${repair.node} — re-run verified PASS.`);
};

function appendAutoRepairSuggestions() {
  const detail = document.getElementById("xray-detail");
  if (!detail) return;
  const existing = detail.innerHTML;
  let html = "";
  for (const [testName, repair] of Object.entries(REPAIRS_DB)) {
    html += `<div class="auto-repair-card mt-2">
      <div class="d-flex align-items-center gap-2 mb-1">
        <i class="bi bi-wrench" style="color:var(--neon-amber)"></i>
        <span class="fw-semibold small">Self-Healing Suggestion</span>
        <span class="badge text-bg-secondary" style="font-size:0.6rem">${testName}</span>
        <button class="btn btn-repair ms-auto" onclick="window._applyFixDeep('${testName}', this)">
          <i class="bi bi-magic me-1"></i>Apply Fix
        </button>
      </div>
      <div class="small mb-2" style="color:var(--text-secondary)">${repair.desc}</div>
      <div class="small mb-2 fix-reason-text"><i class="bi bi-info-circle me-1" style="color:var(--neon-blue)"></i><strong>Why this fix:</strong> ${repair.rootCause}</div>
      <pre class="auto-repair-code small p-2 rounded mb-0"><code class="language-python">${repair.fix}</code></pre>
    </div>`;
  }
  detail.innerHTML = existing + html;
  detail.querySelectorAll(".auto-repair-code code").forEach((el) => {
    if (window.hljs) { try { el.innerHTML = window.hljs.highlight(el.textContent, { language: "python" }).value; el.classList.add("hljs"); } catch {} }
  });
  renderSelfHealingPreview();
}

// ── Mutation Score Analysis ──
function renderMutationScore(totalTests) {
  const container = document.getElementById("mutation-score-view");
  if (!container) return;
  const data = getMutationScore(totalTests);
  const scoreColor = data.score >= 80 ? "var(--neon-green)" : data.score >= 60 ? "var(--neon-amber)" : "var(--neon-red)";
  const scoreLabel = data.score >= 80 ? "STRONG" : data.score >= 60 ? "MODERATE" : "WEAK";

  container.innerHTML = `
    <div class="d-flex align-items-center gap-3 mb-3">
      <div class="mutation-score-ring" style="--score-color:${scoreColor}">
        <div class="mutation-score-inner">
          <div class="mutation-score-pct" style="color:${scoreColor}">${data.score}%</div>
          <div class="mutation-score-label">${scoreLabel}</div>
        </div>
      </div>
      <div>
        <div class="small fw-semibold mb-1">Mutation Kill Rate</div>
        <div class="small text-secondary">${data.killed} of ${data.total} injected bugs caught by tests</div>
        <div class="small text-secondary">${data.survived} mutants survived — potential blind spots</div>
      </div>
    </div>
    <div class="mutation-list">
      ${data.mutations.map((m) => `
        <div class="d-flex align-items-center gap-2 mb-1">
          <i class="bi ${m.killed ? "bi-check-circle-fill text-success" : "bi-x-circle-fill"}" style="${m.killed ? "" : "color:var(--neon-red)"}"></i>
          <span class="small fw-medium" style="min-width:160px">${m.operator}</span>
          <span class="small text-secondary flex-fill">${m.target}</span>
          ${m.killed ? `<span class="badge" style="font-size:0.55rem;background:rgba(0,255,153,0.1);color:var(--neon-green)">KILLED</span>` : `<span class="badge" style="font-size:0.55rem;background:rgba(255,76,76,0.1);color:var(--neon-red)">SURVIVED</span>`}
        </div>`).join("")}
    </div>`;
}

// ── Blast Radius Map ──
function renderBlastRadius() {
  const container = document.getElementById("blast-radius-view");
  if (!container) return;
  const data = getBlastRadius();

  container.innerHTML = `
    <div class="small mb-2 text-secondary">When a node fails, these downstream systems are impacted. Click a row to see the cascade.</div>
    ${data.impacts.map((imp) => {
      const sevColor = imp.severity === "critical" ? "var(--neon-red)" : imp.severity === "high" ? "var(--neon-amber)" : "var(--neon-green)";
      return `
        <div class="blast-radius-row mb-2 p-2 rounded">
          <div class="d-flex align-items-center gap-2 mb-1">
            <i class="bi bi-bullseye" style="color:${sevColor}"></i>
            <span class="fw-semibold small">${imp.failNode} failure</span>
            <span class="badge" style="font-size:0.6rem;background:${sevColor}20;color:${sevColor}">${imp.severity.toUpperCase()}</span>
            <span class="small ms-auto fw-bold" style="color:${sevColor}">${imp.exposure}</span>
          </div>
          <div class="d-flex flex-wrap gap-1">
            ${imp.affected.map((a) => `<span class="badge blast-affected-badge">${a}</span>`).join("")}
          </div>
        </div>`;
    }).join("")}`;
}

// ── Data Lineage Trace ──
function renderDataLineage() {
  const container = document.getElementById("lineage-view");
  if (!container) return;
  const data = getDataLineage();

  container.innerHTML = data.map((field) => {
    const stagesHtml = field.stages.map((s, i) => {
      const colorVar = s.color === "green" ? "var(--neon-green)" : s.color === "red" ? "var(--neon-red)" : "var(--neon-amber)";
      const connector = i < field.stages.length - 1 ? `<i class="bi bi-arrow-right lineage-arrow" style="color:var(--text-secondary)"></i>` : "";
      return `<div class="lineage-stage"><div class="lineage-stage-system" style="border-color:${colorVar}">${s.system}</div><div class="lineage-stage-format">${s.format}</div></div>${connector}`;
    }).join("");
    return `
      <div class="lineage-field mb-3">
        <div class="d-flex align-items-center gap-2 mb-2">
          <code class="lineage-field-name">${field.field}</code>
        </div>
        <div class="lineage-stages d-flex align-items-start gap-1 flex-wrap">${stagesHtml}</div>
      </div>`;
  }).join("");
}

// ── Test Impact Ranking ──
function renderTestImpactRanking() {
  const container = document.getElementById("impact-ranking-view");
  if (!container) return;
  const ranked = getTestImpactRanking(getLastTestsInOrder());
  const maxDaily = ranked.length > 0 ? ranked[0].daily : 1;

  container.innerHTML = `
    <div class="small mb-2 text-secondary">Tests ranked by daily business exposure. Higher = more critical to catch.</div>
    ${ranked.slice(0, 8).map((t, i) => {
      const pColor = t.priority === "critical" ? "var(--neon-red)" : t.priority === "high" ? "var(--neon-amber)" : t.priority === "medium" ? "var(--neon-blue)" : "var(--text-secondary)";
      const barPct = Math.max(5, (t.daily / maxDaily) * 100);
      return `
        <div class="d-flex align-items-center gap-2 mb-2">
          <span class="small fw-bold" style="min-width:18px;color:${pColor}">#${i + 1}</span>
          <div class="flex-fill">
            <div class="small fw-medium text-truncate" style="max-width:280px" title="${t.name}">${t.name.replace("test_", "")}</div>
            <div class="impact-bar-bg mt-1"><div class="impact-bar" style="width:${barPct}%;background:${pColor}"></div></div>
          </div>
          <span class="small fw-bold" style="min-width:80px;text-align:right;color:${pColor}">$${(t.daily / 1000000).toFixed(1)}M</span>
          ${t.expertTag ? `<span class="badge expert-tag-badge" style="font-size:0.55rem">${t.expertTag}</span>` : ""}
        </div>`;
    }).join("")}`;
}

// ── Schema Version Diff ──
function renderSchemaDiff() {
  const container = document.getElementById("schema-diff-view");
  if (!container) return;
  const data = getSchemaDiff();
  const typeIcons = { added: "bi-plus-circle-fill text-success", modified: "bi-pencil-fill", removed: "bi-dash-circle-fill" };
  const typeColors = { added: "var(--neon-green)", modified: "var(--neon-amber)", removed: "var(--neon-red)" };

  container.innerHTML = `
    <div class="d-flex align-items-center gap-2 mb-3">
      <span class="badge" style="background:var(--bg-card);color:var(--text-secondary);border:1px solid rgba(148,163,184,0.2)">${data.from}</span>
      <i class="bi bi-arrow-right text-secondary"></i>
      <span class="badge badge-glow-green">${data.to}</span>
      <span class="small text-secondary ms-2">${data.changes.length} changes</span>
      <span class="badge" style="font-size:0.6rem;background:rgba(0,255,153,0.1);color:var(--neon-green)">${data.newTestsNeeded} new tests needed</span>
      <span class="badge" style="font-size:0.6rem;background:rgba(255,76,76,0.1);color:var(--neon-red)">${data.breakingTests} breaking</span>
    </div>
    ${data.changes.map((c) => `
      <div class="d-flex align-items-start gap-2 mb-2">
        <i class="bi ${typeIcons[c.type]}" style="color:${typeColors[c.type]};margin-top:2px"></i>
        <div>
          <code class="small" style="color:${typeColors[c.type]}">${c.path}</code>
          <div class="small text-secondary">${c.desc}</div>
          <div class="small fw-medium" style="color:var(--neon-purple)">${c.impact}</div>
        </div>
      </div>`).join("")}`;
}

// ── Latency & Throughput Simulation ──
function renderLatencySimulation() {
  const container = document.getElementById("latency-sim-view");
  if (!container) return;
  const data = getLatencySimulation();
  const throughputPct = Math.round((data.overallThroughput / data.targetRps) * 100);
  const p99Status = data.overallP99 <= data.targetP99Ms ? "PASS" : "BREACH";
  const p99Color = p99Status === "PASS" ? "var(--neon-green)" : "var(--neon-red)";

  container.innerHTML = `
    <div class="d-flex flex-wrap gap-3 mb-3">
      <div class="latency-gauge text-center">
        <div class="small text-secondary">Throughput</div>
        <div class="fw-bold" style="color:${throughputPct >= 95 ? "var(--neon-green)" : "var(--neon-amber)"}">${data.overallThroughput.toLocaleString()} rps</div>
        <div class="latency-gauge-bar"><div class="latency-gauge-fill" style="width:${throughputPct}%;background:${throughputPct >= 95 ? "var(--neon-green)" : "var(--neon-amber)"}"></div></div>
        <div class="small text-secondary">Target: ${data.targetRps.toLocaleString()} rps</div>
      </div>
      <div class="latency-gauge text-center">
        <div class="small text-secondary">P99 Latency</div>
        <div class="fw-bold" style="color:${p99Color}">${data.overallP99}ms</div>
        <div class="latency-gauge-bar"><div class="latency-gauge-fill" style="width:${Math.min(100, (data.overallP99 / 400) * 100)}%;background:${p99Color}"></div></div>
        <div class="small text-secondary">Target: &lt;${data.targetP99Ms}ms</div>
      </div>
    </div>
    <div class="small fw-semibold mb-2">Per-Node Breakdown</div>
    ${data.nodes.map((n) => {
      const isBottleneck = n.bottleneck;
      const barColor = n.p99Ms > data.targetP99Ms ? "var(--neon-red)" : n.p99Ms > data.targetP99Ms * 0.8 ? "var(--neon-amber)" : "var(--neon-green)";
      return `
        <div class="d-flex align-items-center gap-2 mb-1">
          ${isBottleneck ? '<i class="bi bi-exclamation-triangle-fill" style="color:var(--neon-red);font-size:0.7rem"></i>' : '<i class="bi bi-circle" style="color:var(--text-secondary);font-size:0.5rem"></i>'}
          <span class="small fw-medium" style="min-width:120px">${n.name}</span>
          <div class="flex-fill"><div class="flakiness-bar-bg"><div class="flakiness-bar" style="width:${Math.min(100, (n.p99Ms / 400) * 100)}%;background:${barColor}"></div></div></div>
          <span class="small" style="min-width:50px;color:${barColor}">${n.p99Ms}ms</span>
          ${isBottleneck ? '<span class="badge" style="font-size:0.55rem;background:rgba(255,76,76,0.1);color:var(--neon-red)">BOTTLENECK</span>' : ""}
        </div>`;
    }).join("")}
    ${data.slaBreaches.length > 0 ? `
      <div class="small fw-semibold mt-2 mb-1" style="color:var(--neon-red)">SLA Breaches</div>
      ${data.slaBreaches.map((b) => `<div class="d-flex align-items-center gap-2 mb-1"><i class="bi bi-x-circle-fill" style="color:var(--neon-red);font-size:0.7rem"></i><span class="small">${b.node}: ${b.metric} = ${b.value} (threshold: ${b.threshold})</span></div>`).join("")}` : ""}`;
}

// ── Dead Letter Queue ──
function renderDlq() {
  const container = document.getElementById("dlq-view");
  if (!container) return;
  const data = getDlqData();
  const statusIcons = { exhausted: "bi-x-circle text-secondary", poison: "bi-radioactive", retrying: "bi-arrow-repeat" };
  const statusColors = { exhausted: "var(--text-secondary)", poison: "var(--neon-red)", retrying: "var(--neon-amber)" };

  container.innerHTML = `
    <div class="d-flex flex-wrap gap-2 mb-3">
      <span class="badge" style="background:rgba(148,163,184,0.1);color:var(--text-secondary);font-size:0.7rem">${data.totalMessages} total messages</span>
      <span class="badge" style="background:rgba(255,76,76,0.1);color:var(--neon-red);font-size:0.7rem">${data.poisonPills} poison pills</span>
      <span class="badge" style="background:rgba(245,158,11,0.1);color:var(--neon-amber);font-size:0.7rem">${data.messages.filter((m) => m.status === "retrying").length} retrying</span>
    </div>
    ${data.messages.map((m) => `
      <div class="dlq-message mb-2 p-2 rounded">
        <div class="d-flex align-items-center gap-2 mb-1">
          <i class="bi ${statusIcons[m.status]}" style="color:${statusColors[m.status]}"></i>
          <code class="small" style="color:var(--neon-blue)">${m.id}</code>
          <span class="badge" style="font-size:0.55rem;background:${statusColors[m.status]}20;color:${statusColors[m.status]}">${m.status.toUpperCase()}</span>
          <span class="small text-secondary ms-auto">${m.age}</span>
        </div>
        <div class="small text-secondary">${m.reason}</div>
        <div class="d-flex align-items-center gap-2 mt-1">
          <span class="small" style="color:var(--text-secondary)">Retries: ${m.retries}/3</span>
          <div class="dlq-retry-dots">${[0,1,2].map((i) => `<span class="dlq-retry-dot ${i < m.retries ? "used" : ""}"></span>`).join("")}</div>
        </div>
      </div>`).join("")}`;
}

// ── Section Navigation ──
// Auto-scrolling removed — users scroll at their own pace.
// Keeping function signature so section nav clicks still work.
function scrollToSection(id) {
  // Only scroll when user explicitly clicks nav dots, not during auto flow
  const el = document.getElementById(id);
  if (el && !isRunning) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function initSectionNav() {
  const sections = ["hero-section", "console-section", "spec-code-section", "xray-section", "insights-section", "advanced-section"];
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

// ── Phase Transition Vignette ──
function flashPhaseVignette(fail = false) {
  const vig = document.createElement("div");
  vig.className = `phase-vignette${fail ? " fail" : ""}`;
  document.body.appendChild(vig);
  setTimeout(() => vig.remove(), 700);
}

// ── Progressive Disclosure: Analytics Panels ──
function hideAnalyticsPanels() {
  document.querySelectorAll("#insights-section > div, #advanced-section > div").forEach((el) => {
    el.classList.add("panel-reveal");
    el.classList.remove("revealed");
  });
}

function revealAnalyticsPanels() {
  const panels = document.querySelectorAll(".panel-reveal");
  panels.forEach((el, i) => {
    setTimeout(() => el.classList.add("revealed"), i * 150);
  });
}

// ── Fullscreen X-Ray Toggle ──
let xrayFullscreen = false;
let xrayBackdrop = null;

function initFullscreenXray() {
  const btn = document.getElementById("xray-fullscreen-btn");
  if (!btn) return;
  btn.addEventListener("click", toggleFullscreenXray);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && xrayFullscreen) toggleFullscreenXray();
  });
}

function toggleFullscreenXray() {
  const xrayCard = document.querySelector("#xray-section .xray-card");
  const btn = document.getElementById("xray-fullscreen-btn");
  if (!xrayCard) return;

  xrayFullscreen = !xrayFullscreen;

  if (xrayFullscreen) {
    xrayBackdrop = document.createElement("div");
    xrayBackdrop.className = "xray-fullscreen-backdrop";
    xrayBackdrop.addEventListener("click", toggleFullscreenXray);
    document.body.appendChild(xrayBackdrop);
    xrayCard.classList.add("xray-fullscreen");
    if (btn) btn.innerHTML = '<i class="bi bi-fullscreen-exit"></i>';
  } else {
    if (xrayBackdrop) { xrayBackdrop.remove(); xrayBackdrop = null; }
    xrayCard.classList.remove("xray-fullscreen");
    if (btn) btn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i>';
  }
}

// ── Spark Particles on Time Saved Counter ──
function spawnTimeSparks() {
  const container = document.getElementById("time-saved-float");
  if (!container) return;
  container.style.position = "relative";
  for (let i = 0; i < 6; i++) {
    const spark = document.createElement("div");
    spark.className = "spark";
    spark.style.left = "50%";
    spark.style.top = "50%";
    spark.style.setProperty("--spark-x", `${(Math.random() - 0.5) * 60}px`);
    spark.style.setProperty("--spark-y", `${-Math.random() * 40 - 10}px`);
    container.appendChild(spark);
    setTimeout(() => spark.remove(), 800);
  }
}
