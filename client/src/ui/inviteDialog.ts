/** Modal that surfaces the current room's invite code + share URL with
 *  click-to-copy interactions. Opened by clicking the in-game invite
 *  badge; closed via the X, the dim backdrop, or ESC. The share URL
 *  carries the code in a `?code=` query string so the recipient lands
 *  on the login overlay with the field already filled in. */
export function setupInviteDialog(): {
  setCode: (code: string | undefined) => void;
} {
  const overlay = document.getElementById('invite-dialog-overlay') as HTMLDivElement;
  const closeBtn = document.getElementById('invite-dialog-close') as HTMLButtonElement;
  const codeRow = document.getElementById('invite-dialog-code-row') as HTMLDivElement;
  const codeText = document.getElementById('invite-dialog-code') as HTMLSpanElement;
  const linkRow = document.getElementById('invite-dialog-link-row') as HTMLDivElement;
  const linkText = document.getElementById('invite-dialog-link') as HTMLSpanElement;
  const badge = document.getElementById('invite-badge') as HTMLDivElement;

  let currentCode: string | undefined;

  const setOpen = (on: boolean): void => {
    overlay.classList.toggle('open', on);
  };

  const buildShareLink = (code: string): string => {
    const url = new URL(window.location.href);
    url.search = `?code=${encodeURIComponent(code)}`;
    url.hash = '';
    return url.toString();
  };

  const flashCopied = (row: HTMLDivElement, originalAction: string): void => {
    const action = row.querySelector('.invite-copyable-action') as HTMLSpanElement;
    row.classList.add('copied');
    action.textContent = 'copied!';
    setTimeout(() => {
      row.classList.remove('copied');
      action.textContent = originalAction;
    }, 1100);
  };

  const copyToClipboard = async (text: string, row: HTMLDivElement): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(row, 'click to copy');
    } catch {
      // Clipboard API blocked (insecure context, denied permission). Fall
      // back to the legacy execCommand path so the user still gets the
      // string into their clipboard on http:// localhost during dev.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); flashCopied(row, 'click to copy'); }
      catch { /* nothing to do */ }
      ta.remove();
    }
  };

  codeRow.addEventListener('click', () => {
    if (!currentCode) return;
    void copyToClipboard(currentCode, codeRow);
  });
  linkRow.addEventListener('click', () => {
    if (!currentCode) return;
    void copyToClipboard(buildShareLink(currentCode), linkRow);
  });

  closeBtn.addEventListener('click', () => setOpen(false));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) setOpen(false);
  });

  // Click on the in-game badge opens the dialog. We swap the old direct
  // click-to-copy because the dialog is now the canonical sharing path
  // (it surfaces the link form too).
  badge.addEventListener('click', () => {
    if (!currentCode) return;
    setOpen(true);
  });

  // ESC closes the invite dialog when it's open. The settings dialog
  // has its own ESC handler, but we get there first only when this
  // overlay is actually visible — otherwise we let the event flow to
  // the settings handler.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!overlay.classList.contains('open')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setOpen(false);
  });

  return {
    setCode: (code: string | undefined): void => {
      currentCode = code;
      codeText.textContent = code ?? '— —';
      linkText.textContent = code ? buildShareLink(code) : '—';
    },
  };
}
