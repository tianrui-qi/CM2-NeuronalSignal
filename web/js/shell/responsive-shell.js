const LAYOUT_WIDE = "wide";
const LAYOUT_BOTTOM = "bottom";
export const SIDEBAR_MIN_WIDTH = 340;
const DEFAULT_UI_SPACING = 8;
const DETENT_MIDDLE = "middle";
const DETENT_FULL = "full";
const DETENTS = Object.freeze([DETENT_MIDDLE, DETENT_FULL]);
const CONTENT_PULL_CLAIM_SLOP = 8;
const CONTENT_PULL_DIRECTION_RATIO = 1.15;
const CONTENT_PULL_COMMIT_DISTANCE = 44;
const CONTENT_PULL_CLICK_SUPPRESSION_MS = 500;

/**
 * @param {number} viewportWidth
 * @param {number} [outerInset]
 */
export function sidebarMaximumWidth(viewportWidth, outerInset = 16) {
  const halfViewport = Math.max(0, Number(viewportWidth) || 0) / 2;
  const inset = Math.max(0, Number(outerInset) || 0);
  return Math.floor(Math.max(0, halfViewport - inset));
}

/**
 * Resolve the sidebar's two global horizontal gaps from the live CSS token.
 *
 * @param {{ document: Document, window: Window }} options
 */
export function sidebarOuterInset({ document, window }) {
  const rawSpacing = window.getComputedStyle(document.documentElement)
    .getPropertyValue("--ui-spacing");
  const spacing = Number.parseFloat(rawSpacing);
  return 2 * (Number.isFinite(spacing) ? spacing : DEFAULT_UI_SPACING);
}

/** @param {{ width: number, outerInset?: number }} viewport */
export function shouldUseWideLayout({ width, outerInset = 16 }) {
  return sidebarMaximumWidth(width, outerInset) >= SIDEBAR_MIN_WIDTH;
}

/**
 * Own responsive workflow-panel presentation without persisting layout state.
 * Feature state and scientific coordinates remain outside this controller.
 *
 * @param {{ document: Document, window: Window }} options
 */
