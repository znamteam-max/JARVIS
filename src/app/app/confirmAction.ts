// Telegram's own confirm dialog inside the Mini App, the browser's one elsewhere.
export function confirmAction(message: string) {
  return new Promise<boolean>((resolve) => {
    const app = window.Telegram?.WebApp;
    if (app?.initData && app.showConfirm && app.isVersionAtLeast?.("6.2")) {
      try {
        app.showConfirm(message, resolve);
        return;
      } catch {
        // fall through to the browser dialog
      }
    }
    resolve(window.confirm(message));
  });
}
