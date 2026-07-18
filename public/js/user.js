/* ── Collapsible sidebar items ── */
document.querySelectorAll('.collapsible .folder-header').forEach(header => {
  header.addEventListener('click', () => {
    header.closest('.collapsible').classList.toggle('open');
  });
});

/* ── Dropdown menus ── */
function toggleDropdown(e) {
  e.stopPropagation();
  const dd = e.currentTarget.nextElementSibling;
  const isOpen = dd.classList.contains('open');
  document.querySelectorAll('.dropdown-content.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) dd.classList.add('open');
}
document.addEventListener('click', () => {
  document.querySelectorAll('.dropdown-content.open').forEach(el => el.classList.remove('open'));
});




/* ── About Modal ── */
function openAboutModal() {
  document.getElementById('aboutModal').style.display = 'block';
}
function closeAboutModal() {
  document.getElementById('aboutModal').style.display = 'none';
}
window.addEventListener('click', e => {
  const modal = document.getElementById('aboutModal');
  if (modal && e.target === modal) modal.style.display = 'none';
});

/* ════════════════════════════════════════════════════════════
   PIMS NEXT · JavaScript — All interactions & navigation
   Drop pims-next.js alongside pims-next.css and index.html
════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Helpers ── */
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  /* ════════════════════════════════════════════════
     TOAST
  ════════════════════════════════════════════════ */
  let toastTimer;
  function showToast(msg, duration = 2800) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), duration);
  }

  /* ════════════════════════════════════════════════
     VIEW ROUTER
  ════════════════════════════════════════════════ */
  const viewLabels = {
    'welcome': 'Welcome',
    'default-task-table-container': 'My Tasks',
    'pc-task-table-container': 'My Tasks',
    'mc-task-table-container': 'My Tasks',
    'default-notification-table-container': 'Notifications',
    'pc-notification-table-container': 'Notifications',
    'mc-notification-table-container': 'Notifications',
    'checker-view-container': 'Task Detail',
    'stress-upload-container': 'Stress Index',
  };

  let currentView = 'view-welcome';

  function showView(viewId, label) {
    // Hide all panels
    $$('.view-panel').forEach(p => {
      p.classList.remove('active-panel');
      p.style.display = 'none';
    });

    // Find target
    const target = $('view-' + viewId) || $(viewId);
    if (!target) return;

    target.style.display = 'block';
    // Force reflow then add class for animation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => target.classList.add('active-panel'));
    });

    currentView = viewId;

    // Update breadcrumb
    const crumb = $('cbCurrent');
    if (crumb) crumb.textContent = label || viewLabels[viewId] || viewId;

    // Update mobile bottom nav
    updateMobNav(viewId);
  }

  /* Expose for legacy scripts */
  window.showPIMSView = showView;

  /* ════════════════════════════════════════════════
     SIDEBAR
  ════════════════════════════════════════════════ */
  const sidebar = $('sidebar');
  const shell = $('shell');
  const sbCollapseBtn = $('sbCollapseBtn');

  // Desktop collapse
  on(sbCollapseBtn, 'click', () => {
    sidebar && sidebar.classList.toggle('collapsed');
  });

  // Nav groups — accordion only; nav-active is NOT tied to open/closed
  $$('.nav-group-btn').forEach(btn => {
    on(btn, 'click', () => {
      const group = btn.closest('.nav-group');
      if (!group) return;
      if (!group.querySelector('.nav-children')) return;

      const isOpen = group.classList.contains('open');
      $$('.nav-group.open').forEach(g => g.classList.remove('open'));
      if (!isOpen) group.classList.add('open');
    });
  });

  // Pre-open inbox accordion so children are visible when sidebar is expanded,
  // but do NOT mark it nav-active — the user lands on the welcome view, not Inbox.
  const inboxGroup = document.querySelector('[data-group="inbox"]');
  if (inboxGroup) inboxGroup.classList.add('open');

  // Nav children clicks — mark the clicked child AND its parent group as active
  $$('.nav-child').forEach(child => {
    on(child, 'click', () => {
      if (child.classList.contains('disabled-nav')) return;
      $$('.nav-child').forEach(c => c.classList.remove('active-nav'));
      child.classList.add('active-nav');
      $$('.nav-group-btn').forEach(b => b.classList.remove('nav-active'));
      const parentGroup = child.closest('.nav-group');
      const parentBtn = parentGroup && parentGroup.querySelector(':scope > .nav-group-btn');
      if (parentBtn) parentBtn.classList.add('nav-active');
      const view = child.dataset.view;
      if (view) navigateTo(view);
    });
  });

  // View mapping for nav
  function navigateTo(view) {
    if (view === 'notifications') {
      showView('default-notification-table-container', 'Notifications');
      const tbody = document.querySelector('#default-notification-table-container .data-table tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="no-data">Loading notifications…</td></tr>';
      if (typeof autoLoadNotifications === 'function') autoLoadNotifications();
      return;
    }
    if (view === 'my-tasks') {
      showView('default-task-table-container', 'My Tasks');
      const tbody = document.querySelector('#default-task-table-container .data-table tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="no-data">Loading tasks…</td></tr>';
      if (typeof loadClaimedTasksData === 'function') loadClaimedTasksData();
      return;
    }
    const map = {
      'my-tasks':      'default-task-table-container',
      'notifications': 'default-notification-table-container',
    };
    const target = map[view];
    if (target) showView(target, viewLabels[target] || target);
  }

  /* ════════════════════════════════════════════════
     MOBILE SIDEBAR
  ════════════════════════════════════════════════ */
  const mobMenuBtn = $('mobMenuBtn');
  const sidebarOverlay = $('sidebarOverlay');

  function openMobileSidebar() {
    sidebar && sidebar.classList.add('mobile-open');
    sidebarOverlay && sidebarOverlay.classList.add('show');
    mobMenuBtn && mobMenuBtn.classList.add('open');
  }

  function closeMobileSidebar() {
    sidebar && sidebar.classList.remove('mobile-open');
    sidebarOverlay && sidebarOverlay.classList.remove('show');
    mobMenuBtn && mobMenuBtn.classList.remove('open');
  }

  on(mobMenuBtn, 'click', () => {
    sidebar && sidebar.classList.contains('mobile-open')
      ? closeMobileSidebar()
      : openMobileSidebar();
  });

  on(sidebarOverlay, 'click', closeMobileSidebar);

  // Close sidebar on nav child click (mobile)
  $$('.nav-child').forEach(child => {
    on(child, 'click', () => {
      if (window.innerWidth <= 768) closeMobileSidebar();
    });
  });

  /* ════════════════════════════════════════════════
     MOBILE BOTTOM NAV
  ════════════════════════════════════════════════ */
  function updateMobNav(viewId) {
    const mobMap = {
      'view-welcome': 'welcome',
      'default-task-table-container': 'my-tasks',
      'default-notification-table-container': 'notifications',
    };
    const mview = mobMap[viewId] || viewId;
    $$('.mob-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mview === mview);
    });
  }

  $$('.mob-nav-item').forEach(btn => {
    on(btn, 'click', () => {
      const view = btn.dataset.mview;
      if (view === 'welcome') showView('welcome', 'Welcome');
      else navigateTo(view);
      $$('.mob-nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  /* ════════════════════════════════════════════════
     COMMAND BAR DROPDOWNS
  ════════════════════════════════════════════════ */
  function setupCbDropdown(btnId, ddId) {
    const btn = $(btnId);
    const dd = $(ddId);
    if (!btn || !dd) return;

    on(btn, 'click', e => {
      e.stopPropagation();
      const isOpen = dd.classList.contains('open');
      closeAllDropdowns();
      if (!isOpen) {
        dd.classList.add('open');
        btn.classList.add('open');
      }
    });
  }

  function closeAllDropdowns() {
    $$('.cb-dropdown.open').forEach(d => d.classList.remove('open'));
    $$('.cb-pill.open').forEach(b => b.classList.remove('open'));
  }

  document.addEventListener('click', closeAllDropdowns);

  /* ════════════════════════════════════════════════
     ABOUT MODAL
  ════════════════════════════════════════════════ */
  function openAbout() {
    const modal = $('aboutModal');
    if (modal) { modal.classList.add('open'); }
  }

  function closeAbout() {
    const modal = $('aboutModal');
    if (modal) modal.classList.remove('open');
  }

  // Multiple triggers
  ['aboutBtn', 'aboutBtnTop'].forEach(id => on($(id), 'click', openAbout));
  on($('modalClose'), 'click', closeAbout);

  on($('aboutModal'), 'click', e => {
    if (e.target === $('aboutModal')) closeAbout();
  });

  // Expose for legacy
  window.openAboutModal = openAbout;
  window.closeAboutModal = closeAbout;

  /* ════════════════════════════════════════════════
     LOGOUT
  ════════════════════════════════════════════════ */
  async function doLogout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { }
    window.location.href = '/index.html';
  }

  ['btnLogout', 'mobLogoutBtn'].forEach(id => on($(id), 'click', doLogout));

  /* ════════════════════════════════════════════════
     GLOBAL KEYBOARD SHORTCUTS
  ════════════════════════════════════════════════ */
  document.addEventListener('keydown', e => {
    // ⌘K / Ctrl+K → focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const search = $('globalSearch');
      if (search) search.focus();
    }
    // Escape → close modals/dropdowns
    if (e.key === 'Escape') {
      closeAllDropdowns();
      closeAbout();
      closeMobileSidebar();
    }
  });

  /* ════════════════════════════════════════════════
     GLOBAL SEARCH — live filter visible table
  ════════════════════════════════════════════════ */
  on($('globalSearch'), 'input', e => {
    const q = e.target.value.trim().toLowerCase();
    const activePanel = document.querySelector('.view-panel.active-panel');
    if (!activePanel) return;

    activePanel.querySelectorAll('.data-table tbody tr').forEach(row => {
      row.style.display = q === '' || row.textContent.toLowerCase().includes(q)
        ? '' : 'none';
    });
  });

  // Per-panel search inputs
  function hookPanelSearch(inputId) {
    on($(inputId), 'input', e => {
      const q = e.target.value.trim().toLowerCase();
      const tbl = e.target.closest('.view-panel')?.querySelector('.data-table tbody');
      if (!tbl) return;
      tbl.querySelectorAll('tr').forEach(row => {
        row.style.display = q === '' || row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  hookPanelSearch('task-table-search-input');
  hookPanelSearch('notification-table-search-input');

  /* Expose for legacy scripts */
  window.setupTableSearch = function (type) {
    if (type === 'notification') hookPanelSearch('notification-table-search-input');
    if (type === 'task') hookPanelSearch('task-table-search-input');
  };

  /* ════════════════════════════════════════════════
     SIDEBAR TOOL BUTTONS
  ════════════════════════════════════════════════ */

  on($('feedbackBtn'), 'click', () => window.open('https://forms.gle/UjGuMiht51UcDdPW7', '_blank'));

  /* ════════════════════════════════════════════════
     CONTEXT MENU
  ════════════════════════════════════════════════ */
  const ctxMenu = $('iso-context');

  on(document, 'contextmenu', e => {
    const row = e.target.closest('.iso-row');
    if (!row || !ctxMenu) return;
    e.preventDefault();
    ctxMenu.style.left = e.pageX + 'px';
    ctxMenu.style.top = e.pageY + 'px';
    ctxMenu.style.display = 'block';
    ctxMenu.style.position = 'fixed';
  });

  on(document, 'click', () => {
    if (ctxMenu) ctxMenu.style.display = 'none';
  });

  /* ════════════════════════════════════════════════
     SIDEBAR DRAG RESIZE (desktop only)
  ════════════════════════════════════════════════ */
  let sbDragging = false, sbStartX, sbStartW;

  // Create drag handle at sidebar edge
  const sbDragHandle = document.createElement('div');
  sbDragHandle.style.cssText = `
    position:absolute; right:-3px; top:0; bottom:0; width:6px;
    cursor:col-resize; z-index:10;
  `;
  sidebar && sidebar.appendChild(sbDragHandle);

  on(sbDragHandle, 'mousedown', e => {
    if (window.innerWidth <= 768) return;
    sbDragging = true;
    sbStartX = e.clientX;
    sbStartW = sidebar.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  on(document, 'mousemove', e => {
    if (!sbDragging) return;
    const w = Math.max(180, Math.min(400, sbStartW + e.clientX - sbStartX));
    sidebar.style.width = w + 'px';
    sidebar.style.transition = 'none';
  });

  on(document, 'mouseup', () => {
    if (!sbDragging) return;
    sbDragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    sidebar && (sidebar.style.transition = '');
  });

  /* ════════════════════════════════════════════════
     PAGE LOAD ANIMATION SEQUENCE
  ════════════════════════════════════════════════ */
  function staggerIn(selector, baseDelay = 60) {
    $$(selector).forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(12px)';
      el.style.transition = `opacity 0.4s ease ${i * baseDelay}ms, transform 0.4s ease ${i * baseDelay}ms`;
      requestAnimationFrame(() => {
        setTimeout(() => {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        }, 50);
      });
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    staggerIn('.sb-brand, .sb-user, .sb-section-label, .nav-group', 80);
    staggerIn('.wstat', 120);
  });

  /* ════════════════════════════════════════════════
     SCROLL-BASED COMMAND BAR ELEVATION
  ════════════════════════════════════════════════ */
  const contentArea = document.querySelector('.content-area');
  const commandBar = $('commandBar');

  on(contentArea, 'scroll', () => {
    if (!commandBar) return;
    const scrolled = contentArea.scrollTop > 10;
    commandBar.style.boxShadow = scrolled
      ? '0 4px 20px rgba(58,40,20,0.10)'
      : 'none';
  });

  /* ════════════════════════════════════════════════
     WELCOME STATS — auto-populate from DOM counts
  ════════════════════════════════════════════════ */
  function updateWelcomeStats() {
    // These get updated by left-top.js; we just ensure they show something
    const taskRows = document.querySelectorAll('#default-task-table-container tbody tr:not([style*="none"])').length;
    const notifRows = document.querySelectorAll('#default-notification-table-container tbody tr:not([style*="none"])').length;

    const statTasks = $('statTasks');
    const statNotifs = $('statNotifs');
    const statProjects = $('statProjects');

    if (statTasks && taskRows > 0) statTasks.textContent = taskRows;
    if (statNotifs && notifRows > 0) statNotifs.textContent = notifRows;
    if (statProjects) statProjects.textContent = '—';
  }

  // Run after scripts load
  setTimeout(updateWelcomeStats, 1500);

  /* ════════════════════════════════════════════════
     LEGACY COMPATIBILITY LAYER
     left-top.js and friends expect these globals
  ════════════════════════════════════════════════ */

  // toggleDropdown used by old inline onclick attrs
  window.toggleDropdown = function (e) {
    e.stopPropagation();
    const dd = e.currentTarget.nextElementSibling;
    if (!dd) return;
    const isOpen = dd.classList.contains('open');
    closeAllDropdowns();
    if (!isOpen) {
      dd.classList.add('open');
      e.currentTarget.classList.add('open');
    }
  };

  // Show/hide specific containers (called by left-top.js)
  function hideAllRoleContainers() {
    const ids = [
      'default-task-table-container',
      'pc-task-table-container',
      'mc-task-table-container',
      'default-notification-table-container',
      'pc-notification-table-container',
      'mc-notification-table-container',
      'checker-view-container',
      'stress-upload-container',
      'view-welcome',
    ];
    ids.forEach(id => {
      const el = $(id);
      if (el) {
        el.classList.remove('active-panel');
        el.style.display = 'none';
      }
    });
  }

  // Legacy show functions compatible with left-top.js
  window.showContainer = function (containerId) {
    hideAllRoleContainers();
    const el = $(containerId);
    if (el) {
      el.style.display = 'block';
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('active-panel')));
    }
    const crumb = $('cbCurrent');
    if (crumb) crumb.textContent = viewLabels[containerId] || containerId;
  };

  // Intercept iso-surface and comments-surface show/hide
  const origDisplay = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style');
  // (keep native — just ensure surfaces use view-panel class when shown)

  /* ════════════════════════════════════════════════
     RESPONSIVE: HANDLE RESIZE
  ════════════════════════════════════════════════ */
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth > 768) {
        closeMobileSidebar();
        // Restore sidebar width if it was auto-sized
        if (sidebar && !sidebar.style.width) {
          sidebar.style.width = '';
        }
      }
    }, 150);
  });

  /* ════════════════════════════════════════════════
     INIT — show welcome
  ════════════════════════════════════════════════ */
  showView('welcome', 'Welcome');

  // Expose useful API
  window.PIMS = {
    showView,
    showToast,
    openAbout,
    navigateTo,
  };

  console.log('%cPIMS NEXT loaded ✦', 'color:#c8922a; font-family:serif; font-size:14px;');

  /* ════════════════════════════════════════════════
     COLLAPSED SIDEBAR FLYOUT
     Shows label + children as a fixed panel when
     hovering a nav icon in icon-only (collapsed) mode.
  ════════════════════════════════════════════════ */
  const sbFlyout = document.createElement('div');
  sbFlyout.id        = 'sb-flyout';
  sbFlyout.className = 'sb-flyout-panel';
  sbFlyout.innerHTML =
    '<div class="sb-flyout-hdr"></div>' +
    '<div class="sb-flyout-body"></div>';
  sbFlyout.style.display = 'none';
  document.body.appendChild(sbFlyout);

  let _flyTimer = null;

  function _showFlyout(btn) {
    if (!sidebar || !sidebar.classList.contains('collapsed')) return;
    clearTimeout(_flyTimer);

    const group = btn.closest('.nav-group');

    /* ── Label ── */
    const labelEl = btn.querySelector('.nav-label');
    const label   = labelEl ? labelEl.textContent.trim() : '';
    sbFlyout.querySelector('.sb-flyout-hdr').textContent = label;

    /* ── Children ── */
    const body        = sbFlyout.querySelector('.sb-flyout-body');
    body.innerHTML    = '';
    const navChildren = group && group.querySelector('.nav-children');
    let   hasItems    = false;

    if (navChildren) {
      Array.from(navChildren.children).forEach(function (el) {
        /* skip: inline-hidden (role-gated) or project tree containers */
        if (el.style.display === 'none') return;
        if (el.classList.contains('mp-tree-container') ||
            el.classList.contains('mp-tree')) return;

        hasItems = true;

        if (el.classList.contains('nav-child-hdr')) {
          const hdr = document.createElement('div');
          hdr.className   = 'sb-flyout-section-hdr';
          hdr.textContent = el.textContent.trim();
          body.appendChild(hdr);

        } else if (el.classList.contains('nav-child')) {
          const isLink  = el.tagName === 'A';
          const clone   = document.createElement(isLink ? 'a' : 'button');
          clone.className = 'nav-child' +
            (el.classList.contains('active-nav') ? ' active-nav' : '');
          if (isLink) {
            clone.href   = el.href;
            clone.target = el.target || '';
            clone.rel    = el.rel    || '';
          }
          clone.innerHTML = el.innerHTML;
          clone.addEventListener('click', function () {
            _hideFlyout(true);
            if (!isLink) el.click(); /* fire all attached listeners; <a> follows href naturally */
          });
          body.appendChild(clone);
        }
      });

      if (hasItems) {
        const divider = document.createElement('div');
        divider.className = 'sb-flyout-divider';
        body.insertBefore(divider, body.firstChild);
      }
    }

    /* ── Position (hidden first to avoid flash) ── */
    sbFlyout.style.visibility = 'hidden';
    sbFlyout.style.display    = 'block';
    const rect  = btn.getBoundingClientRect();
    const flyH  = sbFlyout.offsetHeight;
    const winH  = window.innerHeight;
    let   top   = rect.top;
    if (top + flyH > winH - 8) top = winH - flyH - 8;
    sbFlyout.style.left       = (rect.right + 6) + 'px';
    sbFlyout.style.top        = top + 'px';
    sbFlyout.style.visibility = '';
  }

  function _hideFlyout(immediate) {
    if (immediate) {
      sbFlyout.style.display = 'none';
    } else {
      _flyTimer = setTimeout(function () { sbFlyout.style.display = 'none'; }, 130);
    }
  }

  /* Attach hover to every nav-group row */
  $$('.nav-group').forEach(function (group) {
    const btn = group.querySelector(':scope > .nav-group-btn') ||
                group.querySelector(':scope > a');
    if (!btn) return;
    group.addEventListener('mouseenter', function () { _showFlyout(btn); });
    group.addEventListener('mouseleave', function () { _hideFlyout(false); });
  });

  /* Keep flyout alive while mouse is over it */
  sbFlyout.addEventListener('mouseenter', function () { clearTimeout(_flyTimer); });
  sbFlyout.addEventListener('mouseleave', function () { _hideFlyout(false); });

  /* Hide immediately when sidebar is expanded */
  on(sbCollapseBtn, 'click', function () { _hideFlyout(true); });

})();
