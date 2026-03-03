const CI_STEP_DELAYS = [1000, 1500, 2000, 1000, 1000, 1500];

function stepIcon(status) {
  if (status === "queued") return '<i class="bi bi-circle ci-step-icon ci-github-check ci-step-queued me-2"></i>';
  if (status === "running") return '<i class="bi bi-arrow-repeat ci-step-icon ci-github-check running me-2"></i>';
  if (status === "success") return '<i class="bi bi-check-circle-fill ci-step-icon ci-github-check me-2"></i>';
  return '<i class="bi bi-circle ci-step-icon ci-github-check me-2"></i>';
}

export function renderCiSummary(summary) {
  const container = document.getElementById("ci-view");
  if (!container) return;
  if (!summary) {
    container.innerHTML = "";
    return;
  }

  const providers = [
    { id: "github", label: "GitHub Actions", badge: "bi-github", yaml: summary.yaml_github || summary.yaml_snippet },
    { id: "gitlab", label: "GitLab CI", badge: "bi-git", yaml: summary.yaml_gitlab || summary.yaml_snippet },
    { id: "jenkins", label: "Jenkins", badge: "bi-gear-wide-connected", yaml: summary.yaml_jenkins || summary.yaml_snippet },
  ];

  const steps = summary.steps || [];
  const stepsHtml = steps
    .map((step, idx) => {
      const status = step.status || "queued";
      const logBody = step.log_body ? step.log_body.replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";
      return `
        <div class="ci-step-row d-flex align-items-start mb-2 rounded px-2 py-1" data-step-index="${idx}" role="button" title="Click to expand log">
          ${stepIcon(status)}
          <div class="flex-grow-1">
            <div class="fw-semibold">${step.name}</div>
            <div class="small text-secondary ci-step-summary">${step.duration_seconds.toFixed(1)}s &bull; ${step.log_summary}</div>
            <pre class="ci-step-log bg-dark text-light rounded small p-2 mt-1 mb-0 d-none"><code>${logBody}</code></pre>
          </div>
        </div>`;
    })
    .join("");

  const determinism = summary.determinism || { confidence: 0, reasons: [] };
  const reasonsHtml = (determinism.reasons || []).map((r) => `<li>${r}</li>`).join("");
  const deterministicPercent = (determinism.confidence * 100).toFixed(0);
  const maybeFlakyPercent = (100 - Number(deterministicPercent)).toFixed(0);

  const providerTabs = providers
    .map(
      (p, idx) => `
      <button type="button" class="btn btn-sm ${idx === 0 ? "btn-primary" : "btn-outline-primary"} ci-provider-btn" data-provider="${p.id}">
        <i class="bi ${p.badge} me-1"></i>${p.label}
      </button>`,
    )
    .join("");

  const prStatusHtml = `
    <div class="col-12 mb-3" id="ci-pr-status">
      <div class="ci-pr-mock border rounded px-3 py-2 d-flex align-items-center gap-3 flex-wrap">
        <span class="fw-semibold">Pull Request <span class="text-secondary">#42</span></span>
        <span class="ci-pr-check"><i class="bi bi-check-circle-fill text-success me-1"></i>Lint</span>
        <span class="ci-pr-check"><i class="bi bi-check-circle-fill text-success me-1"></i>Build</span>
        <span class="ci-pr-check ci-pr-pending"><i class="bi bi-arrow-repeat me-1"></i>Tests</span>
        <span class="ci-pr-check"><i class="bi bi-dash-circle text-secondary me-1"></i>Deploy</span>
      </div>
    </div>`;

  container.innerHTML =
    prStatusHtml +
    `
    <div class="col-12">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <div class="small text-secondary">CI providers</div>
        <div class="btn-group" role="group">${providerTabs}</div>
      </div>
    </div>
    <div class="col-12 col-lg-6">
      <div class="ci-github-header">
        <i class="bi bi-github ci-gh-icon"></i>
        <span class="ci-github-title">${summary.pipeline_name}</span>
        <span class="ci-github-badge ms-auto">In Progress</span>
      </div>
      <div class="ci-github-body" id="ci-steps-container">
        ${steps.map((step, idx) => `
          <div class="ci-github-step" data-step-index="${idx}">
            <i class="bi bi-circle ci-github-check ci-step-icon ci-step-queued"></i>
            <span>${step.name}</span>
            <span class="step-duration">${step.duration_seconds.toFixed(1)}s</span>
          </div>`).join("")}
      </div>
    </div>
    <div class="col-12 col-lg-6">
      <div class="card border-0 bg-body-tertiary h-100">
        <div class="card-header"><div class="fw-semibold">Determinism &amp; Flakiness</div></div>
        <div class="card-body">
          <div class="display-6 fw-bold mb-2">${deterministicPercent}% <span class="fs-6 text-secondary">confidence non-flaky</span></div>
          <div class="mb-2 small">
            <span class="badge text-bg-success me-1">${deterministicPercent}% deterministic</span>
            <span class="badge text-bg-warning">${maybeFlakyPercent}% potential flakes (guarded)</span>
          </div>
          <ul class="small text-secondary mb-3">${reasonsHtml}</ul>
          <div class="mt-2">
            <div class="small text-secondary mb-1">CI snippet</div>
            <pre class="bg-dark text-light rounded small p-3 mb-0"><code id="ci-yaml-snippet">${summary.yaml_snippet}</code></pre>
          </div>
        </div>
      </div>
    </div>`;

  container.querySelectorAll(".ci-provider-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".ci-provider-btn").forEach((b) => {
        b.classList.remove("btn-primary");
        b.classList.add("btn-outline-primary");
      });
      btn.classList.remove("btn-outline-primary");
      btn.classList.add("btn-primary");
      const config = providers.find((p) => p.id === btn.dataset.provider) || providers[0];
      const yamlEl = document.getElementById("ci-yaml-snippet");
      if (yamlEl && config.yaml) yamlEl.textContent = config.yaml;
    });
  });

  container.querySelectorAll(".ci-step-row").forEach((row) => {
    row.addEventListener("click", () => {
      const logEl = row.querySelector(".ci-step-log");
      if (logEl) logEl.classList.toggle("d-none");
    });
  });

  runCiAnimation(container, steps);
}

