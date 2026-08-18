/**
 * DOM-only confirmation dialog for destructive ROI actions. State changes stay
 * with the callbacks supplied by the ROI panel/facade boundary.
 *
 * @param {{ document: Document }} dependencies
 */
export function createRoiConfirmationDialog({ document }) {
  /** @type {null | { dialog: HTMLDialogElement, trigger: HTMLElement | null }} */
  let active = null;
  let dialogSequence = 0;

  /**
   * @param {{ restoreFocus?: boolean }} [options]
   */
  function close({ restoreFocus = true } = {}) {
    if (!active) {
      return false;
    }

    const { dialog, trigger } = active;
    active = null;
    if (dialog.open) {
      dialog.close();
    }
    dialog.remove();
    if (restoreFocus && trigger?.isConnected) {
      trigger.focus();
    }
    return true;
  }

  /**
   * @param {{
   *   title: string,
   *   description: string,
   *   confirmLabel: string,
   *   confirmDescription: string,
   *   trigger?: HTMLElement | null,
   *   onConfirm: () => void,
   *   focusAfterConfirm?: () => HTMLElement | null,
   * }} options
   */
  function open({
    title,
    description,
    confirmLabel,
    confirmDescription,
    trigger = null,
    onConfirm,
    focusAfterConfirm = () => null,
  }) {
    close({ restoreFocus: false });

    dialogSequence += 1;
    const titleId = `roi-confirm-dialog-title-${dialogSequence}`;
    const descriptionId = `roi-confirm-dialog-description-${dialogSequence}`;

    const dialog = document.createElement("dialog");
    dialog.className = "roi-confirm-dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-describedby", descriptionId);

    const heading = document.createElement("h4");
    heading.id = titleId;
    heading.className = "roi-confirm-dialog-title";
    heading.textContent = title;

    const message = document.createElement("p");
    message.id = descriptionId;
    message.className = "roi-confirm-dialog-description";
    message.textContent = description;

    const actions = document.createElement("div");
    actions.className = "roi-confirm-dialog-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "mini-btn roi-confirm-dialog-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.setAttribute("aria-label", "Cancel ROI action");
    cancelButton.dataset.controlDescription = (
      "Cancel and keep the ROI unchanged"
    );
    cancelButton.autofocus = true;
    cancelButton.addEventListener("click", () => close());

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "mini-btn roi-confirm-dialog-confirm";
    confirmButton.textContent = confirmLabel;
    confirmButton.setAttribute("aria-label", confirmLabel);
    confirmButton.dataset.controlDescription = confirmDescription;
    confirmButton.addEventListener("click", () => {
      const previousTrigger = active?.trigger ?? trigger;
      close({ restoreFocus: false });
      try {
        onConfirm();
      } finally {
        const nextFocus = focusAfterConfirm();
        if (nextFocus?.isConnected) {
          nextFocus.focus();
        } else if (previousTrigger?.isConnected) {
          previousTrigger.focus();
        }
      }
    });

    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    dialog.appendChild(heading);
    dialog.appendChild(message);
    dialog.appendChild(actions);

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) {
        return;
      }
      const bounds = dialog.getBoundingClientRect();
      const clickedBackdrop = (
        event.clientX < bounds.left
        || event.clientX > bounds.right
        || event.clientY < bounds.top
        || event.clientY > bounds.bottom
      );
      if (clickedBackdrop) {
        close();
      }
    });

    document.body.appendChild(dialog);
    active = { dialog, trigger };
    dialog.showModal();
    cancelButton.focus();
    return true;
  }

  return Object.freeze({ close, open });
}
