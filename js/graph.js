const NODE_LAYOUT = [
  { id: "Client", x: 80, y: 165, icon: "\u{1F464}", label: "Client" },
  { id: "API Gateway", x: 230, y: 80, icon: "\u{1F6E1}", label: "API Gateway" },
  { id: "Validator", x: 400, y: 80, icon: "\u2713", label: "Validator" },
  { id: "Transformer", x: 570, y: 80, icon: "\u21BB", label: "Transformer" },
  { id: "Database", x: 720, y: 165, icon: "\u{1F4BE}", label: "Database" },
  { id: "Legacy Emulator", x: 570, y: 250, icon: "\u2699", label: "Legacy Emulator" },
  { id: "Risk Score API", x: 400, y: 250, icon: "\u26A0", label: "Risk Score API" },
];

const EDGES = [
  ["Client", "API Gateway"],
  ["API Gateway", "Validator"],
  ["Validator", "Transformer"],
  ["Transformer", "Database"],
  ["Transformer", "Legacy Emulator"],
  ["Validator", "Risk Score API"],
];

let svg = null;
let nodeMap = {};
let edgeMap = {};
let packetsLayer = null;
let failureLog = [];
let passCount = 0;
let failCount = 0;
let totalExpected = 0;
let nodesVisited = new Set();

export function initGraph() {
  const container = document.getElementById("xray-graph");
  if (!container) return;

  if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
  svg = null;
  nodeMap = {};
  edgeMap = {};
  packetsLayer = null;

  const ns = "http://www.w3.org/2000/svg";
  svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 800 340");
  svg.setAttribute("width", "100%");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.minHeight = "340px";
  svg.style.display = "block";

  const defs = document.createElementNS(ns, "defs");

  const glow = document.createElementNS(ns, "filter");
  glow.setAttribute("id", "glow");
  glow.setAttribute("x", "-50%");
  glow.setAttribute("y", "-50%");
  glow.setAttribute("width", "200%");
  glow.setAttribute("height", "200%");
  glow.innerHTML = `<feGaussianBlur stdDeviation="4" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>`;
  defs.appendChild(glow);

  const packetGlow = document.createElementNS(ns, "filter");
  packetGlow.setAttribute("id", "packetGlow");
  packetGlow.setAttribute("x", "-100%");
  packetGlow.setAttribute("y", "-100%");
  packetGlow.setAttribute("width", "300%");
  packetGlow.setAttribute("height", "300%");
  packetGlow.innerHTML = `<feGaussianBlur stdDeviation="3" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>`;
  defs.appendChild(packetGlow);

  const marker = document.createElementNS(ns, "marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("markerWidth", "10");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "3.5");
  marker.setAttribute("orient", "auto");
  const arrow = document.createElementNS(ns, "path");
  arrow.setAttribute("d", "M0 0 L10 3.5 L0 7 Z");
  arrow.classList.add("xray-arrowhead");
  marker.appendChild(arrow);
  defs.appendChild(marker);

  svg.appendChild(defs);

  EDGES.forEach(([fromId, toId]) => {
    const from = NODE_LAYOUT.find((n) => n.id === fromId);
    const to = NODE_LAYOUT.find((n) => n.id === toId);
    if (!from || !to) return;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const offsetStart = 32;
    const offsetEnd = 32;
    const sx = from.x + (dx / dist) * offsetStart;
    const sy = from.y + (dy / dist) * offsetStart;
    const ex = to.x - (dx / dist) * offsetEnd;
    const ey = to.y - (dy / dist) * offsetEnd;

    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(sx));
    line.setAttribute("y1", String(sy));
    line.setAttribute("x2", String(ex));
    line.setAttribute("y2", String(ey));
    line.classList.add("xray-edge");
    line.setAttribute("marker-end", "url(#arrowhead)");
    svg.appendChild(line);
    edgeMap[`${fromId}->${toId}`] = line;
  });

  packetsLayer = document.createElementNS(ns, "g");
  svg.appendChild(packetsLayer);

  NODE_LAYOUT.forEach((node) => {
    const g = document.createElementNS(ns, "g");
    g.classList.add("xray-node");
    g.dataset.nodeId = node.id;

    const ring = document.createElementNS(ns, "circle");
    ring.setAttribute("cx", String(node.x));
    ring.setAttribute("cy", String(node.y));
    ring.setAttribute("r", "32");
    ring.classList.add("xray-node-ring");
    g.appendChild(ring);

    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(node.x));
    circle.setAttribute("cy", String(node.y));
    circle.setAttribute("r", "26");
    circle.classList.add("xray-node-circle");
    g.appendChild(circle);

    const icon = document.createElementNS(ns, "text");
    icon.setAttribute("x", String(node.x));
    icon.setAttribute("y", String(node.y + 6));
    icon.setAttribute("text-anchor", "middle");
    icon.setAttribute("font-size", "16");
    icon.classList.add("xray-node-icon");
    icon.textContent = node.icon;
    g.appendChild(icon);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", String(node.x));
    label.setAttribute("y", String(node.y + 50));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", "11");
    label.setAttribute("font-weight", "600");
    label.classList.add("xray-node-label");
    label.textContent = node.label;
    g.appendChild(label);

    svg.appendChild(g);
    nodeMap[node.id] = g;

    g.addEventListener("click", () => onNodeClick(node.id));
  });

  container.appendChild(svg);
}

