// boot.js：在页面画出来之前定下界面语言和主题（放在 <head> 里同步载入），免得先闪一下另一种。
// 语言：地址里的 ?lang=zh|en，其次是上次选的，再次看浏览器的语言（zh 开头的是中文，别的是英文）。主题：上次选的，没选过就跟系统。
(function () {
  var root = document.documentElement;
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  var asked = null;
  try { asked = new URLSearchParams(location.search).get('lang'); } catch (e) { asked = null; }
  var lang = asked === 'zh' || asked === 'en' ? asked : read('voice-pack.lang');
  if (lang !== 'zh' && lang !== 'en') lang = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  root.setAttribute('data-ui', lang);
  root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  var title = root.getAttribute('data-title-' + lang);
  if (title) document.title = title;
  var theme = read('voice-pack.theme');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
})();
