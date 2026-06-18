function renderSegmentedToggle(containerId, keys, labels, activeKey, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) {
    return;
  }
  container.innerHTML = "";
  if (keys.length <= 1) {
    container.style.display = "none";
    return;
  }
  container.style.display = "inline-flex";
  for (const key of keys) {
    const button = document.createElement("button");
    button.className = `trace-source-btn${key === activeKey ? " active" : ""}`;
    button.textContent = labels[key] ?? key;
    button.addEventListener("click", () => onSelect(key));
    container.appendChild(button);
  }
}

function renderSourceToggle(containerId, activeSourceKey, onSelect) {
  renderSegmentedToggle(
    containerId,
    getAvailableTraceSourceKeys(),
    TRACE_SOURCE_UI_LABELS,
    activeSourceKey,
    onSelect
  );
}

function renderTraceValueToggle(containerId, activeValueMode, onSelect) {
  renderSegmentedToggle(
    containerId,
    getAvailableTraceValueModes(),
    TRACE_VALUE_MODE_UI_LABELS,
    activeValueMode,
    onSelect
  );
}
