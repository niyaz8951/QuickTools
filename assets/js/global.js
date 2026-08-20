/* Thinkneering (static build) — global.js
   Injects the shared header and footer and exposes the TN.* helpers the tools
   use. This is the static-hosting build: there is no account system, no API
   and no server, so everything the original global.js did over fetch has been
   removed rather than stubbed. What remains is chrome, icons and utilities.

   Paths are worked out from this script's own URL, so the site runs correctly
   whether it is served from a domain root (user.github.io) or from a project
   subfolder (user.github.io/repo/). Nothing here assumes it lives at "/". */
(function () {
  'use strict';

  /* Base URL of the site root, derived from .../assets/js/global.js. */
  var BASE = (function () {
    var s = document.currentScript;
    var src = s && s.src ? s.src : '';
    var i = src.indexOf('assets/js/global.js');
    if (i >= 0) return src.slice(0, i);
    /* Fallback for browsers without currentScript in this position. */
    var tags = document.getElementsByTagName('script');
    for (var k = 0; k < tags.length; k++) {
      var j = (tags[k].src || '').indexOf('assets/js/global.js');
      if (j >= 0) return tags[k].src.slice(0, j);
    }
    return './';
  })();

  // ---------------------------------------------------------- icons
  // Line icons, currentColor, 1.75px stroke. Only the keys this build uses.
  var P = {
    'file-check': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 15l2 2 4-4"/>',
    container: '<rect x="2" y="7" width="20" height="10" rx="1"/><path d="M7 7v10M12 7v10M17 7v10"/>',
    layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
    type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>'
  };

  function icon(name, size) {
    var d = P[name] || P.square;
    return '<svg viewBox="0 0 24 24" width="' + (size || 24) + '" height="' + (size || 24) +
      '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }

  // ------------------------------------------------------- utilities
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(sel, root) { return (root || document).querySelector(sel); }
  function els(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function toast(message, kind) {
    var region = el('#toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' toast--' + kind : '');
    t.textContent = message;
    region.appendChild(t);
    setTimeout(function () { t.remove(); }, 4500);
  }

  // ---------------------------------------------------------- chrome
  /* The nav is a fixed list because this build has a handful of tools and no
     catalogue to fetch. Adding a tool means adding one line here and one tile
     on the home page. */
  var NAV = [
    { href: 'tools/compliance-maker/', title: 'Compliance Maker' },
    { href: 'tools/container-calculator/', title: 'Container Calculator' },
    { href: 'tools/parts-extractor/', title: 'Parts List Extractor' },
    { href: 'tools/text-cleaner/', title: 'Text Cleaner' }
  ];

  function headerHTML() {
    var here = location.pathname.replace(/index\.html$/, '');
    var links = NAV.map(function (n) {
      var current = here.indexOf(n.href) >= 0 ? ' aria-current="page"' : '';
      return '<a href="' + esc(BASE + n.href) + '"' + current + '>' + esc(n.title) + '</a>';
    }).join('');
    return '<div class="site-header__inner">' +
      '<a class="brand" href="' + esc(BASE) + '"><span class="brand__mark">' + icon('layers', 16) + '</span>Thinkneering</a>' +
      '<nav class="site-nav" aria-label="Tools">' + links + '</nav>' +
      '<div class="header-actions">' +
      '<button class="btn btn--quiet btn--sm" data-theme-toggle aria-label="Switch colour theme">' +
      icon('moon', 18) + '</button></div></div>';
  }

  function footerHTML() {
    return '<div class="site-footer__inner">' +
      '<div>Thinkneering — tools that shorten office work.</div>' +
      '<nav aria-label="Footer">' +
      '<a href="' + esc(BASE) + '">Home</a>' +
      NAV.map(function (n) {
        return '<a href="' + esc(BASE + n.href) + '">' + esc(n.title) + '</a>';
      }).join('') +
      '</nav></div>';
  }

  function applyTheme(mode) {
    if (mode) document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem('tn-theme', mode); } catch (e) {}
  }

  function initTheme() {
    var saved;
    try { saved = localStorage.getItem('tn-theme'); } catch (e) {}
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  }

  function mountChrome() {
    var header = el('[data-site-header]');
    var footer = el('[data-site-footer]');
    if (header) {
      header.className = 'site-header';
      header.innerHTML = headerHTML();
    }
    if (footer) {
      footer.className = 'site-footer';
      footer.innerHTML = footerHTML();
    }
    var toggle = el('[data-theme-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var now = document.documentElement.getAttribute('data-theme');
        applyTheme(now === 'dark' ? 'light' : 'dark');
      });
    }
    document.dispatchEvent(new CustomEvent('tn:ready', { detail: {} }));
  }

  window.TN = {
    base: BASE, icon: icon, esc: esc, el: el, els: els, toast: toast
  };

  initTheme();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountChrome);
  } else {
    mountChrome();
  }
})();
