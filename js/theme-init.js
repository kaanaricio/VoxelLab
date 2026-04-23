(function () {
  var theme = localStorage.getItem('mri-viewer-theme');
  if (theme === 'light') document.documentElement.classList.add('light');
  try {
    var raw = localStorage.getItem('mri-viewer/shellLayout/v1');
    if (!raw) return;
    var layout = JSON.parse(raw);
    if (typeof layout.leftCollapsed !== 'boolean' || typeof layout.rightCollapsed !== 'boolean') return;
    if (layout.leftCollapsed) document.documentElement.setAttribute('data-shell-left-collapsed', 'true');
    if (layout.rightCollapsed) document.documentElement.setAttribute('data-shell-right-collapsed', 'true');
  } catch {
    /* ignore */
  }
})();
