/* watch-together-final.js
   Integra o Watch Together ao seu site de chat (use no mesmo diretório do index.html).
   - Encapsula tudo em initWatchTogether(options)
   - Auto-vincula ao botão #btnWatchTogether quando DOM estiver pronto
   - Não inclui chaves/segredos; ICE_ENDPOINT = '/ice' por padrão
*/

/* eslint-disable no-unused-vars */
(function globalWatchTogetherModule(){
  // Config (ajuste se seu signaling estiver em outro host)
  const DEFAULT_WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const DEFAULT_ICE_ENDPOINT = '/ice';

  // Expose initializer to window so you can call manually if needed
  window.initWatchTogether = function initWatchTogether(opts = {}) {
    // Ids/selectors used in your HTML (these exist in the chat HTML you sent)
    const sel = {
      btnWatchTogether: opts.btnWatchTogether || '#btnWatchTogether',
      watchModal: opts.watchModal || '#watchModal',
      watchClose: opts.watchClose || '#watchClose',
      wtVideo: opts.wtVideo || '#wtVideo',
      wtSource: opts.wtSource || '#wtSource',
      wtRoom: opts.wtRoom || '#wtRoom',
      wtJoin: opts.wtJoin || '#wtJoin',
      wtToggle: opts.wtToggle || '#wtToggle',
      wtUrl: opts.wtUrl || '#wtUrl',
      wtLoadUrl: opts.wtLoadUrl || '#wtLoadUrl',
      wtStatus: opts.wtStatus || '#wtStatus',
      watchControls: opts.watchControls || '.watch-controls'
    };

    // Config overrides
    const WS_URL = opts.WS_URL || DEFAULT_WS_URL;
    const ICE_ENDPOINT = opts.ICE_ENDPOINT || DEFAULT_ICE_ENDPOINT;

    // DOM nodes
    const $ = (s)=> document.querySelector(s);
    const btnWatchTogether = $(sel.btnWatchTogether);
    const watchModal = $(sel.watchModal);
    const watchClose = $(sel.watchClose);
    const wtVideo = $(sel.wtVideo);
    const wtSource = $(sel.wtSource);
    const wtRoom = $(sel.wtRoom);
    const wtJoin = $(sel.wtJoin);
    const wtToggle = $(sel.wtToggle);
    const wtUrl = $(sel.wtUrl);
    const wtLoadUrl = $(sel.wtLoadUrl);
    const wtStatus = $(sel.wtStatus);
    const watchControls = document.querySelector(sel.watchControls);

    if(!btnWatchTogether || !watchModal || !wtVideo){
      console.warn('WatchTogether: elementos essenciais não encontrados — verifique IDs/HTML.');
      return;
    }

    /* Internal state */
    let ws = null;
    let myId = null;
    let isHost = false;
    let roomId = null;
    const peers = new Map(); // peerId -> { pc, dc }
    let outgoingStream = null;
    const pendingPeers = new Set();
    const handledOfferFingerprints = new Set();
    const handledAnswersFrom = new Set();
    let qualityMode = 'auto'; // 'auto' | 'high' | 'ultra'
    let ICE_CACHE = { expires:0, iceServers: [{ urls:'stun:stun.l.google.com:19302' }] };
    let ICE_FETCH_PROMISE = null;

    /* small helpers */
    function now(){ return new Date().toISOString().slice(11,23); }
    function wtLog(...a){ console.log('[WT]['+now()+']', ...a); }
    function setWtStatus(s){ if(wtStatus) wtStatus.innerText = s; wtLog(s); }
    function toastFallback(m){ try{ if(window.toast) return window.toast(m); alert(m); }catch(e){ alert(m); } }

    /* Theme adaptation: nothing aggressive, just keep UI consistent */
    (function applyTheme(){
      try{
        const root = getComputedStyle(document.documentElement);
        const accent = (root.getPropertyValue('--accent') || '').trim();
        if(accent && wtToggle) {
          // small visual hint for toggle (kept subtle)
          wtToggle.style.border = '1px solid rgba(255,255,255,0.04)';
        }
      }catch(e){ wtLog('theme adapt fail', e); }
    })();

    /* Inject quality selector + fs button inside watch-controls if not present */
    (function injectControls(){
      if(!watchControls) return;
      if(document.getElementById('wtQualitySelect')) return;
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '8px';
      wrap.innerHTML = `
        <label style="font-size:12px;margin-right:6px;color:var(--muted)">Qualidade:</label>
        <select id="wtQualitySelect" title="Escolha qualidade">
          <option value="auto">Auto</option>
          <option value="high">Alta (720p)</option>
          <option value="ultra">Ultra (1080p)</option>
        </select>
        <button id="wtFsBtn" title="Fullscreen" type="button">Fullscreen</button>
      `;
      const statusNode = wtStatus;
      if(statusNode && statusNode.parentNode) statusNode.parentNode.insertBefore(wrap, statusNode);
      else watchControls.appendChild(wrap);

      const selEl = document.getElementById('wtQualitySelect');
      selEl.addEventListener('change', (e)=> {
        qualityMode = e.target.value;
        setWtStatus('Qualidade: ' + qualityMode);
        if(isHost && outgoingStream) applyQualityToPeers(qualityMode).catch(err=>wtLog('applyQuality fail', err));
      });

      const fsBtn = document.getElementById('wtFsBtn');
      fsBtn.addEventListener('click', toggleFullScreen);
      wtVideo.addEventListener('dblclick', toggleFullScreen);
    })();

    /* Fullscreen helpers */
    function isFullScreen(){ return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement); }
    async function toggleFullScreen(){
      try{
        if(!isFullScreen()){
          if(wtVideo.requestFullscreen) await wtVideo.requestFullscreen();
          else if(wtVideo.webkitRequestFullscreen) wtVideo.webkitRequestFullscreen();
          else if(wtVideo.mozRequestFullScreen) wtVideo.mozRequestFullScreen();
          else if(wtVideo.msRequestFullscreen) wtVideo.msRequestFullscreen();
        } else {
          if(document.exitFullscreen) await document.exitFullscreen();
          else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
          else if(document.mozCancelFullScreen) document.mozCancelFullScreen();
          else if(document.msExitFullscreen) document.msExitFullscreen();
        }
      }catch(e){ wtLog('fullscreen failed', e); }
    }

    /* Canvas capture util (draws wtVideo onto canvas at specific resolution) */
    function createCanvasCaptureFromVideo(videoEl, w=1280, h=720, fps=30){
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h; canvas.style.display='none'; document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      let rafId = null;
      const draw = ()=>{
        try{ ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height); }catch(e){}
        rafId = requestAnimationFrame(draw);
      };
      rafId = requestAnimationFrame(draw);
      const stream = canvas.captureStream(fps);
      const stopAll = ()=>{ if(rafId){ cancelAnimationFrame(rafId); rafId=null; } setTimeout(()=>{ try{ canvas.remove(); }catch(e){} }, 800); };
      stream._stopCanvas = stopAll;
      stream.getTracks().forEach(t => t.addEventListener('ended', stopAll));
      return { stream, stop: stopAll, canvas };
    }

    /* Try to set bitrate on sender */
    async function boostSenderParameters(pc, bitrate=1500000){
      try{
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if(!sender || !sender.getParameters) return false;
        const params = sender.getParameters();
        if(!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = bitrate;
        params.encodings[0].maxFramerate = 30;
        await sender.setParameters(params);
        return true;
      }catch(e){ wtLog('boostSenderParameters failed', e); return false; }
    }

    /* Apply quality (create canvas capture if needed), replace tracks, renegotiate */
    async function applyQualityToPeers(newMode){
      let newStream = null, canvasController = null;
      try{
        if(newMode === 'ultra'){
          const { stream, stop } = createCanvasCaptureFromVideo(wtVideo, 1920, 1080, 30);
          newStream = stream; canvasController = { stop };
        } else if(newMode === 'high'){
          const { stream, stop } = createCanvasCaptureFromVideo(wtVideo, 1280, 720, 30);
          newStream = stream; canvasController = { stop };
        } else {
          if(typeof wtVideo.captureStream === 'function') newStream = wtVideo.captureStream();
          if(!newStream && outgoingStream) newStream = outgoingStream;
        }
      }catch(e){ wtLog('create stream fail', e); }

      if(!newStream){ setWtStatus('Falha ao criar stream para qualidade ' + newMode); return; }

      const oldStream = outgoingStream;
      outgoingStream = newStream;
      outgoingStream._canvasController = canvasController || null;
      const bitrateMap = { auto:600000, high:1500000, ultra:3500000 };
      const targetBitrate = bitrateMap[newMode] || 1500000;

      for(const pid of Array.from(peers.keys())){
        const entry = peers.get(pid);
        if(!entry) continue;
        const pc = entry.pc;
        for(const track of outgoingStream.getTracks()){
          const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
          if(sender){
            try{ await sender.replaceTrack(track); }catch(e){ wtLog('replaceTrack fail', e); }
          } else {
            try{ pc.addTrack(track, outgoingStream); }catch(e){ wtLog('addTrack fail', e); }
          }
        }
        await boostSenderParameters(pc, targetBitrate).catch(()=>{});
        try{
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const fp = (offer.sdp || '').slice(0,120);
          sendWS({ scope:'watch', type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
        }catch(e){ wtLog('reneg fail', e); }
      }

      if(oldStream && oldStream !== newStream){
        try{ oldStream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} }); if(oldStream._stopCanvas) try{ oldStream._stopCanvas(); }catch(e){} }catch(e){}
      }
    }

    /* ICE fetcher (cache) */
    function fetchIceServers(force=false){
      const nowTs = Date.now();
      if(!force && ICE_CACHE.expires > nowTs && ICE_CACHE.iceServers) return Promise.resolve(ICE_CACHE.iceServers);
      if(ICE_FETCH_PROMISE) return ICE_FETCH_PROMISE;
      ICE_FETCH_PROMISE = (async ()=>{
        try{
          const res = await fetch(ICE_ENDPOINT, { cache: 'no-store' });
          if(!res.ok) throw new Error('ICE endpoint fail ' + res.status);
          const data = await res.json();
          const ice = (data && data.v && data.v.iceServers) ? data.v.iceServers : (data && data.iceServers) ? data.iceServers : (Array.isArray(data) ? data : null);
          if(ice && ice.length){ ICE_CACHE.iceServers = ice; ICE_CACHE.expires = Date.now() + 60*1000; wtLog('ICE from backend'); return ice; }
          throw new Error('No ice');
        }catch(e){
          wtLog('fetchIceServers fail, fallback STUN', e);
          ICE_CACHE.iceServers = [{ urls:'stun:stun.l.google.com:19302' }];
          ICE_CACHE.expires = Date.now() + 30*1000;
          return ICE_CACHE.iceServers;
        } finally { ICE_FETCH_PROMISE = null; }
      })();
      return ICE_FETCH_PROMISE;
    }

    /* WebSocket connect / send */
    function connectWS(){
      if(ws && ws.readyState === WebSocket.OPEN) return;
      try{ ws = new WebSocket(WS_URL); }catch(e){ setWtStatus('WS connect fail'); wtLog(e); return; }
      ws.onopen = ()=> { setWtStatus('WS conectado'); wtLog('WS open'); };
      ws.onmessage = (e)=> { try{ handleWS(JSON.parse(e.data)); }catch(err){ wtLog('WS parse fail', err); } };
      ws.onclose = ()=> { setWtStatus('WS fechado'); wtLog('WS closed'); };
      ws.onerror = (e)=> { wtLog('WS error', e); };
    }
    function sendWS(obj){
      if(!ws || ws.readyState !== WebSocket.OPEN){ connectWS(); setTimeout(()=> { try{ ws && ws.readyState===WebSocket.OPEN && ws.send(JSON.stringify(obj)); }catch(e){ wtLog('sendWS retry fail', e); } }, 300); return; }
      try{ ws.send(JSON.stringify(obj)); }catch(e){ wtLog('sendWS fail', e); }
    }

    /* UI wiring */
    btnWatchTogether.addEventListener('click', ()=>{
      watchModal.style.display = 'flex';
      if(wtRoom) wtRoom.value = wtRoom.value || ('room-'+Math.random().toString(36).slice(2,8));
      connectWS();
    });
    if(watchClose) watchClose.addEventListener('click', ()=> {
      watchModal.style.display = 'none';
      if(outgoingStream && outgoingStream._stopCanvas) try{ outgoingStream._stopCanvas(); }catch(e){}
      outgoingStream = null;
    });

    if(wtLoadUrl) wtLoadUrl.addEventListener('click', ()=>{
      const v = wtUrl && wtUrl.value && wtUrl.value.trim() ? wtUrl.value.trim() : null;
      if(!v) return toastFallback('Cole a URL do vídeo');
      try{ if(wtSource){ wtSource.src = v; wtVideo.load(); setWtStatus('URL carregada'); } }catch(e){ setWtStatus('Erro ao carregar URL'); wtLog(e); }
    });

    if(wtJoin) wtJoin.addEventListener('click', ()=>{
      connectWS();
      roomId = (wtRoom && wtRoom.value && wtRoom.value.trim()) ? wtRoom.value.trim() : ('room-'+Math.random().toString(36).slice(2,8));
      isHost = false;
      sendWS({ scope:'watch', type:'join', roomId });
      setWtStatus('Entrando na sala ' + roomId);
    });

    if(wtToggle) wtToggle.addEventListener('click', ()=>{
      if(wtToggle.classList && wtToggle.classList.contains('watch-on')){
        wtToggle.classList.remove('watch-on'); wtToggle.textContent = 'Watch Together: OFF';
        if(isHost){ sendWS({ scope:'watch', type:'screen-stopped', roomId }); isHost = false; if(outgoingStream && outgoingStream._stopCanvas) try{ outgoingStream._stopCanvas(); }catch(e){} outgoingStream = null; setWtStatus('Host desativado'); }
        return;
      }
      connectWS();
      roomId = (wtRoom && wtRoom.value && wtRoom.value.trim()) ? wtRoom.value.trim() : ('room-'+Math.random().toString(36).slice(2,8));
      isHost = true;
      sendWS({ scope:'watch', type:'create', roomId });
      wtToggle.classList.add('watch-on'); wtToggle.textContent = 'Watch Together: ON';
      setWtStatus('Criando sala: ' + roomId);
    });

    /* When host plays -> create outgoing stream according to qualityMode and negotiate */
    wtVideo.addEventListener('play', async ()=>{
      if(!isHost) { if(!isHost) setWtStatus('Você é convidado'); return; }
      try{
        if(qualityMode === 'ultra'){
          try{ const {stream, stop} = createCanvasCaptureFromVideo(wtVideo,1920,1080,30); outgoingStream = stream; outgoingStream._stopCanvas = stop; setWtStatus('Stream ULTRA iniciado'); }
          catch(e){ wtLog('ultra canvas fail', e); if(typeof wtVideo.captureStream === 'function') outgoingStream = wtVideo.captureStream(); }
        } else if(qualityMode === 'high'){
          try{ const {stream, stop} = createCanvasCaptureFromVideo(wtVideo,1280,720,30); outgoingStream = stream; outgoingStream._stopCanvas = stop; setWtStatus('Stream HIGH iniciado'); }
          catch(e){ wtLog('high canvas fail', e); if(typeof wtVideo.captureStream === 'function') outgoingStream = wtVideo.captureStream(); }
        } else {
          if(typeof wtVideo.captureStream === 'function') outgoingStream = wtVideo.captureStream();
          else setWtStatus('captureStream indisponível; escolha Alta/Ultra para canvas fallback');
        }

        if(!outgoingStream){ setWtStatus('Falha ao iniciar stream'); return; }

        const toNegotiate = Array.from(new Set([...peers.keys(), ...pendingPeers]));
        pendingPeers.clear();
        for(const pid of toNegotiate){
          let entry = peers.get(pid);
          if(!entry){ await createPC(pid, false); entry = peers.get(pid); }
          const pc = entry.pc;
          for(const track of outgoingStream.getTracks()){
            const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
            if(sender){ try{ await sender.replaceTrack(track); }catch(e){ wtLog('replaceTrack fail', e); } }
            else { try{ pc.addTrack(track, outgoingStream); }catch(e){ wtLog('addTrack fail', e); } }
          }
          const bitrate = qualityMode === 'ultra' ? 3500000 : (qualityMode === 'high' ? 1500000 : 600000);
          await boostSenderParameters(pc, bitrate).catch(()=>{});
          try{
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const fp = (offer.sdp || '').slice(0,120);
            sendWS({ scope:'watch', type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
          }catch(e){ wtLog('offer fail', e); }
        }

        const vt = outgoingStream.getVideoTracks()[0];
        if(vt) vt.onended = ()=> { setWtStatus('Stream finalizado pelo host'); sendWS({ scope:'watch', type:'screen-stopped', roomId }); outgoingStream = null; };
      }catch(e){ wtLog('play->stream fail', e); }
    });

    /* sync events */
    wtVideo.addEventListener('play', ()=> { if(isHost) sendWS({ scope:'watch', type:'play', roomId, time: wtVideo.currentTime }); });
    wtVideo.addEventListener('pause', ()=> { if(isHost) sendWS({ scope:'watch', type:'pause', roomId, time: wtVideo.currentTime }); });
    wtVideo.addEventListener('seeked', ()=> { if(isHost) sendWS({ scope:'watch', type:'seek', roomId, time: wtVideo.currentTime }); });

    /* Handle incoming WS messages scoped to 'watch' */
    async function handleWS(msg){
      if(!msg || msg.scope !== 'watch') return;
      const type = msg.type;
      if(type === 'created'){ myId = msg.id; setWtStatus('Sala criada — você é host'); return; }
      if(type === 'joined'){ myId = msg.id; setWtStatus('Entrou na sala — id ' + myId); return; }

      if(type === 'new-peer' && isHost){
        const pid = msg.id;
        wtLog('new-peer', pid);
        await createPC(pid, false);
        if(outgoingStream){
          const pc = peers.get(pid).pc;
          for(const track of outgoingStream.getTracks()){
            const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
            if(sender) { try{ await sender.replaceTrack(track); }catch(e){} }
            else { try{ pc.addTrack(track, outgoingStream); }catch(e){} }
          }
          try{
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const fp = (offer.sdp || '').slice(0,120);
            sendWS({ scope:'watch', type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
          }catch(e){ wtLog(e); }
        } else { pendingPeers.add(pid); }
        return;
      }

      if(type === 'offer' && isHost){ wtLog('Host received offer (ignore) from', msg.from); return; }

      if(type === 'offer' && !isHost){
        const from = msg.from;
        const fp = msg.offerFingerprint || (msg.sdp && msg.sdp.sdp ? msg.sdp.sdp.slice(0,120) : null);
        if(fp && handledOfferFingerprints.has(fp)){ wtLog('dup offer ignore'); return; }
        if(fp) handledOfferFingerprints.add(fp);
        wtLog('Guest handling offer from', from);
        await createPC(from, false);
        const entry = peers.get(from);
        try{
          await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          sendWS({ scope:'watch', type:'answer', to: msg.from, from: myId, roomId, sdp: entry.pc.localDescription });
        }catch(e){ wtLog('guest offer handling fail', e); }
        return;
      }

      if(type === 'answer' && isHost){
        const from = msg.from;
        if(handledAnswersFrom.has(from)){ wtLog('dup answer ignore', from); return; }
        handledAnswersFrom.add(from);
        const entry = peers.get(from);
        if(entry){ try{ await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); wtLog('Answer set from', from); }catch(e){ wtLog('setRemoteDescription fail', e); } }
        else wtLog('Answer but pc missing', from);
        return;
      }

      if(type === 'ice'){
        const from = msg.from; const candidate = msg.candidate;
        if(peers.has(from)){
          try{ await peers.get(from).pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){ wtLog('ice add fail', e); }
        } else {
          for(const entry of peers.values()){
            try{ await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){}
          }
        }
        return;
      }

      if(!isHost && type === 'play'){
        if(!wtVideo.srcObject){ wtVideo.currentTime = msg.time || 0; wtVideo.play().catch(()=>{}); } return;
      }
      if(!isHost && type === 'pause'){
        if(!wtVideo.srcObject){ wtVideo.currentTime = msg.time || wtVideo.currentTime; wtVideo.pause(); } return;
      }
      if(!isHost && type === 'seek'){
        if(!wtVideo.srcObject) wtVideo.currentTime = msg.time || wtVideo.currentTime; return;
      }
      if(type === 'screen-stopped'){
        if(!isHost){ wtVideo.pause(); if(wtSource) wtSource.src=''; wtVideo.load(); setWtStatus('Host parou o stream'); }
        return;
      }
    } // end handleWS

    /* create RTCPeerConnection and handlers */
    async function createPC(peerId, makeOffer=false, remoteSdp=null){
      if(peers.has(peerId)){ wtLog('pc exists', peerId); return; }
      const iceServers = await fetchIceServers().catch(()=> [{ urls:'stun:stun.l.google.com:19302' }]);
      const pc = new RTCPeerConnection({ iceServers });
      let dc = null;

      pc.onicecandidate = (e)=> { if(e.candidate) sendWS({ scope:'watch', type:'ice', to: peerId, from: myId, roomId, candidate: e.candidate }); };
      pc.onconnectionstatechange = ()=> wtLog('PC', peerId, pc.connectionState);

      if(!isHost){
        pc.ontrack = (event)=>{
          const s = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
          if(wtVideo.srcObject !== s){
            wtVideo.srcObject = s;
            wtVideo.muted = true;
            wtVideo.play().catch(()=>{});
            wtVideo.controls = true;
            setWtStatus('Stream recebida');
          }
        };
        pc.ondatachannel = (ev)=> { dc = ev.channel; dc.onmessage = (m)=>{}; };
      } else {
        dc = pc.createDataChannel('ctrl');
        dc.onopen = ()=> wtLog('host dc open', peerId);
        if(outgoingStream){
          for(const track of outgoingStream.getTracks()){
            try{ pc.addTrack(track, outgoingStream); }catch(e){ wtLog('pc.addTrack fail', e); }
          }
        }
      }

      peers.set(peerId, { pc, dc });

      if(makeOffer){
        try{
          if(isHost && outgoingStream){
            for(const track of outgoingStream.getTracks()){
              const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
              if(!sender) try{ pc.addTrack(track, outgoingStream); }catch(e){}
            }
          }
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const fp = (offer.sdp || '').slice(0,120);
          sendWS({ scope:'watch', type:'offer', to: peerId, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
        }catch(e){ wtLog('offer fail', e); }
      } else if(remoteSdp){
        try{
          await pc.setRemoteDescription(new RTCSessionDescription(remoteSdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendWS({ scope:'watch', type:'answer', to: remoteSdp.from || null, from: myId, roomId, sdp: pc.localDescription });
        }catch(e){ wtLog('answer fail', e); }
      }
    } // end createPC

    /* lazy init: observe modal display to warm up WS */
    (function initObserveModal(){
      try{
        const mo = new MutationObserver(muts => {
          muts.forEach(m=>{
            if(m.target && m.target.style && m.target.style.display === 'flex'){
              connectWS();
            }
          });
        });
        mo.observe(watchModal, { attributes:true, attributeFilter:['style'] });
      }catch(e){}
    })();

    /* Attach global handler to incoming ws messages */
    // Hook main ws message loop to our handler (we already call handleWS inside ws.onmessage)
    // But we also make ws.onmessage call handleWS (done in connectWS).

    // Expose a small debug API
    return {
      start: ()=> { connectWS(); if(watchModal) watchModal.style.display='flex'; },
      stop: ()=> { if(ws) try{ ws.close(); }catch(e){} ws = null; if(watchModal) watchModal.style.display='none'; },
      status: ()=> ({ isHost, roomId, myId, peers: Array.from(peers.keys()) })
    };
  }; // end initWatchTogether

  /* Auto-bind: when DOM ready, call initWatchTogether and attach to #btnWatchTogether if present */
  document.addEventListener('DOMContentLoaded', ()=>{
    // only auto-init if script not already used by page
    if(window._watchTogetherAutoInit) return;
    window._watchTogetherAutoInit = true;

    // Initialize module (default options)
    const api = window.initWatchTogether && window.initWatchTogether();
    // If you want manual control later: window.watchTogetherAPI = api;
    window.watchTogetherAPI = api || null;
  });
})();