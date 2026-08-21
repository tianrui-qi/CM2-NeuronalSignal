/**
 * @typedef {Object} InteractionCommand
 * @property {string} id
 * @property {string} label
 * @property {string[]} contexts
 * @property {string[]} bindings
 * @property {string} [bindingLabel]
 * @property {string} [group]
 * @property {(event: KeyboardEvent) => boolean} [canExecute]
 * @property {(event: KeyboardEvent) => unknown} execute
 * @property {boolean} [allowRepeat]
 * @property {boolean} [showInHelp]
 */

/** @param {KeyboardEvent} event */
function normalizeKeyboardBinding(event) {
  let key = event.key;
  if (key === " " || key === "Spacebar") {
    key = "Space";
  } else if (key === "Esc") {
    key = "Escape";
  } else if (key.length === 1 && !["?", "+", "_"].includes(key)) {
    key = key.toLowerCase();
  }

  const modifiers = [];
  if (event.ctrlKey) {
    modifiers.push("Control");
  }
  if (event.metaKey) {
    modifiers.push("Meta");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey && !["?", "+", "_"].includes(key)) {
    modifiers.push("Shift");
  }
  modifiers.push(key);
  return modifiers.join("+");
}

/** @param {EventTarget | null} target */
function isNativeActivationTarget(target) {
  return target instanceof Element && Boolean(target.closest(
    "button, a[href], summary, input[type='button'], input[type='submit'], input[type='reset'], [role='button']",
  ));
}

/**
 * Route keyboard input through the active interaction context. Native inputs,
 * dialogs, and popovers keep their own keyboard behavior.
 *
 * @param {{
 *   contextStack: { activeContexts: () => string[] },
 *   document?: Document,
 * }} options
 */
export function createInteractionCommandRegistry({
  contextStack,
  document: documentRef = globalThis.document,
}) {
  /** @type {InteractionCommand[]} */
  const commands = [];
  let started = false;

  /** @param {InteractionCommand} command */
  function register(command) {
    if (
      !command
      || typeof command.id !== "string"
      || typeof command.label !== "string"
      || !Array.isArray(command.contexts)
      || !Array.isArray(command.bindings)
      || typeof command.execute !== "function"
    ) {
      throw new TypeError("Interaction commands require an id, label, contexts, bindings, and execute callback.");
    }
    if (commands.some((candidate) => candidate.id === command.id)) {
      throw new TypeError(`Duplicate interaction command: ${command.id}`);
    }
    commands.push(Object.freeze({
      allowRepeat: false,
      canExecute: () => true,
      group: "Global",
      showInHelp: true,
      ...command,
      bindings: Object.freeze([...command.bindings]),
      contexts: Object.freeze([...command.contexts]),
    }));
    return command.id;
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.defaultPrevented || event.isComposing) {
      return false;
    }
    const binding = normalizeKeyboardBinding(event);
    if (["Enter", "Space"].includes(binding) && isNativeActivationTarget(event.target)) {
      return false;
    }
    for (const context of contextStack.activeContexts()) {
      const command = commands.find((candidate) => (
        candidate.contexts.includes(context)
        && candidate.bindings.includes(binding)
        && (candidate.allowRepeat || !event.repeat)
        && candidate.canExecute(event)
      ));
      if (!command) {
        continue;
      }
      event.preventDefault();
      event.stopPropagation();
      command.execute(event);
      return true;
    }
    return false;
  }

  function start() {
    if (started) {
      return false;
    }
    started = true;
    documentRef.addEventListener("keydown", handleKeydown);
    return true;
  }

  function helpEntries() {
    return commands
      .filter((command) => command.showInHelp)
      .map((command) => Object.freeze({
        id: command.id,
        label: command.label,
        group: command.group,
        bindingLabel: command.bindingLabel ?? command.bindings.join(" / "),
      }));
  }

  /** @param {ParentNode | Element} [root] */
  function decorateCommandElements(root = documentRef) {
    const elements = [];
    if (root instanceof Element && root.matches("[data-interaction-command]")) {
      elements.push(root);
    }
    elements.push(...root.querySelectorAll("[data-interaction-command]"));

    for (const element of elements) {
      const ids = (element.getAttribute("data-interaction-command") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      const matched = commands.filter((command) => ids.includes(command.id));
      if (matched.length === 0) {
        continue;
      }
      applyAriaKeyShortcuts(/** @type {HTMLElement} */ (element), ids);
      const baseDescription = element.dataset.interactionBaseDescription
        ?? element.getAttribute("data-control-description");
      if (!baseDescription) {
        continue;
      }
      element.dataset.interactionBaseDescription = baseDescription;
      const labels = [...new Set(matched.map((command) => (
        command.bindingLabel ?? command.bindings.join(" / ")
      )))];
      element.setAttribute(
        "data-control-description",
        `${baseDescription} Shortcut: ${labels.join("; ")}.`,
      );
    }
    return elements.length;
  }

  /** @param {HTMLElement | null} element @param {string | string[]} commandIds */
  function applyAriaKeyShortcuts(element, commandIds) {
    const ids = Array.isArray(commandIds) ? commandIds : [commandIds];
    const bindings = commands
      .filter((candidate) => ids.includes(candidate.id))
      .flatMap((command) => command.bindings);
    if (!element || bindings.length === 0) {
      return false;
    }
    element.setAttribute(
      "aria-keyshortcuts",
      [...new Set(bindings)].join(" "),
    );
    return true;
  }

  return Object.freeze({
    decorateCommandElements,
    helpEntries,
    register,
    start,
  });
}
