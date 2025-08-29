/* SIMPLE TRACKING.JS - Clean, focused, reliable */
(function () {
  'use strict';
  
  // Prevent double loading
  if (window.__MH_TRACKING_ACTIVE__) {
    console.warn('Tracking already active');
    return;
  }
  window.__MH_TRACKING_ACTIVE__ = true;

  // ===== CONFIG =====
  const INQUIRY_ID = window.MORE_HOUSE_INQUIRY_ID || 
                     document.querySelector('meta[name="inquiry-id"]')?.content || 
                     'UNKNOWN';
  
  const SESSION_ID = getOrCreateSessionId();
  const HEARTBEAT_INTERVAL = 15000; // 15 seconds
  
  // ===== SIMPLE STATE =====
  let sessionStart = Date.now();
  let lastActivity = Date.now();
  let currentSection = null;
  let sectionStartTime = null;
  let totalTimeOnPage = 0;
  let maxScrollPercent = 0;
  let clickCount = 0;
  let eventQueue = [];
  
  console.log('📊 Simple Tracking started:', { INQUIRY_ID, SESSION_ID });

  // ===== UTILITY FUNCTIONS =====
  function getOrCreateSessionId() {
    const key = 'mh_session_id';
    let sessionId = localStorage.getItem(key);
    if (!sessionId) {
      sessionId = 'S-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(key, sessionId);
    }
    return sessionId;
  }

  function getCurrentSection() {
    const sections = document.querySelectorAll('[data-track-section]');
    let bestSection = null;
    let bestVisibility = 0;

    sections.forEach(section => {
      const rect = section.getBoundingClientRect();
      const visibility = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      const visibilityRatio = visibility / Math.max(1, rect.height);
      
      if (visibilityRatio > 0.5 && visibilityRatio > bestVisibility) {
        bestVisibility = visibilityRatio;
        bestSection = section.getAttribute('data-track-section');
      }
    });

    return bestSection;
  }

  function calculateScrollPercent() {
    const scrolled = window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    return maxScroll > 0 ? Math.round((scrolled / maxScroll) * 100) : 0;
  }

  function updateActivity() {
    lastActivity = Date.now();
  }

  function isActive() {
    return (Date.now() - lastActivity) < 30000; // 30 seconds
  }

  // ===== EVENT TRACKING =====
  function trackEvent(eventType, data = {}) {
    const event = {
      inquiryId: INQUIRY_ID,
      sessionId: SESSION_ID,
      eventType: eventType,
      timestamp: new Date().toISOString(),
      currentSection: currentSection,
      data: {
        ...data,
        sessionDuration: Math.round((Date.now() - sessionStart) / 1000),
        timeOnPage: totalTimeOnPage,
        maxScroll: maxScrollPercent,
        clicks: clickCount
      }
    };
    
    eventQueue.push(event);
    console.log('📍 Event:', eventType, data);
  }

  // ===== SECTION TRACKING =====
  function enterSection(sectionId) {
    if (sectionId === currentSection) return;
    
    // Exit previous section
    if (currentSection && sectionStartTime) {
      const timeInSection = Math.round((Date.now() - sectionStartTime) / 1000);
      totalTimeOnPage += timeInSection;
      
      trackEvent('section_exit', {
        section: currentSection,
        timeInSection: timeInSection,
        scrollPercent: maxScrollPercent
      });
    }
    
    // Enter new section
    currentSection = sectionId;
    sectionStartTime = Date.now();
    
    trackEvent('section_enter', {
      section: sectionId
    });
  }

  // ===== EVENT LISTENERS =====
  
  // Activity tracking
  ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'].forEach(event => {
    document.addEventListener(event, updateActivity, { passive: true });
  });

  // Click tracking
  document.addEventListener('click', function(e) {
    updateActivity();
    clickCount++;
    
    const target = e.target;
    const isLink = target.tagName === 'A' || target.closest('a');
    const isButton = target.tagName === 'BUTTON';
    
    if (isLink || isButton) {
      trackEvent('click', {
        elementType: target.tagName,
        text: target.textContent?.slice(0, 100) || '',
        href: target.href || target.closest('a')?.href || ''
      });
    }
  });

  // Scroll tracking
  let scrollTimeout;
  window.addEventListener('scroll', function() {
    updateActivity();
    
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      maxScrollPercent = Math.max(maxScrollPercent, calculateScrollPercent());
      
      const newSection = getCurrentSection();
      if (newSection && newSection !== currentSection) {
        enterSection(newSection);
      }
    }, 100);
  }, { passive: true });

  // Video tracking
  window.addEventListener('message', function(e) {
    if (e.data && typeof e.data === 'object' && e.data.type === 'video_event') {
      trackEvent('video_' + e.data.action, {
        videoId: e.data.videoId,
        videoTitle: e.data.title,
        currentTime: e.data.currentTime || 0
      });
    }
  });

  // Page visibility
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      trackEvent('page_hidden');
    } else {
      trackEvent('page_visible');
      updateActivity();
    }
  });

  // ===== DATA SENDING =====
  async function sendEvents() {
    if (eventQueue.length === 0) return;
    
    const events = eventQueue.splice(0); // Take all events
    const payload = {
      events: events,
      sessionInfo: {
        inquiryId: INQUIRY_ID,
        sessionId: SESSION_ID,
        timeOnPage: totalTimeOnPage,
        maxScrollDepth: maxScrollPercent,
        clickCount: clickCount,
        deviceInfo: {
          userAgent: navigator.userAgent,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight
          },
          deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
        }
      }
    };

    try {
      const response = await fetch('/api/track-engagement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      });
      
      if (response.ok) {
        console.log('📤 Sent', events.length, 'events');
      } else {
        console.warn('📤 Failed to send events:', response.status);
        // Re-queue events on failure
        eventQueue.unshift(...events);
      }
    } catch (error) {
      console.warn('📤 Network error:', error);
      // Re-queue events on failure
      eventQueue.unshift(...events);
    }
  }

  // ===== HEARTBEAT =====
  function heartbeat() {
    // Update total time if currently active
    if (isActive() && sectionStartTime) {
      const additionalTime = Math.round((Date.now() - sectionStartTime) / 1000);
      totalTimeOnPage += additionalTime;
      sectionStartTime = Date.now(); // Reset for next heartbeat
    }
    
    // Always send heartbeat (even if no events)
    trackEvent('heartbeat', {
      isActive: isActive(),
      currentSection: currentSection
    });
    
    sendEvents();
  }

  // ===== INITIALIZATION =====
  function initialize() {
    // Initial section detection
    const initialSection = getCurrentSection();
    if (initialSection) {
      enterSection(initialSection);
    }
    
    // Start heartbeat
    setInterval(heartbeat, HEARTBEAT_INTERVAL);
    
    // Send initial page load event
    trackEvent('page_load', {
      url: window.location.href,
      referrer: document.referrer,
      timestamp: new Date().toISOString()
    });
    
    console.log('✅ Simple tracking initialized');
  }

  // ===== PAGE UNLOAD =====
  window.addEventListener('beforeunload', function() {
    // Final time update
    if (sectionStartTime) {
      const finalTime = Math.round((Date.now() - sectionStartTime) / 1000);
      totalTimeOnPage += finalTime;
    }
    
    trackEvent('page_unload', {
      finalTimeOnPage: totalTimeOnPage,
      finalScrollPercent: maxScrollPercent,
      finalClickCount: clickCount
    });
    
    // Try to send final events
    if (navigator.sendBeacon && eventQueue.length > 0) {
      const payload = JSON.stringify({
        events: eventQueue,
        sessionInfo: {
          inquiryId: INQUIRY_ID,
          sessionId: SESSION_ID,
          timeOnPage: totalTimeOnPage,
          maxScrollDepth: maxScrollPercent,
          clickCount: clickCount
        }
      });
      
      navigator.sendBeacon('/api/track-engagement', payload);
    }
  });

  // Start tracking when page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

})();