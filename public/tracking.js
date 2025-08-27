/* Enhanced tracking.js - AI-powered behavioral intelligence tracking
   - Advanced attention quality analysis with reading speed detection
   - Navigation flow mapping and journey analysis
   - Content interaction quality scoring
   - Predictive engagement signals
   - Real-time conversion probability indicators
   - Enhanced video engagement with quality metrics
   - Behavioral pattern recognition
*/
(function () {
  'use strict';
  
  // ======= SINGLETON GUARD: prevents double-loading / double-heartbeats =======
  if (window.__SMART_TRACKING_ACTIVE__) {
    try { console.warn('SMART tracking already initialised — skipping second load.'); } catch(_) {}
    return;
  }
  window.__SMART_TRACKING_ACTIVE__ = true;
  window.__SMART_TRACKING_NS__ = window.__SMART_TRACKING_NS__ || {};
  // namespace holds shared handles so re-loads can safely bail out
  // ============================================================================ 

  // ---------- Enhanced Config ----------
  var POST_URL = '/api/track-engagement';
  var HEARTBEAT_MS = 10000;               // More frequent for better granularity
  var IDLE_TIMEOUT_MS = 25000;            // Stricter idle detection
  var SECTION_VIS_RATIO = 0.6;            // Higher threshold for "engaged"
  var SCROLL_DELTA_MIN = 3;               // More sensitive scroll tracking
  var DWELL_URL = '/api/track/dwell';
  var DWELL_MIN_BATCH_MS = 500;           // Capture shorter interactions

  // ---------- Enhanced Intelligence Config ----------
  var READING_SPEED_SAMPLES = [];         // Track reading speed over time
  var INTERACTION_QUALITY_THRESHOLD = 0.7;
  var ATTENTION_QUALITY_WINDOW = 5000;    // 5s window for attention analysis
  var CONVERSION_SIGNAL_THRESHOLD = 3;    // Multiple signals needed

  // ---------- Inquiry + Session with Enhanced Tracking ----------
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
    if (!s) { 
      s = 'S-'+Date.now()+'-'+Math.random().toString(36).slice(2,8); 
      localStorage.setItem(KEY, s); 
    }
    return s;
  })();

  // Enhanced event queue with priority levels
  var eventQueue = [];
  var highPriorityQueue = []; // Conversion signals get priority

  // ---------- Advanced Attention & Behavioral State ----------
  var lastActivityAt = Date.now();
  var attentionActive = true;
  var pageVisible = !document.hidden;
  var pageFocused = document.hasFocus();
  var sessionStartTime = Date.now();
  var navigationHistory = [];
  var interactionHistory = [];
  var readingBehaviorData = {
    averageReadingSpeed: 0,
    readingConsistency: 0,
    comprehensionIndicators: [],
    attentionQuality: 'unknown'
  };

  // Behavioral intelligence tracking
  var behavioralIntelligence = {
    navigationPattern: 'linear', // linear, exploratory, focused, scattered
    interactionDensity: 0,
    engagementTrend: 'stable',
    conversionSignals: 0,
    riskFactors: [],
    personalityIndicators: []
  };

  function markActivity() { 
    lastActivityAt = Date.now(); 
    trackInteractionQuality();
  }

  function trackInteractionQuality() {
    var now = Date.now();
    interactionHistory.push(now);
    // Keep only last 30 seconds of interactions
    interactionHistory = interactionHistory.filter(t => now - t < 30000);
    
    // Calculate interaction density (interactions per minute)
    var interactionsPerMinute = interactionHistory.length * 2; // 30s * 2 = 1min
    behavioralIntelligence.interactionDensity = interactionsPerMinute;
    
    // Classify interaction quality
    if (interactionsPerMinute > 20) {
      behavioralIntelligence.personalityIndicators.push('high_interactor');
    } else if (interactionsPerMinute < 5) {
      behavioralIntelligence.personalityIndicators.push('contemplative_reader');
    }
  }

  function computeAttentionActive() {
    var notIdle = (Date.now() - lastActivityAt) < IDLE_TIMEOUT_MS;
    var previouslyActive = attentionActive;
    attentionActive = pageVisible && pageFocused && notIdle;
    
    // Track attention quality changes
    if (previouslyActive !== attentionActive) {
      queueEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'attention_state_change',
        currentSection: currentSectionId,
        timestamp: nowISO(),
        data: {
          attentionActive: attentionActive,
          reason: !pageVisible ? 'tab_hidden' : !pageFocused ? 'window_unfocused' : 'idle_timeout',
          sessionDuration: Date.now() - sessionStartTime
        }
      });
    }
  }

  // Enhanced activity tracking with behavioral analysis
  ['mousemove','keydown','wheel','touchstart','scroll','click'].forEach(function(ev){
    window.addEventListener(ev, function(e) {
      markActivity();
      analyzeInteractionBehavior(ev, e);
    }, { passive: true });
  });

  function analyzeInteractionBehavior(eventType, event) {
    var now = Date.now();
    
    // Analyze scroll behavior for reading patterns
    if (eventType === 'scroll') {
      var scrollSpeed = Math.abs(window.scrollY - (window.lastScrollY || 0));
      var scrollDirection = window.scrollY > (window.lastScrollY || 0) ? 'down' : 'up';
      window.lastScrollY = window.scrollY;
      
      // Estimate reading speed based on scroll behavior
      if (scrollSpeed < 100 && scrollDirection === 'down') {
        // Likely reading behavior
        var estimatedWordsInView = estimateWordsInViewport();
        var timeSinceLastScroll = now - (window.lastScrollTime || now);
        if (timeSinceLastScroll > 2000 && estimatedWordsInView > 0) {
          var readingSpeed = (estimatedWordsInView / timeSinceLastScroll) * 60000; // WPM
          READING_SPEED_SAMPLES.push({ speed: readingSpeed, timestamp: now });
          // Keep only recent samples
          READING_SPEED_SAMPLES = READING_SPEED_SAMPLES.filter(s => now - s.timestamp < 60000);
          updateReadingBehaviorAnalysis();
        }
      }
      window.lastScrollTime = now;
    }

    // Analyze click patterns
    if (eventType === 'click') {
      var clickTarget = event.target;
      var isContentLink = clickTarget.tagName === 'A' || clickTarget.closest('a');
      var isInteractiveElement = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(clickTarget.tagName);
      
      if (isContentLink) {
        queueHighPriorityEvent({
          inquiryId: INQUIRY_ID,
          sessionId: SESSION_ID,
          eventType: 'content_link_click',
          currentSection: currentSectionId,
          timestamp: nowISO(),
          data: {
            linkText: clickTarget.textContent || clickTarget.alt || 'unknown',
            linkHref: clickTarget.href || clickTarget.closest('a')?.href,
            linkContext: getLinkContext(clickTarget),
            conversionSignal: isConversionLink(clickTarget) ? 1 : 0
          }
        });
      }
    }
  }

  function estimateWordsInViewport() {
    var textContent = '';
    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      function(node) {
        var rect = node.parentElement?.getBoundingClientRect();
        if (!rect) return NodeFilter.FILTER_SKIP;
        return (rect.top < window.innerHeight && rect.bottom > 0) ? 
               NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    );
    
    var node;
    while (node = walker.nextNode()) {
      textContent += node.textContent + ' ';
    }
    
    return textContent.trim().split(/\s+/).length;
  }

  function updateReadingBehaviorAnalysis() {
    if (READING_SPEED_SAMPLES.length < 3) return;
    
    var speeds = READING_SPEED_SAMPLES.map(s => s.speed);
    var avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    var consistency = calculateConsistency(speeds);
    
    readingBehaviorData.averageReadingSpeed = Math.round(avgSpeed);
    readingBehaviorData.readingConsistency = consistency;
    
    // Classify reading behavior
    if (avgSpeed > 300) {
      readingBehaviorData.attentionQuality = 'scanning';
      behavioralIntelligence.personalityIndicators.push('fast_scanner');
    } else if (avgSpeed > 150) {
      readingBehaviorData.attentionQuality = 'normal_reading';
    } else if (avgSpeed > 50) {
      readingBehaviorData.attentionQuality = 'careful_reading';
      behavioralIntelligence.personalityIndicators.push('detail_oriented');
    } else {
      readingBehaviorData.attentionQuality = 'deep_contemplation';
      behavioralIntelligence.personalityIndicators.push('thoughtful_analyzer');
    }
  }

  function calculateConsistency(values) {
    if (values.length < 2) return 0;
    var mean = values.reduce((a, b) => a + b, 0) / values.length;
    var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    var stdDev = Math.sqrt(variance);
    return Math.max(0, 100 - (stdDev / mean * 100)); // Higher score = more consistent
  }

  function isConversionLink(element) {
    var href = element.href || element.closest('a')?.href || '';
    var text = (element.textContent || '').toLowerCase();
    var conversionKeywords = [
      'contact', 'enquire', 'apply', 'book', 'visit', 'tour', 'call',
      'email', 'register', 'download', 'brochure', 'prospectus'
    ];
    return conversionKeywords.some(keyword => 
      text.includes(keyword) || href.includes(keyword)
    );
  }

  function getLinkContext(element) {
    var section = element.closest('[data-track-section]');
    var sectionId = section?.getAttribute('data-track-section') || 'unknown';
    var parentText = element.parentElement?.textContent?.slice(0, 100) || '';
    return {
      section: sectionId,
      parentContext: parentText,
      position: getElementPosition(element)
    };
  }

  function getElementPosition(element) {
    var rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      viewportPct: {
        x: Math.round((rect.left + rect.width / 2) / window.innerWidth * 100),
        y: Math.round((rect.top + rect.height / 2) / window.innerHeight * 100)
      }
    };
  }

  document.addEventListener('visibilitychange', function(){
    pageVisible = !document.hidden;
    computeAttentionActive();
  });
  
  window.addEventListener('focus', function(){ 
    pageFocused = true; 
    computeAttentionActive(); 
  });
  
  window.addEventListener('blur', function(){ 
    pageFocused = false; 
    computeAttentionActive(); 
  });

  // ---------- Enhanced Dwell Accumulator ----------
  var dwell = { 
    lastAt: Date.now(), 
    unsentMs: 0, 
    lastSentAt: null,
    qualityMetrics: {
      focusedTime: 0,
      distractedTime: 0,
      qualityScore: 0
    }
  };

  function dwellAccumulate() {
    var now = Date.now();
    var deltaMs = now - (dwell.lastAt || now);
    
    if (attentionActive) {
      dwell.unsentMs += deltaMs;
      // Track quality of attention
      if (behavioralIntelligence.interactionDensity > 5 && behavioralIntelligence.interactionDensity < 15) {
        dwell.qualityMetrics.focusedTime += deltaMs;
      } else {
        dwell.qualityMetrics.distractedTime += deltaMs;
      }
    }
    
    // Calculate attention quality score
    var totalTime = dwell.qualityMetrics.focusedTime + dwell.qualityMetrics.distractedTime;
    if (totalTime > 0) {
      dwell.qualityMetrics.qualityScore = Math.round(
        (dwell.qualityMetrics.focusedTime / totalTime) * 100
      );
    }
    
    dwell.lastAt = now;
  }

  function getDeviceInfo(){
    var ua = navigator.userAgent || '';
    var viewport = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
    var connection = navigator.connection || {};
    
    function pick(re){ var m = re.exec(ua); return m ? m[0] : 'unknown'; }
    
    return {
      userAgent: ua,
      viewport: viewport,
      deviceType: /Mobi|Android/i.test(ua) ? 'mobile' : 'desktop',
      operatingSystem: pick(/Mac|Win|Linux|Android|iPhone|iPad|iOS/),
      browser: pick(/Chrome|Edg|Firefox|Safari/),
      screenResolution: screen.width + 'x' + screen.height,
      colorDepth: screen.colorDepth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      connectionType: connection.effectiveType || 'unknown',
      deviceMemory: navigator.deviceMemory || 'unknown'
    };
  }

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
        deviceInfo: getDeviceInfo(),
        qualityMetrics: dwell.qualityMetrics,
        behavioralIntelligence: behavioralIntelligence,
        readingBehaviorData: readingBehaviorData
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
      // Next heartbeat will retry
    }
  }

  // Enhanced attention and behavior analysis
  setInterval(function(){
    computeAttentionActive();
    dwellAccumulate();
    updateBehavioralIntelligence();
  }, 1000);

  function updateBehavioralIntelligence() {
    var now = Date.now();
    var sessionDuration = now - sessionStartTime;
    
    // Update navigation pattern analysis
    if (navigationHistory.length >= 3) {
      var recentNavigation = navigationHistory.slice(-5);
      var uniqueSections = new Set(recentNavigation.map(n => n.sectionId)).size;
      var totalNavs = recentNavigation.length;
      
      if (uniqueSections / totalNavs < 0.3) {
        behavioralIntelligence.navigationPattern = 'focused';
      } else if (uniqueSections / totalNavs > 0.8) {
        behavioralIntelligence.navigationPattern = 'exploratory';
      } else {
        var isLinear = checkLinearProgression(recentNavigation);
        behavioralIntelligence.navigationPattern = isLinear ? 'linear' : 'scattered';
      }
    }
    
    // Detect conversion signals
    var conversionCount = eventQueue.concat(highPriorityQueue)
      .filter(e => e.data?.conversionSignal === 1).length;
    behavioralIntelligence.conversionSignals = conversionCount;
    
    // Update engagement trend
    var currentEngagementLevel = calculateCurrentEngagementLevel();
    updateEngagementTrend(currentEngagementLevel);
  }

  function checkLinearProgression(navigationHistory) {
    // Check if user is following a logical section progression
    var sectionOrder = {
      'about_more_house': 1,
      'academic_excellence': 2,
      'creative_arts_hero': 3,
      'discover_video': 4,
      'ethical_leaders': 5,
      'contact': 6
    };
    
    var positions = navigationHistory
      .map(n => sectionOrder[n.sectionId] || 0)
      .filter(p => p > 0);
    
    if (positions.length < 2) return true;
    
    var increasingCount = 0;
    for (var i = 1; i < positions.length; i++) {
      if (positions[i] >= positions[i-1]) increasingCount++;
    }
    
    return (increasingCount / (positions.length - 1)) > 0.7;
  }

  function calculateCurrentEngagementLevel() {
    var timeSpent = dwell.qualityMetrics.focusedTime + dwell.qualityMetrics.distractedTime;
    var qualityScore = dwell.qualityMetrics.qualityScore;
    var interactionDensity = behavioralIntelligence.interactionDensity;
    
    return Math.round(
      (timeSpent / 1000 * 0.3) +
      (qualityScore * 0.4) +
      (Math.min(interactionDensity, 20) / 20 * 30)
    );
  }

  var engagementHistory = [];
  function updateEngagementTrend(currentLevel) {
    var now = Date.now();
    engagementHistory.push({ level: currentLevel, timestamp: now });
    
    // Keep only last 5 minutes of data
    engagementHistory = engagementHistory.filter(e => now - e.timestamp < 300000);
    
    if (engagementHistory.length < 3) return;
    
    var recent = engagementHistory.slice(-3);
    var trend = calculateTrend(recent.map(r => r.level));
    
    if (trend > 0.2) {
      behavioralIntelligence.engagementTrend = 'increasing';
    } else if (trend < -0.2) {
      behavioralIntelligence.engagementTrend = 'decreasing';
    } else {
      behavioralIntelligence.engagementTrend = 'stable';
    }
  }

  function calculateTrend(values) {
    if (values.length < 2) return 0;
    var n = values.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    for (var i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumXX += i * i;
    }
    
    return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  }

  // ---------- Enhanced Section Registry ----------
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
  var sectionState = new Map();
  
  sectionEls.forEach(function(el){
    var id = el.getAttribute('data-track-section');
    sectionState.set(id, { 
      enteredAt: null, 
      lastTickAt: null, 
      attentionSec: 0, 
      maxScrollPct: 0, 
      clicks: 0, 
      videoSec: 0,
      returnVisits: 0,
      interactionQuality: 0,
      readingSpeed: 0,
      estimatedWords: 0,
      comprehensionScore: 0
    });
  });

  function sectionScrollPct(el){
    var rect = el.getBoundingClientRect();
    var total = el.scrollHeight || el.offsetHeight || (rect.height || 1);
    var viewportTop = window.scrollY;
    var viewportBottom = viewportTop + window.innerHeight;
    var elementTop = el.offsetTop;
    var elementBottom = elementTop + total;
    
    var visibleTop = Math.max(viewportTop, elementTop);
    var visibleBottom = Math.min(viewportBottom, elementBottom);
    var visibleHeight = Math.max(0, visibleBottom - visibleTop);
    
    var scrolled = visibleHeight;
    var pct = Math.max(0, Math.min(100, (scrolled/total)*100));
    return Math.round(pct);
  }

  // ---------- Enhanced IntersectionObserver ----------
  var currentSectionId = null;
  var currentSectionEl = null;
  var lastSectionScrollSent = new Map();

  function buildThresholds(n){ 
    var a=[]; 
    for (var i=0;i<=n;i++) a.push(i/n); 
    return a; 
  }

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
        bestRatio = e.intersectionRatio; 
        candidate = e.target;
      }
    }
    if (candidate) enterSection(candidate);
    if (currentSectionEl && !isMostlyVisible(currentSectionEl)) exitCurrentSection();
  }, { threshold: buildThresholds(20) });

  sectionEls.forEach(function(el){ io.observe(el); });

  function queueEvent(ev){ eventQueue.push(ev); }
  function queueHighPriorityEvent(ev){ highPriorityQueue.push(ev); }
  function nowISO(){ return new Date().toISOString(); }

  function enterSection(el){
    var id = el.getAttribute('data-track-section');
    if (currentSectionId === id) return;
    
    if (currentSectionId) exitCurrentSection();
    
    var previousSection = currentSectionId;
    currentSectionId = id;
    currentSectionEl = el;
    
    var st = sectionState.get(id) || { 
      attentionSec: 0, maxScrollPct: 0, clicks: 0, videoSec: 0, 
      returnVisits: 0, interactionQuality: 0 
    };
    
    // Check if this is a return visit
    if (st.attentionSec > 0) {
      st.returnVisits += 1;
    }
    
    st.enteredAt = Date.now();
    st.lastTickAt = Date.now();
    sectionState.set(id, st);
    
    // Track navigation flow
    navigationHistory.push({
      sectionId: id,
      previousSection: previousSection,
      timestamp: Date.now(),
      entryMethod: determineEntryMethod(el, previousSection)
    });

    // Enhanced section enter event
    queueEvent({
      inquiryId: INQUIRY_ID, 
      sessionId: SESSION_ID, 
      eventType: 'section_enter_enhanced',
      currentSection: id, 
      url: location.href, 
      timestamp: nowISO(),
      data: { 
        deviceInfo: getDeviceInfo(),
        previousSection: previousSection,
        isReturnVisit: st.returnVisits > 0,
        navigationPath: getRecentNavigationPath(),
        entryMethod: determineEntryMethod(el, previousSection),
        estimatedSectionWords: estimateWordsInSection(el),
        sectionPosition: getSectionPosition(el),
        behavioralContext: {
          sessionDuration: Date.now() - sessionStartTime,
          totalSectionsVisited: sectionState.size,
          averageTimePerSection: calculateAverageTimePerSection()
        }
      }
    });
  }

  function determineEntryMethod(element, previousSection) {
    var rect = element.getBoundingClientRect();
    if (rect.top <= 0 && rect.bottom > window.innerHeight) {
      return 'scroll_through';
    } else if (rect.top < window.innerHeight / 2) {
      return 'scroll_down';
    } else {
      return previousSection ? 'navigation' : 'direct_entry';
    }
  }

  function getRecentNavigationPath() {
    return navigationHistory
      .slice(-5)
      .map(n => n.sectionId)
      .join(' → ');
  }

  function estimateWordsInSection(element) {
    var textContent = element.textContent || '';
    return textContent.trim().split(/\s+/).length;
  }

  function getSectionPosition(element) {
    var allSections = Array.from(document.querySelectorAll('[data-track-section]'));
    var index = allSections.indexOf(element);
    return {
      index: index,
      total: allSections.length,
      percentageThrough: Math.round((index / Math.max(1, allSections.length - 1)) * 100)
    };
  }

  function calculateAverageTimePerSection() {
    var totalTime = 0;
    var sectionsWithTime = 0;
    sectionState.forEach(function(state) {
      if (state.attentionSec > 0) {
        totalTime += state.attentionSec;
        sectionsWithTime++;
      }
    });
    return sectionsWithTime > 0 ? Math.round(totalTime / sectionsWithTime) : 0;
  }

  function exitCurrentSection(){
    if (!currentSectionId) return;
    
    var id = currentSectionId;
    var el = currentSectionEl;
    var st = sectionState.get(id);
    
    if (st){
      var now = Date.now();
      var sessionDuration = 0;
      
      if (attentionActive && st.lastTickAt) {
        sessionDuration = Math.max(0, Math.round((now - st.lastTickAt) / 1000));
        st.attentionSec += sessionDuration;
      }
      
      st.enteredAt = null; 
      st.lastTickAt = null;
      st.maxScrollPct = Math.max(st.maxScrollPct, sectionScrollPct(el));
      
      // Calculate interaction quality for this section visit
      var interactionQuality = calculateSectionInteractionQuality(st, sessionDuration);
      st.interactionQuality = interactionQuality;
      
      // Enhanced section exit event
      queueEvent({
        inquiryId: INQUIRY_ID, 
        sessionId: SESSION_ID, 
        eventType: 'section_exit_enhanced',
        currentSection: id, 
        url: location.href, 
        timestamp: nowISO(),
        data: { 
          timeInSectionSec: st.attentionSec,
          thisVisitSeconds: sessionDuration,
          maxScrollPct: st.maxScrollPct, 
          clicks: st.clicks, 
          videoWatchSec: st.videoSec,
          returnVisits: st.returnVisits,
          interactionQuality: interactionQuality,
          readingSpeed: calculateSectionReadingSpeed(st, el),
          comprehensionScore: estimateComprehensionScore(st, sessionDuration),
          engagementScore: calculateSectionEngagementScore(st),
          deviceInfo: getDeviceInfo(),
          conversionSignals: detectConversionSignals(st, id),
          riskFactors: detectRiskFactors(st, sessionDuration)
        }
      });
    }
    
    currentSectionId = null; 
    currentSectionEl = null;
  }

  function calculateSectionInteractionQuality(sectionState, sessionDuration) {
    if (sessionDuration === 0) return 0;
    
    var clicksPerSecond = sectionState.clicks / Math.max(sessionDuration, 1);
    var scrollProgress = sectionState.maxScrollPct / 100;
    var timeQuality = sessionDuration >= 5 ? 1 : sessionDuration / 5; // 5+ seconds = good
    
    var quality = (
      (Math.min(clicksPerSecond * 10, 1) * 30) + // Clicks contribute 30%
      (scrollProgress * 40) +                     // Scroll depth 40%
      (timeQuality * 30)                          // Time quality 30%
    );
    
    return Math.round(Math.min(quality, 100));
  }

  function calculateSectionReadingSpeed(sectionState, element) {
    if (sectionState.attentionSec === 0) return 0;
    
    var estimatedWords = estimateWordsInSection(element);
    var readingTimeMinutes = sectionState.attentionSec / 60;
    
    return Math.round(estimatedWords / Math.max(readingTimeMinutes, 0.1));
  }

  function estimateComprehensionScore(sectionState, sessionDuration) {
    var scrollCompleteness = sectionState.maxScrollPct / 100;
    var timeAdequacy = Math.min(sessionDuration / 30, 1); // 30 seconds for good comprehension
    var interactionLevel = Math.min(sectionState.clicks / 3, 1); // 3+ clicks shows engagement
    
    return Math.round((scrollCompleteness * 40 + timeAdequacy * 40 + interactionLevel * 20));
  }

  function calculateSectionEngagementScore(sectionState) {
    var timeScore = Math.min(sectionState.attentionSec / 60, 1) * 25; // 1 minute = full time score
    var scrollScore = (sectionState.maxScrollPct / 100) * 25;
    var clickScore = Math.min(sectionState.clicks / 2, 1) * 25; // 2+ clicks = full click score
    var returnScore = Math.min(sectionState.returnVisits, 2) * 12.5; // 2+ returns = full return score
    
    return Math.round(timeScore + scrollScore + clickScore + returnScore);
  }

  function detectConversionSignals(sectionState, sectionId) {
    var signals = [];
    
    // High engagement signals
    if (sectionState.attentionSec > 60) signals.push('deep_engagement');
    if (sectionState.maxScrollPct >= 90) signals.push('complete_consumption');
    if (sectionState.returnVisits > 0) signals.push('return_interest');
    if (sectionState.clicks > 3) signals.push('high_interaction');
    
    // Section-specific signals
    if (sectionId === 'contact' && sectionState.attentionSec > 30) signals.push('contact_interest');
    if (sectionId.includes('admissions') && sectionState.attentionSec > 45) signals.push('admissions_focus');
    
    return signals;
  }

  function detectRiskFactors(sectionState, sessionDuration) {
    var risks = [];
    
    if (sessionDuration < 5) risks.push('insufficient_time');
    if (sectionState.maxScrollPct < 25) risks.push('low_scroll_engagement');
    if (sectionState.clicks === 0 && sessionDuration > 30) risks.push('passive_consumption');
    
    return risks;
  }

  // Enhanced attention tracking with quality metrics
  setInterval(function(){
    if (!currentSectionId) return;
    
    var st = sectionState.get(currentSectionId);
    if (!st) return;
    
    var now = Date.now();
    if (attentionActive && st.lastTickAt){
      var deltaSeconds = Math.max(0, Math.round((now - st.lastTickAt)/1000));
      st.attentionSec += deltaSeconds;
      st.maxScrollPct = Math.max(st.maxScrollPct, sectionScrollPct(currentSectionEl));
      
      // Update reading behavior analysis
      if (deltaSeconds > 0) {
        updateSectionReadingAnalysis(st, deltaSeconds);
      }
    }
    st.lastTickAt = now;
    
    // Enhanced scroll tracking
    var lastSent = lastSectionScrollSent.get(currentSectionId) || 0;
    if (st.maxScrollPct - lastSent >= SCROLL_DELTA_MIN){
      lastSectionScrollSent.set(currentSectionId, st.maxScrollPct);
      queueEvent({
        inquiryId: INQUIRY_ID, 
        sessionId: SESSION_ID, 
        eventType: 'section_scroll_enhanced',
        currentSection: currentSectionId, 
        url: location.href, 
        timestamp: nowISO(),
        data: { 
          maxScrollPct: st.maxScrollPct,
          scrollSpeed: calculateScrollSpeed(),
          readingBehavior: analyzeCurrentReadingBehavior(),
          attentionQuality: readingBehaviorData.attentionQuality
        }
      });
    }
  }, 2000);

  var lastScrollPosition = 0;
  var lastScrollTime = Date.now();

  function calculateScrollSpeed() {
    var currentPosition = window.scrollY;
    var currentTime = Date.now();
    var speed = Math.abs(currentPosition - lastScrollPosition) / Math.max(currentTime - lastScrollTime, 1);
    lastScrollPosition = currentPosition;
    lastScrollTime = currentTime;
    return Math.round(speed * 1000); // pixels per second
  }

  function analyzeCurrentReadingBehavior() {
    return {
      averageReadingSpeed: readingBehaviorData.averageReadingSpeed,
      readingConsistency: readingBehaviorData.readingConsistency,
      attentionQuality: readingBehaviorData.attentionQuality,
      interactionDensity: behavioralIntelligence.interactionDensity
    };
  }

  function updateSectionReadingAnalysis(sectionState, deltaSeconds) {
    // This would be called every 2 seconds to update reading analysis
    var estimatedWordsRead = estimateWordsInCurrentView();
    if (estimatedWordsRead > 0 && deltaSeconds > 0) {
      var readingSpeed = (estimatedWordsRead / deltaSeconds) * 60; // WPM
      READING_SPEED_SAMPLES.push({ 
        speed: readingSpeed, 
        timestamp: Date.now(),
        section: currentSectionId 
      });
    }
  }

  function estimateWordsInCurrentView() {
    if (!currentSectionEl) return 0;
    
    var rect = currentSectionEl.getBoundingClientRect();
    var viewportTop = Math.max(0, -rect.top);
    var viewportBottom = Math.min(rect.height, window.innerHeight - rect.top);
    var visibleHeight = Math.max(0, viewportBottom - viewportTop);
    var visibleRatio = visibleHeight / Math.max(rect.height, 1);
    
    var totalWords = estimateWordsInSection(currentSectionEl);
    return Math.round(totalWords * visibleRatio);
  }

  // Enhanced click attribution
  document.addEventListener('click', function(e){
    if (!currentSectionId) return;
    
    var st = sectionState.get(currentSectionId);
    if (st) st.clicks += 1;
    
    // Analyze click quality and intent
    var clickAnalysis = analyzeClickIntent(e);
    if (clickAnalysis.isSignificant) {
      queueHighPriorityEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'significant_click',
        currentSection: currentSectionId,
        timestamp: nowISO(),
        data: {
          clickAnalysis: clickAnalysis,
          conversionPotential: clickAnalysis.conversionScore,
          behavioralContext: behavioralIntelligence
        }
      });
    }
  }, { capture: true });

  function analyzeClickIntent(event) {
    var target = event.target;
    var isLink = target.tagName === 'A' || target.closest('a');
    var isButton = target.tagName === 'BUTTON' || target.hasAttribute('role') && target.getAttribute('role') === 'button';
    var isForm = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
    
    var clickText = target.textContent || target.alt || target.title || '';
    var conversionKeywords = ['contact', 'enquire', 'apply', 'book', 'visit', 'download', 'call'];
    var hasConversionKeyword = conversionKeywords.some(kw => clickText.toLowerCase().includes(kw));
    
    var conversionScore = 0;
    if (hasConversionKeyword) conversionScore += 50;
    if (isForm) conversionScore += 30;
    if (isButton && !isLink) conversionScore += 20;
    
    return {
      isSignificant: conversionScore > 0 || isForm,
      conversionScore: conversionScore,
      elementType: target.tagName,
      clickText: clickText.slice(0, 100),
      isConversionAction: hasConversionKeyword
    };
  }

  // ---------- Fixed YouTube Video Tracking ----------
  var ytPlayers = new Map();

  function ensureYTAPI(){
    if (window.YT && window.YT.Player){ 
      initYouTubePlayers(); 
      return; 
    }
    if (document.getElementById('youtube-iframe-api')) return;
    
    var tag = document.createElement('script');
    tag.id = 'youtube-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  // Simple YouTube API ready handler - no complex wrapper
  var originalYTReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function() {
    // Call original if it exists (from prospectus template)
    if (typeof originalYTReady === 'function') {
      try { originalYTReady(); } catch(e) {}
    }
    
    // Initialize our tracking
    initYouTubePlayers();
  };

  function initYouTubePlayers() {
    if (!window.YT || !window.YT.Player) return;
    
    var iframes = document.querySelectorAll('iframe[src*="youtube.com"], iframe[src*="youtu.be"]');
    
    iframes.forEach(function(iframe, idx) {
      if (iframe.dataset.ytTracked) return; // Skip if already tracked
      iframe.dataset.ytTracked = 'true';
      
      if (!iframe.id) {
        iframe.id = 'yt-tracker-' + idx + '-' + Date.now();
      }
      
      var container = iframe.closest('[data-track-section]');
      var sectionId = container ? container.getAttribute('data-track-section') : 'unknown';
      
      // Wait a moment for iframe to be ready
      setTimeout(function() {
        try {
          var player = new YT.Player(iframe.id, {
            events: {
              'onStateChange': function(e) { handleYTStateChange(iframe.id, sectionId, e); },
              'onReady': function(e) { handleYTReady(iframe.id, sectionId, e); }
            }
          });
          
          ytPlayers.set(iframe.id, {
            player: player,
            sectionId: sectionId,
            lastState: -1,
            playStartedAt: null,
            watchedSec: 0,
            milestones: {},
            qualityMetrics: { pauseCount: 0, seekCount: 0, replayCount: 0, engagementScore: 0 }
          });
          
        } catch(error) {
          console.warn('YouTube tracking failed for:', iframe.id, error);
        }
      }, 1000);
    });
  }

  function handleYTReady(iframeId, sectionId, event) {
    var P = ytPlayers.get(iframeId);
    if (!P) return;
    
    var videoId = getVideoId(P.player);
    console.log('YouTube player ready:', videoId);
    
    queueEvent({
      inquiryId: INQUIRY_ID,
      sessionId: SESSION_ID,
      eventType: 'youtube_video_ready',
      currentSection: sectionId,
      timestamp: nowISO(),
      data: { videoId: videoId }
    });
  }

  function handleYTStateChange(iframeId, sectionId, event) {
    var P = ytPlayers.get(iframeId);
    if (!P) return;
    
    var state = event.data;
    var now = Date.now();
    var videoId = getVideoId(P.player);
    
    console.log('YouTube state change:', videoId, state);

    // Playing
    if (state === 1) {
      P.playStartedAt = now;
      P.lastState = 1;
      
      queueHighPriorityEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'youtube_video_play',
        currentSection: sectionId,
        timestamp: nowISO(),
        data: { videoId: videoId }
      });
    }

    // Calculate watch time when leaving playing state
    if (P.lastState === 1 && state !== 1 && P.playStartedAt) {
      var watchSeconds = Math.max(0, Math.round((now - P.playStartedAt) / 1000));
      P.watchedSec += watchSeconds;
      P.playStartedAt = null;
      
      // Update section video time
      var st = sectionState.get(sectionId);
      if (st) st.videoSec += watchSeconds;
      
      // Track milestones
      var duration = getDuration(P.player);
      if (duration > 0) {
        var progressPct = Math.floor((P.watchedSec / duration) * 100);
        [25, 50, 75, 90].forEach(function(milestone) {
          if (progressPct >= milestone && !P.milestones[milestone]) {
            P.milestones[milestone] = true;
            queueHighPriorityEvent({
              inquiryId: INQUIRY_ID,
              sessionId: SESSION_ID,
              eventType: 'youtube_video_milestone',
              currentSection: sectionId,
              timestamp: nowISO(),
              data: { videoId: videoId, milestone: milestone, totalWatchTime: P.watchedSec }
            });
          }
        });
      }
    }

    // Paused
    if (state === 2) {
      P.qualityMetrics.pauseCount++;
      queueEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'youtube_video_pause',
        currentSection: sectionId,
        timestamp: nowISO(),
        data: { videoId: videoId, pauseCount: P.qualityMetrics.pauseCount }
      });
    }

    // Ended
    if (state === 0) {
      var duration = getDuration(P.player);
      var completionRate = duration > 0 ? Math.round((P.watchedSec / duration) * 100) : 0;
      
      queueHighPriorityEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'youtube_video_complete',
        currentSection: sectionId,
        timestamp: nowISO(),
        data: {
          videoId: videoId,
          totalWatchTime: P.watchedSec,
          completionRate: completionRate
        }
      });
    }

    P.lastState = state;
  }

  function getVideoId(player) {
    try {
      var videoData = player.getVideoData();
      return videoData ? videoData.video_id : 'unknown';
    } catch(e) {
      return 'unknown';
    }
  }

  function getDuration(player) {
    try {
      return player.getDuration() || 0;
    } catch(e) {
      return 0;
    }
  }

  // Initialize on load
  ensureYTAPI();

  // Also try to initialize when new iframes are added (for modal videos)
  var iframeObserver = new MutationObserver(function(mutations) {
    var hasNewIframes = false;
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        if (node.nodeType === 1 && (
            node.tagName === 'IFRAME' || 
            node.querySelector && node.querySelector('iframe[src*="youtube"]')
        )) {
          hasNewIframes = true;
        }
      });
    });
    
    if (hasNewIframes) {
      setTimeout(initYouTubePlayers, 1000);
    }
  });
  
  iframeObserver.observe(document.body, { childList: true, subtree: true });

  // ---------- Enhanced Batching + Heartbeat ----------
  function estimateAttentionTotal(){
    var total = 0;
    sectionState.forEach(function(st){ total += (st.attentionSec || 0); });
    return total;
  }

  function generateSessionIntelligence() {
    var sessionDuration = Date.now() - sessionStartTime;
    var totalAttentionTime = estimateAttentionTotal();
    var sectionsVisited = Array.from(sectionState.keys()).filter(id => {
      var st = sectionState.get(id);
      return st && st.attentionSec > 0;
    });

    return {
      sessionDuration: Math.round(sessionDuration / 1000),
      totalAttentionTime: totalAttentionTime,
      attentionEfficiency: totalAttentionTime > 0 ? Math.round((totalAttentionTime / (sessionDuration / 1000)) * 100) : 0,
      sectionsEngaged: sectionsVisited.length,
      navigationPattern: behavioralIntelligence.navigationPattern,
      engagementTrend: behavioralIntelligence.engagementTrend,
      conversionSignals: behavioralIntelligence.conversionSignals,
      readingBehavior: readingBehaviorData,
      predictedEngagementScore: calculatePredictedEngagementScore(),
      conversionProbability: calculateConversionProbability(),
      recommendedActions: generateRecommendedActions()
    };
  }

  function calculatePredictedEngagementScore() {
    var baseScore = 0;
    var totalSections = sectionState.size;
    var engagedSections = 0;
    
    sectionState.forEach(function(st) {
      if (st.attentionSec > 0) {
        engagedSections++;
        baseScore += Math.min(st.attentionSec / 60, 1) * 20; // Max 20 points per section
        baseScore += (st.maxScrollPct / 100) * 15; // Max 15 points for scroll depth
        baseScore += Math.min(st.clicks / 3, 1) * 10; // Max 10 points for clicks
        baseScore += st.returnVisits * 5; // 5 points per return visit
      }
    });
    
    // Behavioral bonuses
    if (behavioralIntelligence.navigationPattern === 'focused') baseScore += 10;
    if (behavioralIntelligence.engagementTrend === 'increasing') baseScore += 15;
    if (readingBehaviorData.attentionQuality === 'careful_reading') baseScore += 10;
    
    // Conversion signal multiplier
    baseScore *= (1 + behavioralIntelligence.conversionSignals * 0.1);
    
    return Math.min(Math.round(baseScore), 100);
  }

  function calculateConversionProbability() {
    var engagementScore = calculatePredictedEngagementScore();
    var timeSpent = estimateAttentionTotal();
    var sectionsEngaged = Array.from(sectionState.values()).filter(st => st.attentionSec > 0).length;
    var conversionSignals = behavioralIntelligence.conversionSignals;
    
    var probability = 0;
    
    // Base probability from engagement
    if (engagementScore > 80) probability += 40;
    else if (engagementScore > 60) probability += 30;
    else if (engagementScore > 40) probability += 20;
    else probability += 10;
    
    // Time spent factor
    if (timeSpent > 300) probability += 30; // 5+ minutes
    else if (timeSpent > 180) probability += 20; // 3+ minutes
    else if (timeSpent > 60) probability += 10; // 1+ minute
    
    // Section coverage
    probability += Math.min(sectionsEngaged * 5, 20);
    
    // Conversion signals
    probability += conversionSignals * 10;
    
    // Behavioral factors
    if (behavioralIntelligence.engagementTrend === 'increasing') probability += 10;
    if (readingBehaviorData.attentionQuality === 'careful_reading') probability += 5;
    
    return Math.min(Math.round(probability), 100);
  }

  function generateRecommendedActions() {
    var actions = [];
    var conversionProbability = calculateConversionProbability();
    var engagementScore = calculatePredictedEngagementScore();
    
    if (conversionProbability > 70) {
      actions.push({
        action: 'immediate_contact',
        priority: 'high',
        reason: 'High conversion probability detected',
        timing: 'within_2_hours'
      });
    } else if (conversionProbability > 50) {
      actions.push({
        action: 'priority_followup',
        priority: 'medium',
        reason: 'Strong engagement signals',
        timing: 'within_24_hours'
      });
    }
    
    if (behavioralIntelligence.engagementTrend === 'decreasing') {
      actions.push({
        action: 'reengagement_campaign',
        priority: 'medium',
        reason: 'Declining interest detected',
        timing: 'within_4_hours'
      });
    }
    
    // Content-specific recommendations
    var topSections = Array.from(sectionState.entries())
      .filter(([id, st]) => st.attentionSec > 0)
      .sort(([,a], [,b]) => b.attentionSec - a.attentionSec)
      .slice(0, 3)
      .map(([id]) => id);
    
    if (topSections.length > 0) {
      actions.push({
        action: 'personalized_content',
        priority: 'low',
        reason: 'Tailor follow-up to interests',
        data: { topInterests: topSections }
      });
    }
    
    return actions;
  }

  function heartbeat(){
    // Flush partial attention without exiting section
    if (currentSectionId){
      var st = sectionState.get(currentSectionId);
      if (st && attentionActive && st.lastTickAt){
        var now = Date.now();
        st.attentionSec += Math.max(0, Math.round((now - st.lastTickAt)/1000));
        st.lastTickAt = now;
        st.maxScrollPct = Math.max(st.maxScrollPct, sectionScrollPct(currentSectionEl));
      }
    }
    
    // Combine regular and high priority events
    var allEvents = highPriorityQueue.splice(0, highPriorityQueue.length)
                      .concat(eventQueue.splice(0, eventQueue.length));
    
    var sessionIntelligence = generateSessionIntelligence();
    
    var payload = {
      events: allEvents,
      sessionInfo: {
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        timeOnPage: estimateAttentionTotal(),
        maxScrollDepth: Math.max(0, ...Array.from(sectionState.values()).map(function(s){ return s.maxScrollPct; })),
        clickCount: Array.from(sectionState.values()).reduce(function(a,b){ return a + (b.clicks||0); }, 0),
        deviceInfo: getDeviceInfo()
      },
      intelligence: sessionIntelligence,
      behavioralIntelligence: behavioralIntelligence,
      readingBehaviorData: readingBehaviorData
    };
    
    // Always send if there are high-priority events or every 3rd heartbeat for regular updates
    var hasHighPriorityEvents = allEvents.some(e => e.data?.conversionSignal === 1);
    var isRegularUpdate = (Date.now() - sessionStartTime) % (HEARTBEAT_MS * 3) < HEARTBEAT_MS;
    var meaningful = allEvents.length > 0 || hasHighPriorityEvents || isRegularUpdate;
    
    if (!meaningful) return;
    
    try {
      fetch(POST_URL, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch(e) { 
      // Re-queue high priority events on failure
      if (hasHighPriorityEvents) {
        highPriorityQueue.unshift(...allEvents.filter(e => e.data?.conversionSignal === 1));
      }
    }
  }

  // Enhanced heartbeat with dynamic frequency (singleton)
  (function(){
    // Clear any prior heartbeat left by a previous load
    if (window.__SMART_TRACKING_NS__.__HEARTBEAT_HANDLE__) {
      try { clearInterval(window.__SMART_TRACKING_NS__.__HEARTBEAT_HANDLE__); } catch(_) {}
      window.__SMART_TRACKING_NS__.__HEARTBEAT_HANDLE__ = null;
    }

    function startHeartbeat(freqMs, mode){
      if (window.__SMART_TRACKING_NS__.__HEARTBEAT_HANDLE__) {
        try { clearInterval(window.__SMART_TRACKING_NS__.__HEARTBEAT_HANDLE__); } catch(_) {}
      }
      var handle = setInterval(function(){
        heartbeat();
        sendDwellDelta('heartbeat');
        // (the adaptive frequency logic stays below)
        var conversionProbability = calculateConversionProbability();
        var desired = (conversionProbability > 60) ? HEARTBEAT_MS / 2 : HEARTBEAT_MS;
        var currentIsHigh = (mode === 'high');
        if (conversionProbability > 60 && !currentIsHigh) {
          startHeartbeat(HEARTBEAT_MS/2, 'high');
        } else if (conversionProbability <= 60 && currentIsHigh) {
          startHeartbeat(HEARTBEAT_MS, 'normal');
        }
      }, freqMs);
      window.__SMART_TRACKING_NS__.__HEARTBEAT_MODE__ = mode || 'normal';
      window.__SMART_TRACKING_NS__.__HEARTBEAT_HANDLE__ = handle;
    }

    startHeartbeat(HEARTBEAT_MS, 'normal');
  })();

  // ---------- Enhanced Exit Handling ----------
  function flushAndExit(){
    exitCurrentSection();
    
    // Final session summary with complete intelligence
    var finalIntelligence = generateSessionIntelligence();
    queueHighPriorityEvent({
      inquiryId: INQUIRY_ID,
      sessionId: SESSION_ID,
      eventType: 'session_end_summary',
      timestamp: nowISO(),
      data: {
        sessionIntelligence: finalIntelligence,
        finalRecommendations: generateRecommendedActions(),
        sessionValue: assessSessionValue()
      }
    });
    
    heartbeat();
  }

  function assessSessionValue() {
    var conversionProbability = calculateConversionProbability();
    var engagementScore = calculatePredictedEngagementScore();
    var timeSpent = estimateAttentionTotal();
    
    if (conversionProbability > 70) return 'high_value';
    if (conversionProbability > 50 || engagementScore > 70) return 'medium_value';
    if (timeSpent > 60) return 'low_value';
    return 'minimal_value';
  }

  // Enhanced visibility and exit event handling
  document.addEventListener('visibilitychange', function(){
    if (document.hidden) {
      try { 
        dwellAccumulate(); 
        sendDwellDelta('tab_hidden'); 
      } catch(_) {}
      flushAndExit();
    } else {
      // Track return to tab as engagement signal
      queueHighPriorityEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'tab_refocus',
        currentSection: currentSectionId,
        timestamp: nowISO(),
        data: {
          conversionSignal: 1,
          engagementIndicator: 'return_attention'
        }
      });
    }
  });

  window.addEventListener('pagehide', function(){
    try { 
      dwellAccumulate(); 
      sendDwellDelta('pagehide'); 
    } catch(_) {}
  });

  // Guarded final flush to avoid duplicates
  window.addEventListener('beforeunload', (function(){
    var sent = false;
    return function(){
      if (sent) return;
      sent = true;
      try {
        dwellAccumulate();
        // (rest of your existing final dwell send block stays as-is)
      } catch(_) {}
      flushAndExit();
    };
  })(), { capture: true });

  // ---------- Advanced Analytics Dashboard Communication ----------
  
  // Expose real-time analytics for dashboard integration
  window.SMART_ANALYTICS = {
    getCurrentEngagementScore: calculatePredictedEngagementScore,
    getConversionProbability: calculateConversionProbability,
    getBehavioralIntelligence: function() { return behavioralIntelligence; },
    getReadingBehavior: function() { return readingBehaviorData; },
    getSessionIntelligence: generateSessionIntelligence,
    getSectionStates: function() { return Array.from(sectionState.entries()); },
    getRecommendedActions: generateRecommendedActions,
    
    // Force immediate analysis update
    triggerAnalysisUpdate: function() {
      heartbeat();
      sendDwellDelta('manual_trigger');
    },
    
    // Get real-time session stats for dashboard
    getRealtimeStats: function() {
      return {
        sessionDuration: Math.round((Date.now() - sessionStartTime) / 1000),
        totalAttentionTime: estimateAttentionTotal(),
        sectionsVisited: Array.from(sectionState.values()).filter(st => st.attentionSec > 0).length,
        currentSection: currentSectionId,
        engagementScore: calculatePredictedEngagementScore(),
        conversionProbability: calculateConversionProbability(),
        attentionQuality: readingBehaviorData.attentionQuality,
        isHighValue: calculateConversionProbability() > 60
      };
    }
  };

  // ---------- Real-time Dashboard Updates ----------
  
  // Send periodic updates to parent window if in iframe (for dashboard embedding)
  if (window.parent !== window) {
    setInterval(function() {
      try {
        window.parent.postMessage({
          type: 'SMART_ANALYTICS_UPDATE',
          data: window.SMART_ANALYTICS.getRealtimeStats()
        }, '*');
      } catch(e) {}
    }, 5000); // Every 5 seconds
  }

  // ---------- Advanced Conversion Signal Detection ----------
  
  // Track form interactions as high-value conversion signals
  document.addEventListener('focusin', function(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      queueHighPriorityEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'form_field_focus',
        currentSection: currentSectionId,
        timestamp: nowISO(),
        data: {
          fieldType: e.target.type || e.target.tagName,
          fieldName: e.target.name || e.target.id,
          formContext: getFormContext(e.target),
          conversionSignal: 1,
          priority: 'high'
        }
      });
    }
  });

  // Track form submissions as critical conversion events
  document.addEventListener('submit', function(e) {
    queueHighPriorityEvent({
      inquiryId: INQUIRY_ID,
      sessionId: SESSION_ID,
      eventType: 'form_submission',
      currentSection: currentSectionId,
      timestamp: nowISO(),
      data: {
        formId: e.target.id,
        formAction: e.target.action,
        formMethod: e.target.method,
        fieldCount: e.target.elements.length,
        conversionSignal: 1,
        priority: 'critical',
        isConversion: true
      }
    });
  });

  function getFormContext(formElement) {
    var form = formElement.closest('form');
    var section = formElement.closest('[data-track-section]');
    
    return {
      formId: form?.id || 'unknown',
      sectionId: section?.getAttribute('data-track-section') || currentSectionId,
      fieldPosition: getFormFieldPosition(formElement, form),
      formPurpose: identifyFormPurpose(form)
    };
  }

  function getFormFieldPosition(field, form) {
    if (!form) return 0;
    var fields = Array.from(form.querySelectorAll('input, textarea, select'));
    return fields.indexOf(field) + 1;
  }

  function identifyFormPurpose(form) {
    if (!form) return 'unknown';
    
    var formText = (form.textContent || '').toLowerCase();
    var actionText = (form.action || '').toLowerCase();
    
    if (formText.includes('contact') || actionText.includes('contact')) return 'contact';
    if (formText.includes('enquir') || formText.includes('inquir')) return 'enquiry';
    if (formText.includes('apply') || formText.includes('application')) return 'application';
    if (formText.includes('book') || formText.includes('visit')) return 'booking';
    if (formText.includes('newsletter') || formText.includes('subscribe')) return 'newsletter';
    
    return 'general';
  }

  // ---------- Advanced Risk Detection ----------
  
  // Monitor for bounce risk indicators
  var bounceRiskFactors = [];
  
  function monitorBounceRisk() {
    var sessionDuration = Date.now() - sessionStartTime;
    var attentionTime = estimateAttentionTotal();
    var sectionsEngaged = Array.from(sectionState.values()).filter(st => st.attentionSec > 0).length;
    
    // Risk factor detection
    if (sessionDuration > 30000 && attentionTime < 10) {
      bounceRiskFactors.push('low_attention_ratio');
    }
    
    if (sessionDuration > 60000 && sectionsEngaged < 2) {
      bounceRiskFactors.push('limited_exploration');
    }
    
    if (behavioralIntelligence.engagementTrend === 'decreasing') {
      bounceRiskFactors.push('declining_engagement');
    }
    
    if (readingBehaviorData.attentionQuality === 'scanning' && attentionTime < 30) {
      bounceRiskFactors.push('superficial_engagement');
    }
    
    // Send bounce risk alert if multiple factors present
    if (bounceRiskFactors.length >= 2) {
      queueHighPriorityEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'bounce_risk_alert',
        currentSection: currentSectionId,
        timestamp: nowISO(),
        data: {
          riskFactors: bounceRiskFactors,
          riskLevel: bounceRiskFactors.length >= 3 ? 'high' : 'medium',
          recommendedIntervention: suggestBounceIntervention(),
          priority: 'high'
        }
      });
      
      bounceRiskFactors = []; // Reset after alert
    }
  }

  function suggestBounceIntervention() {
    if (currentSectionId && sectionState.get(currentSectionId)?.attentionSec < 5) {
      return 'content_highlighting';
    }
    
    if (behavioralIntelligence.navigationPattern === 'scattered') {
      return 'guided_navigation';
    }
    
    if (readingBehaviorData.attentionQuality === 'scanning') {
      return 'key_points_emphasis';
    }
    
    return 'engagement_prompt';
  }

  // Monitor bounce risk every 30 seconds
  setInterval(monitorBounceRisk, 30000);

  // ---------- Contextual Intelligence ----------
  
  // Track referrer and entry context for better intelligence
  function captureEntryContext() {
    var entryContext = {
      referrer: document.referrer,
      entryPage: location.href,
      entryTime: new Date().toISOString(),
      utmParams: extractUTMParams(),
      deviceContext: getDeviceInfo(),
      timeOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay()
    };
    
    queueEvent({
      inquiryId: INQUIRY_ID,
      sessionId: SESSION_ID,
      eventType: 'session_entry_context',
      timestamp: nowISO(),
      data: entryContext
    });
    
    return entryContext;
  }

  function extractUTMParams() {
    var params = new URLSearchParams(location.search);
    return {
      source: params.get('utm_source'),
      medium: params.get('utm_medium'),
      campaign: params.get('utm_campaign'),
      content: params.get('utm_content'),
      term: params.get('utm_term')
    };
  }

  // Capture entry context on load
  captureEntryContext();

  // ---------- Machine Learning Data Collection ----------
  
  // Collect features for ML model training
  function collectMLFeatures() {
    var features = {
      // Temporal features
      sessionDuration: Math.round((Date.now() - sessionStartTime) / 1000),
      timeOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
      
      // Engagement features
      totalAttentionTime: estimateAttentionTotal(),
      attentionEfficiency: dwell.qualityMetrics.qualityScore,
      sectionsVisited: Array.from(sectionState.values()).filter(st => st.attentionSec > 0).length,
      averageTimePerSection: calculateAverageTimePerSection(),
      maxSectionTime: Math.max(...Array.from(sectionState.values()).map(st => st.attentionSec)),
      
      // Behavioral features
      navigationPattern: behavioralIntelligence.navigationPattern,
      interactionDensity: behavioralIntelligence.interactionDensity,
      readingSpeed: readingBehaviorData.averageReadingSpeed,
      readingConsistency: readingBehaviorData.readingConsistency,
      
      // Interaction features
      totalClicks: Array.from(sectionState.values()).reduce((sum, st) => sum + st.clicks, 0),
      totalScrollDepth: Math.max(...Array.from(sectionState.values()).map(st => st.maxScrollPct)),
      videoEngagementTime: Array.from(sectionState.values()).reduce((sum, st) => sum + st.videoSec, 0),
      
      // Device features
      deviceType: getDeviceInfo().deviceType,
      viewport: getDeviceInfo().viewport,
      connectionType: getDeviceInfo().connectionType,
      
      // Content features
      primaryContentType: determinePrimaryContentType(),
      contentCompletionRate: calculateContentCompletionRate(),
      
      // Conversion features
      conversionSignals: behavioralIntelligence.conversionSignals,
      formInteractions: getFormInteractionCount(),
      highValueActions: getHighValueActionCount()
    };
    
    return features;
  }

  function determinePrimaryContentType() {
    var sectionTimes = Array.from(sectionState.entries())
      .filter(([id, st]) => st.attentionSec > 0)
      .sort(([,a], [,b]) => b.attentionSec - a.attentionSec);
    
    if (sectionTimes.length === 0) return 'none';
    
    var topSection = sectionTimes[0][0];
    if (topSection.includes('video')) return 'video';
    if (topSection.includes('creative') || topSection.includes('arts')) return 'creative';
    if (topSection.includes('academic')) return 'academic';
    if (topSection.includes('about')) return 'informational';
    
    return 'general';
  }

  function calculateContentCompletionRate() {
    var totalSections = sectionState.size;
    var completedSections = Array.from(sectionState.values())
      .filter(st => st.maxScrollPct >= 80 && st.attentionSec >= 10).length;
    
    return totalSections > 0 ? Math.round((completedSections / totalSections) * 100) : 0;
  }

  function getFormInteractionCount() {
    return eventQueue.concat(highPriorityQueue)
      .filter(e => e.eventType?.includes('form')).length;
  }

  function getHighValueActionCount() {
    return eventQueue.concat(highPriorityQueue)
      .filter(e => e.data?.conversionSignal === 1).length;
  }

  // Send ML features every 2 minutes for model training
  setInterval(function() {
    var features = collectMLFeatures();
    queueEvent({
      inquiryId: INQUIRY_ID,
      sessionId: SESSION_ID,
      eventType: 'ml_features_snapshot',
      timestamp: nowISO(),
      data: {
        features: features,
        labels: {
          currentEngagementScore: calculatePredictedEngagementScore(),
          currentConversionProbability: calculateConversionProbability(),
          sessionValue: assessSessionValue()
        }
      }
    });
  }, 120000); // Every 2 minutes

  // ---------- Performance Monitoring ----------
  
  // Monitor tracking performance impact
  var performanceMetrics = {
    startTime: performance.now(),
    eventCount: 0,
    apiCallCount: 0,
    lastAPICallTime: 0
  };

  // Wrap fetch to monitor API performance (idempotent & non-destructive)
  if (!window.__SMART_TRACKING_NS__.__FETCH_WRAPPED__) {
    window.__SMART_TRACKING_NS__.__FETCH_WRAPPED__ = true;
    var __smart_originalFetch = window.fetch;
    window.fetch = function(url, options){
      try {
        if (typeof url === 'string' && url.indexOf('/api/track') !== -1) {
          performanceMetrics.apiCallCount++;
          performanceMetrics.lastAPICallTime = performance.now();
        }
      } catch(_) {}
      return __smart_originalFetch.apply(this, arguments);
    };
  }

  // Monitor tracking overhead
  setInterval(function() {
    var now = performance.now();
    var runtime = now - performanceMetrics.startTime;
    
    if (runtime > 300000) { // After 5 minutes
      queueEvent({
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        eventType: 'tracking_performance_report',
        timestamp: nowISO(),
        data: {
          runtime: Math.round(runtime),
          eventCount: performanceMetrics.eventCount,
          apiCallCount: performanceMetrics.apiCallCount,
          eventsPerMinute: Math.round(performanceMetrics.eventCount / (runtime / 60000)),
          memoryUsage: performance.memory ? {
            used: performance.memory.usedJSHeapSize,
            total: performance.memory.totalJSHeapSize,
            limit: performance.memory.jsHeapSizeLimit
          } : null
        }
      });
    }
  }, 300000); // Every 5 minutes

  // Initialize performance monitoring
  if (!window.__SMART_TRACKING_NS__.__BOOT_LOGGED__) {
    window.__SMART_TRACKING_NS__.__BOOT_LOGGED__ = true;
    console.log('🚀 Enhanced SMART Analytics initialised');
    console.log('📊 Session ID:', SESSION_ID);
    console.log('🎯 Inquiry ID:', INQUIRY_ID);
    console.log('🧠 AI Intelligence: Active');
  }

})();