export function resetGraph() {
  Object.values(nodeMap).forEach((g) => {
    g.classList.remove("active", "failed", "passed", "risk-low", "risk-medium", "risk-high");
  });
  if (packetsLayer) {
    while (packetsLayer.firstChild) packetsLayer.removeChild(packetsLayer.firstChild);
  }
  failureLog = [];
  passCount = 0;
  failCount = 0;
  totalExpected = 0;
  nodesVisited = new Set();
  updateCounters();
  updateCoverage();
  const status = document.getElementById("xray-status");
  if (status) status.textContent = "Waiting for X-Ray...";
  const detail = document.getElementById("xray-detail");
  if (detail) detail.innerHTML = "";

  const flash = document.getElementById("xray-failure-flash");
  if (flash) flash.classList.add("d-none");
}

export function setExpectedTests(count) {
  totalExpected = count;
}

export function paintNodeRisk(flakinessMap) {
  const aliases = { "API Gateway": "API Gateway", "Validator": "Validator", "Transformer": "Transformer", "Database": "Database", "Legacy Emulator": "Legacy Emulator", "Risk Score API": "Risk Score API" };
  Object.entries(flakinessMap || {}).forEach(([name, rate]) => {
    const nodeId = aliases[name] || name;
    const g = nodeMap[nodeId];
    if (!g) return;
    g.classList.remove("risk-low", "risk-medium", "risk-high");
    if (rate > 0.25) g.classList.add("risk-high");
    else if (rate > 0.1) g.classList.add("risk-medium");
    else g.classList.add("risk-low");
  });
}

export function handleXrayEvent(evt) {
  if (!evt || !evt.event) return;
  const status = document.getElementById("xray-status");

  if (evt.event === "test_started") {
    Object.values(nodeMap).forEach((g) => g.classList.remove("active"));
    if (status) status.textContent = `Running: ${evt.test_name}`;
    highlightNode("Client");
  } else if (evt.event === "packet_flow") {
    spawnPacket(evt.node_from, evt.node_to, true);
    highlightNode(evt.node_to);
    nodesVisited.add(mapNodeId(evt.node_to));
    updateCoverage();
  } else if (evt.event === "test_finished") {
    const nodeId = evt.node || "Database";
    if (evt.passed === false) {
      markFailed(nodeId);
      failCount++;
      failureLog.push({
        nodeId,
        testName: evt.test_name,
        category: evt.category,
        explanation: evt.explanation || "Test failed at this stage.",
      });
      if (status) status.textContent = `FAIL at ${mapNodeId(nodeId)}: ${evt.test_name}`;
      showExplanation(failureLog[failureLog.length - 1]);
      triggerFailureFlash();

      spawnPacket("Client", nodeId, false);
    } else {
      markPassed(nodeId);
      passCount++;
      if (status) status.textContent = `PASS: ${evt.test_name}`;
    }
    updateCounters();
    updateCoverage();
  }
}