function runCiAnimation(container, steps) {
  if (!steps.length) return;
  const stepsContainer = container.querySelector("#ci-steps-container");
  if (!stepsContainer) return;

  let stepIndex = 0;
  function runNext() {
    if (stepIndex >= steps.length) {
      updatePrStatusChecks(container, true);
      // Update the GitHub Actions badge to 'Passed'
      const badge = container.querySelector(".ci-github-badge");
      if (badge) { badge.textContent = "Passed"; badge.classList.remove("failed"); }
      return;
    }
    const row = stepsContainer.querySelector(`[data-step-index="${stepIndex}"]`);
    if (row) {
      const iconSlot = row.querySelector(".ci-step-icon");
      if (iconSlot) {
        iconSlot.outerHTML = stepIcon("running");
        row.classList.add("ci-step-running-row");
      }
    }
    const duration = (steps[stepIndex] && steps[stepIndex].duration_seconds) ? steps[stepIndex].duration_seconds * 1000 : 1000;
    const delay = CI_STEP_DELAYS[stepIndex] != null ? CI_STEP_DELAYS[stepIndex] : 1000;
    setTimeout(() => {
      if (row) {
        const iconSlot = row.querySelector(".ci-step-icon");
        if (iconSlot) {
          iconSlot.outerHTML = stepIcon("success");
          row.classList.remove("ci-step-running-row");
          row.classList.add("ci-step-success-row");
        }
      }
      stepIndex++;
      setTimeout(runNext, 400);
    }, delay);
  }
  setTimeout(runNext, 500);
}

function updatePrStatusChecks(container, allPassed) {
  const pr = container.querySelector("#ci-pr-status");
  if (!pr) return;
  const pending = pr.querySelector(".ci-pr-pending");
  if (pending) {
    pending.classList.remove("ci-pr-pending");
    pending.innerHTML = allPassed ? '<i class="bi bi-check-circle-fill text-success me-1"></i>Tests' : '<i class="bi bi-x-circle-fill text-danger me-1"></i>Tests';
  }
}

