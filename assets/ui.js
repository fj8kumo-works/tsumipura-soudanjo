// 画面共通の表示部品
import { describeError } from './api.js?v=3';

// エラーを「何が起きたか / どうすれば直るか」の2行で表示する。retry を渡すと「もう一度試す」ボタンを出す
export function showError(box, err, retry) {
  const { what, how } = describeError(err);
  const whatP = document.createElement('p');
  whatP.className = 'error-what';
  whatP.textContent = what;
  const howP = document.createElement('p');
  howP.className = 'error-how';
  howP.textContent = how;
  box.replaceChildren(whatP, howP);
  if (retry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost';
    btn.textContent = 'もう一度試す';
    btn.addEventListener('click', retry);
    box.append(btn);
  }
  box.hidden = false;
}

export function hideError(box) {
  box.hidden = true;
  box.replaceChildren();
}

// 画面の準備ができたことを assets/boot.js に知らせる(知らせがないと10秒後に案内を出す)
export function markReady() {
  window.__appReady = true;
}
