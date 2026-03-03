const CATEGORY_KEYS = {
  "Happy Path": "happy",
  "Edge Cases": "edge",
  "Malicious Inputs": "malicious",
  "Property-Based": "property",
};

const typingQueues = { happy: [], edge: [], malicious: [], property: [] };
const typingState = { happy: null, edge: null, malicious: null, property: null };
const editorContents = { happy: "", edge: "", malicious: "", property: "" };

// ── Spec Extraction Annotations ──
const EXTRACTION_RULES = [
  { delay: 400, text: "POST /payments", type: "" },
  { delay: 800, text: "required: amount, currency", type: "" },
  { delay: 1200, text: "POST /events — idempotency key", type: "warn" },
  { delay: 1600, text: "event_date: string|unix?", type: "risk" },
  { delay: 2000, text: "extra_marketing_flag drift", type: "risk" },
  { delay: 2400, text: "customer_name: no sanitization", type: "risk" },
  { delay: 2800, text: "ISO 4217 currency constraint", type: "" },
];

let extractionTimers = [];

export function specScanStart() {
  const overlay = document.getElementById("spec-scan-overlay");
  const shell = document.getElementById("spec-preview-shell");
  const textarea = document.getElementById("spec-text");
  const extractions = document.getElementById("spec-extractions");

  if (overlay) overlay.classList.remove("d-none");
  if (shell) shell.style.display = "block";
  if (extractions) extractions.innerHTML = "";

  if (textarea) {
    const preview = document.getElementById("spec-preview");
    if (preview) {
      const code = preview.querySelector("code") || preview;
      code.textContent = textarea.value;
      safeHighlight(code, "yaml");
    }
  }

  extractionTimers.forEach(clearTimeout);
  extractionTimers = [];

  EXTRACTION_RULES.forEach((rule) => {
    const timer = setTimeout(() => {
      if (!extractions) return;
      const chip = document.createElement("div");
      chip.className = `spec-extract-chip ${rule.type}`;
      chip.innerHTML = `<i class="bi bi-${rule.type === "risk" ? "exclamation-triangle" : rule.type === "warn" ? "clock-history" : "check2"} me-1"></i>${rule.text}`;
      extractions.appendChild(chip);

      while (extractions.children.length > 5) {
        extractions.removeChild(extractions.firstChild);
      }
    }, rule.delay);
    extractionTimers.push(timer);
  });
}

export function specScanStop() {
  const overlay = document.getElementById("spec-scan-overlay");
  if (overlay) overlay.classList.add("d-none");
  extractionTimers.forEach(clearTimeout);
  extractionTimers = [];
}

export function renderSpecSummary(summary) {
  const shell = document.getElementById("spec-summary");
  const badge = document.getElementById("spec-kind-badge");
  if (!shell) return;

  if (badge && summary && badge.textContent !== "COBOL Legacy") {
    badge.textContent = `${summary.endpoint_count} endpoints`;
  }

  if (!summary) {
    shell.textContent = "";
    return;
  }

  const risks = (summary.risk_flags || []).map((r) => `<li>${r}</li>`).join("");

  shell.innerHTML = `
    <div class="d-flex flex-wrap gap-2 mb-2">
      <span class="metric-pill badge-glow-green"><i class="bi bi-diagram-3 me-1"></i>${summary.endpoint_count} endpoints</span>
      <span class="metric-pill badge-glow-red"><i class="bi bi-exclamation-triangle me-1"></i>${summary.risk_flags.length} risk hotspots</span>
    </div>
    <ul class="mb-0 small text-secondary" style="padding-left:1.2rem;">${risks}</ul>
  `;
}

export function resetCodePanes() {
  for (const key of Object.keys(typingQueues)) {
    typingQueues[key] = [];
    if (typingState[key]) {
      clearInterval(typingState[key]);
      typingState[key] = null;
    }
    editorContents[key] = "";
  }

  document.querySelectorAll(".code-pane code").forEach((codeEl) => {
    const cat = codeEl.id.replace("code-", "");
    codeEl.className = "language-python hljs";
    codeEl.innerHTML = `<span class="hljs-comment"># ${capitalize(cat)} tests will stream here...</span>`;
  });

  document.querySelectorAll(".expert-insight-insert").forEach((el) => el.remove());

  const countIds = ["count-happy", "count-edge", "count-malicious", "count-property"];
  countIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "0";
  });
}

export function queueCodeTyping(categoryLabel, testName, code, meta) {
  const key = CATEGORY_KEYS[categoryLabel];
  if (!key) return;

  const header = `\n\n# --- ${testName} ---\n`;
  const snippet = header + code + "\n";
  const payload = { snippet, meta: meta || {} };

  typingQueues[key].push(payload);
  if (!typingState[key]) typingState[key] = startTypingLoop(key);
}

