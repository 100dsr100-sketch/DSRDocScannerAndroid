/* DSR move kit v3 - moves a DSR web app's on-device data from its old shared address (100dsr100-sketch.github.io,
   where every DSR app shared one storage) to the app's own address (<name>.pages.dev).

   Load it FIRST in <head>, after a config script:
     <script>window.DSR_MOVE = { name: "DSR Researcher", to: "https://dsr-researcher.pages.dev/", ls: ["dsrres."], idb: [] };</script>
     <script src="dsr-move.js"></script>
   ls  = localStorage key prefixes that belong to this app (the old address holds every DSR app's keys)
   idb = IndexedDB database names that belong to this app

   Old address: shows an "OLD COPY - has moved" page instead of the app. "Move my data" uploads this app's data to
   dsr-move-relay (one-time code, 60-minute expiry) and opens the new address as #dsr-move-in=<code>, which collects
   it, stores it, deletes it from the relay. Or a data file can be saved here and chosen there (#dsr-move-in).

   v3: the data goes as lines - one header line, then one line per localStorage key / IndexedDB record - packed
   into ~8 MB parts as it's read, and stored record by record as it arrives. So a journal with hundreds of MB of
   photos never has to sit in memory as one giant string (v2 did that, fine for small apps, risky on a phone).
   The receiving side still understands v2 parts/files. The old copy's data is only read, never changed. */
