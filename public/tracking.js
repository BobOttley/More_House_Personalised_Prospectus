/* tracking.js — SMART Prospectus (Option B ready)
   Tracks: prospectus open/close, time on section, video open/close, enquiry clicks.
   Reads a server-injected mapping: window.PROSPECTUS_SECTIONS = [{id, selector}, ...]
   Also supports pre-tagged nodes via [data-section-id].
*/
(function () {
  'use strict';

  // --- guard against double include
  if (window.__SMART_TRACKING_ACTIVE__) return;
  window.__SMART_TRACKING_ACTIVE__ = true;

  // --- config & endpoints
  var PROSPECTUS_ID =
    String(window.PROSPECTUS_ID || window.MORE_HOUSE_INQUIRY_ID || '').trim();
  if (!PROSPECTUS_ID) { try { console.warn('tracking.js: PROSPECTUS_ID not set'); } catch(_) {} }

  // Allow server to set a specific endpoint; fall back sensibly
  var ENDPOINT = String(window.TRACK_ENDPOINT || '').trim() || '/api/track-engagement';

  // --- ids
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = (c === 'x') ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }
  var VIEWER_KEY = 'smart.viewer_id';
  var viewerId = localStorage.getItem(VIEWER_KEY);
  if (!viewerId) { viewerId = uuid(); localStorage.setItem(VIEWER_KEY, viewerId); }

  var VISIT_KEY = 'smart.visit.' + PROSPECTUS_ID;
  var visitIndex = parseInt(localStorage.getItem(VISIT_KEY) || '0', 10) + 1;
  localStorage.setItem(VISIT_KEY, String(visitIndex));

  var sessionId = uuid();
  var sessionStart = Date.now();

  // --- transport
  function send(obj, opts) {
    opts = opts || {};
    var payload = JSON.stringify(obj);
    try {
      if (navigator.sendBeacon && opts.beacon !== false) {
        var ok = navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
        if (ok) return;
      }
    } catch (_) {}
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(payload);
    } catch (_) {}
  }

  function base() {
    return {
      event: null,
      ts: new Date().toISOString(),
      prospectus_id: PROSPECTUS_ID,
      viewer_id: viewerId,
      session_id: sessionId,
      visit_index: visitIndex,
      url: location.href,
      referrer: document.referrer || null,
      ua: navigator.userAgent || null,
      vw: window.innerWidth || null,
      vh: window.innerHeight || null
    };
  }

  // --- prospectus open/close
  function emitOpen(resume) {
    var e = base(); e.event = 'prospectus_open'; e.resume = !!resume; send(e);
  }
  function emitClose(reason) {
    var e = base(); e.event = 'prospectus_close';
    e.reason = reason || 'unload';
    e.duration_ms = Math.max(0, Date.now() - sessionStart);
    flushSections(e);
    flushVideo(e);
    send(e, { beacon: true });
  }

  // --- Option B: apply server-injected section mapping -> add [data-section-id]
  function applySectionMapping() {
    var mapping = Array.isArray(window.PROSPECTUS_SECTIONS) ? window.PROSPECTUS_SECTIONS : [];
    mapping.forEach(function (m) {
      if (!m || !m.id || !m.selector) return;
      try {
        var nodes = document.querySelectorAll(m.selector);
        nodes.forEach(function (el) {
          if (!el.getAttribute('data-section-id')) el.setAttribute('data-section-id', m.id);
        });
      } catch (_) {}
    });
  }

  // --- sections (time on section)
  var sectionTimers = Object.create(null);
  var currentSectionId = null, currentSectionEl = null;
  var io = null;

  function onEnter(id) {
    var t = sectionTimers[id];
    if (!t) t = sectionTimers[id] = { start: 0, running: false, total: 0, maxScroll: 0 };
    if (!t.running) { t.start = Date.now(); t.running = true; }
  }
  function onExit(id) {
    var t = sectionTimers[id]; if (!t || !t.running) return;
    t.total += (Date.now() - t.start); t.running = false;
    var e = base(); e.event = 'section_time'; e.section_id = id; e.duration_ms = t.total; e.max_scroll_pct = t.maxScroll; send(e);
    t.total = 0; // chunked emission
  }
  function flushSections(parent) {
    Object.keys(sectionTimers).forEach(function (id) {
      var t = sectionTimers[id]; if (!t) return;
      if (t.running) { t.total += (Date.now() - t.start); t.running = false; }
      if (t.total > 0) {
        var e = base(); e.event = 'section_time'; e.section_id = id; e.duration_ms = t.total; e.max_scroll_pct = t.maxScroll; if (parent) e.final_flush = true; send(e, { beacon: true });
        t.total = 0;
      }
    });
  }
  function visibleRatio(el) {
    var r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= window.innerHeight) return 0;
    var vis = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return vis / Math.max(1, r.height);
  }
  function trackScrollDepth() {
    if (!currentSectionEl || !currentSectionId) return;
    var t = sectionTimers[currentSectionId]; if (!t) return;
    var el = currentSectionEl, rect = el.getBoundingClientRect();
    var total = el.scrollHeight || el.offsetHeight || rect.height || 1;
    var top = window.scrollY, bottom = top + window.innerHeight;
    var elTop = el.offsetTop, elBottom = elTop + total;
    var visibleTop = Math.max(top, elTop);
    var visibleBottom = Math.min(bottom, elBottom);
    var visibleHeight = Math.max(0, visibleBottom - visibleTop);
    var pct = Math.round(Math.min(100, Math.max(0, (visibleHeight / total) * 100)));
    t.maxScroll = Math.max(t.maxScroll || 0, pct);
  }
  function enterSection(el) {
    var id = el.getAttribute('data-section-id'); if (!id) return;
    if (currentSectionId && currentSectionId !== id) onExit(currentSectionId);
    currentSectionId = id; currentSectionEl = el; onEnter(id);
  }
  function maybeExitCurrent() {
    if (!currentSectionEl) return;
    if (visibleRatio(currentSectionEl) < 0.5) { onExit(currentSectionId); currentSectionId = null; currentSectionEl = null; }
  }
  function initSections() {
    applySectionMapping(); // Option B: tag DOM with data-section-id first
    var els = document.querySelectorAll('[data-section-id]'); if (!els.length) return;
    if (!('IntersectionObserver' in window)) { enterSection(els[0]); return; }
    io = new IntersectionObserver(function (entries) {
      var best = null, bestRatio = 0;
      entries.forEach(function (ent) {
        if (ent.isIntersecting && ent.intersectionRatio > bestRatio) { best = ent.target; bestRatio = ent.intersectionRatio; }
      });
      if (best) enterSection(best);
      maybeExitCurrent();
    }, { threshold: [0, 0.5, 1] });
    els.forEach(function (el) { io.observe(el); });
    window.addEventListener('scroll', trackScrollDepth, { passive: true });
  }

  // --- video (modal open/close duration)
  var activeVideo = null; // { id, started_at }
  function videoOpen(videoId) {
    if (activeVideo) videoClose('implicit_switch');
    activeVideo = { id: String(videoId || 'unknown'), started_at: Date.now() };
    var e = base(); e.event = 'video_open'; e.video_id = activeVideo.id; e.section_id = currentSectionId || null; send(e);
  }
  function videoClose(reason) {
    if (!activeVideo) return;
    var e = base(); e.event = 'video_close'; e.video_id = activeVideo.id; e.section_id = currentSectionId || null;
    e.duration_ms = Math.max(0, Date.now() - activeVideo.started_at); e.reason = reason || 'close_button'; send(e);
    activeVideo = null;
  }
  function flushVideo(parent) {
    if (!activeVideo) return;
    var e = base(); e.event = 'video_close'; e.video_id = activeVideo.id; e.section_id = currentSectionId || null;
    e.duration_ms = Math.max(0, Date.now() - activeVideo.started_at);
    e.reason = parent && parent.event === 'prospectus_close' ? 'page_close' : 'flush'; send(e, { beacon: true });
    activeVideo = null;
  }
  function wireVideoUI() {
    document.addEventListener('click', function (ev) {
      var openBtn = ev.target.closest('[data-video-id]'); if (openBtn) videoOpen(openBtn.getAttribute('data-video-id'));
      if (ev.target.closest('.video-close')) videoClose('close_button');
      if (ev.target.closest('[data-video-back]')) videoClose('back_to_prospectus');
    }, true);
  }

  // --- enquiry clicks
  function wireEnquiry() {
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-track="enquire"]'); if (!btn) return;
      var e = base(); e.event = 'enquiry_click'; e.label = btn.getAttribute('data-label') || null; send(e);
    }, true);
  }

  // --- visibility (each visible episode is a new session)
  function onVisible() {
    sessionId = uuid(); sessionStart = Date.now();
    emitOpen(true);
    if (currentSectionEl) onEnter(currentSectionId);
  }
  function onHidden() { emitClose('hidden'); }

  // --- init
  function init() {
    emitOpen(false);
    initSections();
    wireVideoUI();
    wireEnquiry();

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') onHidden();
      else if (document.visibilityState === 'visible') onVisible();
    });
    window.addEventListener('pagehide', function () { emitClose('pagehide'); });
    window.addEventListener('beforeunload', function () { emitClose('beforeunload'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
