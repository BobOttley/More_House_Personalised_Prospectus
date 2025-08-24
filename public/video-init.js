(function(){
  function withApi(url){
    try{
      var u = new URL(url || '', location.origin);
      if (!u.searchParams.has('enablejsapi')) u.searchParams.set('enablejsapi','1');
      if (!u.searchParams.has('origin'))      u.searchParams.set('origin', location.origin);
      return u.toString();
    }catch(e){
      return url;
    }
  }

  function extractId(maybeUrlOrId){
    if (!maybeUrlOrId) return null;
    try{
      var u = new URL(maybeUrlOrId, location.origin);
      if (/youtu\.be$/.test(u.hostname)) return u.pathname.replace('/','');
      if (/youtube\.com$/.test(u.hostname)) return u.searchParams.get('v') || (u.pathname.split('/').includes('embed') ? u.pathname.split('/').pop() : null);
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
    try{
      new MutationObserver(function(muts){
        muts.forEach(function(m){
          if (m.attributeName === 'src' && iframe.src && !/enablejsapi=1/.test(iframe.src)) {
            iframe.src = withApi(iframe.src);
          }
        });
      }).observe(iframe, { attributes:true, attributeFilter:['src'] });
    }catch(_){}
  }

  window.openProspectusVideo = function(videoId){
    setIframe(videoId);
    if (typeof window.showVideoModal === 'function') window.showVideoModal();
  };

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

  function initFromMeta(){
    var m = document.querySelector('meta[name="default-video-id"]');
    if (m && m.content) setIframe(m.content);
  }

  (function ensureYT(){
    if (window.YT && window.YT.Player) return;
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  })();

  document.addEventListener('DOMContentLoaded', function(){
    bindClicks();
    initFromMeta();
    var obs = new MutationObserver(bindClicks);
    obs.observe(document.body, { childList:true, subtree:true });
  });
})();
