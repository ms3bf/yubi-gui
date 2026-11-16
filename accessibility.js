// The same panel is a desktop aside and a modal mobile sheet.
const panel = document.getElementById('panel');
const narrow = matchMedia('(max-width:700px)');
let active = false, opener = null;
const background = new Map();
const focusable = () => [...panel.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
  .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert]'));
function syncSheet() {
  const next = narrow.matches && document.body.classList.contains('panel-open');
  if (active === next) return;
  active = next;
  if (active) {
    opener = document.activeElement;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.tabIndex = -1;
    // Inert siblings at every ancestor, while leaving the panel's ancestors usable.
    for (let node = panel; node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.matches('dialog,script,style')) continue;
        background.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
    (panel.querySelector('[role="tab"][aria-selected="true"]') || focusable()[0] || panel).focus();
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    panel.removeAttribute('tabindex');
    for (const [element, inert] of background) element.inert = inert;
    background.clear();
    if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    opener = null;
  }
}
new MutationObserver(syncSheet).observe(document.body, {attributes: true, attributeFilter: ['class']});
narrow.addEventListener('change', syncSheet);
document.addEventListener('keydown', event => {
  if (!active || document.querySelector('dialog[open]') || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    document.body.classList.remove('panel-open'); syncSheet();
  } else if (event.key === 'Tab') {
    const items = focusable(), first = items[0] || panel, last = items.at(-1) || panel;
    if (!panel.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }
}, true);
syncSheet();
