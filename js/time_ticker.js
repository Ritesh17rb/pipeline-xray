let currentAnimation = null;

export function animateTimeSaved(totalMinutes) {
  const valueEl = document.getElementById("time-saved-value");
  if (!valueEl) return;

  const targetHours = totalMinutes / 60;
  const durationMs = 2200;
  const start = performance.now();

  if (currentAnimation) cancelAnimationFrame(currentAnimation);

  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = targetHours * eased;
    valueEl.textContent = value.toFixed(1);
    if (t < 1) {
      currentAnimation = requestAnimationFrame(step);
    }
  }

  currentAnimation = requestAnimationFrame(step);
}
