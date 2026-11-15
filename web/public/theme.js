// Apply the saved theme before first paint so the page does not flash.
;(function () {
  var saved = null
  try {
    saved = localStorage.getItem('mc-theme')
  } catch (e) {}
  var dark = saved === 'dark' || ((!saved || saved === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()