export function createResponsiveShell({ document, window }) {
  let wired = false;
  /** @type {null | { requestPanelResize: (options?: { refreshTemporal?: boolean }) => void }} */
  let resizeEffects = null;
  let layoutMode = null;
  let bottomDetent = DETENT_MIDDLE;
  let middleDetentSize = 0;
  /** @type {number | null} */
  let layoutFrame = null;
  let forceLayoutResize = false;
  /** @type {number | null} */
  let dragFrame = null;
  /** @type {number | null} */
  let pendingDragSize = null;
  /** @type {ResizeObserver | null} */
  let geometryObserver = null;
  let suppressContentClickUntil = -Infinity;
  /** @type {null | {
   *   pointerId: number,
   *   startY: number,
   *   startSize: number,
   *   detentSizes: Record<string, number>,
   * }} */
  let dragSession = null;
  /** @type {null | {
   *   source: "touch" | "pen",
   *   contactId: number,
   *   startX: number,
   *   startY: number,
   *   startSize: number,
   *   targetSize: number,
   *   claimed: boolean,
   * }} */
  let contentPullSession = null;

  const overlay = /** @type {HTMLElement | null} */ (
    document.querySelector(".overlay-stack")
  );
  const workflowPanel = /** @type {HTMLElement | null} */ (
    document.getElementById("workflow-panel")
  );
  function createSheetHandle() {
    if (!overlay || !workflowPanel) {
      return null;
    }
    const existing = /** @type {HTMLElement | null} */ (
      overlay.querySelector(".responsive-sheet-handle")
    );
    if (existing) {
      return existing;
    }

    const nextHandle = document.createElement("div");
    nextHandle.className = "responsive-sheet-handle";
    nextHandle.setAttribute("role", "separator");
    nextHandle.setAttribute("aria-label", "Control panel height");
    nextHandle.setAttribute("aria-orientation", "horizontal");
    nextHandle.setAttribute("aria-controls", workflowPanel.id);
    nextHandle.setAttribute(
      "aria-keyshortcuts",
      "ArrowUp ArrowDown Home End",
    );
    const grabber = document.createElement("span");
    grabber.className = "responsive-sheet-grabber";
    grabber.setAttribute("aria-hidden", "true");
    nextHandle.append(grabber);
    overlay.insertBefore(nextHandle, workflowPanel);
    overlay.setAttribute("aria-label", "Viewer controls");
    return nextHandle;
  }

  const handle = createSheetHandle();
  const workflowContent = /** @type {HTMLElement | null} */ (
    workflowPanel?.querySelector(".workflow-panel-content") ?? null
  );
  const workflowSections = workflowContent
    ? Array.from(workflowContent.children).filter(
      (element) => element instanceof window.HTMLElement
        && element.hasAttribute("data-workflow-section"),
    )
    : [];
  const stateActions = /** @type {HTMLElement | null} */ (
    document.getElementById("workflow-state-actions")
  );

  /** @param {CSSStyleDeclaration} style @param {string} property */
  function cssPixels(style, property) {
    const value = Number.parseFloat(style.getPropertyValue(property));
    return Number.isFinite(value) ? value : 0;
  }

  /** @param {HTMLElement} element */
  function borderBoxHeight(element) {
    const rectHeight = element.getBoundingClientRect().height;
    if (rectHeight > 0) {
      return rectHeight;
    }
    const style = window.getComputedStyle(element);
    let height = Math.max(
      cssPixels(style, "height"),
      cssPixels(style, "min-height"),
    );
    if (style.boxSizing !== "border-box") {
      height += cssPixels(style, "padding-top")
        + cssPixels(style, "padding-bottom")
        + cssPixels(style, "border-top-width")
        + cssPixels(style, "border-bottom-width");
    }
    return height;
  }

  /** @param {HTMLElement} element */
  function outerBlockHeight(element) {
    const style = window.getComputedStyle(element);
    return borderBoxHeight(element)
      + cssPixels(style, "margin-top")
      + cssPixels(style, "margin-bottom");
  }

  /** @param {HTMLElement} element @param {boolean} [includeMargin] */
  function blockChromeHeight(element, includeMargin = false) {
    const style = window.getComputedStyle(element);
    return cssPixels(style, "padding-top")
      + cssPixels(style, "padding-bottom")
      + cssPixels(style, "border-top-width")
      + cssPixels(style, "border-bottom-width")
      + (includeMargin
        ? cssPixels(style, "margin-top") + cssPixels(style, "margin-bottom")
        : 0);
  }

  /** @param {Element} section */
  function collapsedSectionHeight(section) {
    if (!(section instanceof window.HTMLElement)) {
      return 0;
    }
    const header = /** @type {HTMLElement | null} */ (
      section.querySelector("[data-section-toggle]")
    );
    if (!header) {
      return 0;
    }
    const sectionStyle = window.getComputedStyle(section);
    return outerBlockHeight(header)
      + blockChromeHeight(section)
      + cssPixels(sectionStyle, "margin-top")
      + cssPixels(sectionStyle, "margin-bottom");
  }

  function measureMiddleDetentSize() {
    if (!overlay || !workflowPanel || !workflowContent || !handle) {
      return 0;
    }
    const itemHeights = workflowSections.map(collapsedSectionHeight);
    if (stateActions && !stateActions.hidden) {
      itemHeights.push(outerBlockHeight(stateActions));
    }
    const contentStyle = window.getComputedStyle(workflowContent);
    const contentGap = cssPixels(contentStyle, "row-gap");
    const contentHeight = itemHeights.reduce((total, height) => total + height, 0)
      + Math.max(0, itemHeights.length - 1) * contentGap
      + blockChromeHeight(workflowContent, true);
    const overlayStyle = window.getComputedStyle(overlay);
    const structuralGap = cssPixels(overlayStyle, "row-gap");
    return Math.ceil(
      blockChromeHeight(overlay)
      + outerBlockHeight(handle)
      + structuralGap
      + blockChromeHeight(workflowPanel, true)
      + contentHeight,
    );
  }

  function syncMiddleDetentSize() {
    if (!overlay || layoutMode !== LAYOUT_BOTTOM) {
      return false;
    }
    const nextSize = Math.max(0, measureMiddleDetentSize());
    const changed = Math.abs(nextSize - middleDetentSize) >= 0.5;
    middleDetentSize = nextSize;
    overlay.style.setProperty("--sheet-middle-size", `${nextSize}px`);
    return changed;
  }

  function syncVisualViewportMetrics() {
    const viewport = window.visualViewport;
    const height = Math.max(1, viewport?.height ?? window.innerHeight);
    const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
    const bottomOffset = Math.max(0, shellHeight() - offsetTop - height);
    document.documentElement.style.setProperty(
      "--visual-viewport-height",
      `${height}px`,
    );
    document.documentElement.style.setProperty(
      "--visual-viewport-offset-top",
      `${offsetTop}px`,
    );
    document.documentElement.style.setProperty(
      "--visual-viewport-bottom-offset",
      `${bottomOffset}px`,
    );
    document.documentElement.toggleAttribute(
      "data-visual-viewport-constrained",
      Boolean(viewport && window.innerHeight - viewport.height >= 120),
    );
  }

  function resolveLayoutMode() {
    return shouldUseWideLayout({
      width: window.innerWidth,
      outerInset: sidebarOuterInset({ document, window }),
    })
      ? LAYOUT_WIDE
      : LAYOUT_BOTTOM;
  }

  function currentDetent() {
    return layoutMode === LAYOUT_WIDE ? DETENT_FULL : bottomDetent;
  }

  function viewportHeight() {
    return Math.max(1, window.visualViewport?.height ?? window.innerHeight);
  }

  function shellHeight() {
    return Math.max(
      1,
      document.querySelector(".app-shell")?.clientHeight ?? window.innerHeight,
    );
  }

  function fullDetentSize() {
    if (overlay && layoutMode === LAYOUT_BOTTOM) {
      const resolvedMaxHeight = Number.parseFloat(
        window.getComputedStyle(overlay).maxHeight,
      );
      if (Number.isFinite(resolvedMaxHeight) && resolvedMaxHeight >= 0) {
        return Math.max(0, resolvedMaxHeight);
      }
    }
    return viewportHeight();
  }

  function currentDetentSizes() {
    const fullSize = fullDetentSize();
    return {
      [DETENT_MIDDLE]: Math.min(
        fullSize,
        Math.max(0, middleDetentSize),
      ),
      [DETENT_FULL]: fullSize,
    };
  }

  function syncControls() {
    if (!handle) {
      return;
    }
    const isWide = layoutMode === LAYOUT_WIDE;
    const detent = currentDetent();
    const detentIndex = DETENTS.indexOf(detent);

    handle.tabIndex = isWide ? -1 : 0;
    handle.setAttribute("aria-hidden", String(isWide));
    handle.setAttribute("aria-valuemin", "0");
    handle.setAttribute("aria-valuemax", "1");
    handle.setAttribute("aria-valuenow", String(detentIndex));
    handle.setAttribute(
      "aria-valuetext",
      detent === DETENT_MIDDLE ? "Panel headers" : "Full height",
    );
  }

  /** @param {string} nextDetent */
  function setDetent(nextDetent) {
    if (
      !overlay
      || layoutMode !== LAYOUT_BOTTOM
      || !DETENTS.includes(nextDetent)
      || bottomDetent === nextDetent
    ) {
      return false;
    }
    bottomDetent = nextDetent;
    overlay.dataset.sheetDetent = nextDetent;
    syncControls();
    return true;
  }

  /** @param {-1 | 1} direction */
  function moveDetent(direction) {
    const currentIndex = DETENTS.indexOf(currentDetent());
    const nextIndex = Math.min(
      DETENTS.length - 1,
      Math.max(0, currentIndex + direction),
    );
    return setDetent(DETENTS[nextIndex]);
  }

  /** @param {number} size @param {Record<string, number>} [sizes] */
  function nearestDetent(size, sizes = currentDetentSizes()) {
    return DETENTS.reduce((nearest, candidate) => (
      Math.abs(sizes[candidate] - size)
        < Math.abs(sizes[nearest] - size)
        ? candidate
        : nearest
    ), currentDetent());
  }

  function clearDragPreview() {
    if (dragFrame !== null) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = null;
    }
    pendingDragSize = null;
    overlay?.style.removeProperty("--sheet-drag-size");
    if (overlay) {
      delete overlay.dataset.shellDragging;
    }
  }

  function cancelDrag() {
    if (!dragSession) {
      return false;
    }
    const pointerId = dragSession.pointerId;
    dragSession = null;
    clearDragPreview();
    if (handle?.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    return true;
  }

  function cancelContentPull() {
    if (!contentPullSession) {
      return false;
    }
    const hadPreview = contentPullSession.claimed;
    contentPullSession = null;
    if (hadPreview) {
      clearDragPreview();
    }
    return hadPreview;
  }

  function applyPendingDragSize() {
    dragFrame = null;
    if (!overlay || pendingDragSize === null) {
      return;
    }
    overlay.style.setProperty("--sheet-drag-size", `${pendingDragSize}px`);
    resizeEffects?.requestPanelResize();
  }

  /** @param {number} size */
  function scheduleDragPreview(size) {
    pendingDragSize = size;
    if (dragFrame === null) {
      dragFrame = window.requestAnimationFrame(applyPendingDragSize);
    }
  }

  /**
   * @param {{
   *   startSize: number,
   *   startY: number,
   *   detentSizes: Record<string, number>,
   * }} session
   * @param {number} clientY
   */
  function dragSize(session, clientY) {
    const rawSize = session.startSize + session.startY - clientY;
    return Math.min(
      session.detentSizes[DETENT_FULL],
      Math.max(session.detentSizes[DETENT_MIDDLE], rawSize),
    );
  }

  /** @param {PointerEvent} event */
  function updateDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId || !overlay) {
      return;
    }
    scheduleDragPreview(dragSize(dragSession, event.clientY));
    event.preventDefault();
  }

  /** @param {EventTarget | null} target */
  function startsInsideNestedScroller(target) {
    let element = target instanceof window.Element
      ? target
      : target instanceof window.Node
        ? target.parentElement
        : null;
    while (element && element !== workflowPanel) {
      const style = window.getComputedStyle(element);
      if (
        /^(auto|scroll|overlay)$/.test(style.overflowY)
        && element.scrollHeight > element.clientHeight + 0.5
      ) {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  /**
   * @param {{
   *   source: "touch" | "pen",
   *   contactId: number,
   *   clientX: number,
   *   clientY: number,
   *   target: EventTarget | null,
   * }} contact
   */
  function startContentPull(contact) {
    if (
      !overlay
      || !workflowPanel
      || layoutMode !== LAYOUT_BOTTOM
      || dragSession
      || contentPullSession
      || workflowPanel.scrollTop > 0.5
      || !(contact.target instanceof window.Node)
      || !workflowPanel.contains(contact.target)
      || startsInsideNestedScroller(contact.target)
      || currentDetent() !== DETENT_FULL
    ) {
      return;
    }
    const sizes = currentDetentSizes();
    contentPullSession = {
      source: contact.source,
      contactId: contact.contactId,
      startX: contact.clientX,
      startY: contact.clientY,
      startSize: overlay.getBoundingClientRect().height,
      targetSize: sizes[DETENT_MIDDLE],
      claimed: false,
    };
  }

  /**
   * @param {{
   *   source: "touch" | "pen",
   *   contactId: number,
   *   clientX: number,
   *   clientY: number,
   *   timeStamp: number,
   *   cancelable: boolean,
   *   preventDefault: () => boolean,
   * }} contact
   * @returns {boolean} whether a claimed preview was canceled
   */
  function updateContentPull(contact) {
    const session = contentPullSession;
    if (
      !session
      || session.source !== contact.source
      || session.contactId !== contact.contactId
      || !overlay
    ) {
      return false;
    }
    if (
      layoutMode !== LAYOUT_BOTTOM
      || currentDetent() !== DETENT_FULL
      || workflowPanel.scrollTop > 0.5
    ) {
      const hadPreview = cancelContentPull();
      if (hadPreview) {
        resizeEffects?.requestPanelResize({ refreshTemporal: true });
      }
      return false;
    }

    const deltaX = contact.clientX - session.startX;
    const deltaY = contact.clientY - session.startY;
    const horizontalDistance = Math.abs(deltaX);
    if (!session.claimed) {
      if (
        deltaY < -CONTENT_PULL_CLAIM_SLOP
        || (
          horizontalDistance > CONTENT_PULL_CLAIM_SLOP
          && horizontalDistance * CONTENT_PULL_DIRECTION_RATIO
            >= Math.abs(deltaY)
        )
      ) {
        contentPullSession = null;
        return false;
      }
      if (
        deltaY <= CONTENT_PULL_CLAIM_SLOP
        || deltaY <= horizontalDistance * CONTENT_PULL_DIRECTION_RATIO
      ) {
        return false;
      }
      if (!contact.cancelable || !contact.preventDefault()) {
        contentPullSession = null;
        return false;
      }
      session.claimed = true;
      overlay.style.setProperty("--sheet-drag-size", `${session.startSize}px`);
      overlay.dataset.shellDragging = "true";
    } else if (!contact.cancelable || !contact.preventDefault()) {
      return cancelContentPull();
    }

    scheduleDragPreview(Math.max(
      session.targetSize,
      Math.min(session.startSize, session.startSize - Math.max(0, deltaY)),
    ));
    return false;
  }

  /**
   * @param {{
   *   source: "touch" | "pen",
   *   contactId: number,
   *   clientY: number,
   *   timeStamp: number,
   *   cancelable: boolean,
   *   preventDefault: () => boolean,
   * }} contact
   * @param {boolean} commit
   */
  function finishContentPull(contact, commit) {
    const session = contentPullSession;
    if (
      !session
      || session.source !== contact.source
      || session.contactId !== contact.contactId
    ) {
      return false;
    }
    const claimed = session.claimed;
    const shouldCommit = claimed
      && commit
      && currentDetent() === DETENT_FULL
      && contact.clientY - session.startY >= CONTENT_PULL_COMMIT_DISTANCE;
    contentPullSession = null;
    if (claimed) {
      if (commit) {
        suppressContentClickUntil = Math.max(
          suppressContentClickUntil,
          contact.timeStamp + CONTENT_PULL_CLICK_SUPPRESSION_MS,
        );
      }
      clearDragPreview();
      if (contact.cancelable) {
        contact.preventDefault();
      }
    }
    if (shouldCommit) {
      setDetent(DETENT_MIDDLE);
    }
    return claimed;
  }

  /** @param {TouchList} touches @param {number} identifier */
  function touchByIdentifier(touches, identifier) {
    for (let index = 0; index < touches.length; index += 1) {
      if (touches[index].identifier === identifier) {
        return touches[index];
      }
    }
    return null;
  }

  /** @param {PointerEvent} event @param {boolean} commit */
  function finishDrag(event, commit) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) {
      return false;
    }
    const session = dragSession;
    const finalSize = dragSize(session, event.clientY);
    dragSession = null;
    clearDragPreview();
    if (commit) {
      setDetent(nearestDetent(finalSize, session.detentSizes));
    }
    return true;
  }

  function applyLayout() {
    if (!overlay) {
      return false;
    }
    const nextMode = resolveLayoutMode();
    const changed = nextMode !== layoutMode;
    if (changed) {
      cancelDrag();
      cancelContentPull();
      layoutMode = nextMode;
      overlay.dataset.shellLayout = nextMode;
      document.documentElement.dataset.shellLayout = nextMode;
      if (nextMode === LAYOUT_WIDE) {
        delete overlay.dataset.sheetDetent;
      } else {
        overlay.dataset.sheetDetent = bottomDetent;
      }
    }
    const middleSizeChanged = syncMiddleDetentSize();
    syncControls();
    return changed || (middleSizeChanged && currentDetent() === DETENT_MIDDLE);
  }

  /**
   * @param {{ requestPanelResize: (options?: { refreshTemporal?: boolean }) => void }} effects
   */
  function wire(effects) {
    if (wired || !overlay || !workflowPanel || !handle) {
      return false;
    }
    wired = true;
    resizeEffects = effects;

    const cancelPullAndResize = () => {
      if (cancelContentPull()) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    };
    const pointerContact = (event) => ({
      source: /** @type {const} */ ("pen"),
      contactId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      timeStamp: event.timeStamp,
      cancelable: event.cancelable,
      preventDefault: () => {
        event.preventDefault();
        return event.defaultPrevented;
      },
    });

    document.addEventListener("pointerdown", (event) => {
      if (
        dragSession
        && dragSession.pointerId !== event.pointerId
      ) {
        if (cancelDrag()) {
          effects.requestPanelResize({ refreshTemporal: true });
        }
        return;
      }
      if (contentPullSession) {
        if (
          contentPullSession.source !== "pen"
          || contentPullSession.contactId !== event.pointerId
        ) {
          cancelPullAndResize();
        }
        return;
      }
      if (
        event.pointerType !== "pen"
        || !event.isPrimary
        || event.button !== 0
      ) {
        return;
      }
      startContentPull({
        ...pointerContact(event),
        target: event.target,
      });
    }, true);
    document.addEventListener("pointermove", (event) => {
      if (contentPullSession?.source === "pen") {
        if (updateContentPull(pointerContact(event))) {
          effects.requestPanelResize({ refreshTemporal: true });
        }
      }
    }, { passive: false });
    document.addEventListener("pointerup", (event) => {
      if (
        contentPullSession?.source === "pen"
        && finishContentPull(pointerContact(event), true)
      ) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    });
    document.addEventListener("pointercancel", (event) => {
      if (
        contentPullSession?.source === "pen"
        && finishContentPull(pointerContact(event), false)
      ) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    });
    document.addEventListener("lostpointercapture", (event) => {
      if (
        contentPullSession?.source === "pen"
        && contentPullSession.contactId === event.pointerId
      ) {
        cancelPullAndResize();
      }
    });

    document.addEventListener("touchstart", (event) => {
      if (event.touches.length > 1) {
        cancelPullAndResize();
      }
    }, true);
    workflowPanel.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        cancelPullAndResize();
        return;
      }
      const touch = event.touches[0];
      if (contentPullSession?.source === "pen") {
        cancelPullAndResize();
      }
      startContentPull({
        source: "touch",
        contactId: touch.identifier,
        clientX: touch.clientX,
        clientY: touch.clientY,
        target: event.target,
      });
    }, true);
    workflowPanel.addEventListener("touchmove", (event) => {
      if (event.touches.length !== 1) {
        cancelPullAndResize();
        return;
      }
      const session = contentPullSession;
      if (!session || session.source !== "touch") {
        return;
      }
      const touch = touchByIdentifier(event.touches, session.contactId);
      if (!touch) {
        cancelPullAndResize();
        return;
      }
      const canceledPreview = updateContentPull({
        source: "touch",
        contactId: touch.identifier,
        clientX: touch.clientX,
        clientY: touch.clientY,
        timeStamp: event.timeStamp,
        cancelable: event.cancelable,
        preventDefault: () => {
          event.preventDefault();
          return event.defaultPrevented;
        },
      });
      if (canceledPreview) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    }, { capture: true, passive: false });
    workflowPanel.addEventListener("touchend", (event) => {
      const session = contentPullSession;
      if (!session || session.source !== "touch") {
        return;
      }
      const touch = touchByIdentifier(event.changedTouches, session.contactId);
      if (!touch || event.touches.length !== 0) {
        cancelPullAndResize();
        return;
      }
      if (finishContentPull({
        source: "touch",
        contactId: touch.identifier,
        clientY: touch.clientY,
        timeStamp: event.timeStamp,
        cancelable: event.cancelable,
        preventDefault: () => {
          event.preventDefault();
          return event.defaultPrevented;
        },
      }, true)) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    }, true);
    workflowPanel.addEventListener("touchcancel", (event) => {
      const session = contentPullSession;
      if (!session || session.source !== "touch") {
        return;
      }
      const touch = touchByIdentifier(event.changedTouches, session.contactId);
      if (touch) {
        if (finishContentPull({
          source: "touch",
          contactId: touch.identifier,
          clientY: touch.clientY,
          timeStamp: event.timeStamp,
          cancelable: event.cancelable,
          preventDefault: () => {
            event.preventDefault();
            return event.defaultPrevented;
          },
        }, false)) {
          effects.requestPanelResize({ refreshTemporal: true });
        }
      } else {
        cancelPullAndResize();
      }
    }, true);
    document.addEventListener("click", (event) => {
      if (
        event.detail !== 0
        && event.timeStamp <= suppressContentClickUntil
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressContentClickUntil = -Infinity;
      }
    }, true);

    handle.addEventListener("pointerdown", (event) => {
      if (
        layoutMode !== LAYOUT_BOTTOM
        || dragSession
        || event.button !== 0
        || !event.isPrimary
      ) {
        return;
      }
      const startSize = overlay.getBoundingClientRect().height;
      const detentSizes = currentDetentSizes();
      dragSession = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startSize,
        detentSizes,
      };
      overlay.style.setProperty("--sheet-drag-size", `${startSize}px`);
      overlay.dataset.shellDragging = "true";
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", updateDrag);
    handle.addEventListener("pointerup", (event) => {
      if (finishDrag(event, true)) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    });
    handle.addEventListener("pointercancel", (event) => {
      if (finishDrag(event, false)) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    });
    handle.addEventListener("lostpointercapture", () => {
      if (cancelDrag()) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    });
    handle.addEventListener("keydown", (event) => {
      if (layoutMode !== LAYOUT_BOTTOM) {
        return;
      }
      let changed = false;
      if (event.key === "ArrowDown") {
        changed = moveDetent(-1);
      } else if (event.key === "ArrowUp") {
        changed = moveDetent(1);
      } else if (event.key === "Home") {
        changed = setDetent(DETENT_MIDDLE);
      } else if (event.key === "End") {
        changed = setDetent(DETENT_FULL);
      } else {
        return;
      }
      event.preventDefault();
      if (changed) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    });

    const scheduleLayout = (forceResize = false) => {
      forceLayoutResize = forceLayoutResize || forceResize;
      if (layoutFrame !== null) {
        return;
      }
      layoutFrame = window.requestAnimationFrame(() => {
        layoutFrame = null;
        const shouldForceResize = forceLayoutResize;
        forceLayoutResize = false;
        if (shouldForceResize) {
          syncVisualViewportMetrics();
        }
        if (applyLayout() || shouldForceResize) {
          effects.requestPanelResize({ refreshTemporal: true });
        }
      });
    };
    const cancelActiveSheetGesture = () => {
      const canceledDrag = cancelDrag();
      const canceledPullPreview = cancelContentPull();
      if (canceledDrag || canceledPullPreview) {
        effects.requestPanelResize({ refreshTemporal: true });
      }
    };
    window.addEventListener("resize", () => {
      cancelActiveSheetGesture();
      scheduleLayout(true);
    });
    window.addEventListener("blur", cancelActiveSheetGesture);
    window.addEventListener("pagehide", cancelActiveSheetGesture, true);
    window.addEventListener("orientationchange", cancelActiveSheetGesture);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        cancelActiveSheetGesture();
      }
    });
    window.visualViewport?.addEventListener("resize", () => {
      cancelActiveSheetGesture();
      syncVisualViewportMetrics();
      scheduleLayout(true);
    });
    window.visualViewport?.addEventListener("scroll", () => {
      cancelActiveSheetGesture();
      syncVisualViewportMetrics();
      scheduleLayout();
    });

    if (typeof window.ResizeObserver === "function") {
      geometryObserver = new window.ResizeObserver(() => {
        cancelActiveSheetGesture();
        scheduleLayout();
      });
      geometryObserver.observe(handle);
      for (const section of workflowSections) {
        const header = section.querySelector("[data-section-toggle]");
        if (header instanceof window.HTMLElement) {
          geometryObserver.observe(header);
        }
      }
      if (stateActions) {
        geometryObserver.observe(stateActions);
      }
    }
    if (document.fonts) {
      document.fonts.ready.then(() => {
        cancelActiveSheetGesture();
        scheduleLayout(true);
      });
      document.fonts.addEventListener?.("loadingdone", () => {
        cancelActiveSheetGesture();
        scheduleLayout(true);
      });
    }

    syncVisualViewportMetrics();
    applyLayout();
    return true;
  }

  syncVisualViewportMetrics();
  applyLayout();

  return {
    wire,
  };
}