function triggerFailureFlash() {
  const flash = document.getElementById("xray-failure-flash");
  if (!flash) return;
  flash.classList.remove("d-none", "flash-active");
  void flash.offsetWidth;
  flash.classList.add("flash-active");
  setTimeout(() => flash.classList.remove("flash-active"), 700);

  const card = flash.closest(".xray-card");
  if (card) {
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
    setTimeout(() => card.classList.remove("shake"), 500);
  }
}

function updateCoverage() {
  const bar = document.getElementById("coverage-bar");
  const pct = document.getElementById("coverage-pct");
  if (!bar || !pct) return;

  const totalNodes = NODE_LAYOUT.length;
  const visited = nodesVisited.size;
  const coveragePct = totalNodes > 0 ? Math.round((visited / totalNodes) * 100) : 0;

  bar.style.width = `${coveragePct}%`;
  pct.textContent = `${coveragePct}%`;
}

function updateCounters() {
  const p = document.getElementById("xray-pass-count");
  const f = document.getElementById("xray-fail-count");
  if (p) p.textContent = `${passCount} passed`;
  if (f) f.textContent = `${failCount} failed`;
}

function highlightNode(nodeId) {
  const mapped = mapNodeId(nodeId);
  const g = nodeMap[mapped];
  if (g) g.classList.add("active");
}

function markFailed(nodeId) {
  const mapped = mapNodeId(nodeId);
  Object.values(nodeMap).forEach((g) => g.classList.remove("active"));
  const g = nodeMap[mapped];
  if (g) {
    g.classList.remove("passed");
    g.classList.add("failed");
  }
}

function markPassed(nodeId) {
  const mapped = mapNodeId(nodeId);
  Object.values(nodeMap).forEach((g) => g.classList.remove("active"));
  const g = nodeMap[mapped];
  if (g && !g.classList.contains("failed")) {
    g.classList.add("passed");
  }
}

function mapNodeId(id) {
  const aliases = {
    APIGateway: "API Gateway",
    Validator: "Validator",
    Transformer: "Transformer",
    DB: "Database",
    LegacyEmulator: "Legacy Emulator",
    RiskScoreAPI: "Risk Score API",
    Client: "Client",
  };
  return aliases[id] || id;
}

function spawnPacket(fromId, toId, success) {
  if (!packetsLayer) return;
  const ns = "http://www.w3.org/2000/svg";
  const from = NODE_LAYOUT.find((n) => n.id === mapNodeId(fromId));
  const to = NODE_LAYOUT.find((n) => n.id === mapNodeId(toId));
  if (!from || !to) return;

  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("r", "7");
  circle.classList.add(success ? "xray-packet-ok" : "xray-packet-fail");
  circle.setAttribute("filter", "url(#packetGlow)");
  circle.setAttribute("cx", String(from.x));
  circle.setAttribute("cy", String(from.y));

  packetsLayer.appendChild(circle);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const duration = success ? 350 : 500;
  const startTime = performance.now();

  function animate(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    circle.setAttribute("cx", String(from.x + dx * eased));
    circle.setAttribute("cy", String(from.y + dy * eased));

    if (success) {
      circle.setAttribute("r", String(7 - t * 3));
      circle.setAttribute("opacity", String(1 - t * 0.4));
    } else {
      const pulse = 1 + Math.sin(t * Math.PI * 4) * 0.3;
      circle.setAttribute("r", String(8 * pulse));
      circle.setAttribute("opacity", String(1 - t * 0.2));
    }

    if (t < 1) {
      requestAnimationFrame(animate);
    } else if (packetsLayer && circle.parentNode === packetsLayer) {
      packetsLayer.removeChild(circle);
    }
  }

  requestAnimationFrame(animate);
}

