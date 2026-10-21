import { describe, expect, it, vi } from "vitest";

import { openBackLayer, type BackWindow } from "@/app/app/backNavigation";

// A browser window with history and timers that the test drives by hand.
function fakeBrowser(
  options: { telegram?: { version: string } | "no-initdata"; entries?: unknown[] } = {},
) {
  const entries: unknown[] = options.entries ?? [{ __next: "tree" }];
  let index = entries.length - 1;
  const listeners: Record<string, Array<(event: unknown) => void>> = {
    popstate: [],
    keydown: [],
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const button = {
    visible: false,
    callbacks: [] as Array<() => void>,
    show: vi.fn(() => (button.visible = true)),
    hide: vi.fn(() => (button.visible = false)),
    onClick: vi.fn((callback: () => void) => button.callbacks.push(callback)),
    offClick: vi.fn((callback: () => void) => {
      button.callbacks = button.callbacks.filter((item) => item !== callback);
    }),
    press: () => [...button.callbacks].forEach((callback) => callback()),
  };
  const back = vi.fn(() => {
    if (index === 0) return;
    index -= 1;
  });
  const telegramVersion =
    options.telegram && options.telegram !== "no-initdata" ? options.telegram.version : null;
  const win = {
    history: {
      get state() {
        return entries[index];
      },
      pushState: vi.fn((data: unknown) => {
        entries.splice(index + 1);
        entries.push(data);
        index += 1;
      }),
      replaceState: vi.fn((data: unknown) => {
        entries[index] = data;
      }),
      back,
    },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners[type].push(listener),
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listeners[type].filter((item) => item !== listener);
    },
    setTimeout: (handler: () => void) => {
      const id = nextTimer++;
      timers.set(id, handler);
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    Telegram:
      options.telegram === "no-initdata"
        ? { WebApp: { initData: "", BackButton: button, isVersionAtLeast: () => true } }
        : telegramVersion
          ? {
              WebApp: {
                initData: "query_id=1",
                BackButton: button,
                isVersionAtLeast: (version: string) => Number(telegramVersion) >= Number(version),
              },
            }
          : undefined,
  };
  return {
    win: win as unknown as BackWindow,
    button,
    entries,
    get index() {
      return index;
    },
    listenerCount: (type: string) => listeners[type].length,
    // The browser reports a step in history (back button, Android gesture, iOS swipe).
    popstate: () => [...listeners.popstate].forEach((listener) => listener({})),
    key: (key: string, target?: unknown) =>
      [...listeners.keydown].forEach((listener) => listener({ key, target })),
    runTimers: () => [...timers.values()].forEach((handler) => handler()),
    pressBrowserBack: () => {
      back();
      [...listeners.popstate].forEach((listener) => listener({}));
    },
  };
}

describe("JARVIS window: back in a browser or the installed app", () => {
  it("adds a history entry that keeps the router's own state", () => {
    const browser = fakeBrowser();
    openBackLayer(browser.win, () => undefined);
    expect(browser.index).toBe(1);
    expect(browser.entries[1]).toMatchObject({ __next: "tree" });
  });

  it("the phone's back closes the window instead of leaving the app", () => {
    const browser = fakeBrowser();
    const onBack = vi.fn();
    openBackLayer(browser.win, onBack);
    browser.pressBrowserBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(browser.index).toBe(0);
    expect(browser.listenerCount("popstate")).toBe(0);
    expect(browser.listenerCount("keydown")).toBe(0);
  });

  it("«Назад» on the page steps back over its own entry and closes once", () => {
    const browser = fakeBrowser();
    const onBack = vi.fn();
    const layer = openBackLayer(browser.win, onBack);
    layer.close();
    layer.close();
    expect(browser.win.history.back).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    browser.popstate();
    browser.runTimers();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(browser.index).toBe(0);
  });

  it("closes anyway when the browser never reports the step back", () => {
    const browser = fakeBrowser();
    const onBack = vi.fn();
    openBackLayer(browser.win, onBack).close();
    browser.runTimers();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Escape closes it on a computer", () => {
    const browser = fakeBrowser();
    const onBack = vi.fn();
    openBackLayer(browser.win, onBack);
    browser.key("Enter");
    expect(onBack).not.toHaveBeenCalled();
    browser.key("Escape");
    browser.popstate();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("after the window is gone, history steps no longer touch it", () => {
    const browser = fakeBrowser();
    const onBack = vi.fn();
    const layer = openBackLayer(browser.win, onBack);
    layer.dispose();
    browser.pressBrowserBack();
    expect(onBack).not.toHaveBeenCalled();
    expect(browser.listenerCount("popstate")).toBe(0);
  });
});

describe("JARVIS window: after a reload with the window open", () => {
  it("one back press closes the reopened window (the old entry is reused, not stacked)", () => {
    // The previous page load left its JARVIS entry, with an old id, as the current one.
    const browser = fakeBrowser({
      entries: [{ __next: "tree" }, { __next: "tree", jarvisLayer: "oldload-1" }],
    });
    const onBack = vi.fn();
    openBackLayer(browser.win, onBack);
    expect(browser.win.history.pushState).not.toHaveBeenCalled();
    expect(browser.entries).toHaveLength(2);
    browser.pressBrowserBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(browser.index).toBe(0);
  });

  it("ids differ between layers, so an old entry never passes for the new window's own", () => {
    const browser = fakeBrowser();
    openBackLayer(browser.win, () => undefined).dispose();
    const first = (browser.entries[1] as { jarvisLayer: string }).jarvisLayer;
    openBackLayer(browser.win, () => undefined);
    const second = (browser.entries[1] as { jarvisLayer: string }).jarvisLayer;
    expect(first).not.toBe(second);
  });
});

describe("JARVIS window: Escape while typing", () => {
  it("with unsent text only leaves the field; the next Escape closes", () => {
    const browser = fakeBrowser();
    const onBack = vi.fn();
    openBackLayer(browser.win, onBack);
    const field = { tagName: "TEXTAREA", value: "перенеси созвон", blur: vi.fn() };
    browser.key("Escape", field);
    expect(field.blur).toHaveBeenCalledTimes(1);
    expect(browser.win.history.back).not.toHaveBeenCalled();
    browser.key("Escape", { tagName: "BODY" });
    browser.popstate();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("JARVIS window: back inside Telegram", () => {
  it("shows Telegram's own Back button and closes on it, without history entries", () => {
    const telegram = fakeBrowser({ telegram: { version: "8.0" } });
    const onBack = vi.fn();
    openBackLayer(telegram.win, onBack);
    expect(telegram.button.visible).toBe(true);
    expect(telegram.win.history.pushState).not.toHaveBeenCalled();
    telegram.button.press();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(telegram.button.visible).toBe(false);
    expect(telegram.button.callbacks).toHaveLength(0);
  });

  it("«Назад» on the page hides Telegram's button too", () => {
    const telegram = fakeBrowser({ telegram: { version: "7.0" } });
    const onBack = vi.fn();
    openBackLayer(telegram.win, onBack).close();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(telegram.button.visible).toBe(false);
    expect(telegram.win.history.back).not.toHaveBeenCalled();
  });

  it("an old Telegram without the Back button falls back to history", () => {
    const telegram = fakeBrowser({ telegram: { version: "6.0" } });
    openBackLayer(telegram.win, () => undefined);
    expect(telegram.button.show).not.toHaveBeenCalled();
    expect(telegram.win.history.pushState).toHaveBeenCalledTimes(1);
  });

  it("the Telegram script in a plain browser (no launch data) uses history", () => {
    const browser = fakeBrowser({ telegram: "no-initdata" });
    openBackLayer(browser.win, () => undefined);
    expect(browser.button.show).not.toHaveBeenCalled();
    expect(browser.win.history.pushState).toHaveBeenCalledTimes(1);
  });
});
