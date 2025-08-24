(function(){
  function withApi(url){
    try{
      var u = new URL(url || '', location.origin);
      if (!u.searchParams.has('enablejsapi')) u.searchParams.set('enablejsapi','1');
      if (!u.searchParams.has('origin'))      u.searchParams.set('origin', location.origin);
      return u.toString();
    }catch(e){ return url; }
  }

  function extractId(maybeUrlOrId){
    if (!maybeUrlOrId) return null;
    try{
      var u = new URL(maybeUrlOrId, location.origin);
      if (/youtu\.be$/.test(u.hostname)) return u.pathname.replace('/','');
      if (/youtube\.com$/.test(u.hostname)) {
        var v = u.searchParams.get('v');
        if (v) return v;
        var parts = u.pathname.split('/');
        if (parts.includes('embed')) return parts.pop();
      }
    }catch(e){}
    return maybeUrlOrId;
  }

  function setIframe(videoId){
    var id = extractId(videoId);
    if (!id) return;
    var iframe = document.getElementById('videoPlayer');
    if (!iframe) return;
    var src = 'https://www.youtube.com/embed/'+encodeURIComponent(id);
    iframe.src = withApi(src);
  }

  // Defer loading the YT IFrame API until the iframe src truly points at YouTube
  function loadYTWhenReady(){
    var iframe = document.getElementById('videoPlayer');
    if (!iframe) return;
    var ensure = function(){
      var isYT = /^(https:\/\/)?(www\.)?youtube\.com\/embed\//.test(iframe.src);
      if (isYT && !(window.YT && window.YT.Player)) {
        if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
          var s = document.createElement('script');
          s.src = 'https://www.youtube.com/iframe_api';
          document.head.appendChild(s);
        }
      }
    };
    // Run now and whenever the src changes
    ensure();
    try {
      new MutationObserver(function(muts){
        for (var i=0;i<muts.length;i++){
          if (muts[i].attributeName === 'src') ensure();
        }
      }).observe(iframe, { attributes:true, attributeFilter:['src'] });
    } catch(_) {}
  }

  // Public helper so existing buttons can open the video
  window.openProspectusVideo = function(videoId){
    setIframe(videoId);
    if (typeof window.showVideoModal === 'function') window.showVideoModal();
  };

  // Auto-bind any element with data-video-id or data-video-url
  function bindClicks(){
    var els = document.querySelectorAll('[data-video-id], [data-video-url]');
    els.forEach(function(el){
      if (el.__mhBound) return;
      el.__mhBound = true;
      el.addEventListener('click', function(ev){
        ev.preventDefault();
        setIframe(el.getAttribute('data-video-id') || el.getAttribute('data-video-url'));
        if (typeof window.showVideoModal === 'function') window.showVideoModal();
      });
    });
  }

  // Optional: default video via meta tag if you have it
  function initFromMeta(){
    var m = document.querySelector('meta[name="default-video-id"]');
    if (m && m.content) setIframe(m.content);
  }

  document.addEventListener('DOMContentLoaded', function(){
    bindClicks();
    initFromMeta();
    loadYTWhenReady();
    // Re-bind on dynamic content changes
    try {
      new MutationObserver(bindClicks).observe(document.body, { childList:true, subtree:true });
    } catch(_) {}
  });
})();
