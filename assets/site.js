// site.js：两个页面共用的一点交互。界面语言和主题的切换、复制命令、试听贴纸（A 面放完接着放 B 面，外圈是进度）。
// 没有它页面照样能读：文字、命令、链接都在 HTML 里，只是不能切语言、不能一键复制、不能放声音。
(function () {
  var root = document.documentElement;
  var $ = function (selector) { return document.querySelector(selector); };
  var $$ = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 存不了就只管这一次 */ } }
  function lang() { return root.getAttribute('data-ui') === 'en' ? 'en' : 'zh'; }
  function t(zh, en) { return lang() === 'zh' ? zh : en; }
  var announcer = $('#announce');
  function announce(text) { if (!announcer) return; announcer.textContent = ''; setTimeout(function () { announcer.textContent = text; }, 40); }

  // ---------------------------------------------------------------- 界面语言
  function applyLang(next, save) {
    root.setAttribute('data-ui', next);
    root.setAttribute('lang', next === 'zh' ? 'zh-CN' : 'en');
    var title = root.getAttribute('data-title-' + next);
    if (title) document.title = title;
    $$('[data-label-zh]').forEach(function (el) { el.setAttribute('aria-label', el.getAttribute('data-label-' + next)); });
    if (save) store('voice-pack.lang', next);
  }
  $$('[data-set-lang]').forEach(function (button) {
    button.addEventListener('click', function () {
      var next = button.getAttribute('data-set-lang');
      applyLang(next, true);
      // 按下去的这个键在新语言里藏起来了：焦点交给换回去的那个键，不丢到页面顶上
      var back = $('[data-set-lang="' + (next === 'zh' ? 'en' : 'zh') + '"]');
      if (back) back.focus();
    });
  });
  applyLang(lang(), false);

  // ---------------------------------------------------------------- 主题
  var themeButton = $('[data-theme-toggle]');
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var themeColor = $('meta[name="theme-color"]');
  function isDark() {
    var chosen = root.getAttribute('data-theme');
    if (chosen === 'dark' || chosen === 'light') return chosen === 'dark';
    return !!(darkQuery && darkQuery.matches);
  }
  function renderTheme() {
    if (themeButton) themeButton.setAttribute('aria-pressed', String(isDark()));
    if (themeColor) themeColor.setAttribute('content', getComputedStyle(root).getPropertyValue('--table').trim() || '#E6E7E5');
  }
  if (themeButton) {
    themeButton.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      store('voice-pack.theme', next);
      renderTheme();
    });
  }
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', renderTheme);
  renderTheme();

  // ---------------------------------------------------------------- 复制命令
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }
  $$('[data-copy]').forEach(function (button) {
    var timer = null;
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-copy');
      copyText(text).then(function (ok) {
        button.setAttribute('data-state', ok ? 'done' : 'failed');
        announce(ok ? t('已复制：', 'Copied: ') + text : t('没复制上：可以手动选中命令再复制', 'Could not copy: select the command and copy it by hand'));
        clearTimeout(timer);
        timer = setTimeout(function () { button.removeAttribute('data-state'); }, 2400);
      });
    });
  });

  // ---------------------------------------------------------------- 试听：A 面（设计出来的）放完接着放 B 面（拿 A 面克隆的）
  var audio = { a: $('#clip-a'), b: $('#clip-b') };
  if (!audio.a || !audio.b) return;
  var seconds = { a: Number(audio.a.getAttribute('data-seconds')) || 0, b: Number(audio.b.getAttribute('data-seconds')) || 0 };
  var stickers = $$('[data-sticker]');
  var sideButtons = $$('[data-play]');
  var status = $$('[data-player-status]');
  var side = null;      // 正在放（或停在）哪一面：'a'、'b'，没放是 null
  var chain = false;    // 是不是贴纸放的：放完 A 面接着放 B 面

  function playing() { return side !== null && !audio[side].paused; }
  function length(which) { return isFinite(audio[which].duration) && audio[which].duration > 0 ? audio[which].duration : seconds[which]; }
  function progress() {
    if (side === null) return 0;
    var now = audio[side].currentTime || 0;
    if (chain) {
      var total = length('a') + length('b');
      return total > 0 ? Math.min(1, ((side === 'b' ? length('a') : 0) + now) / total) : 0;
    }
    var own = length(side);
    return own > 0 ? Math.min(1, now / own) : 0;
  }
  function render() {
    var state = side === null ? 'idle' : playing() ? 'playing' : 'paused';
    stickers.forEach(function (sticker) {
      sticker.setAttribute('data-state', state);
      sticker.setAttribute('data-side', side === 'b' ? 'b' : 'a');
      var button = sticker.querySelector('button');
      if (button) button.setAttribute('aria-pressed', String(chain && playing()));
      var done = sticker.querySelector('.done');
      if (done) done.style.strokeDashoffset = String(100 - progress() * 100);
    });
    sideButtons.forEach(function (button) { button.setAttribute('aria-pressed', String(playing() && button.getAttribute('data-play') === side)); });
  }
  function say(text) { status.forEach(function (el) { el.textContent = text; }); }
  function stopAll() { ['a', 'b'].forEach(function (which) { audio[which].pause(); try { audio[which].currentTime = 0; } catch (e) { /* 还没载入 */ } }); }
  function start(which, asChain) {
    stopAll();
    side = which;
    chain = asChain;
    say('');
    var attempt = audio[which].play();
    if (attempt && attempt.catch) attempt.catch(function () { say(t('浏览器没让这段声音放出来，再按一次试试。', 'The browser did not let the clip play; press it again.')); render(); });
    render();
  }
  function toggle(which, asChain) {
    if (side !== null && chain === asChain && (asChain || side === which)) {
      if (playing()) audio[side].pause();
      else { var again = audio[side].play(); if (again && again.catch) again.catch(function () { render(); }); }
      render();
      return;
    }
    start(which, asChain);
  }
  stickers.forEach(function (sticker) {
    var button = sticker.querySelector('button');
    if (button) button.addEventListener('click', function () { toggle('a', true); });
  });
  sideButtons.forEach(function (button) { button.addEventListener('click', function () { toggle(button.getAttribute('data-play'), false); }); });
  ['a', 'b'].forEach(function (which) {
    var el = audio[which];
    el.addEventListener('play', render);
    el.addEventListener('pause', render);
    el.addEventListener('timeupdate', render);
    el.addEventListener('ended', function () {
      if (chain && which === 'a') { start('b', true); return; }
      side = null;
      chain = false;
      render();
    });
    el.addEventListener('error', function () {
      say(t('这段声音没载入：网络断了，或者浏览器放不了 MP3。', 'This clip did not load: the network dropped, or the browser cannot play MP3.'));
      side = null;
      chain = false;
      render();
    });
  });
  render();
})();
