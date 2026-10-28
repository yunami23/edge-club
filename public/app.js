(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const initialCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().trim();
  const userName = sessionStorage.getItem('edge-name') || '';
  const playerId = sessionStorage.getItem('edge-id') || (crypto.randomUUID ? crypto.randomUUID() : 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  sessionStorage.setItem('edge-id', playerId);
  $('nameInput').value = userName;
  $('roomInput').value = initialCode;
  let tab = initialCode ? 'join' : 'create';
  let roomCode = null, state = null, socket = null, pending = null, reconnectTimer = null, toastTimer = null;
  let playerName = userName;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const codeLabel = n => String(n).padStart(2, '0');
  const choiceLabel = x => x === 'bank' ? '收手保分' : `前进 ${x} 步`;
  const outcomeLabel = o => o === 'safe' ? '成功落地 ✓' : o === 'banked' ? '积分安全入袋 ✳' : '坠入悬崖 ×';
  function toast(message) {
    $('toast').textContent = message; $('toast').classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3200);
  }
  function connection(ok) {
    $('connectionDot').parentElement.classList.toggle('online', ok);
    $('connectionText').textContent = ok ? '实时在线' : '连接中…';
  }
  function send(payload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    else { pending = payload; connect(); }
  }
  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    connection(false);
    socket.onopen = () => {
      connection(true);
      if (roomCode) socket.send(JSON.stringify({type:'join', code:roomCode, playerId, name:playerName}));
      else if (pending) { socket.send(JSON.stringify(pending)); pending = null; }
    };
    socket.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'error') {
        if (!roomCode) $('entryButton').firstChild.textContent = tab === 'join' ? '加入房间 ' : '创建房间 ';
        return toast(msg.message || '发生了一点问题');
      }
      if (msg.type === 'joined') {
        roomCode = msg.code;
        sessionStorage.setItem('edge-room', roomCode);
        history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(roomCode));
      }
      if (msg.type === 'state') { state = msg.room; roomCode = state.code; render(); }
    };
    socket.onclose = () => {
      connection(false);
      if (!roomCode && !state) $('entryNote').textContent = '正在尝试重新连接服务器…';
      reconnectTimer = setTimeout(connect, 1800);
    };
    socket.onerror = () => { /* close handler retries */ };
  }
  function changeTab(newTab) {
    tab = newTab;
    $('tabCreate').classList.toggle('active', tab === 'create');
    $('tabJoin').classList.toggle('active', tab === 'join');
    $('tabCreate').setAttribute('aria-selected', tab === 'create');
    $('tabJoin').setAttribute('aria-selected', tab === 'join');
    $('joinField').hidden = tab !== 'join';
    $('entryButton').firstChild.textContent = tab === 'join' ? '加入房间 ' : '创建房间 ';
  }
  function entry() {
    const name = $('nameInput').value.trim();
    if (!name) { $('nameInput').focus(); return toast('先给自己取个昵称吧。'); }
    playerName = [...name].slice(0,12).join('');
    sessionStorage.setItem('edge-name', playerName);
    if (tab === 'join') {
      const code = $('roomInput').value.toUpperCase().trim();
      if (!/^[A-Z2-9]{6}$/.test(code)) { $('roomInput').focus(); return toast('请输入正确的6位房间码。'); }
      send({type:'join', code, playerId, name:playerName});
    } else send({type:'create', playerId, name:playerName});
    $('entryButton').firstChild.textContent = '正在进入房间 ';
  }
  function playerCard(p, idx, selfId) {
    const status = p.status === 'fallen' ? '坠崖了' : p.status === 'banked' ? '已保分' : p.committed ? '已锁定选择' : '还在悬崖边';
    const detail = p.status === 'fallen' ? '本关得分：0' : p.status === 'banked' ? '等待下一关' : `本关可存：${p.pot} 分`;
    const left = Math.min(87, 9 + p.position * 8.15);
    const markers = Array.from({length:10}, (_,j)=>`<span class="${j < p.position?'passed':''}">${j+1}</span>`).join('');
    return `<article class="player-panel ${p.id===selfId?'self-player':''}">
      <div class="panel-bg-sun"></div>
      <div class="panel-top"><div class="panel-identity"><div class="panel-avatar">${idx===0?'✳':'✦'}</div><div><div class="panel-label">${idx===0?'PLAYER 01':'PLAYER 02'} ${p.id===selfId?'· 你':'· 对手'} ${p.connected?'':'· 断线'}</div><div class="panel-name">${escapeHtml(p.name)}</div></div></div><div class="score-block"><small>总积分</small><strong>${p.score}</strong></div></div>
      <div class="panel-art"><div class="track-horizon"></div><div class="track-markers">${markers}</div><div class="track-ledge"></div><div class="runner ${p.status==='fallen'?'fallen':''}" style="--runner-left:${left}%">${idx===0?'🧍':'🚶'}</div><span class="track-warning">? DANGER ?</span></div>
      <div class="panel-bottom"><span class="panel-status ${p.status}">${status}</span><span class="panel-substatus">${detail}</span></div>
    </article>`;
  }
  function render() {
    if (!state) return;
    $('homeView').hidden = true; $('gameView').hidden = false;
    $('roomCode').textContent = state.code;
    $('lobbySection').hidden = state.status !== 'lobby';
    $('playSection').hidden = state.status !== 'playing';
    $('finishSection').hidden = state.status !== 'finished';
    const me = state.players.find(p => p.id === playerId);
    const opponent = state.players.find(p => p.id !== playerId);
    if (state.status === 'lobby') {
      const slots = [state.players[0], state.players[1]];
      $('lobbySlots').innerHTML = slots.map((p,i) => `<div class="lobby-slot"><div class="slot-avatar">${i?'✦':'✳'}</div><div class="slot-name">${p?escapeHtml(p.name):'虚位以待'}</div><div class="slot-status">${p?(p.connected?'已就位':'等待重新连接'):'等待朋友加入…'}</div></div>`).join('');
      const ready = state.players.length === 2 && state.players.every(p => p.connected);
      $('startButton').disabled = !ready || state.players[0]?.id !== playerId;
      $('startButton').firstChild.textContent = !ready ? '等待第二位玩家… ' : state.players[0]?.id === playerId ? '开始这场较量 ' : '等待房主开始… ';
      return;
    }
    if (state.status === 'playing') {
      $('stageNumber').innerHTML = `${codeLabel(state.stage)} <small>/ ${codeLabel(state.totalStages)}</small>`;
      $('playerPanels').innerHTML = state.players.map((p,i) => playerCard(p,i,playerId)).join('');
      if (state.phase === 'reveal' && state.lastReveal) {
        const r = state.lastReveal;
        $('revealPanel').hidden = false;
        $('revealPanel').classList.toggle('end', r.stageEnd);
        $('revealPanel').innerHTML = `<div class="reveal-header"><span>${r.stageEnd?'✳ 这一关结束了！':'✦ 双方选择揭晓'}</span><small>${r.stageEnd?`悬崖的真正边界：第 ${r.limit} 格 · 即将进入下一阶段`:'正在准备下一次选择…'}</small></div><div class="reveal-actions">${r.actions.map(a=>`<span>${escapeHtml(a.name)}：${choiceLabel(a.choice)} · ${outcomeLabel(a.outcome)}</span>`).join('')}</div>`;
      } else $('revealPanel').hidden = true;
      const canChoose = Boolean(me && me.status==='active' && !me.committed && state.phase==='choose' && opponent?.connected);
      document.querySelectorAll('[data-act="choose"]').forEach(b => b.disabled = !canChoose);
      if (state.phase === 'reveal') { $('actionTitle').textContent = '看看刚才发生了什么…'; $('actionTip').textContent = '即将自动进入下一次选择'; }
      else if (me?.status === 'banked') { $('actionTitle').textContent = '你已经安全收手。'; $('actionTip').textContent = '等对手完成本关'; }
      else if (me?.status === 'fallen') { $('actionTitle').textContent = '这关摔了，下一关再来。'; $('actionTip').textContent = '等对手完成本关'; }
      else if (me?.committed) { $('actionTitle').textContent = '选择已经锁定。'; $('actionTip').textContent = '等对手做决定…'; }
      else { $('actionTitle').textContent = '这一次，你敢走几步？'; $('actionTip').textContent = '同时暗选，确认后不可撤回'; }
      $('actionFeedback').textContent = !opponent?.connected ? '对手暂时离线，等待重新连接…' : me?.committed ? '你的选择已经保密提交，等待对手。' : me?.status !== 'active' ? '本关已结束你的操作，等待下一关。' : state.phase === 'reveal' ? '选择揭晓中…' : `当前已前进 ${me?.position??0} 步，本关累计 ${me?.pot??0} 分。`;
      $('activityList').innerHTML = [...state.history].reverse().slice(0,7).map(h=>`<div class="activity-item"><b>关 ${codeLabel(h.stage)}</b>${escapeHtml(h.message)}</div>`).join('') || '<div class="activity-item">比赛开始，第一步最难。</div>';
      return;
    }
    if (state.status === 'finished') {
      const tie = state.winner === 'tie', selfWon = state.winner === playerId;
      const winner = state.players.find(p=>p.id===state.winner);
      $('finishTitle').textContent = tie ? '势均力敌，平局！' : selfWon ? '你赢了，胆子真大！' : `${winner?.name??'对手'} 赢了！`;
      $('finishSubtitle').textContent = tie ? '你们对悬崖的敬畏，出奇地一致。' : selfWon ? '你把运气和胆量都拿捏得刚刚好。' : '悬崖还在，机会还有。再来一次？';
      $('finishScores').innerHTML = state.players.map((p,i)=>`<div class="finish-score ${state.winner===p.id?'winner':''}"><small>PLAYER ${codeLabel(i+1)}</small><h3>${escapeHtml(p.name)}</h3><strong>${p.score}</strong><span>${state.winner===p.id?'🏆 本场赢家':p.id===playerId?'你':'对手'}</span></div>`).join('');
      $('rematchButton').disabled = Boolean(me?.rematchReady);
      $('rematchButton').firstChild.textContent = me?.rematchReady ? '已准备，等对手同意 ' : '再来一局 ';
      $('rematchNote').textContent = opponent?.rematchReady ? '对手已经申请重赛！点上方按钮马上开始。' : '双方都选择再来一局后，自动开始新比赛。';
    }
  }
  async function copyInvite() {
    if (!roomCode) return;
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', roomCode);
    try { await navigator.clipboard.writeText(url.href); toast('邀请链接已复制，发给朋友就能一起玩！'); }
    catch { try { const inp = document.createElement('textarea'); inp.value=url.href; document.body.appendChild(inp); inp.select(); document.execCommand('copy'); inp.remove(); toast('邀请链接已复制！'); } catch { toast('房间码：'+roomCode); } }
  }
  document.body.addEventListener('click', ev => {
    const btn = ev.target.closest('button'); if (!btn || btn.disabled) return;
    if (btn.dataset.tab) return changeTab(btn.dataset.tab);
    switch (btn.dataset.act) {
      case 'entry': entry(); break;
      case 'copy': copyInvite(); break;
      case 'start': send({type:'start'}); break;
      case 'choose': send({type:'choose', choice:btn.dataset.choice==='bank'?'bank':Number(btn.dataset.choice)}); break;
      case 'rematch': send({type:'rematch'}); break;
      case 'leave': sessionStorage.removeItem('edge-room'); location.href = '/'; break;
    }
  });
  $('nameInput').addEventListener('keydown', ev => { if (ev.key === 'Enter') entry(); });
  $('roomInput').addEventListener('keydown', ev => { if (ev.key === 'Enter') entry(); });
  $('roomInput').addEventListener('input', ev => { ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
  changeTab(tab);
  if (initialCode && userName && sessionStorage.getItem('edge-room') === initialCode) {
    roomCode = initialCode; playerName = userName;
  }
  // Small client heartbeat to maintain WebSocket connections while both players think.
  setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'ping'})); }, 25000);
  connect();
})();