const REPAIR_DB = {
  "test_events_accepts_unix_timestamp_and_normalizes": {
    label: "Auto-normalize timestamps",
    code: "if isinstance(event_date, int):\n    event_date = datetime.utcfromtimestamp(event_date).strftime('%Y-%m-%d')",
  },
  "test_create_payment_malicious_customer_name": {
    label: "Sanitize input fields",
    code: "import bleach\ncustomer_name = bleach.clean(customer_name, strip=True)",
  },
  "test_events_tolerates_extra_marketing_flag": {
    label: "Switch to permissive schema",
    code: "schema_validation: 'warn'  # was: 'strict'",
  },
  "test_cross_pipe_reconciliation_shares": {
    label: "Add reconciliation check",
    code: "assert_ledger_balance(ticker, expected_shares, tolerance=0)",
  },
  "test_redos_polynomial_regex_attack": {
    label: "Add regex timeout guard",
    code: "import regex\nregex.match(pattern, input, timeout=0.1)",
  },
};

function showExplanation(failure) {
  const detail = document.getElementById("xray-detail");
  if (!detail || !failure) return;

  const repair = REPAIR_DB[failure.testName];
  const repairHtml = repair
    ? `<div class="mt-2">
        <button class="btn btn-sm btn-repair" onclick="this.nextElementSibling.style.display='block';this.style.display='none';">
          <i class="bi bi-wrench me-1"></i>${repair.label}
        </button>
        <div class="auto-repair-inline mt-2" style="display:none;">
          <div class="d-flex align-items-center gap-2 mb-1">
            <i class="bi bi-magic" style="color:var(--neon-amber)"></i>
            <span class="fw-semibold small" style="color:var(--neon-amber)">Self-Healing Fix Applied</span>
          </div>
          <pre class="auto-repair-code small p-2 rounded mb-0"><code class="language-python">${repair.code}</code></pre>
        </div>
      </div>`
    : "";

  detail.innerHTML = `
    <div class="xray-explain-panel">
      <div class="d-flex align-items-start gap-2 mb-2">
        <span class="badge badge-glow-red">FAILURE</span>
        <span class="fw-semibold small">${failure.testName}</span>
        <span class="badge text-bg-secondary" style="font-size:0.65rem">${failure.category}</span>
      </div>
      <div class="small mb-1" style="color:var(--text-secondary)">Failed at node: <strong>${mapNodeId(failure.nodeId)}</strong></div>
      <div class="small" style="color:var(--text-primary)">${failure.explanation}</div>
      ${repairHtml}
    </div>
  `;

  detail.querySelectorAll(".auto-repair-code code").forEach((el) => {
    if (window.hljs) {
      try {
        const result = window.hljs.highlight(el.textContent, { language: "python" });
        el.innerHTML = result.value;
        el.classList.add("hljs");
      } catch {}
    }
  });
}

function onNodeClick(nodeId) {
  const relevant = failureLog.filter((f) => mapNodeId(f.nodeId) === nodeId || f.nodeId === nodeId);
  if (relevant.length > 0) {
    showExplanation(relevant[relevant.length - 1]);
  } else {
    const detail = document.getElementById("xray-detail");
    if (detail) {
      detail.innerHTML = `<div class="small p-2" style="color:var(--text-secondary)"><i class="bi bi-check-circle me-1" style="color:var(--neon-green)"></i>Node <strong>${nodeId}</strong> is healthy. All tests passed through this stage.</div>`;
    }
  }
}