export function renderMocks(mockResponse) {
  const container = document.getElementById("mocks-view");
  if (!container) return;
  if (!mockResponse || !mockResponse.mocks) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = mockResponse.mocks
    .map((mock) => {
      return `
        <div class="col-12 col-md-6" data-mock-card="${mock.name}">
          <div class="card h-100 mock-card">
            <div class="card-header d-flex justify-content-between align-items-center">
              <div class="d-flex align-items-center gap-2">
                <span class="mock-status-dot healthy"></span>
                <span class="fw-semibold">${mock.name}</span>
              </div>
              <span class="badge text-bg-success text-uppercase mock-badge">${mock.status}</span>
            </div>
            <div class="card-body">
              <p class="small mb-3" style="color:var(--text-secondary)">${mock.description}</p>
              <div class="d-flex gap-2 mb-3">
                <button type="button" class="btn btn-sm btn-success mock-state-btn active" data-state="healthy">
                  <i class="bi bi-check-circle me-1"></i>Healthy
                </button>
                <button type="button" class="btn btn-sm btn-outline-warning mock-state-btn" data-state="slow">
                  <i class="bi bi-clock-history me-1"></i>Slow (2s)
                </button>
                <button type="button" class="btn btn-sm btn-outline-danger mock-state-btn" data-state="down">
                  <i class="bi bi-x-octagon me-1"></i>Down
                </button>
              </div>
              <div class="mock-effect-text small" style="color:var(--text-secondary);min-height:2.5em;"></div>
            </div>
          </div>
        </div>`;
    })
    .join("");

  container.querySelectorAll(".mock-state-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest("[data-mock-card]");
      if (!card) return;
      const mockName = card.dataset.mockCard;
      const state = btn.dataset.state;

      // Update active button style
      card.querySelectorAll(".mock-state-btn").forEach((b) => {
        b.classList.remove("active", "btn-success", "btn-warning", "btn-danger");
        b.classList.add(
          b.dataset.state === "healthy" ? "btn-outline-success" :
          b.dataset.state === "slow" ? "btn-outline-warning" : "btn-outline-danger"
        );
      });
      btn.classList.add("active");
      btn.classList.remove("btn-outline-success", "btn-outline-warning", "btn-outline-danger");
      btn.classList.add(state === "healthy" ? "btn-success" : state === "slow" ? "btn-warning" : "btn-danger");

      // Update badge
      const badge = card.querySelector(".mock-badge");
      if (badge) {
        badge.textContent = state;
        badge.classList.remove("text-bg-success", "text-bg-warning", "text-bg-danger");
        badge.classList.add(state === "healthy" ? "text-bg-success" : state === "slow" ? "text-bg-warning" : "text-bg-danger");
      }

      // Update status dot
      const dot = card.querySelector(".mock-status-dot");
      if (dot) {
        dot.classList.remove("healthy", "slow", "down");
        dot.classList.add(state);
      }

      // Show effect description
      const effectEl = card.querySelector(".mock-effect-text");
      if (effectEl) {
        const effects = {
          healthy: `<i class="bi bi-check-circle text-success me-1"></i>${mockName} responding normally. Tests will pass through this dependency.`,
          slow: `<i class="bi bi-exclamation-triangle text-warning me-1"></i>${mockName} responding with 2s latency. Timeout tests will trigger. Circuit breaker may trip.`,
          down: `<i class="bi bi-x-octagon text-danger me-1"></i>${mockName} is offline. Fallback path will be exercised. Tests will verify graceful degradation.`,
        };
        effectEl.innerHTML = effects[state] || "";
      }

      // Log to agent console
      const logEl = document.getElementById("agent-console-log");
      if (logEl) {
        const kind = state === "healthy" ? "signal" : state === "slow" ? "warning" : "warning";
        const div = document.createElement("div");
        div.classList.add("agent-console-log-line", kind);
        div.textContent = `[>>>] Mock ${mockName} set to ${state.toUpperCase()}. Next X-Ray run will reflect this change.`;
        logEl.appendChild(div);
        while (logEl.childNodes.length > 60) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      }
    });
  });
}
