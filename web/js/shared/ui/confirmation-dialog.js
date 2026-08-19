let confirmationDialogSequence = 0;


/**
 * DOM-only confirmation dialog for destructive viewer actions. State changes
 * stay with the callback supplied by the owning feature or application.
 *
 * @param {{ document: Document }} dependencies
 */
export function createConfirmationDialog({ document }) {
  /** @type {null | { dialog: HTMLDialogElement, trigger: HTMLElement | null }} */
  let active = null;

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
   *   cancelDescription?: string,
   *   trigger?: HTMLElement | null,
   *   onConfirm: () => unknown | Promise<unknown>,
   *   focusAfterConfirm?: (result: unknown) => HTMLElement | null,
   * }} options
   */
  function open({
    title,
    description,
    confirmLabel,
    confirmDescription,
    cancelDescription = "Close this dialog without making changes",
    trigger = null,
    onConfirm,
    focusAfterConfirm = () => null,
  }) {
    close({ restoreFocus: false });

    confirmationDialogSequence += 1;
    const titleId = `confirmation-dialog-title-${confirmationDialogSequence}`;
    const descriptionId = `confirmation-dialog-description-${confirmationDialogSequence}`;

    const dialog = document.createElement("dialog");
    dialog.className = "confirmation-dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-describedby", descriptionId);

    const heading = document.createElement("h4");
    heading.id = titleId;
    heading.className = "confirmation-dialog-title";
    heading.textContent = title;

    const message = document.createElement("p");
    message.id = descriptionId;
    message.className = "confirmation-dialog-description";
    message.textContent = description;

    const actions = document.createElement("div");
    actions.className = "confirmation-dialog-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "mini-btn confirmation-dialog-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.setAttribute("aria-label", "Cancel");
    cancelButton.dataset.controlDescription = cancelDescription;
    cancelButton.autofocus = true;

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "mini-btn confirmation-dialog-confirm";
    confirmButton.textContent = confirmLabel;
    confirmButton.setAttribute("aria-label", confirmLabel);
    confirmButton.dataset.controlDescription = confirmDescription;

    let submitting = false;
    cancelButton.addEventListener("click", () => {
      if (!submitting) {
        close();
      }
    });
    confirmButton.addEventListener("click", async () => {
      if (submitting) {
        return;
      }
      submitting = true;
      dialog.setAttribute("aria-busy", "true");
      cancelButton.disabled = true;
      confirmButton.disabled = true;
      const previousTrigger = active?.trigger ?? trigger;
      try {
        const result = await onConfirm();
        close({ restoreFocus: false });
        const nextFocus = focusAfterConfirm(result);
        if (nextFocus?.isConnected) {
          nextFocus.focus();
        } else if (previousTrigger?.isConnected) {
          previousTrigger.focus();
        }
      } catch (error) {
        submitting = false;
        dialog.removeAttribute("aria-busy");
        cancelButton.disabled = false;
        confirmButton.disabled = false;
        cancelButton.focus();
        globalThis.console?.error(error);
      }
    });

    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    dialog.appendChild(heading);
    dialog.appendChild(message);
    dialog.appendChild(actions);

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!submitting) {
        close();
      }
    });
    dialog.addEventListener("click", (event) => {
      if (submitting || event.target !== dialog) {
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
