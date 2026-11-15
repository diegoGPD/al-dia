/* Name matching for insumos. ONE implementation, loaded by the phone page
   (as a script) and by the server (require), so "does this already exist?"
   gives the same answer in both places.

   normalize("Pollos  Pechúga") -> "pollo pechuga"  (lowercase, no accents,
   singular-ish, filler words dropped). It is a stemmer for matching, not
   grammar: "tomate"/"tomates" both become "tomat". */
(function (root) {
  'use strict';
  var FILLER = { de: 1, del: 1, la: 1, el: 1, los: 1, las: 1, y: 1, en: 1, para: 1 };

  function stem(w) {
    if (w.length <= 3) return w;
    if (/ces$/.test(w)) return w.slice(0, -3) + 'z';      // nueces -> nuez
    if (/s$/.test(w)) w = w.slice(0, -1);                 // pollos -> pollo
    if (w.length > 3 && /e$/.test(w)) w = w.slice(0, -1); // limone(s)/tomate -> limon/tomat
    return w;
  }
  function tokens(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
      .filter(function (w) { return w && !FILLER[w]; }).map(stem);
  }
  function normalize(s) { return tokens(s).join(' '); }

  // Small edit distance, capped — enough to forgive one slip on a phone keyboard.
  function dist(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i], best = cur[0];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  // Spelling by ear: pollo/poyo, vaso/baso, cebolla/sevoya, queso/keso, harina/arina.
  // Used only to compare while searching — stored names are never altered.
  function ear(w) {
    return w.replace(/ch/g, 'x').replace(/ll/g, 'y').replace(/qu/g, 'k').replace(/v/g, 'b').replace(/z/g, 's')
      .replace(/c(?=[ei])/g, 's').replace(/c/g, 'k').replace(/h/g, '');
  }
  // How well one typed word matches one word of a name. 0 = no match.
  function tokenScore(q, t) {
    q = ear(q); t = ear(t);
    if (t === q) return 4;
    if (t.indexOf(q) === 0) return 3;                      // "poll" -> "pollo"
    if (q.length >= 3 && t.indexOf(q) > 0) return 2;       // inside the word
    var slack = q.length >= 6 ? 2 : q.length >= 4 ? 1 : 0; // typo tolerance
    if (slack && dist(q, t.slice(0, Math.max(q.length, Math.min(t.length, q.length + 1))), slack) <= slack) return 1;
    if (slack && dist(q, t, slack) <= slack) return 1;
    return 0;
  }
  // Every typed word has to land on some word of the name, in any order.
  // Returns 0 for no match, higher = better.
  function score(query, normalizedName) {
    var qs = tokens(query), ts = String(normalizedName || '').split(' ');
    if (!qs.length) return 0;
    var total = 0;
    for (var i = 0; i < qs.length; i++) {
      var best = 0;
      for (var j = 0; j < ts.length; j++) { var s = tokenScore(qs[i], ts[j]); if (s > best) best = s; }
      if (!best) return 0;
      total += best;
    }
    return total / qs.length + (qs.length === ts.length ? 0.5 : 0);
  }

  var api = { normalize: normalize, tokens: tokens, score: score };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InsumoMatch = api;
})(typeof self !== 'undefined' ? self : this);