function startTypingLoop(key) {
  const baseMs = 6;
  let buffer = "";
  let current = null;
  let currentMeta = null;
  let pauseUntil = 0;
  let isFirstSnippet = editorContents[key].length === 0;

  return setInterval(() => {
    const now = Date.now();
    if (pauseUntil > now) return;

    if (!current) {
      const payload = typingQueues[key].shift();
      buffer = "";
      currentMeta = null;

      if (!payload) {
        clearInterval(typingState[key]);
        typingState[key] = null;
        applyHighlight(key);
        removeThinkingIndicator(key);
        return;
      }

      current = typeof payload === "string" ? payload : payload.snippet;
      currentMeta = typeof payload === "object" && payload.meta ? payload.meta : null;

      if (!isFirstSnippet) {
        showThinkingIndicator(key);
        pauseUntil = now + 300 + Math.random() * 200;
        return;
      }
      isFirstSnippet = false;
    }

    removeThinkingIndicator(key);

    const speedJitter = Math.random() > 0.85 ? 2 : Math.random() > 0.5 ? 5 : 8;
    const chunkSize = speedJitter;
    const next = current.slice(buffer.length, buffer.length + chunkSize);
    buffer += next;
    editorContents[key] += next;

    const pane = document.getElementById(`code-${key}`);
    if (pane) pane.textContent = editorContents[key];

    if (buffer.length >= current.length) {
      applyHighlight(key);
      if (currentMeta && (currentMeta.expertTag || currentMeta.insightBeginner || currentMeta.insightExpert || currentMeta.confidence != null)) {
        appendExpertInsight(key, currentMeta);
      }
      current = null;
      currentMeta = null;
      isFirstSnippet = false;
    }
  }, baseMs);
}

