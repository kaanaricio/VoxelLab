// Notification toasts — stacking, deduplication, dismissable.
//
// Duplicate messages shake the existing toast and reset its timer.
// Max 4 visible toasts — oldest dismissed when exceeded.

const MAX_TOASTS = 4;
let _container = null;

function ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.id = 'notify-container';
  document.body.appendChild(_container);
  return _container;
}

function dismissEl(el) {
  el.classList.add('exiting');
  clearTimeout(el._dismissTimer);
  setTimeout(() => el.remove(), 200);
}

export function notify(message, opts = {}) {
  const { duration = 5000, command, progress, id } = opts;
  const container = ensureContainer();

  // Deduplicate by id — update text, shake, reset timer
  if (id) {
    const existing = container.querySelector(`[data-notify-id="${id}"]`);
    if (existing) {
      const textEl = existing.querySelector('.notify-text');
      if (textEl) textEl.textContent = message;
      existing.classList.remove('shake');
      // Force reflow to restart animation
      void existing.offsetWidth;
      existing.classList.add('shake');
      // Reset auto-dismiss timer
      if (!progress && duration > 0) {
        clearTimeout(existing._dismissTimer);
        existing._dismissTimer = setTimeout(() => dismissEl(existing), duration);
      }
      return existing;
    }
  }

  // Deduplicate by message text (no id) — shake existing
  if (!id) {
    for (const child of container.children) {
      const textEl = child.querySelector('.notify-text');
      if (textEl && textEl.textContent === message) {
        child.classList.remove('shake');
        void child.offsetWidth;
        child.classList.add('shake');
        if (!progress && duration > 0) {
          clearTimeout(child._dismissTimer);
          child._dismissTimer = setTimeout(() => dismissEl(child), duration);
        }
        return child;
      }
    }
  }

  // Enforce max visible toasts — dismiss oldest
  const items = container.querySelectorAll('.notify-item:not(.exiting)');
  if (items.length >= MAX_TOASTS) {
    dismissEl(items[0]);
  }

  const el = document.createElement('div');
  el.className = 'notify-item';
  if (id) el.dataset.notifyId = id;

  let bodyHtml = `<div class="notify-text${command ? ' has-cmd' : ''}">${escapeForNotify(message)}</div>`;

  if (command) {
    bodyHtml += `
      <div class="notify-cmd">
        <code>${escapeForNotify(command)}</code>
        <button class="notify-copy">Copy</button>
      </div>
    `;
  }

  if (progress) {
    bodyHtml += `<div class="notify-progress"><div class="notify-progress-bar"></div></div>`;
  }

  el.innerHTML = `<div class="notify-body">${bodyHtml}</div><button class="notify-dismiss" aria-label="Dismiss">×</button>`;

  // Wire dismiss button
  el.querySelector('.notify-dismiss').addEventListener('click', () => dismissEl(el));

  // Wire copy button
  const copyBtn = el.querySelector('.notify-copy');
  if (copyBtn && command) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      } catch {
        const code = el.querySelector('code');
        if (code) {
          const range = document.createRange();
          range.selectNodeContents(code);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        }
      }
    });
  }

  container.appendChild(el);

  // Auto-dismiss (unless progress indicator is shown)
  if (!progress && duration > 0) {
    el._dismissTimer = setTimeout(() => dismissEl(el), duration);
  }

  return el;
}

export function dismissNotify(id) {
  const container = ensureContainer();
  const el = container.querySelector(`[data-notify-id="${id}"]`);
  if (el) dismissEl(el);
}

function escapeForNotify(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