(function () {
  "use strict";
  var C = window.DSR_MOVE; if (!C) return;
  var OLD = /(^|\.)github\.io$/.test(location.hostname) || (C.testOld === true && location.hostname === "localhost"),   // testOld: local test harness only
      IN = /^#dsr-move-in(=[0-9a-f]{32})?$/.test(location.hash);
  if (!OLD && !IN) return;
  window.stop();                                   // the app itself doesn't start on this page
  var RELAY = "https://dsr-move-relay.100dsr100.workers.dev/p/", PART = 8 * 1024 * 1024;
  async function put(k, body) {
    for (var tries = 0; ; tries++) {               // a phone on mobile data can drop one request - try again
      try { var r = await fetch(RELAY + k, { method: "PUT", body: body }); if (r.ok) return; throw new Error("relay " + r.status); }
      catch (e) { if (tries >= 3) throw e; await wait(2000 * (tries + 1)); }
    }
  }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* ---------- the page ---------- */
  function page(html) {
    document.documentElement.innerHTML = '<head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(C.name) + '</title><style>' +
      'body{margin:0;background:#000;color:#ece6d2;font:16px/1.5 system-ui,-apple-system,Roboto,sans-serif;padding:28px 20px}' +
      'h1{color:#efc13f;font-size:22px;margin:0 0 14px}p{margin:0 0 14px}.dim{color:#9a937c;font-size:14px}' +
      'button,a.b{display:block;width:100%;max-width:420px;box-sizing:border-box;margin:0 0 12px;border-radius:24px;padding:13px 18px;font:600 16px system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer}' +
      '.p{background:#d4af37;color:#120e00;border:0}.g{background:none;color:#efc13f;border:1px solid #d4af37}' +
      '#st{color:#efc13f;min-height:24px;margin:6px 0 16px}</style></head><body>' + html + '</body>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function st(t) { var e = document.getElementById("st"); if (e) e.textContent = t; }
  function $(id) { return document.getElementById(id); }
  function mb(n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB"; }

  /* ---------- reading the data (old address) ---------- */
  function mine(k) { return (C.ls || []).some(function (p) { return k.indexOf(p) === 0; }); }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function lsKeys() { var a = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (mine(k)) a.push(k); } return a; }
  async function openDBs() {                       // this app's databases that exist here, with their layout + keys
    var out = [];
    for (var n = 0; n < (C.idb || []).length; n++) {
      var name = C.idb[n];
      if (indexedDB.databases) { var list = await indexedDB.databases(); if (!list.some(function (d) { return d.name === name; })) continue; }
      var db = await req(indexedDB.open(name)), d = { name: name, version: db.version, stores: [], db: db };
      for (var s = 0; s < db.objectStoreNames.length; s++) {
        var sn = db.objectStoreNames[s], os = db.transaction(sn, "readonly").objectStore(sn);
        var info = { name: sn, keyPath: os.keyPath, autoIncrement: os.autoIncrement, indexes: [] };
        for (var x = 0; x < os.indexNames.length; x++) { var ix = os.index(os.indexNames[x]); info.indexes.push({ name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }); }
        info.keys = await req(db.transaction(sn, "readonly").objectStore(sn).getAllKeys());
        d.stores.push(info);
      }
      out.push(d);
    }
    return out;
  }
  function itemCount(lk, dbs) { var n = lk.length; dbs.forEach(function (d) { d.stores.forEach(function (s) { n += s.keys.length; }); }); return n; }
  /* writes every line through emit(line); records are read one at a time (each in its own transaction, because
     turning a photo into text is async and would end a shared one) */
  async function writeLines(lk, dbs, emit, progress) {
    var total = itemCount(lk, dbs), done = 0;
    await emit(JSON.stringify({ t: "h", v: 3, app: C.name, at: Date.now(), n: total,
      dbs: dbs.map(function (d) { return { name: d.name, version: d.version, stores: d.stores.map(function (s) { return { name: s.name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: s.indexes }; }) }; }) }));
    for (var i = 0; i < lk.length; i++) { await emit(JSON.stringify({ t: "l", k: lk[i], v: localStorage.getItem(lk[i]) })); progress(++done, total); }
    for (var n = 0; n < dbs.length; n++) {
      var d = dbs[n];
      for (var s = 0; s < d.stores.length; s++) {
        var S = d.stores[s];
        for (var r = 0; r < S.keys.length; r++) {
          var v = await req(d.db.transaction(S.name, "readonly").objectStore(S.name).get(S.keys[r]));
          if (v !== undefined) await emit(JSON.stringify({ t: "r", d: d.name, s: S.name, k: S.keyPath != null ? undefined : S.keys[r], v: await toJSON(v) }));
          progress(++done, total);
        }
      }
    }
  }
  /* lines -> parts of about PART characters; sink(partText, index) */
  function packer(sink) {
    var buf = [], len = 0, idx = 0;
    return {
      emit: async function (line) { buf.push(line); len += line.length + 1; if (len >= PART) await this.flush(); },
      flush: async function () { if (!buf.length) return; var t = buf.join("\n") + "\n"; buf = []; len = 0; await sink(t, idx++); },
      count: function () { return idx; }
    };
  }

  /* a file / JSON can't hold Blobs (photos etc.) directly: turn them into data: URLs and back */
  async function toJSON(v) {
    if (v instanceof Blob) return { __blob: await new Promise(function (r, j) { var f = new FileReader(); f.onload = function () { r(f.result); }; f.onerror = function () { j(f.error); }; f.readAsDataURL(v); }) };
    if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length; i++) a.push(await toJSON(v[i])); return a; }
    if (v && typeof v === "object" && !(v instanceof Date)) { var o = {}; for (var k in v) o[k] = await toJSON(v[k]); return o; }
    return v;
  }
  async function fromJSON(v) {
    if (v && typeof v === "object" && typeof v.__blob === "string") return await (await fetch(v.__blob)).blob();
    if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length; i++) a.push(await fromJSON(v[i])); return a; }
    if (v && typeof v === "object") { var o = {}; for (var k in v) o[k] = await fromJSON(v[k]); return o; }
    return v;
  }

  /* ---------- old address: hand over ---------- */
  if (OLD) {
    /* the old copy must never look like the app - otherwise two installed icons can't be told apart */
    page('<div style="display:inline-block;background:#8b1e1e;color:#fff;font-weight:800;letter-spacing:2px;border-radius:8px;padding:6px 14px;margin-bottom:14px">OLD COPY</div>' +
      '<h1>' + esc(C.name) + ' has moved</h1>' +
      '<p>This is the old copy. The app now has its own address, so it no longer shares storage or installs with the other DSR apps:</p>' +
      '<p><b style="color:#efc13f">' + esc(C.to.replace(/^https:\/\//, "").replace(/\/$/, "")) + '</b></p>' +
      '<div id="st"></div>' +
      '<div id="moveBtns" style="display:none"><button class="p" id="go">Move my data and open the new app</button>' +
      '<p class="dim" id="keep">Moving copies your data - nothing is removed from here, so you can move it again if anything goes wrong.</p>' +
      '<button class="g" id="file">Save my data as a file instead</button></div>' +
      '<a class="b p" id="skip" href="' + esc(C.to) + '">Open the new app</a>' +
      '<p style="margin-top:18px"><b style="color:#efc13f">Then remove this old copy:</b> long-press its icon › <b>Uninstall</b>. If Android asks about data in Chrome, tap <b>Keep Data</b> - that storage still holds your other DSR apps.</p>');
    document.title = "OLD – " + C.name;
    var LK = null, DBS = null, busy = false;
    (async function () {
      LK = lsKeys(); DBS = await openDBs();
      var n = itemCount(LK, DBS);
      if (n) { $("moveBtns").style.display = ""; $("skip").className = "b g"; $("skip").textContent = "Open the new app without moving anything"; st("Ready to move " + n + " saved item" + (n > 1 ? "s" : "") + "."); }
    })().catch(function (e) { st("Couldn't read the data here: " + e.message); });
    function pct(d, t) { return t ? Math.floor(d / t * 100) + "%" : ""; }
    /* the hand-over goes through dsr-move-relay (our own Cloudflare Worker): this page uploads the data under a
       one-time code and opens the new address with it; the new address collects it and deletes it. No pop-up
       windows (unreliable from an installed app), and nothing left behind (it expires after 60 minutes anyway). */
    $("go").onclick = async function () {
      if (!DBS || busy) return;
      busy = true; this.disabled = true; $("file").disabled = true;
      var code = "", b = new Uint8Array(16), sent = 0, btn = this;
      crypto.getRandomValues(b); b.forEach(function (x) { code += (x + 256).toString(16).slice(1); });
      try {
        var pk = packer(async function (t, i) { await put(code + "/" + i, t); sent += t.length; });
        await writeLines(LK, DBS, function (l) { return pk.emit(l); }, function (d, t) { st("Sending… " + pct(d, t) + " (" + mb(sent) + " sent) - keep this screen open"); });
        await pk.flush();
        await put(code + "/meta", JSON.stringify({ parts: pk.count(), format: 3, app: C.name }));
        st("Sent ✓ - opening the new app…");
        location.href = C.to + "#dsr-move-in=" + code;
      } catch (e) { st("Couldn't send it (" + e.message + "). Check you're online and try again, or use \"Save my data as a file\"."); btn.disabled = false; $("file").disabled = false; busy = false; }
    };
    $("file").onclick = async function () {
      if (!DBS || busy) return;
      busy = true; var chunks = [], btn = this; btn.disabled = true;
      try {
        var pk = packer(async function (t) { chunks.push(t); });
        await writeLines(LK, DBS, function (l) { return pk.emit(l); }, function (d, t) { st("Making the file… " + pct(d, t)); });
        await pk.flush();
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(chunks, { type: "text/plain" }));
        a.download = C.name.replace(/\s+/g, "-") + "-data.json"; document.body.appendChild(a); a.click(); a.remove();
        st("Saved to Downloads. Now open the new app to import the file - tap below.");
        $("skip").href = C.to + "#dsr-move-in"; $("skip").textContent = "Open the new app to import the file";
      } catch (e) { st("Couldn't make the file: " + e.message); }
      btn.disabled = false; busy = false;
    };
    return;
  }

  /* ---------- new address: receive ---------- */
  var CODE = (location.hash.match(/=([0-9a-f]{32})$/) || [])[1];
  page('<h1>Bringing your data into ' + esc(C.name) + '</h1><div id="st">' + (CODE ? "Collecting your data…" : "Choose the data file you saved from the old app.") + '</div>' +
    '<div id="after"></div>' +
    '<button class="g" id="pick">Choose a saved data file instead</button><input type="file" id="f" accept=".json,application/json,text/plain" style="display:none">' +
    '<a class="b g" id="cancel" href="' + esc(location.pathname) + '">Cancel - just open the app</a>');
  history.replaceState(null, "", location.pathname + "#dsr-move-in");   // the code is used once
  function done(n) {
    st("Done ✓ " + n + " item" + (n === 1 ? "" : "s") + " moved.");
    $("pick").style.display = "none"; $("cancel").style.display = "none";
    $("after").innerHTML = '<p>Now install the app from here if it isn\'t already: Chrome ⋮ › <b>Add to home screen</b> › <b>Install</b>. Then uninstall the old copy (tap <b>Keep Data</b> if asked).</p>' +
      '<a class="b p" href="' + esc(location.pathname) + '">Open ' + esc(C.name) + '</a>';
  }

  /* is there already something saved at this new address? Then never overwrite it without asking. */
  async function hasDataHere() {
    if (lsKeys().length) return true;
    for (var n = 0; n < (C.idb || []).length; n++) {
      if (indexedDB.databases) { var list = await indexedDB.databases(); if (!list.some(function (d) { return d.name === C.idb[n]; })) continue; }
      var db = await req(indexedDB.open(C.idb[n])), any = false;
      for (var s = 0; s < db.objectStoreNames.length; s++) if (await req(db.transaction(db.objectStoreNames[s], "readonly").objectStore(db.objectStoreNames[s]).count())) any = true;
      db.close(); if (any) return true;
    }
    return false;
  }
  async function okToReplace() {
    if (!(await hasDataHere())) return true;
    return confirm(C.name + " at this new address already has saved data.\n\nReplace it with the data from the old copy?\n\n(Cancel keeps what's here and brings nothing over.)");
  }

  /* v3 receiver: lines arrive part by part; the header (re)creates the databases, then each record is stored */
  function receiver() {
    var open = {}, n = 0, header = null;
    function getDB(name) { return open[name]; }
    return {
      line: async function (line) {
        if (!line) return;
        var o = JSON.parse(line);
        if (o.t === "h") {
          header = o;
          for (var i = 0; i < o.dbs.length; i++) {
            var d = o.dbs[i];
            await req(indexedDB.deleteDatabase(d.name)).catch(function () {});
            var rq = indexedDB.open(d.name, d.version || 1);
            rq.onupgradeneeded = (function (d) { return function () {
              var db = rq.result;
              d.stores.forEach(function (s) {
                var os = db.createObjectStore(s.name, s.keyPath != null ? { keyPath: s.keyPath, autoIncrement: s.autoIncrement } : { autoIncrement: s.autoIncrement });
                s.indexes.forEach(function (ix) { os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry }); });
              });
            }; })(d);
            open[d.name] = await req(rq);
          }
        } else if (o.t === "l") { localStorage.setItem(o.k, o.v); n++; }
        else if (o.t === "r") {
          var v = await fromJSON(o.v), db = getDB(o.d);
          await new Promise(function (res, rej) {
            var tx = db.transaction(o.s, "readwrite"), os = tx.objectStore(o.s);
            if (o.k === undefined) os.put(v); else os.put(v, o.k);
            tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error || new Error("storage refused it")); };
          });
          n++;
        }
        if (header && header.n) st("Storing… " + Math.floor(n / header.n * 100) + "%");
      },
      /* feed raw text that may end mid-line; returns the unfinished tail */
      text: async function (tail, t) { var all = tail + t, lines = all.split("\n"), rest = lines.pop(); for (var i = 0; i < lines.length; i++) await this.line(lines[i]); return rest; },
      finish: function () { Object.keys(open).forEach(function (k) { open[k].close(); }); return n; }
    };
  }

  /* v2 (older kit) - one JSON object */
  function v2count(d) { var n = Object.keys(d.ls || {}).length; (d.idb || []).forEach(function (x) { x.stores.forEach(function (s) { n += s.values.length; }); }); return n; }
  async function importV2(data) {
    Object.keys(data.ls || {}).forEach(function (k) { localStorage.setItem(k, data.ls[k]); });
    for (var n = 0; n < (data.idb || []).length; n++) {
      var d = data.idb[n];
      await req(indexedDB.deleteDatabase(d.name)).catch(function () {});
      var rq = indexedDB.open(d.name, d.version || 1);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        d.stores.forEach(function (s) {
          var os = db.createObjectStore(s.name, s.keyPath != null ? { keyPath: s.keyPath, autoIncrement: s.autoIncrement } : { autoIncrement: s.autoIncrement });
          s.indexes.forEach(function (ix) { os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry }); });
        });
      };
      var db = await req(rq);
      for (var s = 0; s < d.stores.length; s++) {
        var S = d.stores[s];
        await new Promise(function (res, rej) {
          var tx = db.transaction(S.name, "readwrite"), os = tx.objectStore(S.name);
          S.values.forEach(function (v, i) { if (S.keyPath != null) os.put(v); else os.put(v, S.keys[i]); });
          tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
        });
      }
      db.close();
    }
    return v2count(data);
  }

  async function getPart(k) {
    for (var tries = 0; tries < 10; tries++) {          // a just-written part can take a moment to show up
      try { var r = await fetch(RELAY + CODE + "/" + k, { cache: "no-store" }); if (r.ok) return await r.text(); } catch (e) {}
      await wait(1500 + tries * 500);
    }
    throw new Error("the data wasn't there (it expires 60 minutes after sending) - send it again from the old copy");
  }
  if (CODE) (async function () {
    try {
      var meta = JSON.parse(await getPart("meta"));
      if (!(await okToReplace())) { st("Nothing changed - the data already here was kept."); return; }
      if (meta.format === 3) {
        var rc = receiver(), tail = "";
        for (var i = 0; i < meta.parts; i++) { st("Collecting your data… part " + (i + 1) + " of " + meta.parts); tail = await rc.text(tail, await getPart(i)); }
        await rc.text(tail, "\n");
        var n = rc.finish();
      } else {
        var json = "";
        for (var j = 0; j < meta.parts; j++) { st("Collecting your data… " + Math.round(j / meta.parts * 100) + "%"); json += await getPart(j); }
        st("Storing…"); n = await importV2(await fromJSON(JSON.parse(json)));
      }
      fetch(RELAY + CODE, { method: "DELETE" }).catch(function () {});
      done(n);
    } catch (e) { st("Couldn't bring it over: " + e.message + ". Your data is still safe in the old copy - try again."); }
  })();
  $("pick").onclick = function () { $("f").click(); };
  $("f").onchange = async function () {
    var f = this.files[0]; if (!f) return;
    try {
      if (!(await okToReplace())) { st("Nothing changed - the data already here was kept."); return; }
      st("Reading the file…");
      var first = await f.slice(0, 200).text();
      if (/^\{"t":"h"/.test(first)) {                   // v3 file: read it in slices, not all at once
        var rc = receiver(), tail = "", step = 4 * 1024 * 1024, dec = new TextDecoder();
        for (var p = 0; p < f.size; p += step) tail = await rc.text(tail, dec.decode(await f.slice(p, p + step).arrayBuffer(), { stream: p + step < f.size }));
        await rc.text(tail, "\n"); done(rc.finish());
      } else { st("Storing…"); done(await importV2(await fromJSON(JSON.parse(await f.text())))); }
    } catch (e) { st("That file couldn't be read: " + e.message); }
  };
})();
