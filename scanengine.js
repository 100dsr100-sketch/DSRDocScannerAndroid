/* DSR Doc Scanner - image engine.
   A faithful port of the desktop app's uimaging.pas (Lazarus) to plain
   typed-array JavaScript so it runs on the phone with no native code.
   Everything works on ImageData; the algorithms match the desktop:
   texture+brightness document detection, foreground-edge deskew (bicubic),
   subtract-flatten + white-balanced colour cleanup, adaptive-threshold B&W. */
(function (global) {
  'use strict';

  var MAX_DIM = 2200;   // phone photos are downscaled to this long edge on load

  function clampF(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------------- plane <-> ImageData ---------------- */

  function planesFromImageData(img) {
    var w = img.width, h = img.height, n = w * h, d = img.data;
    var R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) { R[i] = d[p]; G[i] = d[p + 1]; B[i] = d[p + 2]; }
    return { R: R, G: G, B: B, w: w, h: h };
  }
  function imageDataFromPlanes(R, G, B, w, h) {
    var n = w * h, out = new Uint8ClampedArray(n * 4);
    for (var i = 0, p = 0; i < n; i++, p += 4) { out[p] = R[i]; out[p + 1] = G[i]; out[p + 2] = B[i]; out[p + 3] = 255; }
    return new ImageData(out, w, h);
  }
  function toGrayPlanes(R, G, B) {
    var n = R.length, g = new Uint8Array(n);
    for (var i = 0; i < n; i++) g[i] = (R[i] * 77 + G[i] * 151 + B[i] * 28) >> 8;
    return g;
  }

  /* ---------------- small helpers ---------------- */

  function otsu(gray) {
    var hist = new Int32Array(256), i;
    for (i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var wB = 0, sumB = 0, best = -1, thr = 128;
    for (var t = 0; t < 256; t++) {
      wB += hist[t]; if (wB === 0) continue;
      var wF = total - wB; if (wF === 0) break;
      sumB += t * hist[t];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // Box mean via a summed-area table (O(1) per pixel).
  function boxMean(src, w, h, radius) {
    var iw = w + 1, ii = new Float64Array(iw * (h + 1));
    for (var y = 0; y < h; y++) {
      var s = 0, row = y * w, cur = (y + 1) * iw, prev = y * iw;
      for (var x = 0; x < w; x++) { s += src[row + x]; ii[cur + x + 1] = ii[prev + x + 1] + s; }
    }
    var out = new Float32Array(w * h);
    for (var yy = 0; yy < h; yy++) {
      var y0 = Math.max(0, yy - radius), y1 = Math.min(h - 1, yy + radius);
      for (var xx = 0; xx < w; xx++) {
        var x0 = Math.max(0, xx - radius), x1 = Math.min(w - 1, xx + radius);
        var v = ii[(y1 + 1) * iw + (x1 + 1)] - ii[y0 * iw + (x1 + 1)] - ii[(y1 + 1) * iw + x0] + ii[y0 * iw + x0];
        out[yy * w + xx] = v / ((x1 - x0 + 1) * (y1 - y0 + 1));
      }
    }
    return out;
  }

  function downsampleGray(gray, w, h, maxDim) {
    var sc = maxDim / Math.max(w, h), i;
    if (sc >= 1) {
      var d0 = new Float32Array(w * h);
      for (i = 0; i < d0.length; i++) d0[i] = gray[i];
      return { d: d0, dw: w, dh: h };
    }
    var dw = Math.max(1, Math.round(w * sc)), dh = Math.max(1, Math.round(h * sc));
    var d = new Float32Array(dw * dh);
    for (var y = 0; y < dh; y++) {
      var sy0 = Math.trunc(y * h / dh), sy1 = Math.max(sy0, Math.trunc((y + 1) * h / dh) - 1);
      for (var x = 0; x < dw; x++) {
        var sx0 = Math.trunc(x * w / dw), sx1 = Math.max(sx0, Math.trunc((x + 1) * w / dw) - 1);
        var acc = 0, cnt = 0;
        for (var iy = sy0; iy <= sy1; iy++) for (var ix = sx0; ix <= sx1; ix++) { acc += gray[iy * w + ix]; cnt++; }
        d[y * dw + x] = acc / (cnt || 1);
      }
    }
    return { d: d, dw: dw, dh: dh };
  }

  function sampleBil(M, w, h, fx, fy) {
    if (fx < 0) fx = 0; if (fy < 0) fy = 0;
    if (fx > w - 1) fx = w - 1; if (fy > h - 1) fy = h - 1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    var dx = fx - x0, dy = fy - y0;
    var a = M[y0 * w + x0] * (1 - dx) + M[y0 * w + x1] * dx;
    var b = M[y1 * w + x0] * (1 - dx) + M[y1 * w + x1] * dx;
    return a * (1 - dy) + b * dy;
  }

  function cubic1(p0, p1, p2, p3, t) {
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  function cubicSample(P, w, h, fx, fy) {
    var x0 = Math.floor(fx), y0 = Math.floor(fy), c0, c1, c2, c3;
    var col = [0, 0, 0, 0];
    for (var k = 0; k < 4; k++) {
      var cy = Math.min(h - 1, Math.max(0, y0 - 1 + k));
      c0 = P[cy * w + Math.min(w - 1, Math.max(0, x0 - 1))];
      c1 = P[cy * w + Math.min(w - 1, Math.max(0, x0))];
      c2 = P[cy * w + Math.min(w - 1, Math.max(0, x0 + 1))];
      c3 = P[cy * w + Math.min(w - 1, Math.max(0, x0 + 2))];
      col[k] = cubic1(c0, c1, c2, c3, fx - x0);
    }
    return cubic1(col[0], col[1], col[2], col[3], fy - y0);
  }

  function localRange(g, w, h, rad) {
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var y0 = Math.max(0, y - rad), y1 = Math.min(h - 1, y + rad);
      for (var x = 0; x < w; x++) {
        var x0 = Math.max(0, x - rad), x1 = Math.min(w - 1, x + rad);
        var mn = 255, mx = 0;
        for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) {
          var v = g[yy * w + xx]; if (v < mn) mn = v; if (v > mx) mx = v;
        }
        out[y * w + x] = mx - mn;
      }
    }
    return out;
  }

  // Fill every 0-region of mask not connected to the border.
  function fillHoles(mask, w, h) {
    var n = w * h, outside = new Uint8Array(n), st = new Int32Array(n), sp = 0, i;
    function seed(q) { if (!mask[q] && !outside[q]) { outside[q] = 1; st[sp++] = q; } }
    for (var x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp > 0) {
      var p = st[--sp], px = p % w, py = (p / w) | 0;
      if (px > 0) seed(p - 1);
      if (px < w - 1) seed(p + 1);
      if (py > 0) seed(p - w);
      if (py < h - 1) seed(p + w);
    }
    for (i = 0; i < n; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
  }

  // Morphological close on the foreground (fg = !bgm): dilate r, erode r.
  function binaryCloseFg(bgm, w, h, r) {
    var n = w * h, a = new Uint8Array(n), i, it, x, y;
    for (i = 0; i < n; i++) a[i] = bgm[i] ? 0 : 1;
    for (it = 0; it < r; it++) {
      var t = a.slice();
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        i = y * w + x;
        a[i] = (t[i] || (x > 0 && t[i - 1]) || (x < w - 1 && t[i + 1]) ||
          (y > 0 && t[i - w]) || (y < h - 1 && t[i + w])) ? 1 : 0;
      }
    }
    for (it = 0; it < r; it++) {
      var t2 = a.slice();
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        i = y * w + x;
        a[i] = (t2[i] && (x === 0 || t2[i - 1]) && (x === w - 1 || t2[i + 1]) &&
          (y === 0 || t2[i - w]) && (y === h - 1 || t2[i + w])) ? 1 : 0;
      }
    }
    for (i = 0; i < n; i++) bgm[i] = a[i] ? 0 : 1;
  }

  // Fallback: estimate surface colour from the 1px border, flood inward.
  function floodBgFromBorder(aR, aG, aB, aw, ah) {
    var atot = aw * ah, bgm = new Uint8Array(atot), st = new Int32Array(atot), sp = 0;
    var mr = 0, mg = 0, mb = 0, ns = 0, x, y;
    for (x = 0; x < aw; x++) { mr += aR[x] + aR[(ah - 1) * aw + x]; mg += aG[x] + aG[(ah - 1) * aw + x]; mb += aB[x] + aB[(ah - 1) * aw + x]; ns += 2; }
    for (y = 0; y < ah; y++) { mr += aR[y * aw] + aR[y * aw + aw - 1]; mg += aG[y * aw] + aG[y * aw + aw - 1]; mb += aB[y * aw] + aB[y * aw + aw - 1]; ns += 2; }
    mr = (mr / ns) | 0; mg = (mg / ns) | 0; mb = (mb / ns) | 0;
    function cd2(idx) { var d1 = aR[idx] - mr, d2 = aG[idx] - mg, d3 = aB[idx] - mb; return d1 * d1 + d2 * d2 + d3 * d3; }
    var varB = 0;
    for (x = 0; x < aw; x++) varB += cd2(x) + cd2((ah - 1) * aw + x);
    for (y = 0; y < ah; y++) varB += cd2(y * aw) + cd2(y * aw + aw - 1);
    varB /= ns;
    var tol2 = Math.round(varB * 4);
    if (tol2 < 676) tol2 = 676;
    if (tol2 > 5476) tol2 = 5476;
    function pushIf(p) { if (!bgm[p] && cd2(p) <= tol2) { bgm[p] = 1; st[sp++] = p; } }
    for (x = 0; x < aw; x++) { pushIf(x); pushIf((ah - 1) * aw + x); }
    for (y = 0; y < ah; y++) { pushIf(y * aw); pushIf(y * aw + aw - 1); }
    while (sp > 0) {
      var p = st[--sp], qx = p % aw, qy = (p / aw) | 0;
      if (qx > 0) pushIf(p - 1);
      if (qx < aw - 1) pushIf(p + 1);
      if (qy > 0) pushIf(p - aw);
      if (qy < ah - 1) pushIf(p + aw);
    }
    return bgm;
  }

  // Clockwise-positive shear angle that flattens the text, from fg edges only.
  function estimateSkewDeg(aGray, aw, ah, fgmask, bx0, by0, bx1, by1) {
    if (bx1 - bx0 < 12 || by1 - by0 < 12) return 0;
    var edge = new Uint8Array(aw * ah), nEdge = 0;
    var yy0 = Math.max(1, by0 + 1), yy1 = Math.min(ah - 2, by1 - 1);
    var xx0 = Math.max(1, bx0 + 1), xx1 = Math.min(aw - 2, bx1 - 1);
    for (var y = yy0; y <= yy1; y++) for (var x = xx0; x <= xx1; x++) {
      var i = y * aw + x;
      if (!fgmask[i]) continue;
      var gx = aGray[i + 1] - aGray[i - 1], gy = aGray[i + aw] - aGray[i - aw];
      if (Math.abs(gx) + Math.abs(gy) > 26) { edge[i] = 1; nEdge++; }
    }
    if (nEdge < 200) return 0;
    var cxf = (bx0 + bx1) / 2, hist = new Float64Array(ah);
    var bestScore = -1, best = 0;
    for (var a = -7.0; a <= 7.0001; a += 0.3) {
      var ta = Math.tan(a * Math.PI / 180);
      hist.fill(0);
      for (var yy = by0; yy <= by1; yy++) for (var xx = bx0; xx <= bx1; xx++) {
        if (edge[yy * aw + xx] === 1) {
          var sh = yy + Math.round((xx - cxf) * ta);
          if (sh >= 0 && sh < ah) hist[sh]++;
        }
      }
      var mean = 0, k;
      for (k = 0; k < ah; k++) mean += hist[k];
      mean /= ah;
      var s = 0;
      for (k = 0; k < ah; k++) { var hv = hist[k] - mean; s += hv * hv; }
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best;
  }

  function rotatePlanesRGB(R, G, B, w, h, angleDeg) {
    var c = Math.cos(angleDeg * Math.PI / 180), s = Math.sin(angleDeg * Math.PI / 180);
    var nW = Math.ceil(Math.abs(w * c) + Math.abs(h * s));
    var nH = Math.ceil(Math.abs(w * s) + Math.abs(h * c));
    var R2 = new Uint8Array(nW * nH), G2 = new Uint8Array(nW * nH), B2 = new Uint8Array(nW * nH);
    var cx = (w - 1) / 2, cy = (h - 1) / 2, ncx = (nW - 1) / 2, ncy = (nH - 1) / 2;
    for (var iy = 0; iy < nH; iy++) for (var ix = 0; ix < nW; ix++) {
      var sx = c * (ix - ncx) + s * (iy - ncy) + cx;
      var sy = -s * (ix - ncx) + c * (iy - ncy) + cy;
      var i = iy * nW + ix;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) { R2[i] = 255; G2[i] = 255; B2[i] = 255; continue; }
      R2[i] = clampF(Math.round(cubicSample(R, w, h, sx, sy)), 0, 255);
      G2[i] = clampF(Math.round(cubicSample(G, w, h, sx, sy)), 0, 255);
      B2[i] = clampF(Math.round(cubicSample(B, w, h, sx, sy)), 0, 255);
    }
    return { R: R2, G: G2, B: B2, w: nW, h: nH };
  }
  function rotateMaskNearest(mask, w, h, angleDeg) {
    var c = Math.cos(angleDeg * Math.PI / 180), s = Math.sin(angleDeg * Math.PI / 180);
    var w2 = Math.ceil(Math.abs(w * c) + Math.abs(h * s));
    var h2 = Math.ceil(Math.abs(w * s) + Math.abs(h * c));
    var m2 = new Uint8Array(w2 * h2);
    var cx = (w - 1) / 2, cy = (h - 1) / 2, ncx = (w2 - 1) / 2, ncy = (h2 - 1) / 2;
    for (var iy = 0; iy < h2; iy++) for (var ix = 0; ix < w2; ix++) {
      var sx = Math.round(c * (ix - ncx) + s * (iy - ncy) + cx);
      var sy = Math.round(-s * (ix - ncx) + c * (iy - ncy) + cy);
      m2[iy * w2 + ix] = (sx >= 0 && sy >= 0 && sx < w && sy < h && mask[sy * w + sx]) ? 1 : 0;
    }
    return { mask: m2, w: w2, h: h2 };
  }

  /* ---------------- public: detect ---------------- */

  function detectDocument(img, deskew) {
    var pl = planesFromImageData(img);
    var R = pl.R, G = pl.G, B = pl.B, W = pl.w, H = pl.h;
    if (W < 40 || H < 40) return { img: img, msg: 'Image is too small to analyse.' };

    var sc = 800 / Math.max(W, H); if (sc > 1) sc = 1;
    var aw = Math.max(8, Math.round(W * sc)), ah = Math.max(8, Math.round(H * sc));
    var atot = aw * ah;
    var aR = new Uint8Array(atot), aG = new Uint8Array(atot), aB = new Uint8Array(atot), aGray = new Uint8Array(atot);
    for (var y = 0; y < ah; y++) for (var x = 0; x < aw; x++) {
      var qx = Math.min(W - 1, Math.trunc(x * W / aw)), qy = Math.min(H - 1, Math.trunc(y * H / ah));
      var i = y * aw + x, sIdx = qy * W + qx;
      aR[i] = R[sIdx]; aG[i] = G[sIdx]; aB[i] = B[sIdx];
      aGray[i] = (aR[i] * 77 + aG[i] * 151 + aB[i] * 28) >> 8;
    }

    var thrO = otsu(aGray);
    var aRange = localRange(aGray, aw, ah, 2);
    var bgm = new Uint8Array(atot), brightCnt = 0, k;
    for (k = 0; k < atot; k++) {
      bgm[k] = !((aRange[k] <= 22) && (aGray[k] >= thrO - 40)) ? 1 : 0;
      if (bgm[k] === 0) brightCnt++;
    }
    if (brightCnt < atot / 10 || brightCnt > atot * 0.96) {
      for (k = 0; k < atot; k++) bgm[k] = aGray[k] < thrO ? 1 : 0;
      brightCnt = 0; for (k = 0; k < atot; k++) if (bgm[k] === 0) brightCnt++;
      if (brightCnt < atot / 10 || brightCnt > atot * 0.94) bgm = floodBgFromBorder(aR, aG, aB, aw, ah);
    }
    binaryCloseFg(bgm, aw, ah, 2);

    var fgcount = 0;
    for (k = 0; k < atot; k++) if (bgm[k] === 0) fgcount++;
    if (fgcount < atot / 20) return { img: img, msg: 'Could not tell the document apart from the background.' };
    var fillsFrame = fgcount > atot * 0.97;
    if (fillsFrame && !deskew) return { img: img, msg: 'The document appears to fill the whole frame.' };

    var comp = new Int32Array(atot), st = new Int32Array(atot);
    var best = 0, bestId = 0, bminx = 0, bminy = 0, bmaxx = aw - 1, bmaxy = ah - 1, blobId = 0;
    for (var i0 = 0; i0 < atot; i0++) {
      if (bgm[i0] || comp[i0]) continue;
      blobId++;
      var sp = 0; st[sp++] = i0; comp[i0] = blobId;
      var csize = 0, cminx = aw, cminy = ah, cmaxx = -1, cmaxy = -1;
      while (sp > 0) {
        var p = st[--sp], qx = p % aw, qy = (p / aw) | 0;
        csize++;
        if (qx < cminx) cminx = qx; if (qx > cmaxx) cmaxx = qx;
        if (qy < cminy) cminy = qy; if (qy > cmaxy) cmaxy = qy;
        if (qx > 0 && !bgm[p - 1] && !comp[p - 1]) { comp[p - 1] = blobId; st[sp++] = p - 1; }
        if (qx < aw - 1 && !bgm[p + 1] && !comp[p + 1]) { comp[p + 1] = blobId; st[sp++] = p + 1; }
        if (qy > 0 && !bgm[p - aw] && !comp[p - aw]) { comp[p - aw] = blobId; st[sp++] = p - aw; }
        if (qy < ah - 1 && !bgm[p + aw] && !comp[p + aw]) { comp[p + aw] = blobId; st[sp++] = p + aw; }
      }
      if (csize > best) { best = csize; bestId = blobId; bminx = cminx; bminy = cminy; bmaxx = cmaxx; bmaxy = cmaxy; }
    }
    if (best < atot / 30) return { img: img, msg: 'Could not find a clear document region.' };

    var fgmask = new Uint8Array(atot);
    for (k = 0; k < atot; k++) fgmask[k] = comp[k] === bestId ? 1 : 0;
    fillHoles(fgmask, aw, ah);
    bminx = aw; bminy = ah; bmaxx = -1; bmaxy = -1;
    var filledCnt = 0;
    for (y = 0; y < ah; y++) for (x = 0; x < aw; x++) if (fgmask[y * aw + x]) {
      filledCnt++;
      if (x < bminx) bminx = x; if (x > bmaxx) bmaxx = x;
      if (y < bminy) bminy = y; if (y > bmaxy) bmaxy = y;
    }
    var rectOK = (bmaxx > bminx) && (bmaxy > bminy) &&
      (filledCnt >= (bmaxx - bminx + 1) * (bmaxy - bminy + 1) * 0.7);

    var rotated = false;
    if (deskew) {
      var ang = estimateSkewDeg(aGray, aw, ah, fgmask, bminx, bminy, bmaxx, bmaxy);
      if (Math.abs(ang) >= 0.35) {
        var rr = rotatePlanesRGB(R, G, B, W, H, ang); R = rr.R; G = rr.G; B = rr.B; W = rr.w; H = rr.h;
        var rm = rotateMaskNearest(fgmask, aw, ah, ang); fgmask = rm.mask; aw = rm.w; ah = rm.h; atot = aw * ah;
        bminx = aw; bminy = ah; bmaxx = -1; bmaxy = -1;
        for (y = 0; y < ah; y++) for (x = 0; x < aw; x++) if (fgmask[y * aw + x]) {
          if (x < bminx) bminx = x; if (x > bmaxx) bmaxx = x;
          if (y < bminy) bminy = y; if (y > bmaxy) bmaxy = y;
        }
        if (bmaxx <= bminx) { bminx = 0; bminy = 0; bmaxx = aw - 1; bmaxy = ah - 1; }
        rotated = true;
      }
    }

    var cropped = false;
    if (rectOK) {
      var cx0 = Math.trunc(bminx * W / aw), cy0 = Math.trunc(bminy * H / ah);
      var cx1 = Math.min(W - 1, Math.round((bmaxx + 1) * W / aw));
      var cy1 = Math.min(H - 1, Math.round((bmaxy + 1) * H / ah));
      var marX, marY;
      if (rotated) { marX = -Math.round((cx1 - cx0) * 0.015); marY = -Math.round((cy1 - cy0) * 0.015); }
      else { marX = Math.round((cx1 - cx0) * 0.006) + 1; marY = Math.round((cy1 - cy0) * 0.006) + 1; }
      cx0 = Math.max(0, cx0 - marX); cy0 = Math.max(0, cy0 - marY);
      cx1 = Math.min(W - 1, cx1 + marX); cy1 = Math.min(H - 1, cy1 + marY);
      if ((cx1 - cx0 + 1 < W - 2) || (cy1 - cy0 + 1 < H - 2)) {
        var nw = cx1 - cx0 + 1, nh = cy1 - cy0 + 1;
        var R2 = new Uint8Array(nw * nh), G2 = new Uint8Array(nw * nh), B2 = new Uint8Array(nw * nh);
        for (y = 0; y < nh; y++) for (x = 0; x < nw; x++) {
          var di = y * nw + x, si = (cy0 + y) * W + (cx0 + x);
          R2[di] = R[si]; G2[di] = G[si]; B2[di] = B[si];
        }
        R = R2; G = G2; B = B2; W = nw; H = nh; cropped = true;
      }
    }

    if (cropped || rotated) {
      var msg;
      if (cropped && rotated) msg = 'Detected, cropped and straightened.';
      else if (cropped) msg = 'Detected and cropped.';
      else if (rotated && rectOK) msg = 'Straightened (already near the edges).';
      else msg = 'Straightened, but the outline was unclear - not cropped.';
      return { img: imageDataFromPlanes(R, G, B, W, H), msg: msg };
    }
    if (!rectOK) return { img: img, msg: 'Could not lock onto the document outline.' };
    return { img: img, msg: 'The document already fills the frame.' };
  }

  /* ---------------- public: clean up ---------------- */

  function cleanUpImage(img, binarize) {
    var pl = planesFromImageData(img);
    var R = pl.R, G = pl.G, B = pl.B, W = pl.w, H = pl.h;
    var total = W * H, i, p, x, y;
    var gray = toGrayPlanes(R, G, B);

    var ds = downsampleGray(gray, W, H, 800);
    var bgMap = boxMean(ds.d, ds.dw, ds.dh, Math.max(8, Math.round(Math.max(ds.dw, ds.dh) / 6)));
    var bgMean = 0; for (i = 0; i < bgMap.length; i++) bgMean += bgMap[i]; bgMean /= bgMap.length;

    var flat = new Float32Array(total);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      i = y * W + x;
      var v = gray[i] - sampleBil(bgMap, ds.dw, ds.dh, x * (ds.dw / W), y * (ds.dh / H)) + bgMean;
      flat[i] = clampF(v, 0, 255);
    }

    var hist = new Int32Array(256);
    for (i = 0; i < total; i++) hist[Math.round(flat[i])]++;
    var paperTone = 200, bestCnt = 0;
    for (x = 150; x <= 255; x++) if (hist[x] > bestCnt) { bestCnt = hist[x]; paperTone = x; }
    var gain = 245 / Math.max(1, paperTone);
    if (gain < 0.92) gain = 0.92; if (gain > 1.55) gain = 1.55;

    if (!binarize) {
      /* colour scan: white balance, gentle unsharp, per-pixel luma scale */
      var brightBar = Math.max(60, Math.round(paperTone) - 22);
      var sr = 0, sg = 0, sb = 0, cnt = 0;
      for (i = 0; i < total; i++) if (gray[i] >= brightBar) { sr += R[i]; sg += G[i]; sb += B[i]; cnt++; }
      var gr = 1, gg = 1, gb = 1;
      if (cnt > total / 200) {
        var wr = sr / cnt, wg = sg / cnt, wb = sb / cnt, wAvg = (wr + wg + wb) / 3;
        gr = clampF(wAvg / Math.max(1, wr), 0.75, 1.35);
        gg = clampF(wAvg / Math.max(1, wg), 0.75, 1.35);
        gb = clampF(wAvg / Math.max(1, wb), 0.75, 1.35);
      }
      var sm3 = boxMean(flat, W, H, 1);
      var out = new Uint8ClampedArray(total * 4);
      for (i = 0, p = 0; i < total; i++, p += 4) {
        var vv = flat[i] + 0.45 * (flat[i] - sm3[i]);
        vv = clampF((vv * gain - 10) * 1.10 + 8, 0, 255);
        var scv = vv / Math.max(1, gray[i]);
        out[p] = clampF(R[i] * gr * scv, 0, 255);
        out[p + 1] = clampF(G[i] * gg * scv, 0, 255);
        out[p + 2] = clampF(B[i] * gb * scv, 0, 255);
        out[p + 3] = 255;
      }
      return new ImageData(out, W, H);
    }

    /* B&W: 2nd medium flatten, adaptive threshold + local-contrast gate + despeckle */
    var fb = new Uint8Array(total);
    for (i = 0; i < total; i++) fb[i] = clampF(Math.round(flat[i]), 0, 255);
    var d2 = downsampleGray(fb, W, H, 700);
    var lm = boxMean(d2.d, d2.dw, d2.dh, Math.max(6, Math.round(Math.max(d2.dw, d2.dh) / 14)));
    var bgMean2 = 0; for (i = 0; i < lm.length; i++) bgMean2 += lm[i]; bgMean2 /= lm.length;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      i = y * W + x;
      var w2v = flat[i] - sampleBil(lm, d2.dw, d2.dh, x * (d2.dw / W), y * (d2.dh / H)) + bgMean2;
      flat[i] = clampF(w2v * gain, 0, 255);
    }
    for (i = 0; i < total; i++) fb[i] = clampF(Math.round(flat[i]), 0, 255);
    var d3 = downsampleGray(fb, W, H, 1100);
    var lmMean = boxMean(d3.d, d3.dw, d3.dh, Math.max(8, Math.round(Math.max(d3.dw, d3.dh) / 20)));
    var lmRawB = new Uint8Array(d3.dw * d3.dh);
    for (i = 0; i < lmRawB.length; i++) lmRawB[i] = clampF(Math.round(d3.d[i]), 0, 255);
    var lmRangeB = localRange(lmRawB, d3.dw, d3.dh, Math.max(3, Math.round(Math.max(d3.dw, d3.dh) / 60)));
    var lmRange = new Float32Array(lmRangeB.length);
    for (i = 0; i < lmRangeB.length; i++) lmRange[i] = lmRangeB[i];

    var bin = new Uint8Array(total);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      i = y * W + x;
      var thr = sampleBil(lmMean, d3.dw, d3.dh, x * (d3.dw / W), y * (d3.dh / H)) - 10;
      var rng = sampleBil(lmRange, d3.dw, d3.dh, x * (d3.dw / W), y * (d3.dh / H));
      bin[i] = (flat[i] < thr && rng > 20) ? 0 : 255;
    }
    var binCopy = bin.slice();
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      i = y * W + x;
      if (binCopy[i] !== 0) continue;
      var bc = 0;
      for (var ny = -1; ny <= 1; ny++) for (var nx = -1; nx <= 1; nx++)
        if ((nx || ny) && binCopy[(y + ny) * W + (x + nx)] === 0) bc++;
      if (bc <= 1) bin[i] = 255;
    }
    var o2 = new Uint8ClampedArray(total * 4);
    for (i = 0, p = 0; i < total; i++, p += 4) { o2[p] = o2[p + 1] = o2[p + 2] = bin[i]; o2[p + 3] = 255; }
    return new ImageData(o2, W, H);
  }

  /* ---------------- public: misc ---------------- */

  function rotate90(img, clockwise) {
    var pl = planesFromImageData(img);
    var R = pl.R, G = pl.G, B = pl.B, W = pl.w, H = pl.h;
    var R2 = new Uint8Array(W * H), G2 = new Uint8Array(W * H), B2 = new Uint8Array(W * H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x;
      var j = clockwise ? x * H + (H - 1 - y) : (W - 1 - x) * H + y;
      R2[j] = R[i]; G2[j] = G[i]; B2[j] = B[i];
    }
    return imageDataFromPlanes(R2, G2, B2, H, W);
  }

  function cloneImage(img) { return new ImageData(img.data.slice(0), img.width, img.height); }

  // Decode a File to ImageData, transcoding HEIC via heic2any, flattening
  // transparency onto white, and capping the long edge at MAX_DIM.
  function decodeToImageData(file) {
    var nm = (file.name || '').toLowerCase();
    var isHeic = /\.(heic|heif|hif)$/.test(nm) || file.type === 'image/heic' || file.type === 'image/heif';
    var pre = Promise.resolve(file);
    if (isHeic) {
      if (typeof heic2any !== 'function') {
        return Promise.reject(new Error('HEIC support did not load - needs a connection the first time.'));
      }
      pre = heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 })
        .then(function (b) { return Array.isArray(b) ? b[0] : b; });
    }
    return pre.then(function (blob) {
      return createImageBitmap(blob, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(blob); });
    }).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      var sc = Math.min(1, MAX_DIM / Math.max(w, h));
      w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return ctx.getImageData(0, 0, w, h);
    });
  }

  /* ---------------- public: PDF ---------------- */

  // pages: [{ jpeg: Uint8Array, w, h }]  ->  Blob(application/pdf)
  function buildPdf(pages) {
    var parts = [], len = 0, enc = new TextEncoder();
    function wr(s) { var u = enc.encode(s); parts.push(u); len += u.length; }
    function wb(u) { parts.push(u); len += u.length; }
    function pad10(n) { var s = String(n); while (s.length < 10) s = '0' + s; return s; }

    var N = pages.length, i;
    var pageObj = [], imgObj = [], contObj = [], obj = 2;
    for (i = 0; i < N; i++) { pageObj[i] = ++obj; imgObj[i] = ++obj; contObj[i] = ++obj; }
    var offsets = new Array(obj + 1).fill(0);

    wr('%PDF-1.4\n');
    wb(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    offsets[1] = len; wr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    var kids = '';
    for (i = 0; i < N; i++) kids += pageObj[i] + ' 0 R ';
    offsets[2] = len; wr('2 0 obj\n<< /Type /Pages /Kids [' + kids + '] /Count ' + N + ' >>\nendobj\n');

    for (i = 0; i < N; i++) {
      offsets[pageObj[i]] = len;
      wr(pageObj[i] + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pages[i].w + ' ' + pages[i].h +
        '] /Resources << /XObject << /Im0 ' + imgObj[i] + ' 0 R >> >> /Contents ' + contObj[i] + ' 0 R >>\nendobj\n');
      offsets[imgObj[i]] = len;
      wr(imgObj[i] + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pages[i].w + ' /Height ' + pages[i].h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pages[i].jpeg.length + ' >>\nstream\n');
      wb(pages[i].jpeg);
      wr('\nendstream\nendobj\n');
      var cs = 'q ' + pages[i].w + ' 0 0 ' + pages[i].h + ' 0 0 cm /Im0 Do Q';
      offsets[contObj[i]] = len;
      wr(contObj[i] + ' 0 obj\n<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream\nendobj\n');
    }

    var xrefStart = len;
    wr('xref\n0 ' + (obj + 1) + '\n0000000000 65535 f \n');
    for (i = 1; i <= obj; i++) wr(pad10(offsets[i]) + ' 00000 n \n');
    wr('trailer\n<< /Size ' + (obj + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }

  global.ScanEngine = {
    MAX_DIM: MAX_DIM,
    decodeToImageData: decodeToImageData,
    cloneImage: cloneImage,
    rotate90: rotate90,
    detectDocument: detectDocument,
    cleanUpImage: cleanUpImage,
    buildPdf: buildPdf
  };
})(window);
