// Runs in the page's main world at document_start. Forwards console output and errors to
// the content script, and auto-answers blocking dialogs while an agent controls the tab.

(() => {
  const w = window as any;
  if (w.__bbHook) return;
  w.__bbHook = true;

  const fmt = (args: unknown[]) =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
      .slice(0, 500);

  const post = (kind: string, level: string, text: string) =>
    window.dispatchEvent(new CustomEvent('__bb_log', { detail: JSON.stringify({ kind, level, text }) }));

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level];
    console[level] = function (this: Console, ...args: unknown[]) {
      try {
        post('console', level, fmt(args));
      } catch {
        /* never break the page */
      }
      return orig.apply(this, args);
    };
  }

  window.addEventListener('error', (e) => {
    const file = (e.filename ?? '').split(/[?#]/)[0].split('/').pop()!.slice(-60);
    const where = file ? ` @ ${file}:${e.lineno}` : '';
    post('error', 'error', `${e.message}${where}`);
  });
  window.addEventListener('unhandledrejection', (e) => post('error', 'error', 'Unhandled rejection: ' + fmt([e.reason])));

  const agent = () => document.documentElement?.hasAttribute('data-bb-agent');
  const { alert, confirm, prompt } = window;
  window.alert = function (m?: unknown) {
    if (!agent()) return alert.call(window, m);
    post('console', 'dialog', `alert: ${String(m)}`);
  };
  window.confirm = function (m?: string) {
    if (!agent()) return confirm.call(window, m);
    post('console', 'dialog', `confirm: ${m} -> OK`);
    return true;
  };
  window.prompt = function (m?: string, d?: string) {
    if (!agent()) return prompt.call(window, m, d);
    post('console', 'dialog', `prompt: ${m} -> ${d ?? ''}`);
    return d ?? '';
  };
})();
