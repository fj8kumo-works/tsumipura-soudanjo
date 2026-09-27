/* 画面が動き出せなかったときの案内(古いブラウザでも動くよう、古い書き方だけで書く)
 *   ・module(新しい書き方の JavaScript)に対応していないブラウザ → すぐに案内
 *   ・10秒たっても画面の準備ができない(ファイルが読み込めない等) → 案内
 * 画面の準備ができると assets/ui.js の markReady() が window.__appReady を立てる。
 */
(function () {
  var HINT = 'X などのアプリの中で開いている場合は、Safari や Chrome などのブラウザで開くと表示できる場合があります。';

  function show(what, how) {
    var box = document.getElementById('error');
    if (!box) return;
    box.innerHTML = '';
    var p1 = document.createElement('p');
    p1.className = 'error-what';
    p1.appendChild(document.createTextNode(what));
    var p2 = document.createElement('p');
    p2.className = 'error-how';
    p2.appendChild(document.createTextNode(how));
    box.appendChild(p1);
    box.appendChild(p2);
    box.hidden = false;
    var status = document.getElementById('status');
    if (status) status.textContent = '';
  }

  if (!('noModule' in document.createElement('script'))) {
    show('このブラウザでは、画面を動かす仕組みに対応していません。',
      'Safari や Chrome などのブラウザを最新にして開いてください。' + HINT);
    return;
  }

  setTimeout(function () {
    if (window.__appReady) return;
    show('画面の読み込みが終わりませんでした。',
      '電波の良い場所で、ページを読み込み直してください。' + HINT);
  }, 10000);
})();
