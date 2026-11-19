// ==UserScript==
// @name         Seafile Excalidraw Teacher Tools
// @namespace    https://github.com/berlinstold/seaf-excalidraw-teacher-tools
// @homepageURL  https://github.com/berlinstold/seaf-excalidraw-teacher-tools
// @license      MIT
// @version      2.4.0-dev
// @description  Timer-Overlay und Präsentationsmodus (Lehrenden-/Lernendenansicht) für Excalidraw-Whiteboards in Seafile
// @match        https://seafile.example.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Seafile Excalidraw Teacher Tools
// --------------------------------
// Leitfrage, Fragestellung und Hypothese:
//   - Bibliothekselemente bzw. Panel-Buttons fügen markierte Textfelder in die Tafel ein;
//     ihr Text erscheint dauerhaft oben links (auch in der Lernendenansicht), außer das
//     Element ist selbst vollständig sichtbar.
//
// Stundenuhr (nur Lehrende):
//   - Restzeit der Unterrichtsstunde klein in der Leiste, Einzel- oder Doppelstunde,
//     Beginn minutengenau einstellbar. Längen: LESSON_MINUTES / LESSON_BREAK_MINUTES unten.
//
// Timer:
//   - Button in der oberen Excalidraw-Leiste, verschiebbares Overlay (Countdown/Stoppuhr)
//   - Alt+Shift+T öffnet/schließt das Overlay
//
// Präsentation (zwei Tabs desselben Whiteboards im selben Browser):
//   - Lehrendenansicht: Steuerpanel mit "Tafel einfrieren/aufdecken", "Ansicht spiegeln",
//     "Ausschnitt übertragen" und Timer-Übertragung
//   - Lernendenansicht: reine Anzeige (z. B. auf dem Beamer), ohne Bedienelemente
//   - Die Tabs sprechen direkt über BroadcastChannel miteinander, ohne Server.
//   - Alt+Shift+P Panel, Alt+Shift+F Einfrieren/Aufdecken, Alt+Shift+M Spiegeln an/aus
//
// Das Skript wird nur aktiv, wenn auf der Seite ein Excalidraw-Editor (".excalidraw") vorhanden ist.

