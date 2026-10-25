// 对话框助手（第 14 项第 3 阶段）：打开时聚焦首个可聚焦字段、关闭后把焦点还给触发按钮。
// 原生 <dialog> + showModal() 已经自带 Escape 关闭与焦点陷阱，这里只补"还焦"和"首字段"。
let lastTrigger = null;

const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])';

export function openDialog(dialogEl, trigger) {
  if (!dialogEl) return null;
  lastTrigger = trigger || document.activeElement;
  if (typeof dialogEl.showModal === 'function') {
    if (!dialogEl.open) dialogEl.showModal();
  } else {
    dialogEl.setAttribute('open', '');
  }
  const first = dialogEl.querySelector(FOCUSABLE);
  if (first && typeof first.focus === 'function') first.focus();
  return dialogEl;
}

export function closeDialog(dialogEl) {
  if (!dialogEl) return;
  if (typeof dialogEl.close === 'function') dialogEl.close();
  else dialogEl.removeAttribute('open');
  const back = lastTrigger;
  lastTrigger = null;
  if (back && typeof back.focus === 'function') back.focus();
}

// 把"关闭"按钮一次性接上（data-close-* 的按钮老代码里各自绑了 close()，这里只统一还焦）。
export function bindDialogClose(dialogEl) {
  if (!dialogEl) return;
  dialogEl.addEventListener('close', function () {
    const back = lastTrigger;
    lastTrigger = null;
    if (back && typeof back.focus === 'function') back.focus();
  });
}
