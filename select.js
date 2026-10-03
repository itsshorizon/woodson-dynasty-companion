/* ===========================================================
 * Styled dropdowns
 *
 * Every <select> is wrapped with a themed trigger + popover menu.
 * The native <select> stays inside the wrapper (visually hidden) as the
 * source of truth, so existing code that reads .value, sets innerHTML,
 * or listens for 'change' keeps working untouched.
 *
 * Opt out with <select data-native>. Options may carry:
 *   data-icon="<img url>"  small round image (team logo)
 *   data-abbr="TG"         initials shown when the image is missing/broken
 *   data-sub="Owner name"  muted second line
 * =========================================================== */
(function () {
  const SEARCH_THRESHOLD = 12;
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const indexDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let openState = null; // { sel, wrap, menu, list, search, items, active }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function iconHTML(opt) {
    const icon = opt.dataset.icon;
    const abbr = opt.dataset.abbr;
    if (!icon && !abbr) return '';
    const fallback = `<span class="fs-ico fs-ico-txt">${esc((abbr || opt.textContent.trim()[0] || '?').slice(0, 3))}</span>`;
    if (!icon) return fallback;
    return `<img class="fs-ico" src="${esc(icon)}" alt="" loading="lazy" onerror="this.outerHTML=this.dataset.fb" data-fb="${esc(fallback)}" />`;
  }

  function optionInner(opt) {
    const sub = opt.dataset.sub ? `<small class="fs-sub">${esc(opt.dataset.sub)}</small>` : '';
    return `${iconHTML(opt)}<span class="fs-label"><span class="fs-text">${esc(opt.textContent)}</span>${sub}</span>`;
  }

  function syncTrigger(sel) {
    const wrap = sel._fsWrap;
    if (!wrap) return;
    const trig = wrap.querySelector('.fs-trigger');
    const opt = sel.options[sel.selectedIndex];
    const isPlaceholder = !opt || opt.value === '';
    trig.querySelector('.fs-value').innerHTML = opt ? optionInner(opt) : '<span class="fs-label"><span class="fs-text">—</span></span>';
    trig.classList.toggle('placeholder', isPlaceholder);
    trig.disabled = sel.disabled;
    wrap.classList.toggle('disabled', sel.disabled);
    if (sel.title) trig.title = sel.title; else trig.removeAttribute('title');
    if (openState && openState.sel === sel) renderList();
  }

  function labelFor(sel) {
    if (sel.getAttribute('aria-label')) return sel.getAttribute('aria-label');
    if (sel.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const prev = sel.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return prev.textContent.trim();
    return '';
  }

  function enhance(sel) {
    if (sel._fsWrap || sel.hasAttribute('data-native') || sel.multiple) return;

    const wrap = document.createElement('div');
    wrap.className = 'fs';
    if (sel.id) wrap.dataset.for = sel.id;
    if (sel.getAttribute('style')) wrap.setAttribute('style', sel.getAttribute('style'));
    sel.classList.forEach((c) => wrap.classList.add(`fs--${c}`));

    const trig = document.createElement('button');
    trig.type = 'button';
    trig.className = 'fs-trigger';
    trig.setAttribute('aria-haspopup', 'listbox');
    trig.setAttribute('aria-expanded', 'false');
    const lbl = labelFor(sel);
    if (lbl) trig.setAttribute('aria-label', lbl);
    trig.innerHTML = '<span class="fs-value"></span><svg class="fs-chev" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    sel.replaceWith(wrap);
    sel._fsWrap = wrap;
    sel.classList.add('fs-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    wrap.append(trig, sel);

    // Programmatic .value / .selectedIndex writes don't fire events. Catch them.
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); syncTrigger(this); },
    });
    Object.defineProperty(sel, 'selectedIndex', {
      configurable: true,
      get() { return indexDesc.get.call(this); },
      set(v) { indexDesc.set.call(this, v); syncTrigger(this); },
    });
    sel.addEventListener('change', () => syncTrigger(sel));
    new MutationObserver(() => syncTrigger(sel))
      .observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'title', 'selected'] });

    trig.addEventListener('click', () => (openState && openState.sel === sel ? close() : open(sel)));
    trig.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(sel); }
    });

    syncTrigger(sel);
  }

  /* ---------- Menu ---------- */

  function open(sel) {
    if (sel.disabled) return;
    close();
    const wrap = sel._fsWrap;
    const menu = document.createElement('div');
    menu.className = 'fs-menu';
    const useSearch = sel.options.length > SEARCH_THRESHOLD;
    menu.innerHTML = `
      ${useSearch ? '<div class="fs-search-wrap"><input class="fs-search" type="search" placeholder="Search…" autocomplete="off" /></div>' : ''}
      <div class="fs-list" role="listbox"></div>`;
    document.body.appendChild(menu);
    openState = { sel, wrap, menu, list: menu.querySelector('.fs-list'), search: menu.querySelector('.fs-search'), items: [], active: -1, typed: '', typedAt: 0 };
    wrap.classList.add('open');
    wrap.querySelector('.fs-trigger').setAttribute('aria-expanded', 'true');
    renderList();
    position();
    requestAnimationFrame(() => menu.classList.add('in'));

    if (openState.search) {
      openState.search.addEventListener('input', renderList);
      openState.search.addEventListener('keydown', onMenuKey);
      openState.search.focus({ preventScroll: true });
    } else {
      openState.list.tabIndex = -1;
      openState.list.addEventListener('keydown', onMenuKey);
      openState.list.focus({ preventScroll: true });
    }
    // Keep focus where it is when clicking options; the search box still takes focus normally.
    menu.addEventListener('mousedown', (e) => { if (!e.target.closest('.fs-search')) e.preventDefault(); });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.fs-opt');
      if (item && !item.classList.contains('disabled')) choose(Number(item.dataset.idx));
    });
    menu.addEventListener('mousemove', (e) => {
      const item = e.target.closest('.fs-opt');
      if (item) setActive(openState.items.indexOf(item), false);
    });
  }

  function renderList() {
    const st = openState;
    if (!st) return;
    const q = (st.search?.value || '').trim().toLowerCase();
    const sel = st.sel;
    let html = '';
    let lastGroup = null;
    [...sel.options].forEach((opt, idx) => {
      if (opt.hidden) return;
      const hay = `${opt.textContent} ${opt.dataset.sub || ''}`.toLowerCase();
      if (q && !hay.includes(q)) return;
      const group = opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement.label : null;
      if (group !== lastGroup && group) html += `<div class="fs-group">${esc(group)}</div>`;
      lastGroup = group;
      const selected = idx === sel.selectedIndex;
      const disabled = opt.disabled || opt.parentElement.disabled;
      html += `<div class="fs-opt ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''} ${opt.value === '' ? 'placeholder' : ''}"
        role="option" aria-selected="${selected}" data-idx="${idx}">${optionInner(opt)}<svg class="fs-check" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5l3.5 3.5L11 1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
    });
    st.list.innerHTML = html || '<div class="fs-empty">No matches</div>';
    st.items = [...st.list.querySelectorAll('.fs-opt')];
    const selIdx = st.items.findIndex((el) => el.classList.contains('selected'));
    setActive(q ? st.items.findIndex((el) => !el.classList.contains('disabled')) : selIdx, true);
  }

  function setActive(i, scroll) {
    const st = openState;
    if (!st) return;
    st.items.forEach((el) => el.classList.remove('active'));
    st.active = i;
    const el = st.items[i];
    if (!el) return;
    el.classList.add('active');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    const st = openState;
    let i = st.active;
    for (let n = 0; n < st.items.length; n++) {
      i = Math.min(st.items.length - 1, Math.max(0, i + delta));
      if (!st.items[i].classList.contains('disabled')) break;
    }
    setActive(i, true);
  }

  function onMenuKey(e) {
    const st = openState;
    if (!st) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0, true); }
    else if (e.key === 'End') { e.preventDefault(); setActive(st.items.length - 1, true); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const el = st.items[st.active];
      if (el && !el.classList.contains('disabled')) choose(Number(el.dataset.idx));
    } else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') { close(); }
    else if (!st.search && e.key.length === 1) {
      // Type-ahead: jump to the first option starting with the typed letters.
      const now = Date.now();
      st.typed = (now - st.typedAt < 700 ? st.typed : '') + e.key.toLowerCase();
      st.typedAt = now;
      const i = st.items.findIndex((el) => el.querySelector('.fs-text').textContent.toLowerCase().startsWith(st.typed));
      if (i >= 0) setActive(i, true);
    }
  }

  function choose(idx) {
    const sel = openState.sel;
    const changed = sel.selectedIndex !== idx;
    sel.selectedIndex = idx;
    close(true);
    if (changed) {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function position() {
    const st = openState;
    if (!st) return;
    const r = st.wrap.querySelector('.fs-trigger').getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    // Keep the menu above the fixed bottom nav when it's showing.
    const nav = document.querySelector('.bottom-nav');
    const navTop = nav ? nav.getBoundingClientRect().top : window.innerHeight;
    const vh = Math.min(window.innerHeight, navTop);
    const width = Math.min(Math.max(r.width, 220), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    const maxH = Math.max(160, Math.min(360, up ? above : below));
    Object.assign(st.menu.style, { left: `${left}px`, width: `${width}px`, maxHeight: `${maxH}px` });
    if (up) { st.menu.style.top = ''; st.menu.style.bottom = `${window.innerHeight - r.top + 6}px`; }
    else { st.menu.style.bottom = ''; st.menu.style.top = `${r.bottom + 6}px`; }
    st.menu.classList.toggle('up', up);
  }

  function close(refocus) {
    const st = openState;
    if (!st) return;
    openState = null;
    st.menu.remove();
    st.wrap.classList.remove('open');
    const trig = st.wrap.querySelector('.fs-trigger');
    trig.setAttribute('aria-expanded', 'false');
    if (refocus) trig.focus({ preventScroll: true });
  }

  document.addEventListener('mousedown', (e) => {
    if (openState && !openState.menu.contains(e.target) && !openState.wrap.contains(e.target)) close();
  }, true);
  document.addEventListener('touchstart', (e) => {
    if (openState && !openState.menu.contains(e.target) && !openState.wrap.contains(e.target)) close();
  }, { capture: true, passive: true });
  // Repositions rather than closes: the phone keyboard opening for search fires resize.
  window.addEventListener('resize', () => position());
  // Page scroll would detach the menu from its trigger; scrolling inside the menu is fine.
  window.addEventListener('scroll', (e) => {
    if (openState && !openState.menu.contains(e.target)) position();
  }, true);

  /* ---------- Auto-enhance ---------- */

  function enhanceAll(root) {
    if (root.tagName === 'SELECT') enhance(root);
    else root.querySelectorAll?.('select').forEach(enhance);
  }

  function start() {
    enhanceAll(document.body);
    new MutationObserver((muts) => {
      muts.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) enhanceAll(n); }));
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.enhanceSelect = enhance;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
