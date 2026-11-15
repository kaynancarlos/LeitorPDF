// Aplica o tema salvo antes da página aparecer (evita "piscar" de branco no tema escuro).
(function () {
  var theme = null;
  try { theme = localStorage.getItem('lpdf:theme'); } catch (e) { /* ignora */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  try {
    if (localStorage.getItem('lpdf:invert') === '1') root.setAttribute('data-pages', 'dark');
  } catch (e) { /* ignora */ }
})();
