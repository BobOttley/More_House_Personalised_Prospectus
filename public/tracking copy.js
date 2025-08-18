/**
 * More House School - Enhanced Analytics Tracking
 * Comprehensive tracking for AI-powered admissions intelligence
 * - YouTube video engagement tracking
 * - Granular section and interaction tracking
 * - Behavioral pattern analysis
 * - AI-ready data collection
 */
(function() {
  'use strict';

  console.log('🎯 More House Enhanced Analytics - Initializing...');

  // Enhanced tracking configuration
  const TRACKING_CONFIG = {
    endpoint: resolveEndpoint(),
    batchSize: 3, // Smaller batches for real-time AI analysis
    flushInterval: 5000,    // 5 seconds for faster processing
    heartbeatInterval: 15000, // 15 seconds for more granular data
    scrollThreshold: 10,     // More sensitive scrolling
    timeThreshold: 500,      // Faster interaction detection
    debug: true,
    aiAnalysisThreshold: 10, // Trigger AI analysis after 10 meaningful events
    videoProgressInterval: 2000 // Check video progress every 2 seconds
  };

  // Global tracking state with AI-ready metrics
  let trackingState = {
    inquiryId: null,
    sessionId: generateSessionId(),
    startTime: Date.now(),
    lastHeartbeat: Date.now(),
    lastActivity: Date.now(),
    currentPage: location.pathname,
    events: [],
    
    // Enhanced engagement metrics
    timeOnPage: 0,
    maxScrollDepth: 0,
    clickCount: 0,
    sectionViews: {},
    milestonesSent: new Set(),
    
    // AI-focused behavioral data
    readingSpeed: 0, // Words per minute estimate
    attentionSpans: [], // Array of focused reading periods
    interactionPatterns: [], // Sequence of interactions
    contentPreferences: {}, // Video vs text engagement
    conversionSignals: 0, // Strong intent indicators
    
    // YouTube tracking
    youtubeVideos: {},
    videoEngagement: {},
    
    // Section-specific data
    entryPointEngagement: {},
    timelineInteractions: {},
    photoGalleryViews: {},
    
    // Device info
    deviceInfo: getDeviceInfo(),
    isActive: true,
    heartbeatTimer: null,
    flushTimer: null,
    
    // AI trigger state
    meaningfulEvents: 0,
    lastAIAnalysis: null
  };

  // Resolve tracking endpoint
  function resolveEndpoint() {
    const meta = document.querySelector('meta[name="tracking-endpoint"]');
    if (meta && meta.content) {
      console.log('📡 Using tracking endpoint from meta tag:', meta.content);
      return meta.content;
    }
    
    if (location.origin === 'null' || location.protocol === 'file:') {
      console.log('📁 File protocol detected, using localhost endpoint');
      return 'http://localhost:3000/api/track-engagement';
    }
    
    const endpoint = `${location.origin}/api/track-engagement`;
    console.log('🌐 Using same-origin endpoint:', endpoint);
    return endpoint;
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeTracking);
  } else {
    initializeTracking();
  }

  // Main initialization
  function initializeTracking() {
    console.log('📊 Initializing Enhanced More House tracking...');
    
    trackingState.inquiryId = extractInquiryId() || window.MORE_HOUSE_INQUIRY_ID || null;
    
    if (!trackingState.inquiryId) {
      console.warn('⚠️ No inquiry-id found; tracking disabled.');
      return;
    }
    
    console.log('🎯 Enhanced analytics initialized for:', trackingState.inquiryId);
    
    // Set up all tracking systems
    setupEventListeners();
    setupEnhancedSectionTracking();
    setupYouTubeTracking();
    setupInteractionTracking();
    setupBehavioralAnalysis();
    
    // Send enhanced initial event
    trackEvent('enhanced_page_load', {
      url: location.href,
      title: document.title,
      referrer: document.referrer,
      timestamp: new Date().toISOString(),
      deviceInfo: trackingState.deviceInfo,
      personalizedFor: getPersonalizedUserData(),
      sessionStartTime: trackingState.startTime
    });
    
    startHeartbeat();
    startPeriodicFlush();
    
    // Page unload handlers
    window.addEventListener('beforeunload', handlePageUnload);
    window.addEventListener('pagehide', handlePageUnload);
    
    console.log('✅ Enhanced tracking system fully initialized');
  }

  // Extract inquiry ID
  function extractInquiryId() {
    const meta = document.querySelector('meta[name="inquiry-id"]');
    return meta ? meta.content : null;
  }

  // Generate session ID
  function generateSessionId() {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // Enhanced device info
  function getDeviceInfo() {
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages ? navigator.languages.join(',') : navigator.language,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenColorDepth: screen.colorDepth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      isMobile: isMobileDevice(),
      isTablet: isTabletDevice(),
      devicePixelRatio: window.devicePixelRatio || 1,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: new Date().toISOString(),
      touchSupport: 'ontouchstart' in window,
      orientation: screen.orientation ? screen.orientation.type : 'unknown'
    };
  }

  // Device detection
  function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
           window.innerWidth <= 768;
  }

  function isTabletDevice() {
    return /iPad|Android/i.test(navigator.userAgent) && 
           window.innerWidth > 768 && window.innerWidth <= 1024;
  }

  // Get personalized user data from prospectus
  function getPersonalizedUserData() {
    try {
      // Extract from meta tags
      const studentName = document.querySelector('meta[name="student-name"]');
      const entryYear = document.querySelector('meta[name="entry-year"]');
      const ageGroup = document.querySelector('meta[name="age-group"]');
      
      return {
        studentName: studentName ? studentName.content : null,
        entryYear: entryYear ? entryYear.content : null,
        ageGroup: ageGroup ? ageGroup.content : null,
        pageTitle: document.title
      };
    } catch (error) {
      return {};
    }
  }

  // Enhanced event listeners
  function setupEventListeners() {
    // Enhanced scroll tracking
    let scrollTimeout;
    let lastScrollPosition = 0;
    let scrollDirection = 'down';
    
    window.addEventListener('scroll', function() {
      const currentScroll = window.pageYOffset;
      scrollDirection = currentScroll > lastScrollPosition ? 'down' : 'up';
      lastScrollPosition = currentScroll;
      
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => handleEnhancedScroll(scrollDirection), 100);
      updateActivity();
    });

    // Enhanced click tracking
    document.addEventListener('click', function(e) {
      handleEnhancedClick(e);
      updateActivity();
    });

    // Focus/blur with quality metrics
    window.addEventListener('focus', function() {
      trackingState.isActive = true;
      const timeAway = Date.now() - trackingState.lastActivity;
      trackEvent('page_focus', {
        timeAwayMs: timeAway,
        returnBehavior: timeAway > 60000 ? 'long_return' : 'quick_return'
      });
      updateActivity();
    });

    window.addEventListener('blur', function() {
      trackingState.isActive = false;
      trackEvent('page_blur', {
        timeOnPageMs: Date.now() - trackingState.startTime,
        currentSection: getCurrentSection(),
        engagementScore: calculateCurrentEngagementScore()
      });
    });

    // Visibility change tracking
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        trackEvent('page_hidden', {
          timeVisible: Date.now() - trackingState.lastActivity,
          currentSection: getCurrentSection()
        });
      } else {
        trackEvent('page_visible', {
          timeHidden: Date.now() - trackingState.lastActivity,
          currentSection: getCurrentSection()
        });
        updateActivity();
      }
    });

    // Window resize with engagement context
    let resizeTimeout;
    window.addEventListener('resize', function() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        trackEvent('window_resize', {
          newViewport: `${window.innerWidth}x${window.innerHeight}`,
          isMobile: isMobileDevice(),
          isTablet: isTabletDevice(),
          currentSection: getCurrentSection()
        });
      }, 250);
    });
  }

  // Enhanced scroll handling with reading analysis
  function handleEnhancedScroll(direction) {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    
    if (scrollHeight <= 0) {
      trackingState.maxScrollDepth = 100;
      return;
    }
    
    const scrollPercent = Math.min(Math.round((scrollTop / scrollHeight) * 100), 100);
    
    if (scrollPercent > trackingState.maxScrollDepth) {
      trackingState.maxScrollDepth = scrollPercent;
      
      // Track milestones with direction context
      const milestones = [10, 25, 50, 75, 90, 100];
      milestones.forEach(milestone => {
        if (scrollPercent >= milestone && !trackingState.milestonesSent.has(milestone)) {
          trackingState.milestonesSent.add(milestone);
          trackEvent('scroll_milestone', {
            milestone: `${milestone}%`,
            depth: scrollPercent,
            direction: direction,
            timeToReach: Date.now() - trackingState.startTime,
            currentSection: getCurrentSection(),
            readingSpeed: estimateReadingSpeed()
          });
        }
      });
    }
  }

  // Enhanced click handling with context analysis
  function handleEnhancedClick(event) {
    trackingState.clickCount++;
    
    const target = event.target;
    const tagName = target.tagName.toLowerCase();
    const clickData = {
      element: tagName,
      text: (target.textContent || '').trim().slice(0, 100),
      id: target.id || '',
      className: target.className || '',
      href: target.href || '',
      clickCount: trackingState.clickCount,
      x: event.clientX,
      y: event.clientY,
      timestamp: Date.now(),
      currentSection: getCurrentSection(),
      timeOnPage: Date.now() - trackingState.startTime
    };

    // Analyze click context and intent
    const clickContext = analyzeClickContext(target, clickData);
    
    // Track based on click type and importance
    if (clickContext.isConversionAction) {
      trackingState.conversionSignals++;
      trackEvent('conversion_action', {
        ...clickData,
        ...clickContext,
        conversionType: clickContext.conversionType,
        conversionSignals: trackingState.conversionSignals
      });
    } else if (clickContext.isNavigationAction) {
      trackEvent('navigation_action', {
        ...clickData,
        ...clickContext
      });
    } else if (clickContext.isContentAction) {
      trackEvent('content_interaction', {
        ...clickData,
        ...clickContext
      });
    } else {
      trackEvent('general_click', clickData);
    }
    
    // Update interaction patterns for AI analysis
    trackingState.interactionPatterns.push({
      type: 'click',
      target: clickContext.elementType,
      timestamp: Date.now(),
      context: clickContext
    });
  }

  // Analyze click context for AI insights
  function analyzeClickContext(target, clickData) {
    const context = {
      elementType: 'unknown',
      isConversionAction: false,
      isNavigationAction: false,
      isContentAction: false,
      conversionType: null,
      importance: 'low'
    };

    // Conversion actions (high value)
    if (target.href && target.href.includes('open-events')) {
      context.isConversionAction = true;
      context.conversionType = 'book_open_morning';
      context.importance = 'critical';
      context.elementType = 'conversion_cta';
    } else if (target.href && target.href.includes('mailto:')) {
      context.isConversionAction = true;
      context.conversionType = 'email_inquiry';
      context.importance = 'high';
      context.elementType = 'email_cta';
    }
    
    // Navigation actions (medium value)
    else if (target.closest('.entry-card-header')) {
      context.isNavigationAction = true;
      context.importance = 'medium';
      context.elementType = 'entry_point_expansion';
      context.entryPoint = target.closest('.entry-card').id;
    } else if (target.onclick && target.onclick.toString().includes('openVideo')) {
      context.isContentAction = true;
      context.importance = 'high';
      context.elementType = 'video_open';
      context.videoId = extractVideoIdFromClick(target);
    } else if (target.onclick && target.onclick.toString().includes('openPhotoModal')) {
      context.isContentAction = true;
      context.importance = 'medium';
      context.elementType = 'photo_modal';
    }
    
    // Content engagement actions
    else if (target.closest('.photo-card')) {
      context.isContentAction = true;
      context.importance = 'medium';
      context.elementType = 'photo_gallery';
    } else if (target.closest('.timeline-item')) {
      context.isContentAction = true;
      context.importance = 'medium';
      context.elementType = 'timeline_interaction';
    }

    return context;
  }

  // Extract video ID from click event
  function extractVideoIdFromClick(target) {
    try {
      const onclickStr = target.onclick.toString();
      const match = onclickStr.match(/openVideo\(['"]([^'"]+)['"]/);
      return match ? match[1] : 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  // Enhanced section tracking with AI-ready data
  function setupEnhancedSectionTracking() {
    // Add section attributes to key content areas
    addSectionAttributes();
    
    const sections = document.querySelectorAll('[data-section]');
    
    if (sections.length === 0) {
      console.log('ℹ️ No sections found, adding dynamic sections');
      return;
    }

    console.log(`📖 Setting up enhanced section tracking for ${sections.length} sections`);
    
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const sectionName = entry.target.getAttribute('data-section');
        
        if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
          // Section entered view
          if (!trackingState.sectionViews[sectionName]) {
            trackingState.sectionViews[sectionName] = {
              firstView: Date.now(),
              viewCount: 0,
              totalTime: 0,
              lastViewStart: Date.now(),
              engagementQuality: 'low',
              readingEstimate: 0
            };
          }
          
          trackingState.sectionViews[sectionName].viewCount++;
          trackingState.sectionViews[sectionName].lastViewStart = Date.now();
          
          trackEvent('section_enter', {
            section: sectionName,
            viewCount: trackingState.sectionViews[sectionName].viewCount,
            scrollDepth: trackingState.maxScrollDepth,
            intersectionRatio: Math.round(entry.intersectionRatio * 100),
            timeToView: Date.now() - trackingState.startTime,
            readingContext: analyzeSectionReadingContext(entry.target)
          });
        } else if (!entry.isIntersecting && trackingState.sectionViews[sectionName]?.lastViewStart) {
          // Section left view
          const viewTime = Date.now() - trackingState.sectionViews[sectionName].lastViewStart;
          trackingState.sectionViews[sectionName].totalTime += viewTime;
          trackingState.sectionViews[sectionName].lastViewStart = null;
          
          // Calculate engagement quality
          const quality = calculateSectionEngagementQuality(sectionName, viewTime, entry.target);
          trackingState.sectionViews[sectionName].engagementQuality = quality;
          
          if (viewTime > 1000) { // Only track meaningful section views
            trackEvent('section_exit', {
              section: sectionName,
              timeSpent: viewTime,
              totalTimeInSection: trackingState.sectionViews[sectionName].totalTime,
              engagementQuality: quality,
              wordEstimate: estimateWordsInSection(entry.target),
              readingSpeed: viewTime > 5000 ? estimateReadingSpeedForSection(entry.target, viewTime) : null
            });
          }
        }
      });
    }, {
      threshold: [0.1, 0.3, 0.6, 0.9],
      rootMargin: '0px 0px -10% 0px'
    });

    sections.forEach(section => {
      observer.observe(section);
      if (TRACKING_CONFIG.debug) {
        section.setAttribute('data-tracking-active', 'true');
      }
    });
  }

  // Add section attributes to key content areas
  function addSectionAttributes() {
    // Add section tracking to key areas that don't have it
    const coverPage = document.querySelector('.cover-page');
    if (coverPage && !coverPage.hasAttribute('data-section')) {
      coverPage.setAttribute('data-section', 'cover');
    }

    const headsWelcome = document.querySelector('.page:nth-child(2)');
    if (headsWelcome && !headsWelcome.hasAttribute('data-section')) {
      headsWelcome.setAttribute('data-section', 'heads-welcome');
    }

    const academicHero = document.querySelector('#academicHero');
    if (academicHero && !academicHero.hasAttribute('data-section')) {
      academicHero.setAttribute('data-section', 'academic-hero');
    }

    const welcomeContent = document.querySelector('.page:nth-child(4)');
    if (welcomeContent && !welcomeContent.hasAttribute('data-section')) {
      welcomeContent.setAttribute('data-section', 'welcome-stats');
    }

    const dayTimeline = document.querySelector('.day-timeline');
    if (dayTimeline && !dayTimeline.hasAttribute('data-section')) {
      dayTimeline.setAttribute('data-section', 'day-timeline');
    }

    const entryPoints = document.querySelector('.entry-points-container');
    if (entryPoints && !entryPoints.hasAttribute('data-section')) {
      entryPoints.setAttribute('data-section', 'entry-points');
    }

    const londonSection = document.querySelector('.london-grid');
    if (londonSection && !londonSection.hasAttribute('data-section')) {
      londonSection.setAttribute('data-section', 'london-curriculum');
    }

    const valuesSection = document.querySelector('.values-grid');
    if (valuesSection && !valuesSection.hasAttribute('data-section')) {
      valuesSection.setAttribute('data-section', 'values');
    }

    const videoSection = document.querySelector('.video-hero');
    if (videoSection && !videoSection.hasAttribute('data-section')) {
      videoSection.setAttribute('data-section', 'discovery-videos');
    }
  }

  // YouTube tracking implementation
  function setupYouTubeTracking() {
    console.log('🎥 Setting up YouTube tracking...');
    
    // Load YouTube IFrame API
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    }

    // Override the existing openVideo function to add tracking
    if (window.openVideo) {
      const originalOpenVideo = window.openVideo;
      window.openVideo = function(videoId, title, description) {
        trackYouTubeVideoOpen(videoId, title, description);
        return originalOpenVideo(videoId, title, description);
      };
    }

    // Set up YouTube API ready callback
    window.onYouTubeIframeAPIReady = function() {
      console.log('✅ YouTube API ready');
      setupYouTubePlayerTracking();
    };
  }

  // Track YouTube video open events
  function trackYouTubeVideoOpen(videoId, title, description) {
    trackEvent('youtube_video_open', {
      videoId: videoId,
      title: title,
      description: description,
      timestamp: Date.now(),
      currentSection: getCurrentSection(),
      timeOnPageBeforeVideo: Date.now() - trackingState.startTime
    });

    // Initialize video tracking state
    if (!trackingState.youtubeVideos[videoId]) {
      trackingState.youtubeVideos[videoId] = {
        title: title,
        description: description,
        openCount: 0,
        totalWatchTime: 0,
        completions: 0,
        lastOpened: Date.now()
      };
    }
    
    trackingState.youtubeVideos[videoId].openCount++;
    trackingState.youtubeVideos[videoId].lastOpened = Date.now();
  }

  // Set up YouTube player tracking
  function setupYouTubePlayerTracking() {
    // Monitor for YouTube iframes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.tagName === 'IFRAME' && node.src && node.src.includes('youtube.com')) {
            setupIndividualYouTubePlayer(node);
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Setup individual YouTube player tracking
  function setupIndividualYouTubePlayer(iframe) {
    const videoId = extractVideoIdFromUrl(iframe.src);
    if (!videoId) return;

    console.log('🎬 Setting up tracking for YouTube video:', videoId);

    // Update iframe src to enable API
    if (!iframe.src.includes('enablejsapi=1')) {
      iframe.src += (iframe.src.includes('?') ? '&' : '?') + 'enablejsapi=1&origin=' + window.location.origin;
    }

    // Create player when iframe loads
    iframe.onload = function() {
      try {
        const player = new YT.Player(iframe, {
          events: {
            'onStateChange': (event) => handleYouTubeStateChange(event, videoId),
            'onError': (event) => handleYouTubeError(event, videoId)
          }
        });

        // Store player reference
        trackingState.videoEngagement[videoId] = {
          player: player,
          startTime: Date.now(),
          totalWatchTime: 0,
          lastPlayTime: null,
          progressMarkers: new Set(),
          pauseCount: 0,
          replayCount: 0
        };

        // Start progress monitoring
        startYouTubeProgressMonitoring(videoId, player);

      } catch (error) {
        console.error('Error setting up YouTube player tracking:', error);
      }
    };
  }

  // Extract video ID from YouTube URL
  function extractVideoIdFromUrl(url) {
    const regex = /(?:youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
  }

  // Handle YouTube player state changes
  function handleYouTubeStateChange(event, videoId) {
    const state = trackingState.videoEngagement[videoId];
    if (!state) return;

    const currentTime = state.player.getCurrentTime();
    const duration = state.player.getDuration();

    switch (event.data) {
      case YT.PlayerState.PLAYING:
        state.lastPlayTime = Date.now();
        trackEvent('youtube_video_play', {
          videoId: videoId,
          currentTime: currentTime,
          duration: duration,
          playCount: state.replayCount + 1
        });
        break;

      case YT.PlayerState.PAUSED:
        if (state.lastPlayTime) {
          const watchTime = (Date.now() - state.lastPlayTime) / 1000;
          state.totalWatchTime += watchTime;
          state.pauseCount++;
        }
        trackEvent('youtube_video_pause', {
          videoId: videoId,
          currentTime: currentTime,
          totalWatchTime: state.totalWatchTime,
          pauseCount: state.pauseCount
        });
        break;

      case YT.PlayerState.ENDED:
        if (state.lastPlayTime) {
          const watchTime = (Date.now() - state.lastPlayTime) / 1000;
          state.totalWatchTime += watchTime;
        }
        trackEvent('youtube_video_complete', {
          videoId: videoId,
          totalWatchTime: state.totalWatchTime,
          completionRate: duration ? Math.round((state.totalWatchTime / duration) * 100) : 0,
          replayCount: state.replayCount
        });
        break;
    }
  }

  // Monitor YouTube video progress
  function startYouTubeProgressMonitoring(videoId, player) {
    const interval = setInterval(() => {
      try {
        const state = trackingState.videoEngagement[videoId];
        if (!state || !player.getCurrentTime) {
          clearInterval(interval);
          return;
        }

        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        if (!duration || duration <= 0) return;

        const progress = (currentTime / duration) * 100;
        const milestones = [25, 50, 75, 90];

        milestones.forEach(milestone => {
          if (progress >= milestone && !state.progressMarkers.has(milestone)) {
            state.progressMarkers.add(milestone);
            trackEvent('youtube_video_progress', {
              videoId: videoId,
              milestone: `${milestone}%`,
              currentTime: currentTime,
              duration: duration,
              totalWatchTime: state.totalWatchTime
            });
          }
        });

      } catch (error) {
        console.error('Error monitoring YouTube progress:', error);
        clearInterval(interval);
      }
    }, TRACKING_CONFIG.videoProgressInterval);
  }

  // Handle YouTube errors
  function handleYouTubeError(event, videoId) {
    trackEvent('youtube_video_error', {
      videoId: videoId,
      errorCode: event.data,
      errorMessage: getYouTubeErrorMessage(event.data)
    });
  }

  // Get YouTube error message
  function getYouTubeErrorMessage(errorCode) {
    const errors = {
      2: 'Invalid video ID',
      5: 'HTML5 player error',
      100: 'Video not found',
      101: 'Video not embeddable',
      150: 'Video not embeddable'
    };
    return errors[errorCode] || 'Unknown error';
  }

  // Setup interaction tracking for specific elements
  function setupInteractionTracking() {
    console.log('🎯 Setting up interaction tracking...');

    // Track entry point card expansions
    document.addEventListener('click', function(e) {
      if (e.target.closest('.entry-card-header')) {
        const card = e.target.closest('.entry-card');
        const entryPoint = card.id;
        const isExpanding = !card.classList.contains('expanded');
        
        trackEvent('entry_point_interaction', {
          entryPoint: entryPoint,
          action: isExpanding ? 'expand' : 'collapse',
          timeOnPage: Date.now() - trackingState.startTime,
          currentSection: getCurrentSection()
        });

        if (!trackingState.entryPointEngagement[entryPoint]) {
          trackingState.entryPointEngagement[entryPoint] = {
            expansions: 0,
            timeSpent: 0,
            firstExpansion: null
          };
        }

        if (isExpanding) {
          trackingState.entryPointEngagement[entryPoint].expansions++;
          if (!trackingState.entryPointEngagement[entryPoint].firstExpansion) {
            trackingState.entryPointEngagement[entryPoint].firstExpansion = Date.now();
          }
        }
      }
    });

    // Track photo modal interactions
    document.addEventListener('click', function(e) {
      if (e.target.closest('.photo-card')) {
        const photoCard = e.target.closest('.photo-card');
        const imageSrc = photoCard.querySelector('img')?.src;
        
        trackEvent('photo_modal_open', {
          imageSrc: imageSrc,
          altText: photoCard.querySelector('img')?.alt || '',
          currentSection: getCurrentSection(),
          timeOnPage: Date.now() - trackingState.startTime
        });
      }
    });

    // Track timeline interactions
    document.querySelectorAll('.timeline-item').forEach((item, index) => {
      item.addEventListener('mouseenter', function() {
        trackEvent('timeline_item_hover', {
          itemIndex: index,
          timeText: item.querySelector('.timeline-time')?.textContent || '',
          currentSection: getCurrentSection()
        });
      });
    });
  }

  // Setup behavioral analysis
  function setupBehavioralAnalysis() {
    // Reading speed estimation
    let lastScrollTime = Date.now();
    let scrollPauses = [];

    window.addEventListener('scroll', function() {
      const now = Date.now();
      const timeSinceLastScroll = now - lastScrollTime;
      
      if (timeSinceLastScroll > 2000) { // Pause in scrolling
        scrollPauses.push({
          duration: timeSinceLastScroll,
          section: getCurrentSection(),
          scrollPosition: window.pageYOffset
        });
      }
      
      lastScrollTime = now;
    });

    // Attention span tracking
    let focusStartTime = Date.now();
    
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        const attentionSpan = Date.now() - focusStartTime;
        if (attentionSpan > 5000) { // Meaningful attention spans
          trackingState.attentionSpans.push({
            duration: attentionSpan,
            section: getCurrentSection(),
            timestamp: Date.now()
          });
        }
      } else {
        focusStartTime = Date.now();
      }
    });
  }

  // Helper functions for analysis
  function analyzeSectionReadingContext(sectionElement) {
    const wordCount = estimateWordsInSection(sectionElement);
    const hasVideo = sectionElement.querySelector('iframe, video') !== null;
    const hasImages = sectionElement.querySelectorAll('img').length;
    const hasInteractive = sectionElement.querySelectorAll('button, .photo-card, .entry-card').length;

    return {
      wordCount: wordCount,
      hasVideo: hasVideo,
      imageCount: hasImages,
      interactiveElements: hasInteractive,
      contentType: determineContentType(sectionElement)
    };
  }

  function estimateWordsInSection(element) {
    const text = element.textContent || '';
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }

  function determineContentType(element) {
    if (element.querySelector('iframe[src*="youtube"]')) return 'video-heavy';
    if (element.querySelectorAll('img').length > 3) return 'image-heavy';
    if (element.querySelectorAll('.entry-card, .timeline-item').length > 0) return 'interactive';
    if (estimateWordsInSection(element) > 200) return 'text-heavy';
    return 'mixed';
  }

  function calculateSectionEngagementQuality(sectionName, viewTime, element) {
    const wordCount = estimateWordsInSection(element);
    const expectedReadingTime = (wordCount / 200) * 60 * 1000; // 200 WPM average
    const ratio = viewTime / expectedReadingTime;

    if (ratio > 0.8) return 'high';
    if (ratio > 0.4) return 'medium';
    return 'low';
  }

  function estimateReadingSpeed() {
    const wordsOnPage = estimateWordsInSection(document.body);
    const timeOnPage = (Date.now() - trackingState.startTime) / 1000 / 60; // minutes
    return timeOnPage > 0 ? Math.round(wordsOnPage / timeOnPage) : 0;
  }

  function estimateReadingSpeedForSection(element, timeSpent) {
    const words = estimateWordsInSection(element);
    const minutes = timeSpent / 1000 / 60;
    return minutes > 0 ? Math.round(words / minutes) : 0;
  }

  function calculateCurrentEngagementScore() {
    let score = 0;
    
    // Time-based scoring (40 points max)
    const timeMinutes = (Date.now() - trackingState.startTime) / 1000 / 60;
    score += Math.min((timeMinutes / 5) * 40, 40);
    
    // Section diversity (30 points max)
    const sectionsVisited = Object.keys(trackingState.sectionViews).length;
    score += Math.min((sectionsVisited / 8) * 30, 30);
    
    // Interaction quality (20 points max)
    score += Math.min((trackingState.clickCount / 15) * 20, 20);
    
    // Conversion signals (10 points max)
    score += Math.min(trackingState.conversionSignals * 5, 10);
    
    return Math.round(score);
  }

  function getCurrentSection() {
    const sections = document.querySelectorAll('[data-section]');
    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      if (rect.top <= window.innerHeight / 2 && rect.bottom >= window.innerHeight / 2) {
        return section.getAttribute('data-section');
      }
    }
    return null;
  }

  function updateActivity() {
    trackingState.lastActivity = Date.now();
  }

  // Enhanced heartbeat with AI trigger check
  function startHeartbeat() {
    trackingState.heartbeatTimer = setInterval(() => {
      if (trackingState.isActive && !document.hidden) {
        const now = Date.now();
        const timeSinceLastBeat = now - trackingState.lastHeartbeat;
        trackingState.timeOnPage += timeSinceLastBeat;
        trackingState.lastHeartbeat = now;

        const timeSinceActivity = now - trackingState.lastActivity;
        if (timeSinceActivity < 30000) { // Active within last 30 seconds
          trackEvent('enhanced_heartbeat', {
            timeOnPage: Math.round(trackingState.timeOnPage / 1000),
            maxScrollDepth: trackingState.maxScrollDepth,
            clickCount: trackingState.clickCount,
            sectionsVisited: Object.keys(trackingState.sectionViews).length,
            currentSection: getCurrentSection(),
            engagementScore: calculateCurrentEngagementScore(),
            conversionSignals: trackingState.conversionSignals,
            readingSpeed: estimateReadingSpeed(),
            attentionSpans: trackingState.attentionSpans.length,
            videoEngagement: Object.keys(trackingState.youtubeVideos).length
          });

          // Check if we should trigger AI analysis
          checkAIAnalysisTrigger();
        }
      }
    }, TRACKING_CONFIG.heartbeatInterval);
  }

  // Check if we should trigger AI analysis
  function checkAIAnalysisTrigger() {
    if (trackingState.meaningfulEvents >= TRACKING_CONFIG.aiAnalysisThreshold) {
      const timeSinceLastAnalysis = trackingState.lastAIAnalysis ? 
        Date.now() - trackingState.lastAIAnalysis : Infinity;
      
      if (timeSinceLastAnalysis > 60000) { // At least 1 minute between analyses
        triggerAIAnalysis();
      }
    }
  }

  // Trigger AI analysis
  function triggerAIAnalysis() {
    trackingState.lastAIAnalysis = Date.now();
    trackingState.meaningfulEvents = 0; // Reset counter

    trackEvent('ai_analysis_trigger', {
      triggerReason: 'engagement_threshold',
      currentEngagementScore: calculateCurrentEngagementScore(),
      timeOnPage: Math.round(trackingState.timeOnPage / 1000),
      sectionsVisited: Object.keys(trackingState.sectionViews).length,
      conversionSignals: trackingState.conversionSignals,
      videoEngagement: Object.keys(trackingState.youtubeVideos).length,
      analysisTimestamp: Date.now()
    });
  }

  // Enhanced track event function
  function trackEvent(eventType, data = {}) {
    if (!trackingState.inquiryId) return;

    const event = {
      inquiryId: trackingState.inquiryId,
      sessionId: trackingState.sessionId,
      eventType: eventType,
      timestamp: new Date().toISOString(),
      data: data,
      url: location.href,
      currentSection: getCurrentSection(),
      timeOnPage: Math.round((Date.now() - trackingState.startTime) / 1000),
      scrollDepth: trackingState.maxScrollDepth,
      engagementScore: calculateCurrentEngagementScore(),
      isMeaningfulEvent: isMeaningfulEvent(eventType)
    };

    trackingState.events.push(event);

    if (event.isMeaningfulEvent) {
      trackingState.meaningfulEvents++;
    }

    if (TRACKING_CONFIG.debug) {
      console.log('📊 Enhanced Track:', eventType, data);
    }

    // Immediate flush for critical events
    const immediateFlushEvents = [
      'enhanced_page_load', 'conversion_action', 'youtube_video_complete', 
      'ai_analysis_trigger', 'session_end'
    ];
    
    if (immediateFlushEvents.includes(eventType)) {
      flushEvents();
    }

    // Auto-flush if batch is full
    if (trackingState.events.length >= TRACKING_CONFIG.batchSize) {
      flushEvents();
    }
  }

  // Determine if an event is meaningful for AI analysis
  function isMeaningfulEvent(eventType) {
    const meaningfulEvents = [
      'section_enter', 'section_exit', 'conversion_action', 'navigation_action',
      'youtube_video_play', 'youtube_video_complete', 'entry_point_interaction',
      'photo_modal_open', 'scroll_milestone'
    ];
    return meaningfulEvents.includes(eventType);
  }

  // Start periodic flush
  function startPeriodicFlush() {
    trackingState.flushTimer = setInterval(() => {
      if (trackingState.events.length > 0) {
        if (TRACKING_CONFIG.debug) {
          console.log(`🔄 Periodic flush: ${trackingState.events.length} events`);
        }
        flushEvents();
      }
    }, TRACKING_CONFIG.flushInterval);
  }

  // Enhanced flush events
  function flushEvents() {
    if (trackingState.events.length === 0) return;

    const eventsToSend = [...trackingState.events];
    trackingState.events = [];

    const payload = {
      events: eventsToSend,
      sessionInfo: {
        sessionId: trackingState.sessionId,
        inquiryId: trackingState.inquiryId,
        timeOnPage: Math.round(trackingState.timeOnPage / 1000),
        maxScrollDepth: trackingState.maxScrollDepth,
        clickCount: trackingState.clickCount,
        sectionViews: trackingState.sectionViews,
        deviceInfo: trackingState.deviceInfo,
        pageUrl: location.href,
        pageTitle: document.title,
        sessionStartTime: trackingState.startTime,
        totalEvents: eventsToSend.length,
        
        // Enhanced AI-ready data
        engagementScore: calculateCurrentEngagementScore(),
        conversionSignals: trackingState.conversionSignals,
        youtubeVideos: trackingState.youtubeVideos,
        videoEngagement: Object.keys(trackingState.youtubeVideos).length,
        entryPointEngagement: trackingState.entryPointEngagement,
        behavioralMetrics: {
          readingSpeed: estimateReadingSpeed(),
          attentionSpans: trackingState.attentionSpans,
          interactionPatterns: trackingState.interactionPatterns.slice(-10) // Last 10 interactions
        }
      }
    };

    if (TRACKING_CONFIG.debug) {
      console.log('📤 Sending enhanced events:', {
        count: eventsToSend.length,
        endpoint: TRACKING_CONFIG.endpoint,
        inquiryId: trackingState.inquiryId,
        engagementScore: payload.sessionInfo.engagementScore
      });
    }

    fetch(TRACKING_CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    })
    .then(data => {
      if (TRACKING_CONFIG.debug) {
        console.log('✅ Enhanced events sent successfully:', {
          eventsProcessed: data.eventsProcessed || eventsToSend.length,
          serverResponse: data.message || 'OK',
          aiTriggered: data.aiAnalysisTriggered || false
        });
      }
    })
    .catch(error => {
      console.error('❌ Failed to send enhanced tracking events:', error.message);
      trackingState.events.unshift(...eventsToSend);
      
      if (trackingState.events.length > 100) {
        trackingState.events = trackingState.events.slice(0, 100);
        console.warn('⚠️ Event queue truncated to prevent memory issues');
      }
    });
  }

  // Enhanced page unload
  function handlePageUnload() {
    if (TRACKING_CONFIG.debug) {
      console.log('👋 Page unloading, sending final enhanced session data');
    }

    // Calculate final metrics
    Object.keys(trackingState.sectionViews).forEach(sectionName => {
      const section = trackingState.sectionViews[sectionName];
      if (section.lastViewStart) {
        section.totalTime += Date.now() - section.lastViewStart;
      }
    });

    const sessionEndEvent = {
      inquiryId: trackingState.inquiryId,
      sessionId: trackingState.sessionId,
      eventType: 'enhanced_session_end',
      timestamp: new Date().toISOString(),
      data: {
        totalSessionTime: Math.round((Date.now() - trackingState.startTime) / 1000),
        timeOnPage: Math.round(trackingState.timeOnPage / 1000),
        maxScrollDepth: trackingState.maxScrollDepth,
        clickCount: trackingState.clickCount,
        sectionViews: trackingState.sectionViews,
        finalSection: getCurrentSection(),
        deviceInfo: trackingState.deviceInfo,
        exitType: 'unload',
        totalEvents: trackingState.events.length + 1,
        
        // Enhanced session summary
        engagementScore: calculateCurrentEngagementScore(),
        conversionSignals: trackingState.conversionSignals,
        youtubeEngagement: trackingState.youtubeVideos,
        entryPointEngagement: trackingState.entryPointEngagement,
        behavioralSummary: {
          averageReadingSpeed: estimateReadingSpeed(),
          totalAttentionSpans: trackingState.attentionSpans.length,
          interactionCount: trackingState.interactionPatterns.length,
          meaningfulEvents: trackingState.meaningfulEvents
        }
      },
      url: location.href,
      currentSection: getCurrentSection()
    };

    const finalPayload = {
      events: [...trackingState.events, sessionEndEvent],
      sessionInfo: {
        sessionId: trackingState.sessionId,
        inquiryId: trackingState.inquiryId,
        sessionComplete: true,
        finalEngagementScore: calculateCurrentEngagementScore(),
        totalConversionSignals: trackingState.conversionSignals,
        finalMetrics: sessionEndEvent.data
      }
    };

    // Use sendBeacon for reliable delivery
    if (navigator.sendBeacon) {
      try {
        const blob = new Blob([JSON.stringify(finalPayload)], { 
          type: 'application/json' 
        });
        const sent = navigator.sendBeacon(TRACKING_CONFIG.endpoint, blob);
        if (TRACKING_CONFIG.debug) {
          console.log(sent ? '✅ Enhanced beacon sent successfully' : '❌ Enhanced beacon failed');
        }
      } catch (error) {
        console.error('❌ Enhanced beacon error:', error);
      }
    }

    // Cleanup timers
    if (trackingState.heartbeatTimer) clearInterval(trackingState.heartbeatTimer);
    if (trackingState.flushTimer) clearInterval(trackingState.flushTimer);
  }

  // Enhanced global API
  window.MORE_HOUSE_ENHANCED_TRACKING = {
    trackEvent: trackEvent,
    flushEvents: flushEvents,
    triggerAIAnalysis: triggerAIAnalysis,
    getSessionInfo: () => ({
      inquiryId: trackingState.inquiryId,
      sessionId: trackingState.sessionId,
      timeOnPage: Math.round(trackingState.timeOnPage / 1000),
      maxScrollDepth: trackingState.maxScrollDepth,
      clickCount: trackingState.clickCount,
      sectionViews: trackingState.sectionViews,
      eventsQueued: trackingState.events.length,
      endpoint: TRACKING_CONFIG.endpoint,
      deviceInfo: trackingState.deviceInfo,
      engagementScore: calculateCurrentEngagementScore(),
      conversionSignals: trackingState.conversionSignals,
      youtubeEngagement: trackingState.youtubeVideos,
      meaningfulEvents: trackingState.meaningfulEvents
    }),
    getConfig: () => TRACKING_CONFIG,
    getState: () => trackingState,
    // AI analysis helper
    analyzeCurrentSession: () => ({
      engagementLevel: calculateCurrentEngagementScore() > 60 ? 'high' : 
                      calculateCurrentEngagementScore() > 30 ? 'medium' : 'low',
      conversionReadiness: trackingState.conversionSignals > 0,
      contentPreferences: analyzeContentPreferences(),
      recommendedAction: getRecommendedAction()
    })
  };

  // Helper functions for AI analysis
  function analyzeContentPreferences() {
    const videoTime = Object.values(trackingState.youtubeVideos)
      .reduce((total, video) => total + (video.totalWatchTime || 0), 0);
    const readingTime = trackingState.timeOnPage - videoTime;
    
    return {
      prefersVideo: videoTime > readingTime,
      videoEngagement: Object.keys(trackingState.youtubeVideos).length,
      readingEngagement: Object.keys(trackingState.sectionViews).length,
      interactivityLevel: trackingState.clickCount / (trackingState.timeOnPage / 1000 / 60) // clicks per minute
    };
  }

  function getRecommendedAction() {
    const score = calculateCurrentEngagementScore();
    const hasConversionSignals = trackingState.conversionSignals > 0;
    const timeOnPage = (Date.now() - trackingState.startTime) / 1000 / 60;
    
    if (hasConversionSignals && score > 70) return 'immediate_contact';
    if (score > 60 && timeOnPage > 5) return 'priority_followup';
    if (score > 40) return 'standard_followup';
    if (score > 20) return 'nurture_sequence';
    return 'low_priority';
  }

  if (TRACKING_CONFIG.debug) {
    console.log('🔧 Enhanced debug mode enabled. Available commands:');
    console.log('  - MORE_HOUSE_ENHANCED_TRACKING.getSessionInfo()');
    console.log('  - MORE_HOUSE_ENHANCED_TRACKING.analyzeCurrentSession()');
    console.log('  - MORE_HOUSE_ENHANCED_TRACKING.triggerAIAnalysis()');
  }

})();