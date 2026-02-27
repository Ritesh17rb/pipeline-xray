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

export function initGraph() {
  const container = document.getElementById("xray-graph");
  if (!container) return;

  // Destroy previous SVG if it exists (for theme re-renders)
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

  // Defs: filters & markers
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

  // Edges
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

  // Packets layer (above edges, below nodes)
  packetsLayer = document.createElementNS(ns, "g");
  svg.appendChild(packetsLayer);

  // Nodes
  NODE_LAYOUT.forEach((node) => {
    const g = document.createElementNS(ns, "g");
    g.classList.add("xray-node");
    g.dataset.nodeId = node.id;

    // Outer pulse ring
    const ring = document.createElementNS(ns, "circle");
    ring.setAttribute("cx", String(node.x));
    ring.setAttribute("cy", String(node.y));
    ring.setAttribute("r", "32");
    ring.classList.add("xray-node-ring");
    g.appendChild(ring);

    // Main circle
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(node.x));
    circle.setAttribute("cy", String(node.y));
    circle.setAttribute("r", "26");
    circle.classList.add("xray-node-circle");
    g.appendChild(circle);

    // Icon
    const icon = document.createElementNS(ns, "text");
    icon.setAttribute("x", String(node.x));
    icon.setAttribute("y", String(node.y + 6));
    icon.setAttribute("text-anchor", "middle");
    icon.setAttribute("font-size", "16");
    icon.classList.add("xray-node-icon");
    icon.textContent = node.icon;
    g.appendChild(icon);

    // Label
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
    g.classList.remove("active", "failed", "passed");
  });
  if (packetsLayer) {
    while (packetsLayer.firstChild) packetsLayer.removeChild(packetsLayer.firstChild);
  }
  failureLog = [];
  passCount = 0;
  failCount = 0;
  updateCounters();
  const status = document.getElementById("xray-status");
  if (status) status.textContent = "Waiting for X-Ray...";
  const detail = document.getElementById("xray-detail");
  if (detail) detail.innerHTML = "";
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
    } else {
      markPassed(nodeId);
      passCount++;
      if (status) status.textContent = `PASS: ${evt.test_name}`;
    }
    updateCounters();
  }
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
  const duration = 350;
  const startTime = performance.now();

  function animate(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    circle.setAttribute("cx", String(from.x + dx * eased));
    circle.setAttribute("cy", String(from.y + dy * eased));
    circle.setAttribute("r", String(7 - t * 3));
    circle.setAttribute("opacity", String(1 - t * 0.4));
    if (t < 1) {
      requestAnimationFrame(animate);
    } else if (packetsLayer && circle.parentNode === packetsLayer) {
      packetsLayer.removeChild(circle);
    }
  }

  requestAnimationFrame(animate);
}

function showExplanation(failure) {
  const detail = document.getElementById("xray-detail");
  if (!detail || !failure) return;

  detail.innerHTML = `
    <div class="xray-explain-panel">
      <div class="d-flex align-items-start gap-2 mb-2">
        <span class="badge badge-glow-red">FAILURE</span>
        <span class="fw-semibold small">${failure.testName}</span>
        <span class="badge text-bg-secondary" style="font-size:0.65rem">${failure.category}</span>
      </div>
      <div class="small mb-1" style="color:var(--text-secondary)">Failed at node: <strong>${mapNodeId(failure.nodeId)}</strong></div>
      <div class="small" style="color:var(--text-primary)">${failure.explanation}</div>
    </div>
  `;
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
