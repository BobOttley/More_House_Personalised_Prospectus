/* public/tracking.js — Lean tracker with tier tracking fix + idle timeout + CTA tracking
   Tracks: visit start/end, section enter/exit, tier expand/exit (with analytics compatibility), video open/close, Open Morning clicks
   FIXED: Tier events now send both tier_* and entry_point_interaction for analytics compatibility
*/

(function () {
  'use strict';
  if (window.__PP_TRACKING_ACTIVE__) return;
  window.__PP_TRACKING_ACTIVE__ = true;

  // ===== IDs =====
  const INQUIRY_ID =
    window.MORE_HOUSE_INQUIRY_ID ||
    document.querySelector('meta[name="inquiry-id"]')?.content ||
    'UNKNOWN';
  const SESSION_ID = 'S-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // ===== Config =====
  const POST_URL = '/api/track-engagement';
  const FLUSH_INTERVAL_MS = 4000;         // batching
  const SECTION_VIS_RATIO = 0.5;          // dominant threshold
  const SECTION_ENTER_STICKY_MS = 1200;   // must stay dominant to count as 'enter'
  const MIN_SECTION_DWELL_SEC   = 3;      // clamp dwell to avoid 0s/1s
  const REENTER_COOLDOWN_MS     = 2000;   // ignore re-entry too soon after exit
  const IDLE_TIMEOUT_MS         = 180000; // 3 minutes splits long idle

  // ===== State =====
  const queue = [];
  let flushTimer = null;

  let currentSection = null;
  let lastSectionEnterTs = null;

  // Debounce state for section changes
  let candidateSection = null;
  let candidateSince   = 0;

  // Cooldown: prevent oscillation spam
  const lastExitAt = new Map(); // sectionKey -> ts

  // Tier dwell (expand-only; inferred exit)
  let activeTier = null;
  let activeTierEnterTs = null;

  // Idle detection
  let idleTimer = null;
  const resetIdle = () => { 
    if (idleTimer) clearTimeout(idleTimer); 
    idleTimer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS); 
  };

  // ===== Helpers =====
  const nowIso = () => new Date().toISOString();
  const throttle = (fn, ms) => { 
    let t = 0; 
    return () => { 
      const n = Date.now(); 
      if (n - t > ms) { 
        t = n; 
        fn(); 
      } 
    }; 
  };
  const nameFor = (kind, action, tail) => `pp.v1.${kind}.${action}${tail ? '.' + tail : ''}`;

  function track(eventType, data = {}) {
    queue.push({
      inquiryId: INQUIRY_ID,
      sessionId:  SESSION_ID,
      eventType,
      data: { ...data, name: data.name || eventType },
      timestamp: nowIso()
    });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  async function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    const payload = JSON.stringify({ 
      events: batch, 
      sessionInfo: { 
        inquiryId: INQUIRY_ID, 
        sessionId: SESSION_ID 
      } 
    });

    try {
      if (navigator.sendBeacon && document.visibilityState === 'hidden') {
        navigator.sendBeacon(POST_URL, payload);
      } else {
        await fetch(POST_URL, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: payload 
        });
      }
    } catch {
      // Best-effort retry: put events back to the front of the queue
      batch.unshift(...queue);
      queue.length = 0;
      queue.push(...batch);
    }
  }

  // FIXED: endActiveTier now sends both event types for analytics compatibility
  function endActiveTier(reason) {
    if (!activeTier || !activeTierEnterTs) return;
    const dwellSec = Math.max(0, Math.round((Date.now() - activeTierEnterTs) / 1000));
    
    // Send existing tier event (backward compatibility)
    track('tier_exit', { 
      name: nameFor('tier','exit',activeTier), 
      tier: activeTier, 
      dwellSec, 
      reason 
    });
    
    // ALSO send what analytics expects
    track('entry_point_interaction', { 
      name: nameFor('entry','exit',activeTier), 
      entryPoint: activeTier,
      action: 'exit',
      tier: activeTier,
      dwellSec: dwellSec,
      reason: reason
    });
    
    activeTier = null; 
    activeTierEnterTs = null;
  }

  function endCurrentSection(reason) {
    if (!currentSection || !lastSectionEnterTs) return;
    const dwellSecRaw = Math.max(0, Math.round((Date.now() - lastSectionEnterTs) / 1000));
    const dwellSec    = Math.max(MIN_SECTION_DWELL_SEC, dwellSecRaw);
    lastExitAt.set(currentSection, Date.now());
    track('section_exit', { 
      name: nameFor('section','exit',currentSection), 
      section: currentSection, 
      dwellSec, 
      reason 
    });
    currentSection = null; 
    lastSectionEnterTs = null;
  }

  function detectDominantSection() {
    const sections = document.querySelectorAll('section[data-track-section]');
    let bestKey = null, bestRatio = 0;
    for (const sec of sections) {
      const key = sec.getAttribute('data-track-section');
      const r = sec.getBoundingClientRect();
      const visible = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const ratio = r.height > 0 ? (visible / r.height) : 0;
      if (ratio > SECTION_VIS_RATIO && ratio > bestRatio) { 
        bestRatio = ratio; 
        bestKey = key; 
      }
    }
    return bestKey;
  }

  function handleSectionChange() {
    resetIdle();
    const next = detectDominantSection();

    // If we leave 'your_journey' whilst a tier is active, infer its end
    if (activeTier && next && next !== 'your_journey' && currentSection === 'your_journey') {
      endActiveTier('left_section');
    }

    // Debounce: require the new candidate to be dominant for a short period
    if (next !== candidateSection) { 
      candidateSection = next; 
      candidateSince = Date.now(); 
      return; 
    }
    if (next && next !== currentSection && (Date.now() - candidateSince) < SECTION_ENTER_STICKY_MS) {
      return;
    }

    // Enforce re-entry cooldown to prevent oscillation spam
    if (next && lastExitAt.has(next)) {
      const sinceExit = Date.now() - (lastExitAt.get(next) || 0);
      if (sinceExit < REENTER_COOLDOWN_MS) return;
    }

    if (next && next !== currentSection) {
      endCurrentSection('left_section');            // Exit old (clamped)
      currentSection = next;                        // Enter new
      lastSectionEnterTs = Date.now();
      track('section_enter', { 
        name: nameFor('section','enter',currentSection), 
        section: currentSection 
      });
    }
  }

  function onIdleTimeout() {
    endActiveTier('idle_timeout');
    endCurrentSection('idle_timeout');
    scheduleFlush();
  }

  // ===== Visit start =====
  track('page_load', { name: nameFor('visit','start') });

  // Initial detection + listeners
  window.addEventListener('load', handleSectionChange, { passive: true });
  window.addEventListener('scroll', throttle(handleSectionChange, 250), { passive: true });
  window.addEventListener('resize', throttle(handleSectionChange, 250), { passive: true });

  // Activity listeners reset idle timer
  ['mousemove','keydown','touchstart','wheel'].forEach(ev =>
    window.addEventListener(ev, throttle(resetIdle, 500), { passive: true })
  );
  
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { 
      flush(); 
    } else { 
      resetIdle(); 
      handleSectionChange(); 
    }
  });
  resetIdle();

  // ===== FIXED Tier cards (pre-senior / senior / sixth form) =====
  const originalToggle = window.toggleCard;
  window.toggleCard = function (cardId) {
    resetIdle();
    const tier = cardId === 'preseniorCard' ? 'presenior'
               : cardId === 'seniorCard'     ? 'senior'
               : cardId === 'sixthformCard'  ? 'sixthform'
               : cardId;

    const el = document.getElementById(cardId);
    const wasExpanded = el?.classList.contains('expanded');
    if (typeof originalToggle === 'function') originalToggle(cardId);
    const isExpanded = el?.classList.contains('expanded');

    if (!wasExpanded && isExpanded) {
      if (activeTier && activeTier !== tier) endActiveTier('next_tier');
      activeTier = tier; 
      activeTierEnterTs = Date.now();
      
      // Send existing tier event (backward compatibility)
      track('tier_expand', { 
        name: nameFor('tier','expand',tier), 
        tier 
      });
      
      // ALSO send what analytics expects
      track('entry_point_interaction', { 
        name: nameFor('entry','expand',tier), 
        entryPoint: tier,
        action: 'expand',
        tier: tier,
        cardId: cardId
      });
    }
  };

  // ===== Video open/close =====
  const originalOpenVideo  = window.openVideo;
  const originalCloseVideo = window.closeVideo;

  window.openVideo = function (youtubeId, title) {
    resetIdle();
    track('video_open',  { 
      name: nameFor('video','open', youtubeId), 
      youtubeId, 
      title 
    });
    if (typeof originalOpenVideo === 'function') return originalOpenVideo(youtubeId, title);
  };

  window.closeVideo = function () {
    resetIdle();
    let youtubeId;
    try {
      const iframe = document.querySelector('#videoModal iframe');
      const src = iframe?.getAttribute('src') || '';
      const m = src.match(/\/embed\/([A-Za-z0-9_\-]+)/);
      if (m) youtubeId = m[1];
    } catch {}
    track('video_close', { 
      name: nameFor('video','close', youtubeId || 'unknown'), 
      youtubeId 
    });
    if (typeof originalCloseVideo === 'function') return originalCloseVideo();
  };

  // ===== Open Morning CTA clicks (two buttons anywhere on the page) =====
  document.addEventListener('click', function(e){
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const isOpenMorning =
      a.classList?.contains('openmorning-btn') ||
      /\/admissions\/our-open-events\/?$/i.test(href) ||
      /\/admissions\/our-open-events\//i.test(href);

    if (!isOpenMorning) return;

    // Attach context: which section was dominant at click time
    const sectionAtClick = currentSection || detectDominantSection();

    track('cta_openmorning_click', {
      name: nameFor('cta','openmorning_click'),
      label: (a.textContent || '').trim(),
      href,
      section: sectionAtClick
    });
  }, { passive:true });

  // ===== Flush on unload, and end state cleanly =====
  window.addEventListener('beforeunload', function () {
    endActiveTier('unload');
    endCurrentSection('unload');
    track('page_unload', { name: nameFor('visit','end') });

    if (queue.length) {
      const payload = JSON.stringify({ 
        events: queue, 
        sessionInfo: { 
          inquiryId: INQUIRY_ID, 
          sessionId: SESSION_ID 
        } 
      });
      if (navigator.sendBeacon) navigator.sendBeacon(POST_URL, payload);
    }
  });
})();