function appendExpertInsight(key, meta) {
  const pane = document.getElementById(`code-${key}`);
  if (!pane) return;
  const paneParent = pane.closest(".tab-pane");
  if (!paneParent) return;

  const confidence = meta.confidence != null ? meta.confidence : 0.98;
  const pct = Math.round(confidence * 100);
  const confidenceClass = confidence >= 0.97 ? "confidence-high" : confidence >= 0.93 ? "confidence-medium" : "confidence-low";

  const testId = meta._testName || `test-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

  let cardHtml = "";
  if (meta.expertTag || meta.insightBeginner || meta.insightExpert) {
    cardHtml = `
      <div class="expert-insight-card mt-2 mb-2">
        <div class="d-flex align-items-center gap-2 mb-2">
          <i class="bi bi-mortarboard-fill expert-insight-icon"></i>
          ${meta.expertTag ? `<span class="badge expert-tag-badge">${meta.expertTag}</span>` : ""}
          <span class="badge ${confidenceClass} confidence-badge ms-auto">${pct}% deterministic</span>
        </div>
        <div class="row g-2 small">
          <div class="col-6">
            <div class="text-secondary mb-1">Beginner would</div>
            <div class="expert-insight-text">${meta.insightBeginner || "—"}</div>
          </div>
          <div class="col-6">
            <div class="text-secondary mb-1">Expert checks</div>
            <div class="expert-insight-text fw-medium">${meta.insightExpert || "—"}</div>
          </div>
        </div>
        <div class="mt-2 text-end">
          <button class="btn btn-why-test" onclick="window._showTestReasoning('${meta.expertTag || ''}', '${meta.insightExpert || ''}', '${meta.insightBeginner || ''}', ${pct})">
            <i class="bi bi-lightbulb me-1"></i>Why This Test?
          </button>
        </div>
      </div>`;
  } else if (meta.confidence != null) {
    cardHtml = `<div class="expert-insight-card mt-2 mb-2 d-flex justify-content-end"><span class="badge ${confidenceClass} confidence-badge">${pct}% deterministic</span></div>`;
  }

  if (!cardHtml) return;

  const pre = pane.closest("pre");
  if (!pre || !pre.parentNode) return;
  const div = document.createElement("div");
  div.className = "expert-insight-insert";
  div.innerHTML = cardHtml;
  pre.parentNode.insertBefore(div, pre.nextSibling);
}

// ── "Why This Test?" Reasoning Drawer ──
const TEST_REASONING_DB = {
  "Edge Validation": {
    validators: ["Schema Analysis", "Type Mutation Scan"],
    reasoning: "The AI detected boundary values (zero, overflow, invalid ISO currency) that are commonly missed in manual tests. These parametrized cases catch off-by-one errors and type confusion that cause $200K/day in failed transactions.",
    alternatives: ["Single-value assertion (less coverage)", "Exhaustive enumeration of all currencies (too slow)"],
    risk: "Each failed edge case in production silently drops a transaction. At PG's volume, even 0.01% failure rate costs $200K/day.",
  },
  "Idempotency": {
    validators: ["Business Logic Mapping"],
    reasoning: "Idempotency on event_id prevents duplicate downstream records. The AI fires the same payload 3x and asserts only 1 record appears — catching race conditions that single-request tests miss entirely.",
    alternatives: ["Single POST and check response (doesn't test dedup)", "Timestamp-based dedup (fragile)"],
    risk: "Without idempotency testing, duplicate charges can occur at scale. For payment events, this could mean double-billing customers — a $5.4M/day exposure.",
  },
  "Type Mutation": {
    validators: ["Type Mutation Scan", "Schema Analysis"],
    reasoning: "The AI identified that event_date accepts both ISO strings and Unix timestamps from different upstream systems. Rather than just testing the documented format, it probes the undocumented one to verify normalization.",
    alternatives: ["Only test documented format (misses real-world input)", "Reject all non-string dates (breaks upstream)"],
    risk: "If the Transformer fails to normalize, downstream reconciliation reports break. The legacy ledger expects ISO-8601, and raw timestamps cause T+0 settlement failures ($3.1M/day).",
  },
  "Injection & Encoding": {
    validators: ["Security Assessment"],
    reasoning: "The AI's security scanner detected that customer_name is passed to SQL queries without sanitization. It generates SQL injection, emoji, and RTL spoofing payloads to stress-test the input pipeline end-to-end.",
    alternatives: ["Whitelist validation only (blocks legitimate Unicode names)", "WAF-level blocking (can be bypassed)"],
    risk: "SQL injection in a payments API is a critical vulnerability. An attacker could exfiltrate PII or drop tables — triggering regulatory fines ($1.2M+) and reputational damage.",
  },
  "Schema Drift": {
    validators: ["Schema Analysis", "Business Logic Mapping"],
    reasoning: "The AI noticed the spec doesn't mention extra_marketing_flag, but CRM systems in production commonly add undocumented fields. This test verifies the pipe degrades gracefully rather than hard-rejecting valid data.",
    alternatives: ["Strict schema enforcement (drops valid data)", "Accept-all mode (no validation)"],
    risk: "Strict mode silently drops 100% of marketing events when CRM adds new fields — $2.8M/day in lost attribution data that nobody notices for weeks.",
  },
  "Property-Based": {
    validators: ["Type Mutation Scan", "Security Assessment"],
    reasoning: "Instead of testing one 'John Doe', the AI generates 100+ name variants: emojis, RTL text, SQL injection, null bytes, oversized strings. This catches edge cases that deterministic tests miss.",
    alternatives: ["Manual test cases (10-20 examples)", "Regex-only validation (misses encoding attacks)"],
    risk: "Property-based testing catches the 'unknown unknowns' — the encoding attacks and Unicode edge cases that no human would think to test manually. At scale, these cause $600K/day in processing failures.",
  },
  "Mock Resilience": {
    validators: ["Business Logic Mapping"],
    reasoning: "The AI generates a mock for RiskScoreAPI, sets it to 'down', and tests the fallback path. This proves the system degrades gracefully when third-party dependencies fail — which happens in production regularly.",
    alternatives: ["Skip tests when dependency is down (hides bugs)", "Point at real service (flaky, expensive)"],
    risk: "If RiskScoreAPI goes down with no fallback, all payment requests fail. At PG's volume, 15 minutes of downtime costs $900K in blocked transactions.",
  },
  "Cross-Pipe Integrity": {
    validators: ["Business Logic Mapping"],
    reasoning: "The AI reconciles two separate systems: the trade pipe and the ledger. It writes 100 shares via one endpoint and verifies the count via another. This catches silent data loss between systems.",
    alternatives: ["Test each system in isolation (misses integration bugs)", "Manual reconciliation reports (delayed by hours)"],
    risk: "Cross-pipe discrepancy: 100 shares traded but only 90 posted. At $165/share, that's $16,500 lost per occurrence. At scale, undetected data loss compounds exponentially.",
  },
  "PII Detection": {
    validators: ["Security Assessment"],
    reasoning: "The AI regex-scans log output for SSN, email, and credit card patterns after making requests with known PII. This catches accidental PII leaks into log aggregators — a common GDPR/PCI-DSS violation.",
    alternatives: ["Manual log review (slow, error-prone)", "DLP at network level (misses application logs)"],
    risk: "PII leaked to logs triggers GDPR fines (up to 4% of global revenue) and PCI-DSS audit failures. A single unmasked credit card number in logs can cost $450K in penalties.",
  },
};

window._showTestReasoning = function(expertTag, insightExpert, insightBeginner, confidence) {
  const data = TEST_REASONING_DB[expertTag] || {
    validators: ["Schema Analysis", "Business Logic Mapping"],
    reasoning: insightExpert || "The AI identified this test case based on patterns in the API specification.",
    alternatives: [insightBeginner || "Simple assertion test"],
    risk: "This test covers a critical data path that, if untested, could lead to silent data corruption in production.",
  };

  // Create or update drawer
  let drawer = document.getElementById("test-reasoning-drawer");
  if (!drawer) {
    drawer = document.createElement("div");
    drawer.id = "test-reasoning-drawer";
    drawer.className = "test-reasoning-drawer";
    document.body.appendChild(drawer);
  }

  drawer.innerHTML = `
    <div class="test-reasoning-header">
      <div class="d-flex align-items-center gap-2">
        <i class="bi bi-lightbulb-fill" style="color:var(--neon-amber);font-size:1.2rem"></i>
        <span class="fw-bold">Why This Test?</span>
        ${expertTag ? `<span class="badge expert-tag-badge">${expertTag}</span>` : ""}
        <span class="badge confidence-${confidence >= 97 ? 'high' : confidence >= 93 ? 'medium' : 'low'} confidence-badge ms-auto">${confidence}% deterministic</span>
      </div>
      <button class="btn-close-drawer" onclick="document.getElementById('test-reasoning-drawer').classList.remove('open')">
        <i class="bi bi-x-lg"></i>
      </button>
    </div>
    <div class="test-reasoning-body">
      <div class="reasoning-section">
        <div class="reasoning-section-title"><i class="bi bi-cpu me-1"></i>Validator Chain</div>
        <div class="reasoning-validators">
          ${data.validators.map((v, i) => `<span class="reasoning-validator-chip">${i + 1}. ${v}</span>`).join('<i class="bi bi-arrow-right reasoning-arrow"></i>')}
        </div>
      </div>
      <div class="reasoning-section">
        <div class="reasoning-section-title"><i class="bi bi-chat-dots me-1"></i>AI Reasoning</div>
        <div class="reasoning-text">${data.reasoning}</div>
      </div>
      <div class="reasoning-section">
        <div class="reasoning-section-title"><i class="bi bi-arrow-left-right me-1"></i>Why This is Better</div>
        <div class="reasoning-alternatives">
          ${data.alternatives.map(a => `<div class="reasoning-alt"><i class="bi bi-x-circle" style="color:var(--neon-red)"></i><span>${a}</span></div>`).join('')}
          <div class="reasoning-alt reasoning-alt-chosen"><i class="bi bi-check-circle-fill" style="color:var(--neon-green)"></i><span><strong>AI's approach:</strong> ${insightExpert || 'Expert-grade comprehensive testing'}</span></div>
        </div>
      </div>
      <div class="reasoning-section reasoning-risk">
        <div class="reasoning-section-title"><i class="bi bi-exclamation-triangle me-1"></i>Business Risk if Untested</div>
        <div class="reasoning-text">${data.risk}</div>
      </div>
    </div>
  `;

  // Open with animation
  requestAnimationFrame(() => drawer.classList.add("open"));
};

function showThinkingIndicator(key) {
  const pane = document.getElementById(`code-${key}`);
  if (!pane) return;
  const existing = pane.parentElement.querySelector(".code-thinking-indicator");
  if (existing) return;

  const indicator = document.createElement("div");
  indicator.className = "code-thinking-indicator";
  indicator.textContent = "AI generating next test";
  pane.parentElement.appendChild(indicator);
}

function removeThinkingIndicator(key) {
  const pane = document.getElementById(`code-${key}`);
  if (!pane) return;
  const existing = pane.parentElement.querySelector(".code-thinking-indicator");
  if (existing) existing.remove();
}

function applyHighlight(key) {
  const pane = document.getElementById(`code-${key}`);
  if (!pane) return;
  const raw = editorContents[key];
  if (!raw.trim()) return;

  if (window.hljs && typeof window.hljs.highlight === "function") {
    try {
      const result = window.hljs.highlight(raw, { language: "python" });
      pane.innerHTML = result.value;
      pane.className = "language-python hljs";
    } catch {
      pane.textContent = raw;
    }
  }
}

function safeHighlight(el, lang) {
  if (!window.hljs || !el) return;
  try {
    const raw = el.textContent || "";
    const result = window.hljs.highlight(raw, { language: lang });
    el.innerHTML = result.value;
    el.classList.add("hljs");
  } catch {
    // keep plain text
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function updateCategoryCounts(counts) {
  const map = {
    "Happy Path": "count-happy",
    "Edge Cases": "count-edge",
    "Malicious Inputs": "count-malicious",
    "Property-Based": "count-property",
  };
  const order = ["Happy Path", "Edge Cases", "Malicious Inputs", "Property-Based"];
  order.forEach((label) => {
    const el = document.getElementById(map[label]);
    const value = counts && counts[label] !== undefined ? counts[label] : 0;
    if (el) el.textContent = String(value);
  });
}
