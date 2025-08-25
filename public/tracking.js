/* tracking.js — Behaviour-first, attention-only tracking
   - Section enter/exit with attention seconds
   - Per-section max scroll %, clicks, video watch (YouTube IFrame API)
   - Idle + visibility + focus handling to avoid inflating time
   - Batching to POST /api/track-engagement
   - Dwell-time accumulator posting deltas to /api/track/dwell (fetch for heartbeats; beacon only on final flush)
*/
(function () {
  'use strict';

  // ---------- Config ----------
  var POST_URL = '/api/track-engagement'; // existing batch endpoint
  var HEARTBEAT_MS = 15000;               // send a heartbeat every 15s
  var IDLE_TIMEOUT_MS = 30000;            // consider idle after 30s w/o input
  var SECTION_VIS_RATIO = 0.5;            // ≥50% visible counts as “in section”
  var SCROLL_DELTA_MIN = 5;               // 5% improvement before emitting section_scroll

  // Dwell config
  var DWELL_URL = '/api/track/dwell';
  var DWELL_MIN_BATCH_MS = 1000;          // don't send <1s

  // ---------- Inquiry + Session ----------
  function readMeta(name) {
    var el = document.querySelector('meta[name="'+name+'"]');
    return el && el.content;
  }
  var INQUIRY_ID = (window.MORE_HOUSE_INQUIRY_ID) ||
                   readMeta('inquiry-id') ||
                   new URLSearchParams(location.search).get('inquiry_id') ||
                   'UNKNOWN';

  var SESSION_ID = (function() {
    var KEY = 'mh_session_id';
    var s = localStorage.getItem(KEY);
    if (!s) { s = 'S-'+Date.now()+'-'+Math.random().toString(36).slice(2,8); localStorage.setItem(KEY, s); }
    return s;
  })();

  // Queue for section/video events
  var eventQueue = [];

  // ---------- Attention state (true “active” time only) ----------
  var lastActivityAt = Date.now();
  var attentionActive = true;
  var pageVisible = !document.hidden;
  var pageFocused = document.hasFocus();

  function markActivity(){ lastActivityAt = Date.now(); }
  function computeAttentionActive(){
    var notIdle = (Date.now() - lastActivityAt) < IDLE_TIMEOUT_MS;
    attentionActive = pageVisible && pageFocused && notIdle;
  }

  ['mousemove','keydown','wheel','touchstart','scroll','click'].forEach(function(ev){
    window.addEventListener(ev, markActivity, { passive:true });
  });
  document.addEventListener('visibilitychange', function(){
    pageVisible = !document.hidden;
    computeAttentionActive();
  });
  window.addEventListener('focus', function(){ pageFocused = true; computeAttentionActive(); });
  window.addEventListener('blur',  function(){ pageFocused = false; computeAttentionActive(); });

  // ---------- Dwell accumulator ----------
  var dwell = { lastAt: Date.now(), unsentMs: 0, lastSentAt: null };

  function dwellAccumulate() {
    var now = Date.now();
    if (attentionActive) {
      dwell.unsentMs += (now - (dwell.lastAt || now));
    }
    dwell.lastAt = now;
  }

  function getDeviceInfo(){
    var ua = navigator.userAgent || '';
    var viewport = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
    function pick(re){ var m = re.exec(ua); return m ? m[0] : 'unknown'; }
    return {
      userAgent: ua,
      viewport: viewport,
      deviceType: /Mobi|Android/i.test(ua) ? 'mobile' : 'desktop',
      operatingSystem: pick(/Mac|Win|Linux|Android|iPhone|iPad|iOS/),
      browser: pick(/Chrome|Edg|Firefox|Safari/)
    };
  }

  // Use fetch for normal sends (server reliably parses JSON).
  // Only use sendBeacon on the very last-chance flush.
  async function sendDwellDelta(reason) {
    try {
      var delta = Math.max(0, Math.round(dwell.unsentMs));
      if (delta < DWELL_MIN_BATCH_MS) return;
      var payload = {
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        deltaMs: delta,
        reason: reason || 'heartbeat',
        timestamp: new Date().toISOString(),
        deviceInfo: getDeviceInfo()
      };
      dwell.unsentMs = 0;
      dwell.lastSentAt = Date.now();

      await fetch(DWELL_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch (_) {
      // swallow; next heartbeat will retry
    }
  }

  // Periodic attention recompute + dwell accumulation (every second for accuracy)
  setInterval(function(){
    computeAttentionActive();
    dwellAccumulate();
  }, 1000);

  // ---------- Section registry ----------
  (function applyDynamicSectionMapping(){
    if (!window.PROSPECTUS_SECTIONS || !Array.isArray(window.PROSPECTUS_SECTIONS)) return;
    window.PROSPECTUS_SECTIONS.forEach(function(map){
      try {
        var el = document.querySelector(map.selector);
        if (el && map.id) el.setAttribute('data-track-section', map.id);
      } catch(e){}
    });
  })();

  var sectionEls = Array.prototype.slice.call(document.querySelectorAll('[data-track-section]'));
  var sectionState = new Map(); // id -> state
  sectionEls.forEach(function(el){
    var id = el.getAttribute('data-track-section');
    sectionState.set(id, { enteredAt:null, lastTickAt:null, attentionSec:0, maxScrollPct:0, clicks:0, videoSec:0 });
  });

  function sectionScrollPct(el){
    var rect = el.getBoundingClientRect();
    var total = el.scrollHeight || el.offsetHeight || (rect.height || 1);
    var scrolled = Math.min(total, Math.max(0, window.scrollY + window.innerHeight - (el.offsetTop || (window.scrollY + rect.top))));
    var pct = Math.max(0, Math.min(100, (scrolled/total)*100));
    return Math.round(pct);
  }

  // ---------- IntersectionObserver to find “current section” ----------
  var currentSectionId = null;
  var currentSectionEl = null;
  var lastSectionScrollSent = new Map(); // id -> last pct sent

  function buildThresholds(n){ var a=[]; for (var i=0;i<=n;i++) a.push(i/n); return a; }
  function isMostlyVisible(el){
    var r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
    var visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    var ratio = visible / Math.max(1, r.height);
    return ratio >= SECTION_VIS_RATIO;
  }

  var io = new IntersectionObserver(function(entries){
    var candidate = null, bestRatio = 0;
    for (var i=0;i<entries.length;i++){
      var e = entries[i];
      if (!e.isIntersecting) continue;
      if (e.intersectionRatio >= SECTION_VIS_RATIO && e.intersectionRatio > bestRatio){
        bestRatio = e.intersectionRatio; candidate = e.target;
      }
    }
    if (candidate) enterSection(candidate);
    if (currentSectionEl && !isMostlyVisible(currentSectionEl)) exitCurrentSection();
  }, { threshold: buildThresholds(12) });

  sectionEls.forEach(function(el){ io.observe(el); });

  function queueEvent(ev){ eventQueue.push(ev); }
  function nowISO(){ return new Date().toISOString(); }

  function enterSection(el){
    var id = el.getAttribute('data-track-section');
    if (currentSectionId === id) return;
    if (currentSectionId) exitCurrentSection();
    currentSectionId = id;
    currentSectionEl = el;
    var st = sectionState.get(id) || { attentionSec:0, maxScrollPct:0, clicks:0, videoSec:0 };
    st.enteredAt = Date.now();
    st.lastTickAt = Date.now();
    sectionState.set(id, st);
    queueEvent({
      inquiryId: INQUIRY_ID, sessionId: SESSION_ID, eventType: 'section_enter',
      currentSection: id, url: location.href, timestamp: nowISO(),
      data: { deviceInfo: getDeviceInfo() }
    });
  }

  function exitCurrentSection(){
    if (!currentSectionId) return;
    var id = currentSectionId;
    var el = currentSectionEl;
    var st = sectionState.get(id);
    if (st){
      var now = Date.now();
      if (attentionActive && st.lastTickAt) st.attentionSec += Math.max(0, Math.round((now - st.lastTickAt)/1000));
      st.enteredAt = null; st.lastTickAt = null;
      st.maxScrollPct = Math.max(st.maxScrollPct, sectionScrollPct(el));
      queueEvent({
        inquiryId: INQUIRY_ID, sessionId: SESSION_ID, eventType: 'section_exit',
        currentSection: id, url: location.href, timestamp: nowISO(),
        data: { timeInSectionSec: st.attentionSec, maxScrollPct: st.maxScrollPct, clicks: st.clicks, videoWatchSec: st.videoSec, deviceInfo: getDeviceInfo() }
      });
    }
    currentSectionId = null; currentSectionEl = null;
  }

  // Tick attention inside the current section (every 2s)
  setInterval(function(){
    if (!currentSectionId) return;
    var st = sectionState.get(currentSectionId);
    if (!st) return;
    var now = Date.now();
    if (attentionActive && st.lastTickAt){
      st.attentionSec += Math.max(0, Math.round((now - st.lastTickAt)/1000));
      st.maxScrollPct = Math.max(st.maxScrollPct, sectionScrollPct(currentSectionEl));
    }
    st.lastTickAt = now;
    var lastSent = lastSectionScrollSent.get(currentSectionId) || 0;
    if (st.maxScrollPct - lastSent >= SCROLL_DELTA_MIN){
      lastSectionScrollSent.set(currentSectionId, st.maxScrollPct);
      queueEvent({
        inquiryId: INQUIRY_ID, sessionId: SESSION_ID, eventType: 'section_scroll',
        currentSection: currentSectionId, url: location.href, timestamp: nowISO(),
        data: { maxScrollPct: st.maxScrollPct }
      });
    }
  }, 2000);

  // Attribute clicks to current section
  document.addEventListener('click', function(){
    if (!currentSectionId) return;
    var st = sectionState.get(currentSectionId);
    if (st) st.clicks += 1;
  }, { capture:true });

  // ---------- YouTube IFrame API (attention-gated) ----------
  var ytPlayers = new Map(); // iframeId -> state

  function ensureYTAPI(){
    if (window.YT && window.YT.Player){ onYouTubeIframeAPIReady(); return; }
    if (document.getElementById('youtube-iframe-api')) return;
    var tag = document.createElement('script');
    tag.id = 'youtube-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  window.onYouTubeIframeAPIReady = function(){
    var iframes = Array.prototype.slice.call(document.querySelectorAll('iframe[src*="youtube.com"],iframe[src*="youtu.be"]'));
    iframes.forEach(function(iframe, idx){
      var url = new URL(iframe.src, location.href);
      if (!/enablejsapi=1/.test(url.search)){
        url.searchParams.set('enablejsapi', '1');
        iframe.src = url.toString();
      }
      if (!iframe.id) iframe.id = 'yt-'+idx+'-'+Math.random().toString(36).slice(2,6);
      var container = iframe.closest('[data-track-section]');
      var sectionId = container ? container.getAttribute('data-track-section') : currentSectionId;
      var player = new YT.Player(iframe.id, {
        events: { 'onStateChange': function(e){ handleYTStateChange(iframe.id, sectionId, e); } }
      });
      ytPlayers.set(iframe.id, { player: player, sectionId: sectionId, lastState: -1, playStartedAt: null, watchedSec: 0, milestones: {} });
    });
  };

  function handleYTStateChange(iframeId, sectionId, event){
    var P = ytPlayers.get(iframeId); if (!P) return;
    var state = event.data; // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    var now = Date.now();

    if (state === 1){ // playing
      if (attentionActive) P.playStartedAt = now;
      P.lastState = 1;
      queueEvent({ inquiryId: INQUIRY_ID, sessionId: SESSION_ID, eventType: 'youtube_video_start', currentSection: sectionId, url: location.href, timestamp: nowISO(), data: {} });
    }

    var leavingPlaying = (P.lastState === 1 && state !== 1);
    if (leavingPlaying && P.playStartedAt){
      var sec = Math.max(0, Math.round((now - P.playStartedAt)/1000));
      P.watchedSec += sec; P.playStartedAt = null;
      var st = sectionState.get(sectionId); if (st) st.videoSec += sec;
      try {
        var total = P.player.getDuration ? (P.player.getDuration() || 0) : 0;
        if (total > 0){
          var pct = Math.floor((P.watchedSec / total) * 100);
          [25,50,75].forEach(function(m){
            if (pct >= m && !P.milestones[m]){
              P.milestones[m] = true;
              queueEvent({ inquiryId: INQUIRY_ID, sessionId: SESSION_ID, eventType: 'youtube_video_progress', currentSection: sectionId, url: location.href, timestamp: nowISO(), data: { milestonePct: m } });
            }
          });
        }
      } catch(e){}
    }

    if (state === 2){ // paused
      queueEvent({ inquiryId: INQUIRY_ID, sessionId: SESSION_ID, eventType: 'youtube_video_pause', currentSection: sectionId, url: location.href, timestamp: nowISO(), data: {} });
    }
    if (state === 0){ // ended
      queueEvent({ inquiryId: INQUIRY_ID, sessionId: SESSION_ID, eventType: 'youtube_video_complete', currentSection: sectionId, url: location.href, timestamp: nowISO(), data: {} });
    }
    P.lastState = state;
  }

  ensureYTAPI();

  // ---------- Batching + Heartbeat ----------
  function estimateAttentionTotal(){
    var total = 0;
    sectionState.forEach(function(st){ total += (st.attentionSec || 0); });
    return total;
  }

  function heartbeat(){
    // flush partial attention without exiting section
    if (currentSectionId){
      var st = sectionState.get(currentSectionId);
      if (st && attentionActive && st.lastTickAt){
        var now = Date.now();
        st.attentionSec += Math.max(0, Math.round((now - st.lastTickAt)/1000));
        st.lastTickAt = now;
        st.maxScrollPct = Math.max(st.maxScrollPct, sectionScrollPct(currentSectionEl));
      }
    }
    var payload = {
      events: eventQueue.splice(0, eventQueue.length),
      sessionInfo: {
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        timeOnPage: estimateAttentionTotal(), // seconds
        maxScrollDepth: Math.max(0, ...Array.from(sectionState.values()).map(function(s){ return s.maxScrollPct; })),
        clickCount: Array.from(sectionState.values()).reduce(function(a,b){ return a + (b.clicks||0); }, 0),
        deviceInfo: getDeviceInfo()
      }
    };
    var meaningful = payload.events.length > 0 || (payload.sessionInfo.timeOnPage % 15 === 0);
    if (!meaningful) return;
    try {
      fetch(POST_URL, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch(e){ /* ignore */ }
  }

  // Run both heartbeats on the same cadence
  setInterval(function(){
    heartbeat();                 // existing analytics batch
    sendDwellDelta('heartbeat'); // dwell delta (fetch)
  }, HEARTBEAT_MS);

  // ---------- Finalise on unload / hide ----------
  function flushAndExit(){
    // capture last bit of section attention
    exitCurrentSection();
    heartbeat();
  }

  document.addEventListener('visibilitychange', function(){
    if (document.hidden) {
      try { dwellAccumulate(); sendDwellDelta('tab_hidden'); } catch(_) {}
      flushAndExit();
    }
  });

  window.addEventListener('pagehide', function(){
    try { dwellAccumulate(); sendDwellDelta('pagehide'); } catch(_) {}
  });

  window.addEventListener('beforeunload', function(){
    try {
      dwellAccumulate();
      // last best-effort flush of dwell via beacon; fallback to fetch keepalive
      var delta = Math.max(0, Math.round(dwell.unsentMs));
      if (delta >= DWELL_MIN_BATCH_MS) {
        var payload = {
          inquiryId: INQUIRY_ID,
          sessionId: SESSION_ID,
          deltaMs: delta,
          reason: 'beforeunload',
          timestamp: new Date().toISOString(),
          deviceInfo: getDeviceInfo()
        };
        var ok = false;
        if (navigator.sendBeacon) {
          ok = navigator.sendBeacon(DWELL_URL, new Blob([JSON.stringify(payload)], {type:'application/json'}));
        }
        if (!ok) {
          fetch(DWELL_URL, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload),
            keepalive: true
          });
        }
        dwell.unsentMs = 0;
      }
    } catch(_) {}
    flushAndExit();
  }, { capture:true });
})();
