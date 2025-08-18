/* tracking.js — lightweight prospectus analytics with batching + YouTube support
   - Reads inquiryId from <meta name="inquiry-id"> or ?inquiryId=… or ?id=…
   - Batches events to POST /api/track-engagement
   - Tracks: page_load, page_visible/hidden, scroll_depth, link_click, heartbeat
   - Optional: YouTube quartiles if the IFrame API is available on the page
*/

(function () {
  'use strict';

  // ---------- Config ----------
  var ENDPOINT = '/api/track-engagement';
  var FLUSH_INTERVAL_MS = 10000;
  var HEARTBEAT_MS = 15000; // periodic engagement update
  var BATCH_SIZE = 6;

  // ---------- Identify inquiry + session ----------
  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]+)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }
  function getMeta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  }

  var inquiryId =
    getMeta('inquiry-id') ||
    qs('inquiryId') ||
    qs('inquiry_id') ||
    qs('id') ||
    'unknown';

  var sessionKey = 'mh_session_' + inquiryId;
  var sessionId = (function () {
    try {
      var existing = localStorage.getItem(sessionKey);
      if (existing) return existing;
      var s = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
      localStorage.setItem(sessionKey, s);
      return s;
    } catch (_) {
      return 'sess_' + Date.now();
    }
  })();

  var sessionStart = Date.now();
  var maxScrollPct = 0;
  var clickCount = 0;

  // ---------- Device info ----------
  function deviceInfo() {
    var ua = navigator.userAgent || '';
    var isMobile = /Mobi|Android/i.test(ua);
    var os = /Windows/i.test(ua)
      ? 'Windows'
      : /Mac OS X/i.test(ua)
      ? 'macOS'
      : /iPhone|iPad|iOS/i.test(ua)
      ? 'iOS'
      : /Android/i.test(ua)
      ? 'Android'
      : 'Other';
    var browser = /Chrome/i.test(ua)
      ? 'Chrome'
      : /Safari/i.test(ua) && !/Chrome/i.test(ua)
      ? 'Safari'
      : /Firefox/i.test(ua)
      ? 'Firefox'
      : /Edg/i.test(ua)
      ? 'Edge'
      : 'Other';
    return {
      deviceType: isMobile ? 'mobile' : 'desktop',
      operatingSystem: os,
      browser: browser,
      viewport: window.innerWidth + 'x' + window.innerHeight,
    };
  }

  // ---------- Batch + send ----------
  var queue = [];
  function enqueue(eventType, data) {
    var ev = {
      inquiryId: inquiryId,
      sessionId: sessionId,
      eventType: eventType,
      timestamp: new Date().toISOString(),
      url: location.href,
      data: data || {},
    };
    queue.push(ev);
    if (queue.length >= BATCH_SIZE) flush();
  }

  function flush(bodyOverride) {
    var payload =
      bodyOverride ||
      {
        events: queue.splice(0, queue.length),
        sessionInfo: {
          inquiryId: inquiryId,
          sessionId: sessionId,
          timeOnPage: Math.round((Date.now() - sessionStart) / 1000),
          maxScrollDepth: Math.round(maxScrollPct),
          clickCount: clickCount,
          deviceInfo: deviceInfo(),
        },
      };

    if (!payload.events || !payload.events.length) return;

    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify(payload),
      }).catch(function () {
        // swallow – we’ll try again on next flush
      });
    } catch (_) {
      // ignore
    }
  }

  // Periodic flush
  setInterval(function () {
    if (queue.length) flush();
  }, FLUSH_INTERVAL_MS);

  // Heartbeat to capture time on page even without interactions
  setInterval(function () {
    enqueue('heartbeat', { t: Math.round((Date.now() - sessionStart) / 1000) });
  }, HEARTBEAT_MS);

  // ---------- Core event hooks ----------
  // Page load
  document.addEventListener('DOMContentLoaded', function () {
    enqueue('page_load', {
      referrer: document.referrer || '',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      deviceInfo: deviceInfo(),
    });
  });

  // Scroll depth tracking
  function onScroll() {
    var h = document.documentElement;
    var scrollTop = window.scrollY || h.scrollTop || 0;
    var docHeight = Math.max(
      h.scrollHeight,
      h.offsetHeight,
      h.clientHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var winHeight = window.innerHeight || h.clientHeight || 1;
    var pct = ((scrollTop + winHeight) / Math.max(docHeight, 1)) * 100;
    if (pct > maxScrollPct + 5) {
      maxScrollPct = Math.min(100, pct);
      enqueue('scroll_depth', { percent: Math.round(maxScrollPct) });
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  // Link clicks
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    clickCount += 1;
    enqueue('link_click', {
      href: a.getAttribute('href') || '',
      text: (a.textContent || '').trim().slice(0, 120),
    });
  });

  // Visibility changes
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      enqueue('page_hidden', {
        totalTimeVisible: Math.round((Date.now() - sessionStart) / 1000),
      });
      flush();
    } else {
      enqueue('page_visible', {});
    }
  });

  // Before unload – use sendBeacon for last batch
  window.addEventListener('beforeunload', function () {
    if (!queue.length) return;
    try {
      var payload = {
        events: queue.splice(0, queue.length),
        sessionInfo: {
          inquiryId: inquiryId,
          sessionId: sessionId,
          sessionComplete: true,
          timeOnPage: Math.round((Date.now() - sessionStart) / 1000),
          maxScrollDepth: Math.round(maxScrollPct),
          clickCount: clickCount,
          deviceInfo: deviceInfo(),
        },
      };
      navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    } catch (_) {
      // ignore
    }
  });

  // ---------- Optional YouTube tracking ----------
  // If the page already loaded the IFrame API (our server injects it into generated prospectuses), hook into it.
  // Otherwise, if there are YouTube iframes present, we load the API here to enable quartile tracking.
  var YT_READY = false;
  var ytIfs = Array.prototype.slice.call(document.querySelectorAll('iframe[src*="youtube.com/embed/"]'));
  if (ytIfs.length && !window.YT) {
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    var first = document.getElementsByTagName('script')[0];
    first.parentNode.insertBefore(tag, first);
  }

  window.onYouTubeIframeAPIReady = (function (orig) {
    return function () {
      YT_READY = true;
      try {
        if (typeof orig === 'function') orig();
      } catch (_) {}
      setupYTPlayers();
    };
  })(window.onYouTubeIframeAPIReady);

  function setupYTPlayers() {
    var iframes = Array.prototype.slice.call(document.querySelectorAll('iframe[src*="youtube.com/embed/"]'));
    if (!iframes.length || !window.YT || !window.YT.Player) return;

    iframes.forEach(function (iframe, index) {
      if (!/enablejsapi=1/.test(iframe.src)) {
        var sep = iframe.src.indexOf('?') > -1 ? '&' : '?';
        iframe.src = iframe.src + sep + 'enablejsapi=1';
      }
      if (!iframe.id) iframe.id = 'yt_' + index;

      var state = { started: false, watch: 0, t: null, Q25: false, Q50: false, Q75: false, pauses: 0, timer: null };

      /* eslint-disable no-new */
      new YT.Player(iframe.id, {
        events: {
          onReady: function () {
            // nothing
          },
          onStateChange: function (e) {
            var p = e.target;
            var dur = Math.max(1, p.getDuration() || 1);
            var cur = p.getCurrentTime() || 0;

            if (e.data === YT.PlayerState.PLAYING) {
              if (!state.started) {
                state.started = true;
                enqueue('youtube_video_start', { videoId: getVideoIdFromSrc(iframe.src), duration: Math.round(dur) });
              }
              if (state.timer) clearInterval(state.timer);
              state.timer = setInterval(function () {
                var pct = (p.getCurrentTime() / dur) * 100;
                if (pct >= 25 && !state.Q25) { state.Q25 = true; enqueue('youtube_video_progress', { videoId: getVideoIdFromSrc(iframe.src), milestone: '25%' }); }
                if (pct >= 50 && !state.Q50) { state.Q50 = true; enqueue('youtube_video_progress', { videoId: getVideoIdFromSrc(iframe.src), milestone: '50%' }); }
                if (pct >= 75 && !state.Q75) { state.Q75 = true; enqueue('youtube_video_progress', { videoId: getVideoIdFromSrc(iframe.src), milestone: '75%' }); }
              }, 2000);
              if (!state.t) state.t = Date.now();
            } else if (e.data === YT.PlayerState.PAUSED) {
              state.pauses += 1;
              if (state.t) { state.watch += (Date.now() - state.t) / 1000; state.t = null; }
              if (state.timer) { clearInterval(state.timer); state.timer = null; }
              enqueue('youtube_video_pause', {
                videoId: getVideoIdFromSrc(iframe.src),
                currentTime: Math.round(cur),
                totalWatchTime: Math.round(state.watch),
                pauseCount: state.pauses,
              });
            } else if (e.data === YT.PlayerState.ENDED) {
              if (state.t) { state.watch += (Date.now() - state.t) / 1000; state.t = null; }
              if (state.timer) { clearInterval(state.timer); state.timer = null; }
              enqueue('youtube_video_complete', {
                videoId: getVideoIdFromSrc(iframe.src),
                totalWatchTime: Math.round(state.watch),
                completionRate: 100,
              });
            }
          },
        },
      });
    });
  }

  function getVideoIdFromSrc(src) {
    var m = /embed\/([^?&]+)/.exec(src || '');
    return m ? m[1] : 'unknown';
  }

  // If the API was already available (injected by server), initialise now.
  if (window.YT && window.YT.Player) {
    setupYTPlayers();
  }
})();
