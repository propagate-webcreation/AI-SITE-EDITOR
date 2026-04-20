/**
 * Sandbox 上の Next.js アプリに inject するクライアントサイドスクリプト。
 *
 * 親ウィンドウ (directors-bot-v1) からの postMessage でモード切り替え、
 * ユーザーがクリックした要素の CSS selector / HTML / テキストを postMessage で返す。
 *
 * このコード全体が `public/directors-bot-selector.js` として Sandbox に書き込まれる。
 * IIFE で即時実行。global は汚さない。
 */
export const INJECTED_SELECTOR_SCRIPT = `(() => {
  if (window.__directorsBotSelector) return;
  window.__directorsBotSelector = true;

  const OVERLAY_COLOR = 'rgba(236, 72, 72, 0.18)';
  const OVERLAY_BORDER = '2px solid #dc2626';
  const HIGHLIGHT_COLOR = 'rgba(245, 158, 11, 0.18)';
  const HIGHLIGHT_BORDER = '2px solid #f59e0b';
  let active = false;
  let hoverEl = null;
  let overlayEl = null;
  let highlightSelectors = [];
  let highlightOverlays = [];
  let highlightRaf = null;

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'box-sizing:border-box',
      'transition:all 60ms ease-out',
      'background:' + OVERLAY_COLOR,
      'border:' + OVERLAY_BORDER,
      'border-radius:2px',
    ].join(';');
    document.body.appendChild(overlayEl);
    return overlayEl;
  }
  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    hoverEl = null;
  }
  function updateOverlay(el) {
    const ov = ensureOverlay();
    const r = el.getBoundingClientRect();
    ov.style.left = r.left + 'px';
    ov.style.top = r.top + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
  }

  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      let seg = node.nodeName.toLowerCase();
      const cls = typeof node.className === 'string'
        ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2)
        : [];
      if (cls.length) seg += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName,
        );
        if (sameTag.length > 1) {
          seg += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      path.unshift(seg);
      if (node.id || node === document.body) break;
      node = parent;
    }
    return path.join(' > ');
  }

  function summarize(el) {
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const html = (el.outerHTML || '').slice(0, 2000);
    return {
      tag: el.tagName.toLowerCase(),
      selector: cssSelector(el),
      text,
      html,
    };
  }

  function setCursor(on) {
    document.documentElement.style.cursor = on ? 'crosshair' : '';
  }

  function enable() {
    if (active) return;
    active = true;
    setCursor(true);
  }
  function disable() {
    if (!active) return;
    active = false;
    setCursor(false);
    removeOverlay();
  }

  function clearHighlights() {
    highlightOverlays.forEach((el) => el.remove());
    highlightOverlays = [];
    highlightSelectors = [];
    if (highlightRaf) {
      cancelAnimationFrame(highlightRaf);
      highlightRaf = null;
    }
  }
  function reflowHighlights() {
    for (let i = 0; i < highlightOverlays.length; i += 1) {
      const ov = highlightOverlays[i];
      const sel = highlightSelectors[i];
      let el = null;
      try {
        el = sel ? document.querySelector(sel) : null;
      } catch (_err) {
        el = null;
      }
      if (!el) {
        ov.style.display = 'none';
        continue;
      }
      const r = el.getBoundingClientRect();
      ov.style.display = '';
      ov.style.left = r.left + 'px';
      ov.style.top = r.top + 'px';
      ov.style.width = r.width + 'px';
      ov.style.height = r.height + 'px';
    }
  }
  function scheduleReflow() {
    if (highlightRaf) return;
    highlightRaf = requestAnimationFrame(() => {
      highlightRaf = null;
      reflowHighlights();
    });
  }
  function setHighlights(selectors) {
    clearHighlights();
    if (!selectors || selectors.length === 0) return;
    highlightSelectors = selectors.slice();
    for (let i = 0; i < selectors.length; i += 1) {
      const ov = document.createElement('div');
      ov.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        'box-sizing:border-box',
        'background:' + HIGHLIGHT_COLOR,
        'border:' + HIGHLIGHT_BORDER,
        'border-radius:2px',
        'transition:opacity 120ms ease-out',
      ].join(';');
      document.body.appendChild(ov);
      highlightOverlays.push(ov);
    }
    reflowHighlights();
    // 最初の対象要素が画面外ならスクロールで見える位置へ。
    let firstEl = null;
    try {
      firstEl = document.querySelector(selectors[0]);
    } catch (_err) {
      firstEl = null;
    }
    if (firstEl) {
      const r = firstEl.getBoundingClientRect();
      const offscreen =
        r.bottom < 0 ||
        r.top > (window.innerHeight || document.documentElement.clientHeight);
      if (offscreen) {
        firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  window.addEventListener('scroll', scheduleReflow, true);
  window.addEventListener('resize', scheduleReflow);

  document.addEventListener(
    'mouseover',
    (e) => {
      if (!active) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t === hoverEl) return;
      hoverEl = t;
      updateOverlay(t);
    },
    true,
  );

  document.addEventListener(
    'mousemove',
    () => {
      if (active && hoverEl) updateOverlay(hoverEl);
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!active) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const payload = summarize(t);
      try {
        window.parent.postMessage(
          { type: 'directors-bot:selection', payload },
          '*',
        );
      } catch (_err) {
        /* ignore */
      }
      disable();
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (active && e.key === 'Escape') {
        disable();
        try {
          window.parent.postMessage({ type: 'directors-bot:selection-cancel' }, '*');
        } catch (_err) {
          /* ignore */
        }
      }
    },
    true,
  );

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'directors-bot:enable-selection') enable();
    else if (data.type === 'directors-bot:disable-selection') disable();
    else if (data.type === 'directors-bot:highlight-selectors')
      setHighlights(Array.isArray(data.selectors) ? data.selectors : []);
    else if (data.type === 'directors-bot:clear-highlights') clearHighlights();
    else if (data.type === 'directors-bot:ping')
      window.parent.postMessage({ type: 'directors-bot:ready' }, '*');
  });

  // アプリ起動時に親に ready を通知
  try {
    window.parent.postMessage({ type: 'directors-bot:ready' }, '*');
  } catch (_err) {
    /* ignore */
  }
})();
`;
