/**
 * Sandbox 上の Next.js アプリに inject するクライアントサイドスクリプト。
 *
 * - EARLY_PATCH_SCRIPT:
 *     layout.tsx に inline の raw `<script dangerouslySetInnerHTML>` として埋め込まれ、
 *     HTML パース時同期実行で hydration より前に走らせる。
 *     Next.js の `<Script strategy="beforeInteractive">` は App Router では
 *     「hydration をブロックしない」仕様なので、timing critical な
 *     matchMedia spoof / IntersectionObserver パッチはそこでは間に合わない。
 *     framer-motion の useReducedMotion / useInView が初期化される前に
 *     確実に走らせる必要があるためここに分離している。
 *
 * - INJECTED_SELECTOR_SCRIPT:
 *     `public/directors-bot-selector.js` として書き込まれ、
 *     `<Script strategy="beforeInteractive">` 経由で load される要素選択・
 *     ハイライト表示のロジック。親から postMessage でモード切り替えされるだけで
 *     hydration タイミングに依存しない。
 */

// HTML パース時に同期実行される早期パッチ。iframe 内 (self !== top) でのみ発動。
// dangerouslySetInnerHTML 経由で JSX に文字列リテラルとして埋まるため、
// 埋め込み時は JSON.stringify で安全にエスケープされる前提で書いている。
export const EARLY_PATCH_SCRIPT = `(function(){
  try { if (window.self === window.top) return; } catch (_e) { /* iframe 扱い */ }
  try {
    var origMM = window.matchMedia ? window.matchMedia.bind(window) : null;
    var fake = function (q, m) {
      return {
        matches: m,
        media: q,
        onchange: null,
        addEventListener: function () {},
        removeEventListener: function () {},
        addListener: function () {},
        removeListener: function () {},
        dispatchEvent: function () { return true; }
      };
    };
    window.matchMedia = function (q) {
      if (typeof q === 'string' && /prefers-reduced-motion/.test(q)) {
        // 値部分だけ match。property 名 "prefers-reduced-motion" の "reduced" に
        // 引っかからないよう \\b で境界を明示する。
        return fake(q, /reduce\\b/.test(q));
      }
      return origMM ? origMM(q) : fake(q, false);
    };
  } catch (_e) { /* ignore */ }
  try {
    var NativeIO = window.IntersectionObserver;
    if (NativeIO) {
      var Patched = function (cb, opts) {
        var inst = new NativeIO(cb, opts);
        var origObserve = inst.observe.bind(inst);
        inst.observe = function (target) {
          origObserve(target);
          // 二重 RAF で native IO の初期 callback (isIntersecting:false) の後に
          // 合成 true を流す。viewport.once:true なら framer-motion が unobserve
          // するので以降の native 挙動に干渉しない。
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              try {
                var r = target.getBoundingClientRect();
                cb([{
                  target: target,
                  isIntersecting: true,
                  intersectionRatio: 1,
                  boundingClientRect: r,
                  intersectionRect: r,
                  rootBounds: null,
                  time: (performance && performance.now) ? performance.now() : Date.now()
                }], inst);
              } catch (_err) { /* ignore */ }
            });
          });
        };
        return inst;
      };
      Patched.prototype = NativeIO.prototype;
      window.IntersectionObserver = Patched;
    }
  } catch (_e) { /* ignore */ }

  // Safety net: sandbox preview + Turbopack dev + scaled iframe の組み合わせで
  // framer-motion の mount 時 animate が発火せず、SSR で焼き込まれた
  // inline style="opacity:0" のまま残るケースがある。prod では正しく動くので
  // iframe 特有の問題。hydration + mount が落ち着いた後の時点で、
  // inline opacity:0 を残している要素を強制的に可視に戻す。
  // framer-motion が正常に動いていれば既に opacity:1 になっていて何もしない。
  try {
    var forceShow = function () {
      var nodes = document.querySelectorAll('[style]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el && el.style) {
          if (el.style.opacity === '0') {
            el.style.removeProperty('opacity');
          }
          var tr = el.style.transform || '';
          if (/translate/.test(tr)) {
            // framer-motion の mount 初期状態が translate(Y?) で少し下に
            // ずれている場合があるので、opacity:0 をクリアする対象には合わせて外す。
            el.style.removeProperty('transform');
          }
        }
      }
    };
    // 1 回目: hydration + framer-motion の mount が終わった想定のタイミング。
    // 2 回目: 遅延 hydration / 後からマウントする dynamic import 対策。
    setTimeout(forceShow, 1500);
    setTimeout(forceShow, 3500);
  } catch (_e) { /* ignore */ }
})();`;

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