(function () {
  'use strict';

  if (window.__sfExcalidrawTimerLoaded) return;
  window.__sfExcalidrawTimerLoaded = true;

  // ===========================================================================
  // Konfiguration
  // ===========================================================================
  var TIMER_STORAGE_KEY = 'sf-excalidraw-timer:v1';
  var PRES_POS_KEY = 'sf-excalidraw-pres-pos:v1';
  var PRESETS_MIN = [1, 3, 5, 10, 15, 25, 45];
  var SIZES = ['s', 'm', 'l', 'xl'];
  var TIMER_BTN_ID = 'sf-ex-timer-btn';
  var PRES_BTN_ID = 'sf-ex-pres-btn';
  var FLOAT_ID = 'sf-ex-float';
  var DIVIDER_CLASS = 'sf-ex-timer-divider';
  var FLOATING_FALLBACK_DELAY = 2500;
  var HEARTBEAT_MS = 1500;
  var PEER_TIMEOUT_MS = 4500;

  // Stundenuhr: Länge einer Unterrichtsstunde und Pause innerhalb einer Doppelstunde (Minuten).
  // Für eine ganze Schule hier einmal anpassen, z. B. 60 und 10.
  var LESSON_MINUTES = 45;
  var LESSON_BREAK_MINUTES = 5;
  var LESSON_WARN_MINUTES = 5;      // ab dieser Restzeit wird die Anzeige farbig
  var LESSON_AUTOHIDE_MINUTES = 30; // so lange nach Stundenende verschwindet die Anzeige von selbst
  var LESSON_BTN_ID = 'sf-ex-lesson-btn';

  var TOOLBAR_SELECTORS = [
    '.App-toolbar-content',
    '.App-toolbar .Stack_horizontal',
    '.App-menu_top .shapes-section .Stack_horizontal',
    '.layer-ui__wrapper__top-right'
  ];

  // Dokument-Schlüssel: verbindet nur Tabs mit demselben Whiteboard
  var DOC_KEY = location.pathname + location.search;

  // ===========================================================================
  // Hilfsfunktionen
  // ===========================================================================
  function now() { return Date.now(); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function pad(n) { return String(n).padStart(2, '0'); }

  function fmt(ms, roundUp) {
    var total = roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
    total = Math.max(0, total);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  // "5" (Minuten), "2.5", "5:30", "1:00:00", "1h 30m", "90s", "10 min"
  function parseDuration(input) {
    var str = String(input || '').trim().toLowerCase().replace(',', '.');
    if (!str) return null;
    var m;
    if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 60);
    if ((m = str.match(/^(\d+):(\d{1,2})$/))) return (+m[1]) * 60 + (+m[2]);
    if ((m = str.match(/^(\d+):(\d{1,2}):(\d{1,2})$/))) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    m = str.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ek|ec)?)?$/);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return null;
  }

  function jsonGet(storage, key) {
    try { var raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function jsonSet(storage, key, val) {
    try { storage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignorieren */ }
  }
  function storageRemove(storage, key) {
    try { storage.removeItem(key); } catch (e) { /* ignorieren */ }
  }

  function getExcalidraw() { return document.querySelector('.excalidraw'); }

  function isDark() {
    var ex = getExcalidraw();
    return !!(ex && ex.classList.contains('theme--dark'));
  }

  // ---------------------------------------------------------------------------
  // Zugriff auf die interne Excalidraw-Komponente (ohne offizielle API).
  // Excalidraw ist eine React-Klasse; über das DOM-Element kommt man an ihre
  // Instanz mit "state" (scrollX, scrollY, zoom ...) und "updateScene()".
  // Bricht ggf. bei künftigen Excalidraw-Versionen -> dann liefert sie null.
  // ---------------------------------------------------------------------------
  var appCache = { ex: null, app: null };

  function getApp() {
    var ex = getExcalidraw();
    if (!ex) return null;
    if (appCache.ex === ex && appCache.app && appCache.app.state) return appCache.app;
    appCache.ex = ex;
    appCache.app = null;
    var key = Object.keys(ex).find(function (k) {
      return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
    });
    var f = key ? ex[key] : null;
    var n = 0;
    while (f && n++ < 300) {
      var s = f.stateNode;
      if (s && s.state && typeof s.state === 'object' && 'scrollX' in s.state &&
          (typeof s.updateScene === 'function' || typeof s.setState === 'function')) {
        appCache.app = s;
        break;
      }
      f = f.return;
    }
    return appCache.app;
  }

  function appSet(app, appState) {
    if (typeof app.updateScene === 'function') app.updateScene({ appState: appState });
    else app.setState(appState);
  }

  // ===========================================================================
  // Icons (Tabler-Stil wie Excalidraw)
  // ===========================================================================
  function svgIcon(paths, strokeWidth) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (strokeWidth || 1.5) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var ICON_PLAY = svgIcon('<path d="M7 4v16l13-8z"/>');
  var ICON_PAUSE = svgIcon('<path d="M6 5h4v14h-4z"/><path d="M14 5h4v14h-4z"/>');
  var ICON_GRIP = svgIcon('<path d="M9 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/><path d="M9 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/>' +
    '<path d="M9 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/><path d="M15 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/>' +
    '<path d="M15 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/><path d="M15 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/>');
  var ICON_TEXT_SIZE = svgIcon('<path d="M3 7v-2h13v2"/><path d="M10 5v14"/><path d="M12 19h-4"/><path d="M15 13v-1h6v1"/><path d="M18 12v7"/><path d="M17 19h2"/>');
  var ICON_VOLUME = svgIcon('<path d="M15 8a5 5 0 0 1 0 8"/><path d="M17.7 5a9 9 0 0 1 0 14"/>' +
    '<path d="M6 15h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1-1.5 .5l-3.5-4.5"/>');
  var ICON_VOLUME_OFF = svgIcon('<path d="M6 15h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1-1.5 .5l-3.5-4.5"/>' +
    '<path d="M16 10l4 4m0-4l-4 4"/>');
  var ICON_MINIMIZE = svgIcon('<path d="M5 9l4 0l0-4"/><path d="M3 3l6 6"/><path d="M5 15l4 0l0 4"/><path d="M3 21l6-6"/>' +
    '<path d="M19 9l-4 0l0-4"/><path d="M15 9l6-6"/><path d="M19 15l-4 0l0 4"/><path d="M15 15l6 6"/>');
  var ICON_MAXIMIZE = svgIcon('<path d="M16 4l4 0l0 4"/><path d="M14 10l6-6"/><path d="M8 20l-4 0l0-4"/><path d="M4 20l6-6"/>' +
    '<path d="M16 20l4 0l0-4"/><path d="M14 14l6 6"/><path d="M8 4l-4 0l0 4"/><path d="M4 4l6 6"/>');
  var ICON_CLOSE = svgIcon('<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>');
  var ICON_SNOW = svgIcon('<path d="M10 4l2 1l2-1"/><path d="M12 2v6.5l3 1.72"/><path d="M17.928 6.268l.134 2.232l1.866 1.232"/>' +
    '<path d="M20.66 7l-5.629 3.25l.01 3.458"/><path d="M19.928 14.268l-1.866 1.232l-.134 2.232"/><path d="M20.66 17l-5.629-3.25l-2.99 1.738"/>' +
    '<path d="M14 20l-2-1l-2 1"/><path d="M12 22v-6.5l-3-1.72"/><path d="M6.072 17.732l-.134-2.232l-1.866-1.232"/>' +
    '<path d="M3.34 17l5.629-3.25l-.01-3.458"/><path d="M4.072 9.732l1.866-1.232l.134-2.232"/><path d="M3.34 7l5.629 3.25l2.99-1.738"/>');
  var ICON_EYE = svgIcon('<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0-4 0"/><path d="M21 12c-2.4 4-5.4 6-9 6c-3.6 0-6.6-2-9-6c2.4-4 5.4-6 9-6c3.6 0 6.6 2 9 6"/>');
  var ICON_EYE_OFF = svgIcon('<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/>' +
    '<path d="M16.681 16.673a8.717 8.717 0 0 1-4.681 1.327c-3.6 0-6.6-2-9-6c1.272-2.12 2.712-3.678 4.32-4.674m2.86-1.146a9.055 9.055 0 0 1 1.82-.18c3.6 0 6.6 2 9 6c-.666 1.11-1.379 2.067-2.138 2.87"/>' +
    '<path d="M3 3l18 18"/>');
  var ICON_TAG = svgIcon('<path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/>' +
    '<path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592-5.592a2.41 2.41 0 0 0 0-3.408l-7.71-7.71a2 2 0 0 0-1.414-.586h-5.172a3 3 0 0 0-3 3z"/>');
  var ICON_SEND = svgIcon('<path d="M10 14l11-11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1-1 0l-3.5-7l-7-3.5a.55 .55 0 0 1 0-1l18-6.5"/>');

  // Toolbar-Icons (Linienstärke wird zur Laufzeit an die Original-Icons angeglichen)
  var ICON_TIMER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 13a7 7 0 1 0 14 0a7 7 0 0 0-14 0z"/><path d="M14.5 10.5l-2.5 2.5"/><path d="M17 8l1-1"/>' +
    '<path d="M14 3h-4"/></svg>';
  var ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0"/><path d="M12 7v5l3 2"/></svg>';
  var ICON_PRESENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 4l18 0"/><path d="M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-10"/><path d="M12 16l0 4"/>' +
    '<path d="M9 20l6 0"/><path d="M8 12l3-3l2 2l3-3"/></svg>';

  // ===========================================================================
  // Overlay-Hosts, Vollbild, Ereignis-Abschirmung
  // ===========================================================================
  var hosts = [];

  function overlayParent() { return document.fullscreenElement || document.body; }

  function mountHost(el) {
    if (hosts.indexOf(el) < 0) hosts.push(el);
    overlayParent().appendChild(el);
  }

  function unmountHost(el) {
    var i = hosts.indexOf(el);
    if (i >= 0) hosts.splice(i, 1);
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  document.addEventListener('fullscreenchange', function () {
    var p = overlayParent();
    hosts.forEach(function (h) { if (h.isConnected && h.parentNode !== p) p.appendChild(h); });
    setTimeout(function () { Pres.onResize(); Timer.render(); }, 120);
  });

  // Ereignisse aus Overlays nicht zu Excalidraw durchreichen (Kürzel, Einfügen, Zoom ...)
  function isolate(host) {
    ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'wheel', 'pointerdown',
     'mousedown', 'touchstart', 'contextmenu', 'dblclick', 'click'].forEach(function (type) {
      host.addEventListener(type, function (e) { e.stopPropagation(); });
    });
  }

  function createShadowHost(id, css, html, zIndex) {
    var host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:' + zIndex + ';display:none;';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + css + '</style>' + html;
    isolate(host);
    mountHost(host);
    return { host: host, root: root };
  }

  function placeHost(host, panel, pos, fallback) {
    var w = panel.offsetWidth || 240;
    var h = panel.offsetHeight || 160;
    if (pos.x == null || pos.y == null) {
      var d = fallback(w, h);
      pos.x = d.x; pos.y = d.y;
    }
    pos.x = clamp(pos.x, 0, Math.max(0, window.innerWidth - w));
    pos.y = clamp(pos.y, 0, Math.max(0, window.innerHeight - h));
    host.style.left = pos.x + 'px';
    host.style.top = pos.y + 'px';
  }

  // Verschieben per Zeiger; onClick(downTarget) wird bei Klick ohne Bewegung gerufen
  function makeDraggable(host, panel, pos, opts) {
    var drag = null;
    panel.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (opts.canDrag && !opts.canDrag()) return;
      if (e.target.closest('button, input, label, select, .nodrag')) return;
      var r = host.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top,
               sx: e.clientX, sy: e.clientY, moved: false, target: e.target };
      try { panel.setPointerCapture(e.pointerId); } catch (err) { /* ignorieren */ }
    });
    panel.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      if (!drag.moved) { drag.moved = true; panel.classList.add('dragging'); }
      pos.x = e.clientX - drag.dx;
      pos.y = e.clientY - drag.dy;
      opts.place();
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      try { panel.releasePointerCapture(e.pointerId); } catch (err) { /* ignorieren */ }
      panel.classList.remove('dragging');
      var d = drag;
      drag = null;
      if (d.moved) { if (opts.onMoved) opts.onMoved(); return; }
      if (opts.onClick) opts.onClick(d.target);
    }
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
  }

  // Gemeinsame Basis-Styles der Panels
  var BASE_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.panel{--bg:#fff;--fg:#1b1b1f;--muted:#70707b;--border:#e3e3ea;--btn:#f1f0ff;--btn-h:#e0dfff;--primary:#6965db;--primary-fg:#fff;--track:#ececf4;--warn:#e03131;--warn-bg:#fff0f0;--ok:#2f9e44;',
    '  font-family:Assistant,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:var(--fg);background:var(--bg);',
    '  border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:6px 10px 10px;',
    '  user-select:none;-webkit-user-select:none;touch-action:none;cursor:grab}',
    '.panel.dark{--bg:#232329;--fg:#e3e3e8;--muted:#a0a0ab;--border:#3a3a44;--btn:#31303b;--btn-h:#403e6a;--primary:#a8a5ff;--primary-fg:#121212;--track:#34343d;--warn:#ff8787;--warn-bg:#3b2326;--ok:#8ce99a}',
    '.panel.dragging{cursor:grabbing;box-shadow:0 12px 36px rgba(0,0,0,.28)}',
    '.head{display:flex;align-items:center;gap:4px;margin-bottom:2px}',
    '.grip{display:inline-flex;color:var(--muted);opacity:.7}',
    '.grip svg{width:14px;height:14px}',
    '.title{font-weight:700;font-size:13px;padding:0 2px}',
    '.spacer{flex:1}',
    '.icon{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:0}',
    '.icon:hover{background:var(--btn);color:var(--fg)}',
    '.icon svg{width:16px;height:16px}',
    '.btn{height:32px;border-radius:8px;border:0;background:var(--btn);color:var(--fg);font:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:0 10px;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px}',
    '.btn:hover{background:var(--btn-h)}',
    '.btn svg{width:16px;height:16px}',
    '.btn.primary{background:var(--primary);color:var(--primary-fg)}',
    '.btn.primary:hover{filter:brightness(1.08)}',
    '.btn:disabled{opacity:.45;cursor:not-allowed;filter:none}',
    'button:focus-visible{outline:2px solid var(--primary);outline-offset:1px}'
  ].join('\n');

  // ===========================================================================
  // Ton
  // ===========================================================================
  var audioCtx = null;

  function ensureAudio() {
    try {
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }

  function playAlarm() {
    ensureAudio();
    if (!audioCtx) return;
    var t0 = audioCtx.currentTime + 0.05;
    for (var r = 0; r < 3; r++) {
      for (var i = 0; i < 3; i++) {
        var t = t0 + r * 1.0 + i * 0.18;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.16);
      }
    }
  }

  var excalidrawActive = false;

  // ===========================================================================
  // TIMER
  // ===========================================================================
  var Timer = (function () {
    var defaults = {
      open: false, x: null, y: null, mode: 'countdown', duration: 300,
      remainingMs: 300000, endAt: null, elapsedMs: 0, startAt: null,
      running: false, compact: false, size: 'm', sound: true,
      title: '', titleEdit: false
    };
    var TITLE_PRESETS = ['Eigenarbeit endet in', 'Partnerarbeit endet in', 'Gruppenarbeit endet in'];
    var lastSize = { w: 240, h: 160 }; // zuletzt gemessene Panelgröße (auch wenn das Panel gerade geschlossen ist)
    var state = {};
    var alarmActive = false;
    var editing = false;
    var remote = false;      // true in der Lernendenansicht (nur Anzeige)
    var remotePos = null;    // relative Position {rx, ry} aus der Lehrendenansicht
    var ui = null;
    var tickTimer = null;

    function loadLocal() {
      state = Object.assign({}, defaults, jsonGet(localStorage, TIMER_STORAGE_KEY) || {});
      if (SIZES.indexOf(state.size) < 0) state.size = 'm';
      if (state.mode !== 'stopwatch') state.mode = 'countdown';
    }

    function save() {
      if (remote) return; // Lernendenansicht speichert nichts, Zustand kommt von der Lehrendenansicht
      jsonSet(localStorage, TIMER_STORAGE_KEY, state);
      Pres.onTimerChange();
    }

    function currentMs() {
      if (state.mode === 'countdown') return state.running ? Math.max(0, state.endAt - now()) : state.remainingMs;
      return state.running ? now() - state.startAt : state.elapsedMs;
    }

    // --- Logik ---------------------------------------------------------------
    function start() {
      ensureAudio();
      alarmActive = false;
      if (state.mode === 'countdown') {
        if (state.remainingMs <= 0) state.remainingMs = state.duration * 1000;
        state.endAt = now() + state.remainingMs;
      } else {
        state.startAt = now() - state.elapsedMs;
      }
      state.running = true;
      save(); startTicking(); render();
    }

    function pause() {
      if (!state.running) return;
      if (state.mode === 'countdown') state.remainingMs = Math.max(0, state.endAt - now());
      else state.elapsedMs = now() - state.startAt;
      state.running = false; state.endAt = null; state.startAt = null;
      save(); render();
    }

    function reset() {
      state.running = false; state.endAt = null; state.startAt = null;
      if (state.mode === 'countdown') state.remainingMs = state.duration * 1000;
      else state.elapsedMs = 0;
      alarmActive = false;
      save(); render();
    }

    function setDuration(sec) {
      state.duration = clamp(Math.round(sec), 1, 100 * 3600 - 1);
      state.mode = 'countdown';
      reset();
    }

    function addTime(sec) {
      if (state.mode !== 'countdown') return;
      alarmActive = false;
      if (state.running) state.endAt += sec * 1000;
      else state.remainingMs = Math.max(0, state.remainingMs + sec * 1000);
      if (!state.running && state.remainingMs > state.duration * 1000) state.duration = Math.ceil(state.remainingMs / 1000);
      save(); render();
    }

    function setMode(mode) {
      if (state.mode === mode) return;
      pause();
      alarmActive = false;
      state.mode = mode;
      save(); render();
    }

    function finish(lateMs) {
      state.running = false; state.endAt = null; state.remainingMs = 0;
      alarmActive = true;
      if (!state.open) state.open = true;
      save(); startTicking(); render();
      if (!remote && state.sound && lateMs < 15000) playAlarm();
    }

    function startTicking() { if (!tickTimer) tickTimer = setInterval(tick, 250); }

    function tick() {
      if (state.mode === 'countdown' && state.running && now() >= state.endAt) finish(now() - state.endAt);
      render();
      if (!state.running && !alarmActive) { clearInterval(tickTimer); tickTimer = null; }
    }

    function setOpen(open) {
      if (remote) return;
      state.open = open;
      if (!open) alarmActive = false;
      if (open) Pres.onTimerOpened();
      save(); render();
    }

    // --- Austausch mit der Lernendenansicht ------------------------------------
    function snapshot() {
      // Gemerkte Größe verwenden: bei geschlossenem Panel liefert offsetWidth 0,
      // was die relative Position verfälschen würde.
      var w = lastSize.w, h = lastSize.h;
      return {
        title: state.title || '',
        open: state.open, mode: state.mode, duration: state.duration, remainingMs: state.remainingMs,
        endAt: state.endAt, elapsedMs: state.elapsedMs, startAt: state.startAt, running: state.running,
        compact: state.compact, size: state.size, alarm: alarmActive,
        rx: state.x == null ? 1 : state.x / Math.max(1, window.innerWidth - w),
        ry: state.y == null ? 0.1 : state.y / Math.max(1, window.innerHeight - h)
      };
    }

    function applyRemote(t) {
      if (!remote || !t) return;
      ['open', 'mode', 'duration', 'remainingMs', 'endAt', 'elapsedMs', 'startAt', 'running', 'compact', 'size', 'title'].forEach(function (k) {
        if (k in t) state[k] = t[k];
      });
      alarmActive = !!t.alarm;
      if (typeof t.rx === 'number') remotePos = { rx: clamp(t.rx, 0, 1), ry: clamp(t.ry, 0, 1) };
      if (state.running || alarmActive) startTicking();
      render();
    }

    function setRemote(on) {
      if (remote === on) return;
      remote = on;
      editing = false;
      alarmActive = false;
      if (on) { state = Object.assign({}, defaults, { open: false, sound: false }); }
      else { loadLocal(); remotePos = null; }
      render();
    }

    // --- Overlay ---------------------------------------------------------------
    var CSS = BASE_CSS + '\n' + [
      '.panel{min-width:236px;max-width:min(92vw,960px)}',
      '.ttl{text-align:center;font-weight:600;color:var(--muted);font-size:max(12px,calc(var(--fs) * .3));line-height:1.2;margin-top:4px;overflow-wrap:anywhere}',
      '.panel.remote .ttl{color:var(--fg);margin-top:0}',
      '.titlerow{display:none;margin:4px 0 2px}',
      '.panel.tedit .titlerow{display:block}',
      '.tin-wrap{display:flex;gap:4px}',
      '.tin{flex:1;min-width:0;width:100%;height:28px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;font-size:12px;padding:0 8px;outline:none;user-select:text;-webkit-user-select:text}',
      '.tin:focus{border-color:var(--primary)}',
      '.tchips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}',
      '.panel.compact .titlerow{display:none}',
      '.icon.on{color:var(--primary)}',
      '.lernonly{display:none}',
      '.panel.lehrende .lernonly{display:inline-flex}',
      '.tabs{display:flex;background:var(--track);border-radius:8px;padding:2px;gap:2px}',
      '.tab{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;font-weight:600;padding:4px 8px;border-radius:6px;cursor:pointer}',
      '.tab.on{background:var(--bg);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '.mini{display:none}',
      '.display{text-align:center;font-variant-numeric:tabular-nums;font-weight:700;line-height:1.1;padding:4px 0 2px;white-space:nowrap}',
      '.panel[data-mode=countdown]:not(.running):not(.compact):not(.remote) .display{cursor:text}',
      '.panel[data-size=s]{--fs:28px}.panel[data-size=m]{--fs:46px}.panel[data-size=l]{--fs:76px}.panel[data-size=xl]{--fs:120px}',
      '.time{font-size:var(--fs);letter-spacing:.5px}',
      '.edit{font:inherit;font-size:var(--fs);font-weight:700;width:100%;min-width:0;text-align:center;border:2px solid var(--primary);border-radius:8px;background:var(--bg);color:var(--fg);padding:0 4px;outline:none;user-select:text;-webkit-user-select:text}',
      '.progress{height:4px;background:var(--track);border-radius:2px;overflow:hidden;margin:4px 0 8px}',
      '.bar{height:100%;width:100%;background:var(--primary);transition:width .25s linear}',
      '.presets{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}',
      '.chip{flex:1 0 auto;border:1px solid var(--border);background:transparent;color:var(--fg);font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;cursor:pointer}',
      '.chip:hover{background:var(--btn)}',
      '.chip.on{border-color:var(--primary);color:var(--primary)}',
      '.controls{display:flex;gap:6px}',
      '.controls .btn{flex:1;padding:0 8px}',
      '.controls .btn.primary{flex:1.4}',
      '.panel[data-mode=stopwatch] .progress,.panel[data-mode=stopwatch] .presets,.panel[data-mode=stopwatch] [data-act=plus]{display:none}',
      '.hint{display:none;font-size:11px;color:var(--muted);text-align:center;margin-top:6px}',
      '.panel.done .hint{display:block}',
      '.panel.compact{min-width:0;padding:4px 6px 6px 8px}',
      '.panel.compact .tabs,.panel.compact .presets,.panel.compact .progress,.panel.compact .controls,.panel.compact [data-act=size]{display:none}',
      '.panel.compact .mini{display:inline-flex}',
      '.panel.compact .display{padding:0 4px}',
      // Lernendenansicht: nur Anzeige
      '.panel.remote{min-width:0;padding:8px 14px;cursor:default}',
      '.panel.remote .head,.panel.remote .presets,.panel.remote .controls,.panel.remote .hint{display:none}',
      '.panel.remote .progress{margin:6px 0 2px}',
      '.panel.remote.compact .progress{display:none}',
      '.panel.done{animation:sfexflash 1s infinite}',
      '.panel.done .time{color:#e03131}',
      '@keyframes sfexflash{0%,100%{background:var(--bg)}50%{background:#ffc9c9}}'
    ].join('\n');

    function html() {
      var chips = PRESETS_MIN.map(function (m) {
        return '<button class="chip" data-act="preset" data-min="' + m + '">' + m + '′</button>';
      }).join('');
      return '' +
        '<div class="panel" role="dialog" aria-label="Timer">' +
        '  <div class="head">' +
        '    <span class="grip" title="Ziehen zum Verschieben">' + ICON_GRIP + '</span>' +
        '    <div class="tabs">' +
        '      <button class="tab" data-act="mode" data-mode="countdown">Countdown</button>' +
        '      <button class="tab" data-act="mode" data-mode="stopwatch">Stoppuhr</button>' +
        '    </div>' +
        '    <span class="spacer"></span>' +
        '    <button class="icon mini" data-act="toggle"></button>' +
        '    <button class="icon" data-act="titleedit" title="Titel für den Timer">' + ICON_TAG + '</button>' +
        '    <button class="icon lernonly" data-act="lern"></button>' +
        '    <button class="icon" data-act="size" title="Schriftgröße">' + ICON_TEXT_SIZE + '</button>' +
        '    <button class="icon" data-act="sound"></button>' +
        '    <button class="icon" data-act="compact"></button>' +
        '    <button class="icon" data-act="close" title="Schließen (Alt+Shift+T)">' + ICON_CLOSE + '</button>' +
        '  </div>' +
        '  <div class="titlerow">' +
        '    <div class="tin-wrap"><input class="tin" type="text" size="1" maxlength="80" placeholder="Titel für Lernende (optional)" autocomplete="off" spellcheck="false">' +
        '      <button class="icon" data-act="ttlclear" title="Titel entfernen">' + ICON_CLOSE + '</button></div>' +
        '    <div class="tchips">' + TITLE_PRESETS.map(function (t) { return '<button class="chip" data-act="ttlpreset" data-t="' + t + '">' + t.split(' ')[0] + '</button>'; }).join('') + '</div>' +
        '  </div>' +
        '  <div class="ttl" hidden></div>' +
        '  <div class="display" title="Klicken zum Bearbeiten (z. B. 5, 2:30, 1h 15m)">' +
        '    <span class="time">00:00</span>' +
        '    <input class="edit" type="text" size="1" inputmode="numeric" autocomplete="off" spellcheck="false" hidden>' +
        '  </div>' +
        '  <div class="progress"><div class="bar"></div></div>' +
        '  <div class="presets">' + chips + '</div>' +
        '  <div class="controls">' +
        '    <button class="btn primary" data-act="toggle">Start</button>' +
        '    <button class="btn" data-act="reset">Reset</button>' +
        '    <button class="btn" data-act="plus">+1 min</button>' +
        '  </div>' +
        '  <div class="hint">Zeit abgelaufen – klicken zum Bestätigen</div>' +
        '</div>';
    }

    function ensureUI() {
      if (ui && ui.host.isConnected) return;
      var s = createShadowHost('sf-ex-timer-overlay', CSS, html(), 2147483000);
      var root = s.root;
      ui = {
        host: s.host, root: root,
        panel: root.querySelector('.panel'),
        time: root.querySelector('.time'),
        input: root.querySelector('.edit'),
        bar: root.querySelector('.bar'),
        mainToggle: root.querySelector('.btn[data-act=toggle]'),
        miniToggle: root.querySelector('.mini[data-act=toggle]'),
        tabs: root.querySelectorAll('.tab'),
        chips: root.querySelectorAll('.chip'),
        sound: root.querySelector('[data-act=sound]'),
        compact: root.querySelector('[data-act=compact]'),
        lern: root.querySelector('[data-act=lern]'),
        titleEdit: root.querySelector('[data-act=titleedit]'),
        tin: root.querySelector('.tin'),
        ttl: root.querySelector('.ttl'),
        tchips: root.querySelectorAll('[data-act=ttlpreset]')
      };
      ui.tin.addEventListener('input', function () { state.title = ui.tin.value.slice(0, 80); save(); render(); });
      ui.tin.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); ui.tin.blur(); } });
      root.addEventListener('click', onClick);
      var posProxy = {
        get x() { return state.x; }, set x(v) { state.x = v; },
        get y() { return state.y; }, set y(v) { state.y = v; }
      };
      makeDraggable(ui.host, ui.panel, posProxy, {
        canDrag: function () { return !remote; },
        place: place,
        onMoved: save,
        onClick: function (target) {
          if (alarmActive) { alarmActive = false; save(); render(); return; }
          if (target.closest('.display') && state.mode === 'countdown' && !state.running && !state.compact) beginEdit();
        }
      });
      ui.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
      });
      ui.input.addEventListener('blur', function () { if (editing) commitEdit(); });
    }

    function onClick(e) {
      if (remote) return;
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      switch (btn.getAttribute('data-act')) {
        case 'toggle': state.running ? pause() : start(); break;
        case 'reset': reset(); break;
        case 'plus': addTime(60); break;
        case 'preset': setDuration(+btn.getAttribute('data-min') * 60); break;
        case 'mode': setMode(btn.getAttribute('data-mode')); break;
        case 'size': state.size = SIZES[(SIZES.indexOf(state.size) + 1) % SIZES.length]; save(); render(); break;
        case 'sound': state.sound = !state.sound; save(); render(); break;
        case 'compact': state.compact = !state.compact; save(); render(); break;
        case 'close': setOpen(false); break;
        case 'titleedit': state.titleEdit = !state.titleEdit; save(); render(); if (state.titleEdit) ui.tin.focus(); break;
        case 'ttlpreset': state.title = btn.getAttribute('data-t'); save(); render(); break;
        case 'ttlclear': state.title = ''; save(); render(); break;
        case 'lern': Pres.setLernTimer(!Pres.lernTimer()); break;
      }
    }

    function place() {
      if (!ui) return;
      if (remote && remotePos) {
        var w = ui.panel.offsetWidth || 240, h = ui.panel.offsetHeight || 160;
        state.x = remotePos.rx * Math.max(0, window.innerWidth - w);
        state.y = remotePos.ry * Math.max(0, window.innerHeight - h);
      }
      placeHost(ui.host, ui.panel, state, function (w) { return { x: window.innerWidth - w - 24, y: 72 }; });
      if (!remote && ui.panel.offsetWidth > 0) lastSize = { w: ui.panel.offsetWidth, h: ui.panel.offsetHeight };
    }

    function beginEdit() {
      editing = true;
      // Breite einfrieren: ein <input> hätte sonst ~20 Zeichen Mindestbreite in großer Schrift
      ui.panel.style.width = (ui.panel.offsetWidth + 16) + 'px';
      ui.input.value = fmt(state.remainingMs > 0 ? state.remainingMs : state.duration * 1000, true);
      ui.time.hidden = true;
      ui.input.hidden = false;
      ui.input.focus();
      ui.input.select();
    }

    function commitEdit() {
      var sec = parseDuration(ui.input.value);
      endEdit();
      if (sec && sec > 0) setDuration(sec);
    }

    function endEdit() {
      editing = false;
      ui.panel.style.width = '';
      ui.input.hidden = true;
      ui.time.hidden = false;
      render();
    }

    function setIcon(el, svg, title) {
      if (el.__icon !== svg) { el.innerHTML = svg; el.__icon = svg; }
      if (title && el.title !== title) el.title = title;
    }

    function render() {
      Buttons.update();
      if (!state.open || !excalidrawActive) {
        if (ui) ui.host.style.display = 'none';
        return;
      }
      ensureUI();
      ui.host.style.display = '';
      ui.host.style.pointerEvents = remote ? 'none' : '';

      var p = ui.panel;
      var ms = currentMs();
      p.setAttribute('data-mode', state.mode);
      p.setAttribute('data-size', state.size);
      p.classList.toggle('compact', !!state.compact);
      p.classList.toggle('running', !!state.running);
      p.classList.toggle('done', alarmActive);
      p.classList.toggle('remote', remote);
      p.classList.toggle('dark', isDark());

      if (!editing) {
        var txt = fmt(ms, state.mode === 'countdown');
        if (ui.time.textContent !== txt) ui.time.textContent = txt;
      }
      var partial = state.mode === 'countdown' ? (ms > 0 && ms < state.duration * 1000) : ms > 0;
      ui.mainToggle.textContent = state.running ? 'Pause' : (partial ? 'Weiter' : 'Start');
      if (state.mode === 'countdown') {
        var pct = state.duration > 0 ? clamp(ms / (state.duration * 1000), 0, 1) * 100 : 0;
        ui.bar.style.width = pct.toFixed(2) + '%';
      }
      Array.prototype.forEach.call(ui.tabs, function (t) { t.classList.toggle('on', t.getAttribute('data-mode') === state.mode); });
      Array.prototype.forEach.call(ui.chips, function (c) { c.classList.toggle('on', +c.getAttribute('data-min') * 60 === state.duration); });
      setIcon(ui.sound, state.sound ? ICON_VOLUME : ICON_VOLUME_OFF, state.sound ? 'Ton aus' : 'Ton an');
      setIcon(ui.compact, state.compact ? ICON_MAXIMIZE : ICON_MINIMIZE, state.compact ? 'Erweiterte Ansicht' : 'Kompaktansicht');
      setIcon(ui.miniToggle, state.running ? ICON_PAUSE : ICON_PLAY, state.running ? 'Pause' : 'Start');

      // Titel
      var title = (state.title || '').trim();
      ui.ttl.hidden = !title;
      if (ui.ttl.textContent !== title) ui.ttl.textContent = title;
      p.classList.toggle('tedit', !!state.titleEdit && !remote);
      ui.titleEdit.classList.toggle('on', !!state.titleEdit || !!title);
      if (ui.root.activeElement !== ui.tin && ui.tin.value !== (state.title || '')) ui.tin.value = state.title || '';
      Array.prototype.forEach.call(ui.tchips, function (c) { c.classList.toggle('on', c.getAttribute('data-t') === state.title); });

      // Anzeige für Lernende (nur in der Lehrendenansicht)
      var isLehr = !remote && Pres.role() === 'lehrende';
      p.classList.toggle('lehrende', isLehr);
      if (isLehr) {
        var lv = Pres.lernTimer();
        setIcon(ui.lern, lv ? ICON_EYE : ICON_EYE_OFF, lv ? 'Für Lernende sichtbar – klicken zum Ausblenden' : 'Für Lernende ausgeblendet – klicken zum Einblenden');
        ui.lern.classList.toggle('on', lv);
      }
      place();
    }

    function init() {
      loadLocal();
      if (state.running || (state.mode === 'countdown' && state.endAt)) startTicking();
    }

    return {
      init: init, render: render, setRemote: setRemote, applyRemote: applyRemote, snapshot: snapshot,
      toggleOpen: function () { setOpen(!state.open); },
      isOpen: function () { return !!state.open; },
      isBusy: function () { return !!state.running || alarmActive; },
      label: function () { return state.running ? fmt(currentMs(), state.mode === 'countdown') : ''; },
      // Restzeit neben dem Leisten-Symbol, solange das Overlay geschlossen ist
      closedLabel: function () {
        if (remote || state.open) return null;
        var ms = currentMs();
        var cd = state.mode === 'countdown';
        if (alarmActive) return { text: '00:00', cls: 'alarm' };
        if (state.running) return { text: fmt(ms, cd), cls: '' };
        var partial = cd ? (ms > 0 && ms < state.duration * 1000) : ms > 0;
        return partial ? { text: fmt(ms, cd), cls: 'paused' } : null;
      },
      onResize: function () { if (ui && state.open) { place(); save(); } }
    };
  })();

  // ===========================================================================
  // PRÄSENTATION (Lehrenden- und Lernendenansicht)
  // ===========================================================================
  var Pres = (function () {
    var ROLE_KEY = 'sf-ex-pres-role:' + DOC_KEY;
    var STATE_KEY = 'sf-ex-pres-state:' + DOC_KEY;
    var tabId = Math.random().toString(36).slice(2, 10);

    var role = (function () { try { return sessionStorage.getItem(ROLE_KEY); } catch (e) { return null; } })();
    if (role !== 'lehrende' && role !== 'lernende') role = null;

    // Einstellungen der Lehrendenansicht (pro Tab)
    // lernTimer: Timer in der Lernendenansicht zeigen (unabhängig davon, ob er hier geöffnet ist)
    var cfg = Object.assign({ frozen: false, mirror: false, fade: true, lernTimer: false },
                            jsonGet(sessionStorage, STATE_KEY) || {});
    delete cfg.syncTimer;
    // Einstellungen der Lernendenansicht (pro Tab)
    var lern = Object.assign({ hideUi: true, badgeHidden: false, hideCursor: true }, jsonGet(sessionStorage, STATE_KEY + ':lern') || {});

    var panelOpen = false;
    var panelPos = Object.assign({ x: null, y: null }, jsonGet(localStorage, PRES_POS_KEY) || {});
    var channel = null;
    var peers = {};          // Lehrendenansicht: verbundene Lernendenansichten
    var teacherSeen = 0;     // Lernendenansicht: letzter Kontakt zur Lehrendenansicht
    var gotFirstSync = false;
    var heartbeat = null;
    var lastView = null;
    var lastSent = { key: '', t: 0 };
    var mirrorLoop = null;
    var frozenLocal = false; // Lernendenansicht: Abdeckung aktiv
    var cover = null;
    var appliedViewMode = null;

    function saveCfg() { jsonSet(sessionStorage, STATE_KEY, cfg); }
    function saveLern() { jsonSet(sessionStorage, STATE_KEY + ':lern', lern); }

    // --- Kanal ---------------------------------------------------------------
    function post(msg) {
      if (!channel) return;
      msg.from = tabId;
      msg.role = role;
      try { channel.postMessage(msg); } catch (e) { /* ignorieren */ }
    }

    function openChannel() {
      if (channel || typeof BroadcastChannel === 'undefined') return;
      channel = new BroadcastChannel('sf-ex-pres:' + DOC_KEY);
      channel.onmessage = function (ev) { onMessage(ev.data || {}); };
      heartbeat = setInterval(beat, HEARTBEAT_MS);
    }

    function closeChannel() {
      if (!channel) return;
      post({ type: 'bye' });
      channel.close();
      channel = null;
      clearInterval(heartbeat);
      heartbeat = null;
    }

    function beat() {
      if (role === 'lehrende') {
        post({ type: 'ping', frozen: cfg.frozen, mirror: cfg.mirror });
        prunePeers();
      } else if (role === 'lernende') {
        post({ type: 'status', frozen: frozenLocal });
      }
      renderAll();
    }

    function prunePeers() {
      var t = now();
      Object.keys(peers).forEach(function (id) { if (t - peers[id] > PEER_TIMEOUT_MS) delete peers[id]; });
    }

    function peerCount() { prunePeers(); return Object.keys(peers).length; }
    function teacherConnected() { return now() - teacherSeen < PEER_TIMEOUT_MS; }

    function fullSync() {
      return {
        type: 'sync', frozen: cfg.frozen, mirror: cfg.mirror,
        view: cfg.mirror ? currentView() : null,
        timer: timerForLern()
      };
    }

    function timerForLern() {
      var t = Timer.snapshot();
      t.open = !!cfg.lernTimer;
      return t;
    }

    function setLernTimer(v) {
      cfg.lernTimer = !!v;
      saveCfg();
      post({ type: 'timer', timer: timerForLern() });
      renderAll();
      Timer.render();
    }

    function onMessage(m) {
      if (!m || m.from === tabId) return;
      if (role === 'lehrende') {
        if (m.role !== 'lernende') return;
        if (m.type === 'bye') { delete peers[m.from]; renderAll(); return; }
        var isNew = !peers[m.from];
        peers[m.from] = now();
        if (m.type === 'hello' || isNew) post(fullSync());
        renderAll();
      } else if (role === 'lernende') {
        if (m.role !== 'lehrende') return;
        if (m.type === 'bye') { teacherSeen = 0; renderAll(); return; }
        teacherSeen = now();
        var first = !gotFirstSync && (m.type === 'sync' || m.type === 'ping');
        if (m.type === 'sync' || m.type === 'ping') gotFirstSync = true;
        if (m.type === 'sync') {
          setFrozen(!!m.frozen, { neutral: first && m.frozen, fade: false });
          if (m.view) applyView(m.view);
          Timer.applyRemote(m.timer);
        } else if (m.type === 'ping') {
          if (!!m.frozen !== frozenLocal) setFrozen(!!m.frozen, { neutral: first, fade: false });
        } else if (m.type === 'freeze') {
          setFrozen(!!m.on, { neutral: false, fade: !!m.fade });
        } else if (m.type === 'view') {
          applyView(m);
        } else if (m.type === 'timer') {
          Timer.applyRemote(m.timer);
        }
        renderAll();
      }
    }

    // --- Rollen ----------------------------------------------------------------
    function setRole(r) {
      if (r === role) return;
      var old = role;
      if (old) closeChannel();
      if (old === 'lernende') { setFrozen(false, { fade: false }); applyLernendeUi(false); }
      role = r;
      applyCursor();
      try { if (r) sessionStorage.setItem(ROLE_KEY, r); else sessionStorage.removeItem(ROLE_KEY); } catch (e) { /* ignorieren */ }
      peers = {}; teacherSeen = 0; gotFirstSync = false; lastView = null;
      Timer.setRemote(r === 'lernende');
      if (r) {
        openChannel();
        if (r === 'lernende') {
          panelOpen = false;
          applyLernendeUi(lern.hideUi);
          post({ type: 'hello' });
        } else {
          post(fullSync());
          startMirrorLoop();
        }
      }
      if (r !== 'lehrende') stopMirrorLoop();
      Buttons.remove();
      scheduleCheck();
      renderAll();
    }

    // --- Einfrieren (Lernendenansicht) --------------------------------------------
    // Standbild der Zeichenfläche über den Editor legen. Darunter läuft die
    // Synchronisation normal weiter, Änderungen bleiben bis zum Aufdecken unsichtbar.
    function buildCover(neutral) {
      var ex = getExcalidraw();
      var r = ex ? ex.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      var app = getApp();
      var el = document.createElement('div');
      el.id = 'sf-ex-freeze-cover';
      isolate(el);
      el.style.cssText = 'position:fixed;overflow:hidden;z-index:2147482990;transition:opacity .45s ease;opacity:1;';
      sizeCover(el, r);

      var src = ex ? (ex.querySelector('canvas.excalidraw__canvas.static') || ex.querySelector('canvas.static') || ex.querySelector('canvas')) : null;
      var inner = document.createElement('div');
      var bg = (app && app.state && app.state.viewBackgroundColor) || '#ffffff';
      var filter = src ? getComputedStyle(src).filter : 'none';
      inner.style.cssText = 'position:absolute;inset:0;background:' + bg + ';filter:' + (filter || 'none') + ';';
      el.appendChild(inner);

      if (!neutral && src && src.width && src.height) {
        var sr = src.getBoundingClientRect();
        var copy = document.createElement('canvas');
        copy.width = src.width;
        copy.height = src.height;
        try { copy.getContext('2d').drawImage(src, 0, 0); } catch (e) { /* ignorieren */ }
        copy.style.cssText = 'position:absolute;left:' + (sr.left - r.left) + 'px;top:' + (sr.top - r.top) +
          'px;width:' + sr.width + 'px;height:' + sr.height + 'px;';
        inner.appendChild(copy);
      } else if (neutral) {
        var note = document.createElement('div');
        note.textContent = 'Tafel pausiert';
        note.style.cssText = 'position:absolute;left:0;right:0;bottom:24px;text-align:center;' +
          'font:600 14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:' + (isDark() ? '#8a8a96' : '#9a9aa6') + ';';
        el.appendChild(note);
      }
      return el;
    }

    function sizeCover(el, r) {
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
    }

    function setFrozen(on, opts) {
      opts = opts || {};
      if (on === frozenLocal) return;
      frozenLocal = on;
      if (on) {
        if (cover) unmountHost(cover);
        cover = buildCover(!!opts.neutral);
        mountHost(cover);
      } else if (cover) {
        var c = cover;
        cover = null;
        if (opts.fade) {
          c.style.opacity = '0';
          setTimeout(function () { unmountHost(c); }, 480);
        } else {
          unmountHost(c);
        }
      }
      post({ type: 'status', frozen: frozenLocal });
      Question.onFreeze(on, !!opts.neutral);
    }

    // --- Lehrendenansicht: Steuerung ------------------------------------------------
    function toggleFreeze() {
      cfg.frozen = !cfg.frozen;
      saveCfg();
      post({ type: 'freeze', on: cfg.frozen, fade: cfg.fade });
      renderAll();
    }

    function toggleMirror() {
      if (!getApp()) return;
      cfg.mirror = !cfg.mirror;
      saveCfg();
      if (cfg.mirror) { lastSent.key = ''; sendView(true); startMirrorLoop(); }
      post({ type: 'ping', frozen: cfg.frozen, mirror: cfg.mirror });
      renderAll();
    }

    function currentView() {
      var app = getApp();
      if (!app || !app.state) return null;
      var s = app.state;
      var z = (s.zoom && s.zoom.value) || 1;
      var ex = getExcalidraw();
      var W = s.width || (ex ? ex.clientWidth : window.innerWidth);
      var H = s.height || (ex ? ex.clientHeight : window.innerHeight);
      return { cx: -s.scrollX + W / (2 * z), cy: -s.scrollY + H / (2 * z), w: W / z, h: H / z };
    }

    function sendView(force) {
      var v = currentView();
      if (!v) return;
      var key = [v.cx, v.cy, v.w, v.h].map(function (n) { return Math.round(n * 2) / 2; }).join('|');
      var t = now();
      if (!force && (key === lastSent.key || t - lastSent.t < 33)) return;
      lastSent = { key: key, t: t };
      post({ type: 'view', cx: v.cx, cy: v.cy, w: v.w, h: v.h });
    }

    // Sichtbarer Tab: pro Bild (requestAnimationFrame); verdeckter Tab: per Timer,
    // weil Browser requestAnimationFrame in Hintergrund-Tabs anhalten.
    function startMirrorLoop() {
      if (mirrorLoop || role !== 'lehrende') return;
      var step = function () {
        mirrorLoop = null;
        if (role !== 'lehrende') return;
        if (cfg.mirror && excalidrawActive) sendView(false);
        mirrorLoop = document.hidden
          ? { t: setTimeout(step, 50) }
          : { r: requestAnimationFrame(step) };
      };
      step();
    }

    function stopMirrorLoop() {
      if (mirrorLoop) {
        if (mirrorLoop.r) cancelAnimationFrame(mirrorLoop.r);
        if (mirrorLoop.t) clearTimeout(mirrorLoop.t);
      }
      mirrorLoop = null;
    }

    // --- Lernendenansicht: Ansicht übernehmen ------------------------------------------
    function applyView(v) {
      if (!v || !(v.w > 0) || !(v.h > 0)) return;
      lastView = { cx: v.cx, cy: v.cy, w: v.w, h: v.h };
      var app = getApp();
      if (!app || !app.state) return;
      var s = app.state;
      var ex = getExcalidraw();
      var W = s.width || (ex ? ex.clientWidth : window.innerWidth);
      var H = s.height || (ex ? ex.clientHeight : window.innerHeight);
      var z = clamp(Math.min(W / v.w, H / v.h), 0.1, 30);
      appSet(app, { scrollX: W / (2 * z) - v.cx, scrollY: H / (2 * z) - v.cy, zoom: { value: z } });
    }

    // Zeiger anderer Teilnehmender (und deren Auswahlrahmen) zeichnet Excalidraw auf die "interactive"-Ebene.
    // Der Laserpointer liegt auf einer eigenen SVG-Ebene und bleibt deshalb sichtbar.
    function applyCursor() {
      document.documentElement.classList.toggle('sf-ex-lernende-nocursor', role === 'lernende' && !!lern.hideCursor);
    }

    function applyLernendeUi(hide) {
      document.documentElement.classList.toggle('sf-ex-lernende-ui', !!hide && role === 'lernende');
      var app = getApp();
      if (app && app.state && 'viewModeEnabled' in app.state) {
        var want = !!hide && role === 'lernende';
        if (app.state.viewModeEnabled !== want) appSet(app, { viewModeEnabled: want });
        appliedViewMode = app;
      }
    }

    function toggleFullscreen() {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      var ex = getExcalidraw();
      var target = ex || document.documentElement;
      if (target.requestFullscreen) target.requestFullscreen().catch(function () {
        document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
      });
    }

    // --- Panel der Lehrendenansicht / Rollenwahl ------------------------------------------
    var PANEL_CSS = BASE_CSS + '\n' + [
      '.panel{width:300px;padding-bottom:12px}',
      '.section{margin-top:8px}',
      '.text{font-size:12px;line-height:1.45;color:var(--muted);margin:2px 2px 10px}',
      '.roles{display:flex;flex-direction:column;gap:6px}',
      '.roles .btn{height:auto;padding:9px 10px;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;white-space:normal}',
      '.roles .btn small{font-weight:400;font-size:11px;color:var(--muted)}',
      '.status{display:flex;align-items:center;gap:8px;font-size:12px;padding:7px 9px;border-radius:8px;background:var(--track);margin-bottom:8px}',
      '.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:0 0 auto}',
      '.status.ok .dot{background:var(--ok)}',
      '.freeze{width:100%;height:42px;font-size:14px}',
      '.freeze.on{background:var(--warn);color:#fff}',
      '.freeze.on:hover{filter:brightness(1.08)}',
      '.frozen-note{display:none;font-size:11px;color:var(--warn);text-align:center;margin-top:4px}',
      '.panel.frozen .frozen-note{display:block}',
      '.row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 2px}',
      '.row .lbl{font-weight:600}',
      '.row .sub{display:block;font-size:11px;font-weight:400;color:var(--muted)}',
      '.switch{position:relative;width:38px;height:22px;border-radius:11px;border:0;background:var(--border);cursor:pointer;flex:0 0 auto;padding:0;transition:background .15s}',
      '.switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}',
      '.switch[aria-checked=true]{background:var(--primary)}',
      '.switch[aria-checked=true]::after{left:19px}',
      '.switch:disabled{opacity:.4;cursor:not-allowed}',
      '.wide{width:100%}',
      '.sep{height:1px;background:var(--border);margin:8px 0}',
      '.foot{display:flex;align-items:center;justify-content:space-between;margin-top:8px}',
      '.link{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;padding:2px;text-decoration:underline}',
      '.link:hover{color:var(--fg)}',
      '.keys{font-size:11px;color:var(--muted)}',
      '.warn{font-size:11px;color:var(--warn);margin:2px 2px 6px}',
      '[hidden]{display:none!important}'
    ].join('\n');

    var PANEL_HTML = '' +
      '<div class="panel" role="dialog" aria-label="Präsentation">' +
      '  <div class="head">' +
      '    <span class="grip" title="Ziehen zum Verschieben">' + ICON_GRIP + '</span>' +
      '    <span class="title">Präsentation</span>' +
      '    <span class="spacer"></span>' +
      '    <button class="icon" data-act="close" title="Schließen (Alt+Shift+P)">' + ICON_CLOSE + '</button>' +
      '  </div>' +
      // Rollenwahl
      '  <div class="section" data-view="choose">' +
      '    <p class="text">Öffne dieses Whiteboard in einem zweiten Tab, ziehe ihn auf den Beamer bzw. den zweiten Bildschirm und wähle dort „Lernendenansicht“. In diesem Tab wählst du „Lehrendenansicht“.</p>' +
      '    <div class="roles">' +
      '      <button class="btn primary" data-act="role" data-role="lehrende">Lehrendenansicht<small style="color:inherit;opacity:.85">Steuert die Anzeige für Lernende</small></button>' +
      '      <button class="btn" data-act="role" data-role="lernende">Lernendenansicht<small>Reine Anzeige, z. B. für den Beamer</small></button>' +
      '    </div>' +
      '  </div>' +
      // Lehrendenansicht
      '  <div class="section" data-view="lehrende" hidden>' +
      '    <div class="status"><span class="dot"></span><span class="status-text"></span></div>' +
      '    <button class="btn freeze" data-act="freeze"></button>' +
      '    <div class="frozen-note">Lernende sehen den Stand vom Einfrieren. Änderungen bleiben verborgen.</div>' +
      '    <div class="sep"></div>' +
      '    <div class="row"><span class="lbl">Ansicht spiegeln<span class="sub">Verschieben und Zoomen live übertragen</span></span>' +
      '      <button class="switch" role="switch" data-act="mirror" aria-label="Ansicht spiegeln"></button></div>' +
      '    <div class="warn" data-warn="api" hidden>Die Ansicht lässt sich in dieser Excalidraw-Version nicht auslesen. Einfrieren und Timer funktionieren weiterhin.</div>' +
      '    <button class="btn wide" data-act="sendview">' + ICON_SEND + 'Ausschnitt einmal übertragen</button>' +
      '    <div class="sep"></div>' +
      '    <div class="row"><span class="lbl">Sanft aufdecken<span class="sub">Neuen Stand weich einblenden</span></span>' +
      '      <button class="switch" role="switch" data-act="fade" aria-label="Sanft aufdecken"></button></div>' +
      '    <div class="row"><span class="lbl">Timer für Lernende anzeigen<span class="sub">Bleibt sichtbar, auch wenn der Timer hier geschlossen ist</span></span>' +
      '      <button class="switch" role="switch" data-act="synctimer" aria-label="Timer für Lernende anzeigen"></button></div>' +
      '    <div class="foot"><button class="link" data-act="role" data-role="">Rolle beenden</button>' +
      '      <span class="keys">Alt+Shift+F / M / P</span></div>' +
      '  </div>' +
      '</div>';

    var panel = null;

    function ensurePanel() {
      if (panel && panel.host.isConnected) return;
      var s = createShadowHost('sf-ex-pres-panel', PANEL_CSS, PANEL_HTML, 2147483001);
      panel = { host: s.host, root: s.root, el: s.root.querySelector('.panel') };
      s.root.addEventListener('click', onPanelClick);
      makeDraggable(panel.host, panel.el, panelPos, {
        place: placePanel,
        onMoved: function () { jsonSet(localStorage, PRES_POS_KEY, panelPos); }
      });
    }

    function placePanel() {
      if (!panel) return;
      placeHost(panel.host, panel.el, panelPos, function () { return { x: 24, y: 72 }; });
    }

    function onPanelClick(e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      switch (b.getAttribute('data-act')) {
        case 'close': panelOpen = false; renderAll(); break;
        case 'role': setRole(b.getAttribute('data-role') || null); if (role === 'lernende') panelOpen = false; renderAll(); break;
        case 'freeze': toggleFreeze(); break;
        case 'mirror': toggleMirror(); break;
        case 'sendview': lastSent.key = ''; sendView(true); break;
        case 'fade': cfg.fade = !cfg.fade; saveCfg(); renderAll(); break;
        case 'synctimer': setLernTimer(!cfg.lernTimer); break;
      }
    }

    function renderPanel() {
      var show = panelOpen && excalidrawActive && role !== 'lernende';
      if (!show) { if (panel) panel.host.style.display = 'none'; return; }
      ensurePanel();
      panel.host.style.display = '';
      var r = panel.root;
      var el = panel.el;
      el.classList.toggle('dark', isDark());
      el.classList.toggle('frozen', role === 'lehrende' && cfg.frozen);
      r.querySelector('[data-view=choose]').hidden = role === 'lehrende';
      r.querySelector('[data-view=lehrende]').hidden = role !== 'lehrende';
      if (role === 'lehrende') {
        var n = peerCount();
        var st = r.querySelector('.status');
        st.classList.toggle('ok', n > 0);
        r.querySelector('.status-text').textContent =
          n === 0 ? 'Keine Lernendenansicht verbunden' : (n === 1 ? '1 Lernendenansicht verbunden' : n + ' Lernendenansichten verbunden');
        var fb = r.querySelector('[data-act=freeze]');
        fb.classList.toggle('on', cfg.frozen);
        var fl = cfg.frozen ? ICON_EYE + 'Tafel aufdecken' : ICON_SNOW + 'Tafel einfrieren';
        if (fb.__html !== fl) { fb.innerHTML = fl; fb.__html = fl; }
        fb.title = (cfg.frozen ? 'Aufdecken' : 'Einfrieren') + ' (Alt+Shift+F)';
        var hasApp = !!getApp();
        var ms = r.querySelector('[data-act=mirror]');
        ms.setAttribute('aria-checked', String(cfg.mirror && hasApp));
        ms.disabled = !hasApp;
        ms.title = 'Ansicht spiegeln (Alt+Shift+M)';
        r.querySelector('[data-act=sendview]').disabled = !hasApp || cfg.mirror;
        r.querySelector('[data-warn=api]').hidden = hasApp;
        r.querySelector('[data-act=fade]').setAttribute('aria-checked', String(cfg.fade));
        r.querySelector('[data-act=synctimer]').setAttribute('aria-checked', String(cfg.lernTimer));
      }
      placePanel();
    }

    // --- Hinweis der Lernendenansicht ------------------------------------------------
    var BADGE_CSS = BASE_CSS + '\n' + [
      '.wrap{display:flex;flex-direction:column-reverse;align-items:flex-end;gap:6px;font-family:Assistant,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px}',
      '.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--fg);',
      '  font:600 12px Assistant,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.12);cursor:pointer;opacity:.25;transition:opacity .3s}',
      '.wrap:hover .pill,.wrap.open .pill,.wrap.attn .pill{opacity:1}',
      '.pill .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}',
      '.pill.ok .dot{background:var(--ok)}',
      '.pill.frozen .dot{background:var(--warn)}',
      '.menu{display:none;flex-direction:column;gap:4px;padding:6px;border-radius:10px;border:1px solid var(--border);background:var(--bg);box-shadow:0 8px 28px rgba(0,0,0,.18);min-width:220px}',
      '.wrap.open .menu{display:flex}',
      '.menu .btn{justify-content:flex-start;background:transparent;font-weight:500}',
      '.menu .btn:hover{background:var(--btn)}',
      '.menu .btn.warnbtn{color:var(--warn)}',
      '.vars{--bg:#fff;--fg:#1b1b1f;--muted:#70707b;--border:#e3e3ea;--btn:#f1f0ff;--warn:#e03131;--ok:#2f9e44}',
      '.vars.dark{--bg:#232329;--fg:#e3e3e8;--muted:#a0a0ab;--border:#3a3a44;--btn:#31303b;--warn:#ff8787;--ok:#8ce99a}',
      '[hidden]{display:none!important}'
    ].join('\n');

    var BADGE_HTML = '' +
      '<div class="wrap vars">' +
      '  <div class="pill" data-act="menu" role="button" tabindex="0"><span class="dot"></span><span class="ptext"></span></div>' +
      '  <div class="menu">' +
      '    <button class="btn" data-act="fullscreen"></button>' +
      '    <button class="btn" data-act="ui"></button>' +
      '    <button class="btn" data-act="cursor"></button>' +
      '    <button class="btn warnbtn" data-act="unfreeze" hidden>Jetzt aufdecken</button>' +
      '    <button class="btn" data-act="hidebadge">Hinweis ausblenden (Alt+Shift+P zeigt ihn wieder)</button>' +
      '    <button class="btn" data-act="leave">Rolle beenden</button>' +
      '  </div>' +
      '</div>';

    var badge = null;
    var attnUntil = 0;

    function ensureBadge() {
      if (badge && badge.host.isConnected) return;
      var s = createShadowHost('sf-ex-pres-badge', BADGE_CSS, BADGE_HTML, 2147483002);
      s.host.style.left = 'auto';
      s.host.style.top = 'auto';
      badge = { host: s.host, root: s.root, wrap: s.root.querySelector('.wrap') };
      s.root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]');
        if (!b) return;
        switch (b.getAttribute('data-act')) {
          case 'menu': badge.wrap.classList.toggle('open'); break;
          case 'fullscreen': badge.wrap.classList.remove('open'); toggleFullscreen(); break;
          case 'ui': lern.hideUi = !lern.hideUi; saveLern(); applyLernendeUi(lern.hideUi); break;
          case 'cursor': lern.hideCursor = !lern.hideCursor; saveLern(); applyCursor(); break;
          case 'unfreeze': setFrozen(false, { fade: true }); break;
          case 'hidebadge': lern.badgeHidden = true; saveLern(); badge.wrap.classList.remove('open'); break;
          case 'leave': badge.wrap.classList.remove('open'); setRole(null); break;
        }
        renderAll();
      });
      attnUntil = now() + 4000;
    }

    function renderBadge() {
      var show = role === 'lernende' && excalidrawActive && !lern.badgeHidden;
      if (!show) { if (badge) badge.host.style.display = 'none'; return; }
      ensureBadge();
      badge.host.style.display = '';
      // unten rechts auf der Tafelfläche (oben links sitzen Leitfrage/Fragestellung/Hypothese);
      // bei eingeblendeten Bedienelementen oberhalb der Excalidraw-Fußleiste
      var exr = getExcalidraw() ? getExcalidraw().getBoundingClientRect()
        : { right: window.innerWidth, bottom: window.innerHeight };
      badge.host.style.right = Math.round(Math.max(0, window.innerWidth - exr.right) + 12) + 'px';
      badge.host.style.bottom = Math.round(Math.max(0, window.innerHeight - exr.bottom) + (lern.hideUi ? 12 : 64)) + 'px';
      var r = badge.root;
      var connected = teacherConnected();
      badge.wrap.classList.toggle('dark', isDark());
      badge.wrap.classList.toggle('attn', now() < attnUntil || !connected);
      var pill = r.querySelector('.pill');
      pill.classList.toggle('ok', connected && !frozenLocal);
      pill.classList.toggle('frozen', frozenLocal);
      var t = 'Lernendenansicht · ' + (connected ? (frozenLocal ? 'eingefroren' : 'verbunden') : 'Lehrendenansicht nicht verbunden');
      var pt = r.querySelector('.ptext');
      if (pt.textContent !== t) pt.textContent = t;
      r.querySelector('[data-act=fullscreen]').textContent = document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild (nur Tafel)';
      r.querySelector('[data-act=ui]').textContent = lern.hideUi ? 'Bedienelemente einblenden' : 'Bedienelemente ausblenden';
      r.querySelector('[data-act=cursor]').textContent = lern.hideCursor ? 'Mauszeiger der Lehrenden einblenden' : 'Mauszeiger der Lehrenden ausblenden';
      // Nur ohne verbundene Lehrendenansicht sinnvoll (sonst friert diese sofort wieder ein)
      r.querySelector('[data-act=unfreeze]').hidden = !frozenLocal || connected;
    }

    // --- Allgemein -------------------------------------------------------------------
    var LERN_CSS_ID = 'sf-ex-lernende-style';
    function injectLernCss() {
      if (document.getElementById(LERN_CSS_ID)) return;
      var st = document.createElement('style');
      st.id = LERN_CSS_ID;
      // Fallback, falls der Ansichtsmodus nicht gesetzt werden kann: Excalidraw-Bedienelemente ausblenden
      st.textContent = [
        '.layer-ui__wrapper', '.layer-ui__wrapper__footer', '.App-bottom-bar', 'footer',
        '.zoom-actions', '.undo-redo-buttons', '.disable-view-mode', '.main-menu-trigger'
      ].map(function (sel) { return 'html.sf-ex-lernende-ui .excalidraw ' + sel; }).join(',') + '{visibility:hidden!important}\n' +
        'html.sf-ex-lernende-nocursor .excalidraw canvas.excalidraw__canvas.interactive,' +
        'html.sf-ex-lernende-nocursor .excalidraw canvas.interactive{opacity:0!important}';
      (document.head || document.documentElement).appendChild(st);
    }

    function renderAll() {
      Buttons.update();
      renderPanel();
      renderBadge();
      Lesson.render();
      Question.render();
    }

    // Wird regelmäßig aus check() aufgerufen
    function check() {
      if (role === 'lernende') {
        injectLernCss();
        var app = getApp();
        if (app && appliedViewMode !== app) applyLernendeUi(lern.hideUi);
        applyCursor();
        if (app && lastView && !app.__sfViewApplied) { app.__sfViewApplied = true; applyView(lastView); }
      }
      if (role === 'lehrende' && cfg.mirror) startMirrorLoop();
    }

    function onResize() {
      if (cover) {
        var ex = getExcalidraw();
        if (ex) sizeCover(cover, ex.getBoundingClientRect());
      }
      if (role === 'lernende' && lastView) applyView(lastView);
      if (role === 'lehrende' && cfg.mirror) { lastSent.key = ''; sendView(true); }
      placePanel();
      renderBadge();
    }

    function onTimerChange() {
      if (role === 'lehrende') post({ type: 'timer', timer: timerForLern() });
    }

    function init() {
      window.addEventListener('pagehide', function () { if (channel) post({ type: 'bye' }); });
      if (role) {
        Timer.setRemote(role === 'lernende');
        openChannel();
        if (role === 'lernende') post({ type: 'hello' });
        else { post(fullSync()); startMirrorLoop(); }
      }
    }

    return {
      init: init, check: check, renderAll: renderAll, onResize: onResize, onTimerChange: onTimerChange,
      role: function () { return role; },
      togglePanel: function () {
        if (role === 'lernende') { lern.badgeHidden = !lern.badgeHidden; saveLern(); attnUntil = now() + 4000; renderAll(); return; }
        panelOpen = !panelOpen; renderAll();
      },
      toggleFreeze: function () { if (role === 'lehrende') toggleFreeze(); },
      toggleMirror: function () { if (role === 'lehrende') toggleMirror(); },
      isPanelOpen: function () { return panelOpen; },
      lernTimer: function () { return role === 'lehrende' && !!cfg.lernTimer; },
      setLernTimer: function (v) { if (role === 'lehrende') setLernTimer(v); },
      onTimerOpened: function () { if (role === 'lehrende' && !cfg.lernTimer) setLernTimer(true); },
      isFrozen: function () { return role === 'lehrende' && cfg.frozen; },
      isMirror: function () { return role === 'lehrende' && cfg.mirror; },
      isFrozenLocal: function () { return role === 'lernende' && frozenLocal; },
      lernUiHidden: function () { return !!lern.hideUi; }
    };
  })();

  // ===========================================================================
  // STUNDENUHR (nur für Lehrende, nie in der Lernendenansicht)
  // ===========================================================================
  var Lesson = (function () {
    var KEY = 'sf-excalidraw-lesson:v1';
    var PREF_KEY = 'sf-excalidraw-lesson-pref:v1';
    var MIN = 60000;

    var lesson = null;  // { type: 'single'|'double', start: ms, len: min, brk: min }
    var prefType = 'single';
    var pop = null;
    var popOpen = false;
    var tick = null;

    function load() {
      lesson = jsonGet(localStorage, KEY);
      if (!lesson || typeof lesson.start !== 'number') lesson = null;
      var pref = jsonGet(localStorage, PREF_KEY);
      prefType = pref && pref.type === 'double' ? 'double' : 'single';
    }
    function save() {
      if (lesson) jsonSet(localStorage, KEY, lesson); else storageRemove(localStorage, KEY);
      jsonSet(localStorage, PREF_KEY, { type: prefType });
    }

    function lenMin() { return lesson ? lesson.len : LESSON_MINUTES; }
    function brkMin() { return lesson ? lesson.brk : LESSON_BREAK_MINUTES; }
    function totalMin(type, len, brk) { return type === 'double' ? len * 2 + brk : len; }
    function endAt() { return lesson ? lesson.start + totalMin(lesson.type, lesson.len, lesson.brk) * MIN : 0; }

    function floorMinute(t) { var d = new Date(t); d.setSeconds(0, 0); return d.getTime(); }
    function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

    // "8:03", "08.03", "803", "0803"
    function parseClock(str) {
      var s = String(str || '').trim().replace('.', ':');
      var m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{1,2})(\d{2})$/);
      if (!m) return null;
      var h = +m[1], mi = +m[2];
      if (h > 23 || mi > 59) return null;
      var d = new Date(); d.setHours(h, mi, 0, 0);
      return d.getTime();
    }

    // Phase und Restzeit berechnen
    function status(t) {
      if (!lesson) return null;
      var L = lesson.len * MIN, B = lesson.brk * MIN;
      var el = t - lesson.start;
      if (el < 0) return { phase: 'before', ms: -el };
      if (lesson.type === 'single') {
        if (el < L) return { phase: 'single', ms: L - el };
      } else {
        if (el < L) return { phase: 'first', ms: L - el };
        if (el < L + B) return { phase: 'break', ms: L + B - el };
        if (el < 2 * L + B) return { phase: 'second', ms: 2 * L + B - el };
      }
      return { phase: 'over', ms: el - totalMin(lesson.type, lesson.len, lesson.brk) * MIN };
    }

    function remMin(st) { return Math.ceil(st.ms / MIN); }

    // Kurzform für die Leiste (muss schmal bleiben)
    function label() {
      var st = status(now());
      if (!st) return null;
      var warn = st.ms <= LESSON_WARN_MINUTES * MIN;
      switch (st.phase) {
        // "mini" wird genutzt, wenn die Excalidraw-Leiste zu schmal ist
        case 'before': return { text: 'in ' + remMin(st) + ' min', mini: remMin(st) + '′', cls: 'paused' };
        case 'break': return { text: 'Pause ' + remMin(st) + ' min', mini: 'P ' + remMin(st) + '′', cls: 'paused' };
        case 'single': case 'first': case 'second':
          return { text: remMin(st) + ' min', mini: remMin(st) + '′', cls: warn ? 'warn' : '' };
        default:
          var over = Math.floor(st.ms / MIN);
          return { text: over > 0 ? '+' + over + ' min' : 'Ende', mini: over > 0 ? '+' + over + '′' : '0′', cls: 'alarm' };
      }
    }

    // Ausführliche Form für Tooltip und Fenster
    function longText() {
      var st = status(now());
      if (!st) return '';
      var r = remMin(st);
      switch (st.phase) {
        case 'before': return 'Beginnt in ' + r + ' min';
        case 'single': return 'Noch ' + r + ' min';
        case 'first': return '1. Stunde · noch ' + r + ' min bis zur Pause';
        case 'break': return 'Pause · noch ' + r + ' min';
        case 'second': return '2. Stunde · noch ' + r + ' min';
        default:
          var over = Math.floor(st.ms / MIN);
          return over > 0 ? 'Stunde vorbei · ' + over + ' min überzogen' : 'Stunde vorbei';
      }
    }

    function title() {
      if (!lesson) return 'Stundenuhr';
      return 'Stundenuhr – ' + longText() + ' (' + (lesson.type === 'double' ? 'Doppelstunde' : 'Einzelstunde') +
        ', ' + hhmm(lesson.start) + '–' + hhmm(endAt()) + ')';
    }

    // Abgelaufene Stunde nach einer Weile von selbst entfernen
    function expire() {
      if (lesson && now() > endAt() + LESSON_AUTOHIDE_MINUTES * MIN) { lesson = null; save(); }
    }

    // --- Aktionen -------------------------------------------------------------
    function startAt(t) {
      lesson = { type: prefType, start: floorMinute(t), len: LESSON_MINUTES, brk: LESSON_BREAK_MINUTES };
      save(); changed();
    }
    function setType(type) {
      prefType = type;
      if (lesson) lesson.type = type;
      save(); changed();
    }
    function shift(deltaMin) {
      if (!lesson) { startAt(now() + deltaMin * MIN); return; }
      lesson.start += deltaMin * MIN;
      save(); changed();
    }
    function stop() { lesson = null; save(); changed(); }

    function changed() {
      Buttons.update();
      renderPop();
      ensureTick();
    }

    function ensureTick() {
      var need = !!lesson || popOpen;
      if (need && !tick) tick = setInterval(function () { expire(); Buttons.update(); renderPop(); ensureTick(); }, 1000);
      if (!need && tick) { clearInterval(tick); tick = null; }
    }

    // --- Einstellungsfenster ----------------------------------------------------
    var CSS = BASE_CSS + '\n' + [
      '.panel{width:290px;cursor:default;padding:8px 12px 12px}',
      '.types{display:flex;gap:6px;margin:6px 0 10px}',
      '.now{font-weight:600;padding:7px 9px;border-radius:8px;background:var(--track);margin-top:4px;font-variant-numeric:tabular-nums}',
      '.now.warn{color:#e8590c}',
      '.now.alarm{color:var(--warn)}',
      '.type{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 4px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--fg);font:inherit;font-weight:600;cursor:pointer}',
      '.type small{font-weight:400;font-size:11px;color:var(--muted)}',
      '.type:hover{background:var(--btn)}',
      '.type.on{border:2px solid var(--primary);padding:6px 3px;color:var(--primary)}',
      '.row{display:flex;align-items:center;justify-content:space-between;padding:4px 0}',
      '.row .k{color:var(--muted)}',
      '.row .v{font-variant-numeric:tabular-nums;font-weight:600}',
      '.adj{display:inline-flex;align-items:center;gap:6px}',
      '.step{width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--fg);font:inherit;font-weight:600;cursor:pointer;padding:0}',
      '.step:hover{background:var(--btn)}',
      '.clock{width:62px;height:28px;text-align:center;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;font-weight:600;font-variant-numeric:tabular-nums;outline:none;padding:0;user-select:text;-webkit-user-select:text}',
      '.clock:focus{border-color:var(--primary)}',
      '.clock.idle{color:var(--muted)}',
      '.actions{display:flex;gap:6px;margin-top:10px}',
      '.actions .btn{flex:1}',
      '.note{font-size:11px;color:var(--muted);margin-top:8px}',
      '[hidden]{display:none!important}'
    ].join('\n');

    function html() {
      return '' +
        '<div class="panel" role="dialog" aria-label="Stundenuhr">' +
        '  <div class="head"><span class="title">Stundenuhr</span><span class="spacer"></span>' +
        '    <button class="icon" data-act="close" title="Schließen">' + ICON_CLOSE + '</button></div>' +
        '  <div class="now" hidden></div>' +
        '  <div class="types">' +
        '    <button class="type" data-act="type" data-type="single">Einzelstunde<small class="d-single"></small></button>' +
        '    <button class="type" data-act="type" data-type="double">Doppelstunde<small class="d-double"></small></button>' +
        '  </div>' +
        '  <div class="row"><span class="k">Beginn</span><span class="adj">' +
        '    <button class="step" data-act="minus" title="Beginn eine Minute früher">−1</button>' +
        '    <input class="clock" type="text" size="1" inputmode="numeric" maxlength="5" autocomplete="off" spellcheck="false" title="Uhrzeit eintippen, z. B. 8:03">' +
        '    <button class="step" data-act="plus" title="Beginn eine Minute später">+1</button></span></div>' +
        '  <div class="row r-break"><span class="k">Pause</span><span class="v v-break"></span></div>' +
        '  <div class="row"><span class="k">Ende</span><span class="v v-end"></span></div>' +
        '  <div class="actions">' +
        '    <button class="btn primary" data-act="start">Jetzt starten</button>' +
        '    <button class="btn" data-act="stop">Beenden</button>' +
        '  </div>' +
        '  <div class="note">Nur für dich sichtbar, nicht in der Lernendenansicht.</div>' +
        '</div>';
    }

    function ensurePop() {
      if (pop && pop.host.isConnected) return;
      var s = createShadowHost('sf-ex-lesson-pop', CSS, html(), 2147483001);
      pop = { host: s.host, root: s.root, panel: s.root.querySelector('.panel'), clock: s.root.querySelector('.clock') };
      s.root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]');
        if (!b) return;
        switch (b.getAttribute('data-act')) {
          case 'close': setPop(false); break;
          case 'type': setType(b.getAttribute('data-type')); break;
          case 'minus': shift(-1); break;
          case 'plus': shift(1); break;
          case 'start': startAt(now()); break;
          case 'stop': stop(); break;
        }
      });
      pop.clock.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitClock(); pop.clock.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); pop.clock.value = ''; pop.clock.blur(); renderPop(); }
      });
      pop.clock.addEventListener('blur', function () { if (pop.clock.value && pop.clock.__dirty) commitClock(); });
      pop.clock.addEventListener('input', function () { pop.clock.__dirty = true; });
    }

    function commitClock() {
      var t = parseClock(pop.clock.value);
      pop.clock.__dirty = false;
      if (t == null) { renderPop(); return; }
      if (lesson) { lesson.start = t; save(); changed(); } else { startAt(t); }
    }

    function placePop() {
      var btn = document.getElementById(LESSON_BTN_ID);
      var w = pop.panel.offsetWidth || 290;
      var x = window.innerWidth - w - 16, y = 64;
      if (btn) {
        var r = btn.getBoundingClientRect();
        x = r.right - w;
        y = r.bottom + 8;
      }
      pop.host.style.left = clamp(x, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
      pop.host.style.top = clamp(y, 8, Math.max(8, window.innerHeight - (pop.panel.offsetHeight || 200) - 8)) + 'px';
    }

    function renderPop() {
      var show = popOpen && excalidrawActive && Pres.role() !== 'lernende';
      if (!show) { if (pop) pop.host.style.display = 'none'; return; }
      ensurePop();
      pop.host.style.display = '';
      var r = pop.root;
      var L = lenMin(), B = brkMin();
      var type = lesson ? lesson.type : prefType;
      pop.panel.classList.toggle('dark', isDark());
      var nowEl = r.querySelector('.now');
      var lt = longText();
      nowEl.hidden = !lt;
      if (nowEl.textContent !== lt) nowEl.textContent = lt;
      var lab = label();
      nowEl.className = 'now' + (lab && (lab.cls === 'warn' || lab.cls === 'alarm') ? ' ' + lab.cls : '');
      nowEl.hidden = !lt;
      r.querySelector('.d-single').textContent = LESSON_MINUTES + ' min';
      r.querySelector('.d-double').textContent = LESSON_MINUTES + ' + ' + LESSON_BREAK_MINUTES + ' + ' + LESSON_MINUTES + ' min';
      Array.prototype.forEach.call(r.querySelectorAll('.type'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-type') === type);
      });
      var start = lesson ? lesson.start : floorMinute(now());
      var end = start + totalMin(type, L, B) * MIN;
      if (!(r.activeElement === pop.clock && pop.clock.__dirty)) pop.clock.value = hhmm(start);
      pop.clock.classList.toggle('idle', !lesson);
      r.querySelector('.r-break').hidden = type !== 'double' || B <= 0;
      r.querySelector('.v-break').textContent = hhmm(start + L * MIN) + '–' + hhmm(start + (L + B) * MIN);
      r.querySelector('.v-end').textContent = hhmm(end);
      var sb = r.querySelector('[data-act=start]');
      sb.textContent = lesson ? 'Neu starten (jetzt)' : 'Jetzt starten';
      sb.classList.toggle('primary', !lesson);
      r.querySelector('[data-act=stop]').hidden = !lesson;
      placePop();
    }

    function setPop(open) {
      popOpen = open;
      if (open) { expire(); if (pop && pop.clock) pop.clock.__dirty = false; }
      Buttons.update();
      renderPop();
      ensureTick();
    }

    // Klick außerhalb schließt das Fenster
    document.addEventListener('pointerdown', function (e) {
      if (!popOpen || !pop) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(pop.host) >= 0) return;
      var btn = document.getElementById(LESSON_BTN_ID);
      if (btn && path.indexOf(btn) >= 0) return;
      setPop(false);
    }, true);

    window.addEventListener('storage', function (e) {
      if (e.key === KEY || e.key === PREF_KEY) { load(); changed(); }
    });

    function init() { load(); expire(); ensureTick(); }

    return {
      init: init,
      togglePop: function () { setPop(!popOpen); },
      isOpen: function () { return popOpen; },
      isActive: function () { return !!lesson; },
      label: function () { expire(); return label(); },
      title: title,
      onResize: function () { if (popOpen && pop) placePop(); },
      render: renderPop
    };
  })();

  // ===========================================================================
  // FRAGESTELLUNG UND HYPOTHESE
  // Quelle sind normale Excalidraw-Elemente (Rahmen mit Text) auf der Tafel,
  // erkennbar an customData.sfTeacherTools oder am Textanfang "Leitfrage:" / "Fragestellung:" / "Hypothese:".
  // Drei eigenständige Elemente; das Overlay zeigt sie in der Reihenfolge Leitfrage, Fragestellung, Hypothese.
  // Das Overlay zeigt ihren Text dauerhaft in der Ecke, solange das Element nicht
  // selbst vollständig auf dem Bildschirm zu sehen ist.
  // ===========================================================================
  var Question = (function () {
    // Präfix zum Abschneiden ("Leitfrage:" / "Leitfrage ") – nur ganzes Wort
    function prefixRe(words) {
      return new RegExp('^\\s*(?:' + alts(words) + ')(?=\\s|:|$)\\s*:?\\s*', 'i');
    }
    // Erkennung von Textfeldern ohne Markierung: Doppelpunkt ist Pflicht ("Leitfrage: …")
    function detectRe(words) {
      return new RegExp('^\\s*(?:' + alts(words) + ')\\s*:', 'i');
    }
    function alts(words) {
      return words.map(function (w) { return String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
    }
    var KINDS = {
      // Leitfrage: Blau; Fragestellung: Mint (#e6fcf5) mit Petrol; Hypothese: zartes Violett
      leitfrage: { label: 'Leitfrage', words: ['Leitfrage'], stroke: '#1971c2', bg: '#e7f5ff' },
      question: { label: 'Fragestellung', words: ['Fragestellung'], stroke: '#099268', bg: '#e6fcf5' },
      hypothesis: { label: 'Hypothese', words: ['Hypothese'], stroke: '#7048e8', bg: '#f3f0ff' }
    };
    var ORDER = ['leitfrage', 'question', 'hypothesis'];
    ORDER.forEach(function (k) { KINDS[k].prefix = prefixRe(KINDS[k].words); KINDS[k].detect = detectRe(KINDS[k].words); });
    var MARK = 'sfTeacherTools';
    var COLLAPSE_KEY = 'sf-excalidraw-question-collapsed:v1';
    var TOP_KEY = 'sf-excalidraw-question-top:v1';
    // Darstellung in der Lernendenansicht; wird in der Lehrendenansicht eingestellt.
    // Beide Tabs teilen sich localStorage, die Lernendenansicht übernimmt Änderungen sofort (storage-Ereignis).
    var LERN_KEY = 'sf-excalidraw-question-lern:v1';
    var LERN_SIZES = [
      { name: 'S', fs: 'clamp(12px,.9vw,17px)' },
      { name: 'M', fs: 'clamp(14px,1.05vw,20px)' },
      { name: 'L', fs: 'clamp(17px,1.35vw,26px)' },
      { name: 'XL', fs: 'clamp(20px,1.7vw,34px)' },
      { name: 'XXL', fs: 'clamp(24px,2.1vw,42px)' }
    ];
    var LERN_WIDTHS = ['min(20vw,320px)', 'min(25vw,400px)', 'min(30vw,480px)', 'min(36vw,580px)',
                       'min(42vw,680px)', 'min(50vw,800px)', 'min(60vw,960px)'];
    var lernView = loadLernView();
    var learnedTop = jsonGet(localStorage, TOP_KEY);

    function loadLernView() {
      var v = Object.assign({ size: 1, width: 2 }, jsonGet(localStorage, LERN_KEY) || {});
      v.size = clamp(Math.round(v.size), 0, LERN_SIZES.length - 1);
      v.width = clamp(Math.round(v.width), 0, LERN_WIDTHS.length - 1);
      return v;
    }
    function saveLernView() { jsonSet(localStorage, LERN_KEY, lernView); }

    window.addEventListener('storage', function (e) {
      if (e.key === LERN_KEY) { lernView = loadLernView(); render(); }
    });
    var LIB_PREFIX = 'sf-teacher-tools-';
    var LIB_IDS = { leitfrage: LIB_PREFIX + 'leitfrage-v4', question: LIB_PREFIX + 'question-v4', hypothesis: LIB_PREFIX + 'hypothesis-v4' };

    var ui = null;
    var poll = null;
    var current = {};        // kind -> { text, el } (live aus der Tafel)
    var frozenSnap = null;   // Lernendenansicht: Stand beim Einfrieren (null = nichts zeigen)
    var collapsed = !!jsonGet(localStorage, COLLAPSE_KEY);
    var libTried = false;

    // --- Tafel auslesen --------------------------------------------------------
    function sceneElements(app) {
      var sc = app && app.scene;
      if (!sc) return null;
      try {
        if (typeof sc.getNonDeletedElements === 'function') return sc.getNonDeletedElements();
        if (typeof sc.getElementsIncludingDeleted === 'function') return sc.getElementsIncludingDeleted().filter(function (e) { return !e.isDeleted; });
        if (typeof sc.getElements === 'function') return sc.getElements();
      } catch (e) { /* ignorieren */ }
      return null;
    }

    function markOf(el) {
      var k = el && el.customData && el.customData[MARK];
      return KINDS[k] ? k : null;
    }

    function isForeignMark(el) {
      var k = el && el.customData && el.customData[MARK];
      return !!k && !KINDS[k];
    }

    function prefixKind(text) {
      for (var i = 0; i < ORDER.length; i++) if (KINDS[ORDER[i]].detect.test(text || '')) return ORDER[i];
      return null;
    }

    function bodyOf(kind, text) {
      var t = String(text || '').replace(KINDS[kind].prefix, '').replace(/\s+/g, ' ').trim();
      // Platzhalter ("…", "...") gilt als leer
      return /^[.…\s]*$/.test(t) ? '' : t;
    }

    function scan() {
      var app = getApp();
      var els = sceneElements(app);
      if (!els) return null;
      var byId = {};
      els.forEach(function (e) { byId[e.id] = e; });
      var found = {};
      els.forEach(function (t) {
        if (t.type !== 'text' || t.isDeleted) return;
        var container = t.containerId ? byId[t.containerId] : null;
        var raw = t.originalText != null ? t.originalText : t.text;
        // Überschriften-Reiter ("question-label") und andere eigene Markierungen überspringen
        if (isForeignMark(t) || isForeignMark(container)) return;
        var kind = markOf(t) || markOf(container) || prefixKind(raw);
        if (!kind) return;
        var body = bodyOf(kind, raw);
        if (!body) return;
        var box = container || t;
        var updated = Math.max(t.updated || 0, (container && container.updated) || 0);
        if (!found[kind] || updated > found[kind].updated) found[kind] = { text: body, el: box, updated: updated };
      });
      return found;
    }

    // Liegt das Element vollständig im sichtbaren Ausschnitt?
    function fullyVisible(el) {
      var app = getApp();
      if (!app || !app.state || !el) return false;
      var s = app.state;
      var z = (s.zoom && s.zoom.value) || 1;
      var ex = getExcalidraw();
      var W = s.width || (ex ? ex.clientWidth : window.innerWidth);
      var H = s.height || (ex ? ex.clientHeight : window.innerHeight);
      var x0 = -s.scrollX, y0 = -s.scrollY, x1 = x0 + W / z, y1 = y0 + H / z;
      var ex0 = Math.min(el.x, el.x + el.width), ey0 = Math.min(el.y, el.y + el.height);
      var ex1 = Math.max(el.x, el.x + el.width), ey1 = Math.max(el.y, el.y + el.height);
      return ex0 >= x0 && ey0 >= y0 && ex1 <= x1 && ey1 <= y1;
    }

    // --- Neue Elemente erzeugen ------------------------------------------------
    function rid() { return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12); }
    function rnd() { return Math.floor(Math.random() * 2147483647); }

    // Aufbau: farbiger Reiter mit der Überschrift, darunter der Kasten zum Eintippen.
    // Beide liegen in einer Gruppe und bewegen sich gemeinsam.
    //   ┌───────────────┐
    //   │ Fragestellung │
    //   ├───────────────┴──────────────────────────┐
    //   │                    …                     │
    //   └──────────────────────────────────────────┘
    function makeElements(kind, cx, cy, fontFamily) {
      var k = KINDS[kind];
      var W = 520, H = 92, fs = 20;           // Eingabekasten
      var lfs = 24, TH = 46;                   // Reiter mit der Überschrift
      var TW = Math.round(k.label.length * lfs * 0.6 + 40);
      var x0 = Math.round(cx - W / 2), yBody = Math.round(cy - H / 2 + TH / 2), yTab = yBody - TH + 1;
      var t = now(), gid = rid();
      var ids = { tab: rid(), tabText: rid(), body: rid(), bodyText: rid() };
      function mark(v) { var c = {}; c[MARK] = v; return c; }
      var base = {
        angle: 0, strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [gid], frameId: null,
        version: 1, isDeleted: false, updated: t, link: null, locked: false
      };
      function textEl(id, containerId, text, size, color, x, y, w, h, m) {
        return Object.assign({}, base, {
          id: id, type: 'text', x: x, y: y, width: w, height: h,
          strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid', roundness: null,
          seed: rnd(), versionNonce: rnd(), boundElements: null,
          text: text, originalText: text, fontSize: size, fontFamily: fontFamily || 1, textAlign: 'center',
          verticalAlign: 'middle', containerId: containerId, lineHeight: 1.25, autoResize: true, customData: m
        });
      }
      var tab = Object.assign({}, base, {
        id: ids.tab, type: 'rectangle', x: x0, y: yTab, width: TW, height: TH,
        strokeColor: k.stroke, backgroundColor: k.stroke, fillStyle: 'solid', roundness: { type: 3 },
        seed: rnd(), versionNonce: rnd(), boundElements: [{ type: 'text', id: ids.tabText }],
        customData: mark(kind + '-label')
      });
      var ltw = Math.round(k.label.length * lfs * 0.55), lth = Math.round(lfs * 1.25);
      var tabText = textEl(ids.tabText, ids.tab, k.label, lfs, '#ffffff',
        Math.round(x0 + (TW - ltw) / 2), Math.round(yTab + (TH - lth) / 2), ltw, lth, mark(kind + '-label'));
      var body = Object.assign({}, base, {
        id: ids.body, type: 'rectangle', x: x0, y: yBody, width: W, height: H,
        strokeColor: k.stroke, backgroundColor: k.bg, fillStyle: 'solid', roundness: { type: 3 },
        seed: rnd(), versionNonce: rnd(), boundElements: [{ type: 'text', id: ids.bodyText }],
        customData: mark(kind)
      });
      var bth = Math.round(fs * 1.25), btw = Math.round(fs * 0.8);
      var bodyText = textEl(ids.bodyText, ids.body, '…', fs, '#1e1e1e',
        Math.round(x0 + (W - btw) / 2), Math.round(yBody + (H - bth) / 2), btw, bth, mark(kind));
      // Reihenfolge: Kasten zuerst, damit der Reiter seine Oberkante überdeckt
      return [body, bodyText, tab, tabText];
    }

    // --- Excalidraw-Bibliothek -----------------------------------------------------
    function libraryItems() {
      return ORDER.map(function (kind) {
        return { id: LIB_IDS[kind], status: 'unpublished', created: now(), name: KINDS[kind].label, elements: makeElements(kind, 0, 0, 1) };
      });
    }

    // Bei jedem Laden prüfen: fehlende Elemente ergänzen, ältere Versionen ersetzen.
    // (Auch für den Fall, dass Seafile die Bibliothek nicht dauerhaft speichert.)
    function ensureLibrary() {
      var app = getApp();
      var lib = app && app.library;
      if (!lib || typeof lib.updateLibrary !== 'function') return Promise.resolve(false);
      var getter = typeof lib.getLatestLibrary === 'function' ? lib.getLatestLibrary() : Promise.resolve([]);
      return Promise.resolve(getter).then(function (items) {
        items = items || [];
        var mine = libraryItems();
        var isCurrent = function (x) { return mine.some(function (it) { return x && x.id === it.id; }); };
        var outdated = items.filter(function (x) { return x && typeof x.id === 'string' && x.id.indexOf(LIB_PREFIX) === 0 && !isCurrent(x); });
        var missing = mine.filter(function (it) { return !items.some(function (x) { return x && x.id === it.id; }); });
        if (!missing.length && !outdated.length) return true;
        // Ältere Versionen dieser Elemente durch die aktuellen ersetzen, alle anderen Einträge bleiben unverändert
        var opts = outdated.length
          ? { libraryItems: items.filter(function (x) { return outdated.indexOf(x) < 0; }).concat(missing), merge: false }
          : { libraryItems: missing, merge: true };
        opts.defaultStatus = 'unpublished';
        opts.openLibraryMenu = false;
        return Promise.resolve(lib.updateLibrary(opts)).then(function () { return true; });
      }).catch(function () { return false; });
    }

    // --- Overlay ------------------------------------------------------------------------
    var CSS = BASE_CSS + '\n' + [
      '.card{font-family:Assistant,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);',
      '  background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.12);',
      '  padding:8px 10px;display:flex;flex-direction:column;gap:8px;max-width:var(--maxw);position:relative}',
      '.vars{--bg:#fff;--fg:#1b1b1f;--muted:#70707b;--border:#e3e3ea;--btn:#f1f0ff;--maxw:min(26vw,340px);--fs:13px}',
      '.vars.dark{--bg:#232329;--fg:#e3e3e8;--muted:#a0a0ab;--border:#3a3a44;--btn:#31303b}',
      '.vars.lern{--maxw:min(30vw,480px);--fs:clamp(14px,1.05vw,20px)}',
      // Gestaltung wie auf der Tafel: farbiger Reiter mit Überschrift über einem getönten Kasten
      '.item{display:flex;flex-direction:column;align-items:flex-start}',
      '.item[data-kind=leitfrage]{--accent:#1971c2;--tint:#e7f5ff}',
      '.item[data-kind=question]{--accent:#099268;--tint:#e6fcf5}',
      '.item[data-kind=hypothesis]{--accent:#7048e8;--tint:#f3f0ff}',
      '.dark .item[data-kind=leitfrage]{--accent:#4dabf7;--tint:rgba(77,171,247,.14)}',
      '.dark .item[data-kind=question]{--accent:#20c997;--tint:rgba(32,201,151,.14)}',
      '.dark .item[data-kind=hypothesis]{--accent:#9775fa;--tint:rgba(151,117,250,.16)}',
      '.lbl{font-size:calc(var(--fs) * .78);font-weight:700;color:#fff;background:var(--accent);line-height:1.2;padding:3px 9px;border-radius:6px 6px 0 0}',
      '.dark .lbl{color:#121212}',
      '.txt{align-self:stretch;font-size:var(--fs);line-height:1.35;overflow-wrap:anywhere;background:var(--tint);border:1.5px solid var(--accent);border-radius:0 8px 8px 8px;padding:6px 9px}',
      '.lehr .item{cursor:pointer}',
      '.lehr .item:hover .txt{text-decoration:underline;text-decoration-color:var(--border)}',
      // Bedienleiste (nur Lehrendenansicht): Darstellung für Lernende + Einklappen
      '.bar{display:none;align-items:center;justify-content:flex-end;gap:2px;margin:-4px -5px -4px 0}',
      '.lehr .bar{display:flex}',
      '.ctl{display:none;align-items:center;gap:2px}',
      '.withctl .ctl{display:inline-flex}',
      '.ctllbl{font-size:11px;color:var(--muted);margin-right:3px}',
      '.vsep{width:1px;height:16px;background:var(--border);margin:0 4px}',
      '.bar .icon{width:24px;height:24px}',
      '.bar .icon svg{width:15px;height:15px}',
      '.bar .icon:disabled{opacity:.35;cursor:default;background:transparent}',
      '.bar .icon.wl{width:auto;padding:0 5px 0 4px;gap:3px}',
      '.lv{font-size:11px;font-weight:700;color:var(--fg);font-variant-numeric:tabular-nums;line-height:1;min-width:22px;text-align:center}',
      '.bar .icon.wl .lv{min-width:0;text-align:left}',
      '.vsep.thin{height:12px;margin:0 2px;opacity:.7}',
      '.pill{display:none;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--fg);',
      '  font:600 12px Assistant,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.1);cursor:pointer}',
      '.pill svg{width:14px;height:14px}',
      '.collapsed .card{display:none}',
      '.collapsed .pill{display:inline-flex}',
      '[hidden]{display:none!important}'
    ].join('\n');

    var ICON_CHEVRON_UP = svgIcon('<path d="M6 15l6-6l6 6"/>');
    var ICON_CHEVRON_DOWN = svgIcon('<path d="M6 9l6 6l6-6"/>');
    var ICON_NARROWER = svgIcon('<path d="M4 12h6"/><path d="M7 9l3 3l-3 3"/><path d="M20 12h-6"/><path d="M17 9l-3 3l3 3"/>');
    var ICON_WIDER = svgIcon('<path d="M10 12h-6"/><path d="M7 9l-3 3l3 3"/><path d="M14 12h6"/><path d="M17 9l3 3l-3 3"/>');

    var HTML = '' +
      '<div class="wrap vars">' +
      '  <div class="card" role="note" aria-label="Leitfrage, Fragestellung und Hypothese">' +
      '    <div class="bar">' +
      '      <span class="ctl"><span class="ctllbl">Lernende</span>' +
      '        <button class="icon wl" data-act="lsize">' + ICON_TEXT_SIZE + '<span class="lv lv-size"></span></button>' +
      '        <span class="vsep thin"></span>' +
      '        <button class="icon" data-act="lnarrow">' + ICON_NARROWER + '</button>' +
      '        <span class="lv lv-width"></span>' +
      '        <button class="icon" data-act="lwide">' + ICON_WIDER + '</button>' +
      '        <span class="vsep"></span></span>' +
      '      <button class="icon" data-act="collapse" title="Einklappen">' + ICON_CHEVRON_UP + '</button>' +
      '    </div>' +
      '    <div class="item" data-kind="leitfrage" hidden><div class="lbl">Leitfrage</div><div class="txt"></div></div>' +
      '    <div class="item" data-kind="question" hidden><div class="lbl">Fragestellung</div><div class="txt"></div></div>' +
      '    <div class="item" data-kind="hypothesis" hidden><div class="lbl">Hypothese</div><div class="txt"></div></div>' +
      '  </div>' +
      '  <button class="pill" data-act="expand" title="Ausklappen"><span class="ptext"></span>' + ICON_CHEVRON_DOWN + '</button>' +
      '</div>';

    function ensureUI() {
      if (ui && ui.host.isConnected) return;
      var s = createShadowHost('sf-ex-question', CSS, HTML, 2147482995);
      ui = { host: s.host, root: s.root, wrap: s.root.querySelector('.wrap') };
      s.root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act], .item');
        if (!b) return;
        var act = b.getAttribute('data-act');
        if (act === 'collapse') { collapsed = true; jsonSet(localStorage, COLLAPSE_KEY, true); render(); }
        else if (act === 'expand') { collapsed = false; jsonSet(localStorage, COLLAPSE_KEY, false); render(); }
        else if (act === 'lsize') { lernView.size = (lernView.size + 1) % LERN_SIZES.length; saveLernView(); render(); }
        else if (act === 'lnarrow') { if (lernView.width > 0) { lernView.width--; saveLernView(); render(); } }
        else if (act === 'lwide') { if (lernView.width < LERN_WIDTHS.length - 1) { lernView.width++; saveLernView(); render(); } }
        else if (b.classList.contains('item')) jumpTo(b.getAttribute('data-kind'));
      });
    }

    // Klick auf den Text: Tafel zum Element scrollen (nur Lehrende)
    function jumpTo(kind) {
      var c = current[kind];
      var app = getApp();
      if (!c || !app) return;
      try {
        if (typeof app.scrollToContent === 'function') { app.scrollToContent(c.el, { animate: true, fitToContent: false }); return; }
      } catch (e) { /* weiter mit Fallback */ }
      var s = app.state, z = (s.zoom && s.zoom.value) || 1;
      appSet(app, { scrollX: (s.width / (2 * z)) - (c.el.x + c.el.width / 2), scrollY: (s.height / (2 * z)) - (c.el.y + c.el.height / 2) });
    }

    // Excalidraw-Eigenschaftenpanel (links, bei Auswahl) ausweichen
    function leftObstacle(exr) {
      var sels = ['.App-menu__left', '.selected-shape-actions', '.properties-content'];
      var found = null;
      sels.forEach(function (sel) {
        var el = document.querySelector('.excalidraw ' + sel);
        if (!el) return;
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.left < exr.left + 120) {
          if (!found) found = { right: r.right, top: r.top };
          else { found.right = Math.max(found.right, r.right); found.top = Math.min(found.top, r.top); }
        }
      });
      return found;
    }

    function place() {
      var ex = getExcalidraw();
      var exr = ex ? ex.getBoundingClientRect() : { left: 0, top: 0 };
      var lern = Pres.role() === 'lernende';
      var left = Math.max(0, exr.left) + 12;
      var exTop = Math.max(0, exr.top);
      var top = exTop + (lern && Pres.lernUiHidden() ? 12 : 64);
      if (!lern) {
        // Oberkante an Excalidraws Eigenschaften-Panel ausrichten. Dessen Abstand zur Leiste wird gemerkt,
        // damit das Overlay auch ohne geöffnetes Panel auf derselben Höhe sitzt und nicht springt.
        var obs = leftObstacle(exr);
        if (obs) {
          left = Math.max(left, obs.right + 12);
          var off = Math.round(obs.top - exTop);
          if (off > 0 && off < 400 && off !== learnedTop) { learnedTop = off; jsonSet(localStorage, TOP_KEY, off); }
        }
        if (typeof learnedTop === 'number') top = exTop + learnedTop;
      }
      ui.host.style.left = Math.round(left) + 'px';
      ui.host.style.top = Math.round(top) + 'px';
    }

    function render() {
      var lern = Pres.role() === 'lernende';
      var data = lern && Pres.isFrozenLocal() ? (frozenSnap || {}) : current;
      var shown = ORDER.filter(function (k) { return data[k] && data[k].text && !(data[k].visible); });
      if (!excalidrawActive || !shown.length) { if (ui) ui.host.style.display = 'none'; return; }
      ensureUI();
      ui.host.style.display = '';
      ui.host.style.pointerEvents = lern ? 'none' : '';
      ui.wrap.classList.toggle('dark', isDark());
      ui.wrap.classList.toggle('lern', lern);
      ui.wrap.classList.toggle('lehr', !lern);
      ui.wrap.classList.toggle('collapsed', !lern && collapsed);
      if (lern) {
        ui.wrap.style.setProperty('--fs', LERN_SIZES[lernView.size].fs);
        ui.wrap.style.setProperty('--maxw', LERN_WIDTHS[lernView.width]);
      } else {
        ui.wrap.style.removeProperty('--fs');
        ui.wrap.style.removeProperty('--maxw');
      }
      var withCtl = !lern && Pres.role() === 'lehrende';
      ui.wrap.classList.toggle('withctl', withCtl);
      if (withCtl) {
        var sz = ui.root.querySelector('[data-act=lsize]');
        var nb = ui.root.querySelector('[data-act=lnarrow]');
        var wb = ui.root.querySelector('[data-act=lwide]');
        sz.title = 'Schriftgröße in der Lernendenansicht: ' + LERN_SIZES[lernView.size].name + ' (klicken zum Wechseln)';
        var stufe = ' (Stufe ' + (lernView.width + 1) + ' von ' + LERN_WIDTHS.length + ')';
        nb.title = 'In der Lernendenansicht schmaler' + stufe;
        wb.title = 'In der Lernendenansicht breiter' + stufe;
        ui.root.querySelector('.lv-size').textContent = LERN_SIZES[lernView.size].name;
        ui.root.querySelector('.lv-width').textContent = (lernView.width + 1) + '/' + LERN_WIDTHS.length;
        ui.root.querySelector('.lv-width').title = 'Breite in der Lernendenansicht: Stufe ' + (lernView.width + 1) + ' von ' + LERN_WIDTHS.length;
        nb.disabled = lernView.width <= 0;
        wb.disabled = lernView.width >= LERN_WIDTHS.length - 1;
      }
      ORDER.forEach(function (k) {
        var item = ui.root.querySelector('.item[data-kind=' + k + ']');
        var on = shown.indexOf(k) >= 0;
        item.hidden = !on;
        if (on) {
          var t = ui.root.querySelector('.item[data-kind=' + k + '] .txt');
          if (t.textContent !== data[k].text) t.textContent = data[k].text;
          item.title = lern ? '' : 'Klicken, um zur ' + KINDS[k].label + ' auf der Tafel zu springen';
        }
      });
      ui.root.querySelector('.ptext').textContent = shown.map(function (k) { return KINDS[k].label; }).join(' · ');
      place();
    }

    function update() {
      if (!excalidrawActive) { render(); return; }
      var found = scan();
      if (!found) { current = {}; render(); return; }
      var next = {};
      ORDER.forEach(function (k) {
        if (found[k]) next[k] = { text: found[k].text, el: found[k].el, visible: fullyVisible(found[k].el) };
      });
      current = next;
      render();
      if (!libTried && Pres.role() !== 'lernende' && getApp()) { libTried = true; ensureLibrary(); }
    }

    // Lernendenansicht: beim Einfrieren den aktuellen Stand merken
    function onFreeze(on, neutral) {
      if (on) {
        if (neutral) { frozenSnap = {}; }
        else {
          frozenSnap = {};
          ORDER.forEach(function (k) { if (current[k]) frozenSnap[k] = { text: current[k].text, visible: current[k].visible }; });
        }
      } else {
        frozenSnap = null;
      }
      update();
    }

    function init() {
      if (!poll) poll = setInterval(update, 300);
    }

    return {
      init: init, render: render, update: update, onFreeze: onFreeze,
      // Wird bei jeder DOM-Änderung (im selben Bildaufbau) aufgerufen, damit das Overlay
      // ohne Verzögerung dem Eigenschaften-Panel von Excalidraw ausweicht
      reposition: function () { if (ui && ui.host.isConnected && ui.host.style.display !== 'none') place(); },
      libraryItems: libraryItems
    };
  })();

  // ===========================================================================
  // Buttons in der Excalidraw-Leiste
  // ===========================================================================
  var Buttons = (function () {
    var CSS = [
      '.sf-ex-tbtn{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;align-self:center;',
      '  box-sizing:border-box;width:var(--lg-button-size,2.25rem);height:var(--lg-button-size,2.25rem);margin:0;padding:0;border:0;outline:none;',
      '  border-radius:var(--border-radius-lg,.5rem);background:transparent;color:var(--icon-fill-color,#1b1b1f);cursor:pointer}',
      '.sf-ex-tbtn:hover{background:var(--button-hover-bg,rgba(0,0,0,.06))}',
      '.sf-ex-tbtn.sf-active{background:var(--color-primary-light,#e0dfff);color:var(--color-primary-darker,#5b57d1)}',
      '.sf-ex-tbtn svg{width:var(--lg-icon-size,1rem);height:var(--lg-icon-size,1rem);pointer-events:none;flex:0 0 auto}',
      '.sf-ex-tbtn .sf-badge{position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;background:#e03131;display:none}',
      '.sf-ex-tbtn.sf-running .sf-badge{display:block}',
      '.sf-ex-tbtn .sf-tlabel{display:none;margin-left:5px;font:600 11px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:.2px;pointer-events:none}',
      '.sf-ex-tbtn.sf-has-label{width:auto!important;padding:0 8px 0 7px;flex-shrink:0;white-space:nowrap}',
      '.sf-ex-tbtn .sf-tlabel{white-space:nowrap}',
      '.sf-ex-tbtn.sf-has-label .sf-tlabel{display:inline}',
      '.sf-ex-tbtn.sf-has-label .sf-badge{display:none!important}',
      '.sf-ex-tbtn .sf-tlabel.paused{opacity:.55}',
      '.sf-ex-tbtn .sf-tlabel.alarm{color:#e03131}',
      '.sf-ex-tbtn .sf-tlabel.warn{color:#e8590c}',
      '.sf-ex-tbtn.sf-mirror .sf-badge{display:block;background:#2f9e44}',
      '.sf-ex-tbtn.sf-frozen .sf-badge{display:block;background:#e03131}',
      '.' + DIVIDER_CLASS + ':not(.App-toolbar__divider){width:1px;height:1.5rem;align-self:center;margin:0 .25rem;background:var(--default-border-color,#e0e0e0);flex:0 0 auto}',
      '#' + FLOAT_ID + '{position:fixed;right:16px;bottom:84px;z-index:2147482999;display:flex;flex-direction:column;gap:6px}',
      '#' + FLOAT_ID + ' .sf-ex-tbtn{width:40px;height:40px;background:var(--island-bg-color,#fff);box-shadow:0 2px 10px rgba(0,0,0,.2)}',
      '#' + FLOAT_ID + ' .sf-ex-tbtn.sf-active{background:var(--color-primary-light,#e0dfff)}'
    ].join('\n');

    var excalidrawSince = 0;

    function injectCss() {
      if (document.getElementById('sf-ex-timer-style')) return;
      var st = document.createElement('style');
      st.id = 'sf-ex-timer-style';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }

    function create(id, icon, label, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.className = 'sf-ex-tbtn';
      b.setAttribute('aria-label', label);
      b.innerHTML = icon + '<span class="sf-badge"></span>' + (id !== PRES_BTN_ID ? '<span class="sf-tlabel"></span>' : '');
      b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
      return b;
    }

    function makeAll() {
      return [
        create(PRES_BTN_ID, ICON_PRESENT, 'Präsentation', function () { Pres.togglePanel(); }),
        create(TIMER_BTN_ID, ICON_TIMER, 'Timer', function () { Timer.toggleOpen(); }),
        create(LESSON_BTN_ID, ICON_CLOCK, 'Stundenuhr', function () { Lesson.togglePop(); })
      ];
    }

    function remove() {
      [TIMER_BTN_ID, PRES_BTN_ID, LESSON_BTN_ID, FLOAT_ID].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.remove();
      });
      var d = document.querySelectorAll('.' + DIVIDER_CLASS);
      Array.prototype.forEach.call(d, function (x) { x.remove(); });
    }

    function findToolbar(ex) {
      for (var i = 0; i < TOOLBAR_SELECTORS.length; i++) {
        var el = ex.querySelector(TOOLBAR_SELECTORS[i]);
        if (el) return el;
      }
      return null;
    }

    // Original-Bedienelement als Vorlage für Größe, Rundung und Icon suchen
    function findReference(toolbar) {
      var sels = ['.App-toolbar__extra-tools-trigger', '.ToolIcon__icon', 'button', 'label'];
      for (var i = 0; i < sels.length; i++) {
        var list = toolbar.querySelectorAll(sels[i]);
        for (var j = list.length - 1; j >= 0; j--) {
          var el = list[j];
          if (el.closest('.sf-ex-tbtn')) continue;
          var r = el.getBoundingClientRect();
          if (r.width >= 20 && r.height >= 20 && el.querySelector('svg')) return el;
        }
      }
      return null;
    }

    function syncGeometry(btn, toolbar) {
      var ref = findReference(toolbar);
      if (!ref) return;
      var r = ref.getBoundingClientRect();
      var cs = getComputedStyle(ref);
      btn.style.width = Math.round(r.width) + 'px';
      btn.style.minWidth = Math.round(r.width) + 'px';
      btn.style.height = Math.round(r.height) + 'px';
      btn.style.borderRadius = cs.borderRadius;
      var refSvg = ref.querySelector('svg');
      var svg = btn.querySelector('svg');
      if (refSvg && svg) {
        var sr = refSvg.getBoundingClientRect();
        if (sr.width > 0) { svg.style.width = sr.width + 'px'; svg.style.height = sr.height + 'px'; }
        // sichtbare Linienstärke des Originals auf unser 24er-Icon umrechnen
        var swEl = refSvg.hasAttribute('stroke-width') ? refSvg : refSvg.querySelector('[stroke-width]');
        var sw = swEl ? parseFloat(swEl.getAttribute('stroke-width')) : NaN;
        var vb = refSvg.viewBox && refSvg.viewBox.baseVal;
        if (sw > 0 && vb && vb.width > 0 && sr.width > 0) {
          var visible = sw * sr.width / vb.width;
          svg.setAttribute('stroke-width', (visible * 24 / sr.width).toFixed(3));
        }
      }
    }

    function ensure(ex) {
      injectCss();
      if (Pres.role() === 'lernende') { remove(); return; }
      var toolbar = findToolbar(ex);
      var tb = document.getElementById(TIMER_BTN_ID);
      var pb = document.getElementById(PRES_BTN_ID);

      if (toolbar) {
        var lb = document.getElementById(LESSON_BTN_ID);
        if (tb && pb && lb && toolbar.contains(tb) && toolbar.contains(pb) && toolbar.contains(lb)) return;
        remove();
        var div = document.createElement('div');
        div.className = DIVIDER_CLASS + (toolbar.querySelector('.App-toolbar__divider') ? ' App-toolbar__divider' : '');
        toolbar.appendChild(div);
        makeAll().forEach(function (b) { toolbar.appendChild(b); syncGeometry(b, toolbar); });
        update();
        return;
      }

      // Keine bekannte Leiste (z. B. mobile Ansicht) -> schwebende Buttons
      if (document.getElementById(FLOAT_ID)) return;
      if (now() - excalidrawSince < FLOATING_FALLBACK_DELAY) return;
      remove();
      var wrap = document.createElement('div');
      wrap.id = FLOAT_ID;
      makeAll().forEach(function (b) { wrap.appendChild(b); });
      document.body.appendChild(wrap);
      update();
    }

    function update() {
      var tb = document.getElementById(TIMER_BTN_ID);
      if (tb) {
        tb.classList.toggle('sf-active', Timer.isOpen());
        tb.classList.toggle('sf-running', Timer.isBusy());
        var cl = Timer.closedLabel();
        var lab = tb.querySelector('.sf-tlabel');
        tb.classList.toggle('sf-has-label', !!cl);
        if (lab) {
          var txt = cl ? cl.text : '';
          if (lab.textContent !== txt) lab.textContent = txt;
          lab.className = 'sf-tlabel' + (cl && cl.cls ? ' ' + cl.cls : '');
        }
        var t = 'Timer (Alt+Shift+T)' + (Timer.label() ? ' – ' + Timer.label() : '');
        if (tb.title !== t) tb.title = t;
      }
      var lb = document.getElementById(LESSON_BTN_ID);
      if (lb) {
        var ll = Lesson.label();
        lb.classList.toggle('sf-active', Lesson.isOpen());
        lb.classList.toggle('sf-has-label', !!ll);
        var lspan = lb.querySelector('.sf-tlabel');
        if (lspan) {
          var lt = ll ? (lb.__mini ? ll.mini : ll.text) : '';
          if (lspan.textContent !== lt) lspan.textContent = lt;
          // Passt die Leiste nicht mehr, auf die Minimalform umschalten (und erst bei viel Platz zurück)
          var bar = lb.parentElement;
          if (ll && bar && bar.id !== FLOAT_ID) {
            var over = bar.scrollWidth - bar.clientWidth;
            if (!lb.__mini && over > 1) { lb.__mini = true; lspan.textContent = ll.mini; }
            else if (lb.__mini && lb.__fullW && bar.clientWidth - (bar.scrollWidth - lb.offsetWidth + lb.__fullW) > 8) { lb.__mini = false; lspan.textContent = ll.text; }
            if (!lb.__mini) lb.__fullW = lb.offsetWidth;
          }
          var lc = 'sf-tlabel' + (ll && ll.cls ? ' ' + ll.cls : '');
          if (lspan.className !== lc) lspan.className = lc;
        }
        var ltt = Lesson.title();
        if (lb.title !== ltt) lb.title = ltt;
      }
      var pb = document.getElementById(PRES_BTN_ID);
      if (pb) {
        pb.classList.toggle('sf-active', Pres.isPanelOpen());
        pb.classList.toggle('sf-frozen', Pres.isFrozen());
        pb.classList.toggle('sf-mirror', Pres.isMirror() && !Pres.isFrozen());
        var role = Pres.role();
        var p = 'Präsentation (Alt+Shift+P)' + (role === 'lehrende' ? ' – Lehrendenansicht' : '') +
          (Pres.isFrozen() ? ', eingefroren' : '') + (Pres.isMirror() ? ', Ansicht gespiegelt' : '');
        if (pb.title !== p) pb.title = p;
      }
    }

    function resync() {
      [TIMER_BTN_ID, PRES_BTN_ID, LESSON_BTN_ID].forEach(function (id) {
        var b = document.getElementById(id);
        if (b && b.parentElement && b.parentElement.id !== FLOAT_ID) syncGeometry(b, b.parentElement);
      });
    }

    return {
      ensure: ensure, update: update, remove: remove, resync: resync,
      markSeen: function () { excalidrawSince = now(); }
    };
  })();

  // ===========================================================================
  // Start und Beobachtung
  // ===========================================================================
  var themeObserver = null;
  var observedEx = null;

  function check() {
    var ex = getExcalidraw();
    if (!ex) {
      if (excalidrawActive) {
        excalidrawActive = false;
        Buttons.remove();
        Timer.render();
        Pres.renderAll();
      }
      return;
    }
    if (!excalidrawActive) {
      excalidrawActive = true;
      Buttons.markSeen();
      setTimeout(scheduleCheck, FLOATING_FALLBACK_DELAY + 50);
      Timer.render();
      Pres.renderAll();
    }
    if (observedEx !== ex) {
      observedEx = ex;
      if (themeObserver) themeObserver.disconnect();
      themeObserver = new MutationObserver(function () { Timer.render(); Pres.renderAll(); });
      themeObserver.observe(ex, { attributes: true, attributeFilter: ['class'] });
    }
    Buttons.ensure(ex);
    Pres.check();
    Question.reposition();
  }

  var checkPending = false;
  function scheduleCheck() {
    if (checkPending) return;
    checkPending = true;
    requestAnimationFrame(function () { checkPending = false; check(); });
  }

  function onHotkey(e) {
    if (!excalidrawActive || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    var handled = true;
    switch (e.code) {
      case 'KeyT': if (Pres.role() !== 'lernende') Timer.toggleOpen(); else handled = false; break;
      case 'KeyP': Pres.togglePanel(); break;
      case 'KeyF': if (Pres.role() === 'lehrende') Pres.toggleFreeze(); else handled = false; break;
      case 'KeyM': if (Pres.role() === 'lehrende') Pres.toggleMirror(); else handled = false; break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  function init() {
    Timer.init();
    Lesson.init();
    Question.init();
    Pres.init();
    new MutationObserver(scheduleCheck).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('keydown', onHotkey, true);
    window.addEventListener('resize', function () {
      Timer.onResize();
      Pres.onResize();
      Buttons.resync();
      Lesson.onResize();
    });
    check();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
