/* PIMS · Live Notification Client
   Shared across user.html, hod.html, sgl.html
   Uses SSE for real-time push — no polling */
(function () {
  'use strict';

  let _unread = 0;
  let _panelOpen = false;
  let _evtSource = null;

  // ── Helpers ──────────────────────────────────────────

  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }

  function updateBadge(count) {
    _unread = Math.max(0, count);
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (_unread > 0) {
      badge.style.display = 'flex';
      badge.textContent = _unread > 99 ? '99+' : _unread;
    } else {
      badge.style.display = 'none';
    }
  }

  function iconSvg(type) {
    if (type === 'pool') {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
      <path d="M9 11l3 3L22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>`;
  }

  // ── Toast ─────────────────────────────────────────────

  function showToast(notif) {
    const existing = document.getElementById('notifToast');
    if (existing) { existing.remove(); }

    const t = document.createElement('div');
    t.id = 'notifToast';
    t.className = 'notif-toast';
    t.innerHTML = `
      <div class="toast-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      </div>
      <div class="toast-content">
        <div class="toast-title">${notif.title}</div>
        <div class="toast-body">${notif.body}</div>
      </div>
      <button class="toast-close" onclick="this.closest('.notif-toast').remove()" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>`;
    document.body.appendChild(t);

    // Auto-dismiss after 6 seconds
    setTimeout(() => {
      if (!t.parentNode) return;
      t.classList.add('out');
      setTimeout(() => t.remove(), 220);
    }, 6000);
  }

  // ── Panel ─────────────────────────────────────────────

  async function loadNotifications() {
    const list = document.getElementById('notifList');
    if (!list) return;
    try {
      const res = await fetch('/api/notif');
      const data = await res.json();
      if (!data.ok) return;

      const items = data.notifications;
      if (!items.length) {
        list.innerHTML = `<div class="notif-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          <div class="notif-empty-text">All caught up — no notifications</div>
        </div>`;
        return;
      }

      list.innerHTML = items.map(n => `
        <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}"
             onclick="window._notifMarkRead(${n.id}, this)">
          <div class="notif-icon ${n.type === 'pool' ? 'pool' : ''}">${iconSvg(n.type)}</div>
          <div class="notif-content">
            <div class="notif-title">${n.title}</div>
            <div class="notif-body">${n.body}</div>
            <div class="notif-time">${timeAgo(n.created_at)}</div>
          </div>
        </div>`).join('');
    } catch (_) {}
  }

  window._notifMarkRead = async function (id, el) {
    if (!el.classList.contains('unread')) return;
    await fetch(`/api/notif/${id}/read`, { method: 'PUT' });
    el.classList.remove('unread');
    updateBadge(_unread - 1);
  };

  async function markAllRead() {
    await fetch('/api/notif/read-all', { method: 'PUT' });
    document.querySelectorAll('.notif-item.unread').forEach(el => el.classList.remove('unread'));
    updateBadge(0);
  }

  function openPanel() {
    const panel = document.getElementById('notifPanel');
    const overlay = document.getElementById('notifOverlay');
    if (!panel) return;
    _panelOpen = true;
    panel.classList.add('open');
    if (overlay) overlay.classList.add('active');
    loadNotifications();
  }

  function closePanel() {
    const panel = document.getElementById('notifPanel');
    const overlay = document.getElementById('notifOverlay');
    if (!panel) return;
    _panelOpen = false;
    panel.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
  }

  // ── SSE connection ────────────────────────────────────

  function connectSSE() {
    if (_evtSource) return;
    _evtSource = new EventSource('/api/notif/stream');

    _evtSource.addEventListener('init', e => {
      const data = JSON.parse(e.data);
      updateBadge(data.unread);
    });

    _evtSource.addEventListener('notification', e => {
      const notif = JSON.parse(e.data);
      updateBadge(_unread + 1);
      showToast(notif);
      if (_panelOpen) loadNotifications();
    });

    _evtSource.onerror = () => {
      _evtSource.close();
      _evtSource = null;
      // Reconnect after 5s on error / server restart
      setTimeout(connectSSE, 5000);
    };
  }

  // ── Init ──────────────────────────────────────────────

  function init() {
    const bell    = document.getElementById('notifBell');
    const closeBtn = document.getElementById('notifClose');
    const markAll  = document.getElementById('notifMarkAll');
    const overlay  = document.getElementById('notifOverlay');

    if (bell)    bell.addEventListener('click', () => _panelOpen ? closePanel() : openPanel());
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    if (markAll)  markAll.addEventListener('click', markAllRead);
    if (overlay)  overlay.addEventListener('click', closePanel);

    connectSSE();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
