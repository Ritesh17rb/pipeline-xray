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
