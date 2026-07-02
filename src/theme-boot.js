// Resolve the theme before any CSS paints, to avoid a flash of the wrong theme.
// Mirrors applyTheme()'s saved-choice → OS → dark resolution. Loaded as an
// external, non-deferred script (before the stylesheets) so it runs first and
// so the app can ship a strict Content Security Policy with no inline scripts.
try {
  var s = JSON.parse(localStorage.getItem("packetboat.settings") || "{}");
  var t = s.theme || "dark";
  if (t === "system")
    t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
} catch (e) {
  document.documentElement.setAttribute("data-theme", "dark");
}
