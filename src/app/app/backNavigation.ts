// "Back" for a full-screen layer such as the JARVIS window. Inside the Telegram Mini App the
// layer shows Telegram's own Back button (it also takes Android's hardware back); in a browser
// or the installed app it adds a history entry, so the browser's back, Android's back gesture
// and iOS's swipe close the layer instead of leaving the app. Escape closes it on a computer.

type TelegramBackButton = {
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
};

export type BackWindow = {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string): void;
    replaceState(data: unknown, unused: string): void;
    back(): void;
  };
  addEventListener(type: "popstate" | "keydown", listener: (event: never) => void): void;
  removeEventListener(type: "popstate" | "keydown", listener: (event: never) => void): void;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(id: number): void;
  Telegram?: {
    WebApp?: {
      initData?: string;
      BackButton?: TelegramBackButton;
      isVersionAtLeast?(version: string): boolean;
    };
  };
};

export type BackLayer = {
  // "Назад" on the page: closes the layer and takes its history entry back.
  close(): void;
  // The layer went away on its own: listeners off, Telegram's button hidden.
  dispose(): void;
};

const KEY = "jarvisLayer";
// If the browser never reports the step back, the layer closes anyway.
const BACK_FALLBACK_MS = 400;
// history.state survives a reload, a module counter does not: ids carry a per-load prefix so
// an entry left by the previous load can never be taken for the current layer's own.
const LOAD = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let nextLayerId = 1;

function telegramBackButton(win: BackWindow) {
  const app = win.Telegram?.WebApp;
  if (!app?.initData || !app.BackButton) return null;
  // BackButton exists since Bot API 6.1; older clients have only "Закрыть".
  if (app.isVersionAtLeast && !app.isVersionAtLeast("6.1")) return null;
  return app.BackButton;
}

export function openBackLayer(win: BackWindow, onBack: () => void): BackLayer {
  const id = `${LOAD}-${nextLayerId++}`;
  const button = telegramBackButton(win);
  let active = true;
  let fallback: number | null = null;

  const ours = () => (win.history.state as Record<string, unknown> | null)?.[KEY] === id;

  function teardown() {
    win.removeEventListener("popstate", onPopState as (event: never) => void);
    win.removeEventListener("keydown", onKeyDown as (event: never) => void);
    if (fallback !== null) win.clearTimeout(fallback);
    fallback = null;
    if (button) {
      button.offClick(finish);
      button.hide();
    }
  }

  // The one way the layer actually closes: whatever asked for it, it happens once.
  function finish() {
    if (!active) return;
    active = false;
    teardown();
    onBack();
  }

  function onPopState() {
    // Our entry is gone (back was pressed): close. Anything else is not about this layer.
    if (!ours()) finish();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    // Escape in a field with unsent text only leaves the field; the next Escape closes.
    const field = event.target as (HTMLElement & { value?: unknown }) | null;
    if (
      field &&
      (field.tagName === "TEXTAREA" || field.tagName === "INPUT") &&
      typeof field.value === "string" &&
      field.value.trim()
    ) {
      field.blur();
      return;
    }
    close();
  }

  function close() {
    // Closed already, or a step back is on its way (a double tap on «Назад»).
    if (!active || fallback !== null) return;
    if (!button && ours()) {
      // Step back over our own entry; popstate then closes the layer.
      win.history.back();
      fallback = win.setTimeout(finish, BACK_FALLBACK_MS);
      return;
    }
    finish();
  }

  if (button) {
    button.onClick(finish);
    button.show();
  } else {
    const state = win.history.state;
    const record = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
    // Standing on an entry a previous layer left behind (a reload with the window open):
    // reuse it, so no back press is wasted on an entry that changes nothing on screen.
    if (KEY in record) win.history.replaceState({ ...record, [KEY]: id }, "");
    else win.history.pushState({ ...record, [KEY]: id }, "");
    win.addEventListener("popstate", onPopState as (event: never) => void);
  }
  win.addEventListener("keydown", onKeyDown as (event: never) => void);

  return {
    close,
    dispose() {
      if (!active) return;
      active = false;
      teardown();
    },
  };
}
