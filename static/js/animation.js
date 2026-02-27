const CATEGORY_KEYS = {
  "Happy Path": "happy",
  "Edge Cases": "edge",
  "Malicious Inputs": "malicious",
  "Property-Based": "property",
};

const typingQueues = { happy: [], edge: [], malicious: [], property: [] };
const typingState = { happy: null, edge: null, malicious: null, property: null };
const editorContents = { happy: "", edge: "", malicious: "", property: "" };

export function specScanStart() {
  const overlay = document.getElementById("spec-scan-overlay");
  const shell = document.getElementById("spec-preview-shell");
  const textarea = document.getElementById("spec-text");
  if (overlay) overlay.classList.remove("d-none");
  if (shell) shell.style.display = "block";
  if (textarea) {
    const preview = document.getElementById("spec-preview");
    if (preview) {
      const code = preview.querySelector("code") || preview;
      code.textContent = textarea.value;
      safeHighlight(code, "yaml");
    }
  }
}

export function specScanStop() {
  const overlay = document.getElementById("spec-scan-overlay");
  if (overlay) overlay.classList.add("d-none");
}

export function renderSpecSummary(summary) {
  const shell = document.getElementById("spec-summary");
  const badge = document.getElementById("spec-kind-badge");
  if (!shell) return;

  if (badge && summary) {
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
}

export function queueCodeTyping(categoryLabel, testName, code) {
  const key = CATEGORY_KEYS[categoryLabel];
  if (!key) return;

  const header = `\n\n# --- ${testName} ---\n`;
  const snippet = header + code + "\n";

  typingQueues[key].push(snippet);
  if (!typingState[key]) typingState[key] = startTypingLoop(key);
}

function startTypingLoop(key) {
  const intervalMs = 8;
  let buffer = "";
  let current = null;

  return setInterval(() => {
    if (!current) {
      current = typingQueues[key].shift();
      buffer = "";
      if (!current) {
        clearInterval(typingState[key]);
        typingState[key] = null;
        applyHighlight(key);
        return;
      }
    }

    const chunkSize = 6;
    const next = current.slice(buffer.length, buffer.length + chunkSize);
    buffer += next;
    editorContents[key] += next;

    // During typing, show raw text (fast, no re-parse every frame)
    const pane = document.getElementById(`code-${key}`);
    if (pane) pane.textContent = editorContents[key];

    if (buffer.length >= current.length) {
      current = null;
      applyHighlight(key);
    }
  }, intervalMs);
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
  Object.entries(counts || {}).forEach(([label, value]) => {
    const el = document.getElementById(map[label]);
    if (el) el.textContent = String(value);
  });
}
