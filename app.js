// Pasti — registra a voce + foto, salva su Google Drive. Nessun server: tutto gira sul telefono.
(() => {
  "use strict";
  const CFG = window.PASTI_CONFIG || {};
  const app = document.getElementById("app");
  const MEALS = [["colazione", "Colazione"], ["pranzo", "Pranzo"], ["cena", "Cena"], ["extra", "Extra"]];
  // Serve l'accesso completo a Drive (non solo "drive.file") perché la cartella di destinazione esiste già e non è stata creata dall'app.
  // drive.file: l'app vede e modifica SOLO i file che crea lei (cartella "TrainSmart Pasti"). Non può leggere né toccare il resto del tuo Drive.
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const $ = (h) => { app.innerHTML = h; return app; };
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const fmtT = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;

  // ── pasto proposto in base all'ora ───────────────────────────────────────
  function guessMeal(d = new Date()) {
    const m = d.getHours() * 60 + d.getMinutes();
    if (m >= 5 * 60 && m < 10 * 60 + 30) return "colazione";
    if (m >= 10 * 60 + 30 && m < 15 * 60 + 30) return "pranzo";
    if (m >= 17 * 60 + 30 && m < 22 * 60 + 30) return "cena";
    return "extra";
  }
  // pranzo_10_11_26
  const baseName = (meal, d) => `${meal}_${pad(d.getDate())}_${pad(d.getMonth() + 1)}_${pad(d.getFullYear() % 100)}`;
  const extOf = (type, kind) => {
    type = (type || "").toLowerCase();
    if (kind === "audio") return type.includes("mp4") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    return type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("heic") ? "heic" : "jpg";
  };

  // ── archivio locale (IndexedDB): una registrazione non va persa se l'app si chiude ──
  const idb = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open("pasti", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("items", { keyPath: "id" });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("items", mode); const out = fn(t.objectStore("items")); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
    return { put: (it) => tx("readwrite", s => s.put(it)), del: (id) => tx("readwrite", s => s.delete(id)), all: () => tx("readonly", s => s.getAll()) };
  })();

  // ── Google: accesso e Drive ──────────────────────────────────────────────
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  let tokenClient = null, tok = null, tokExp = 0;
  const loadGsi = () => new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error("Non riesco a caricare l'accesso Google (sei online?)")); document.head.appendChild(s);
  });
  let inflight = null;
  function getToken(force = false) {
    if (!force && tok && Date.now() < tokExp - 60000) return Promise.resolve(tok);
    if (inflight) return inflight;                       // una sola richiesta alla volta
    inflight = requestToken().finally(() => { inflight = null; });
    return inflight;
  }
  async function requestToken() {
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith("INCOLLA")) throw new Error("Manca il CLIENT_ID in config.js");
    await loadGsi();
    return new Promise((res, rej) => {
      if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.CLIENT_ID, scope: SCOPE, callback: () => {} });
      tokenClient.callback = (r) => {
        if (r.error) return rej(new Error("Accesso Google non riuscito: " + r.error));
        tok = r.access_token; tokExp = Date.now() + (Number(r.expires_in) || 3600) * 1000; store.set("pasti_granted", "1"); res(tok);
      };
      tokenClient.error_callback = (e) => rej(new Error("Accesso Google annullato"));
      tokenClient.requestAccessToken({ prompt: store.get("pasti_granted") ? "" : "consent" });
    });
  }
  async function gfetch(url, opts = {}, retry = true) {
    const t = await getToken();
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
    if (r.status === 401 && retry) { tok = null; return gfetch(url, opts, false); }
    if (!r.ok) { const e = new Error("Drive " + r.status + ": " + (await r.text()).slice(0, 160)); e.status = r.status; throw e; }
    return r.json();
  }
  const API = "https://www.googleapis.com/drive/v3/files";
  async function ensureFolder() {
    // cerco (o creo) la cartella "TrainSmart Pasti": con drive.file trovo solo quella creata da quest'app
    const saved = store.get("pasti_folder");
    if (saved) { try { const f = await gfetch(`${API}/${saved}?fields=id,trashed`); if (!f.trashed) return f.id; } catch (e) { if (e.status !== 404) throw e; } }
    const name = CFG.FOLDER_NAME || "TrainSmart Pasti";
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await gfetch(`${API}?q=${q}&fields=files(id)&pageSize=1`);
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) id = (await gfetch(API + "?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }) })).id;
    store.set("pasti_folder", id); return id;
  }
  async function uniqueBase(base, folder, d) {
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false and name contains '${base}'`);
    const r = await gfetch(`${API}?q=${q}&fields=files(name)&pageSize=50`);
    const taken = (r.files || []).some(f => f.name.startsWith(base + "."));
    return taken ? `${base}_${pad(d.getHours())}${pad(d.getMinutes())}` : base;
  }
  async function driveUpload(blob, name, folder) {
    const b = "pasti" + Math.random().toString(16).slice(2);
    const meta = JSON.stringify({ name, parents: [folder] });
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`, blob, `\r\n--${b}--`]);
    return gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body });
  }
  async function uploadItem(it) {
    const d = new Date(it.createdAt), folder = await ensureFolder();
    const base = await uniqueBase(baseName(it.meal, d), folder, d);
    await driveUpload(it.audio, `${base}.${extOf(it.audioType, "audio")}`, folder);
    if (it.photo) await driveUpload(it.photo, `${base}.${extOf(it.photoType, "photo")}`, folder);
    await idb.del(it.id);
    return base;
  }

  // ── schermate ────────────────────────────────────────────────────────────
  const chips = (sel) => `<div class="chips" id="chips">${MEALS.map(([k, l]) => `<button class="chip${k === sel ? " on" : ""}" data-m="${k}">${l}</button>`).join("")}</div>`;
  function bindChips(onPick) {
    app.querySelectorAll(".chip").forEach(b => b.onclick = () => { app.querySelectorAll(".chip").forEach(x => x.classList.remove("on")); b.classList.add("on"); onPick(b.dataset.m); });
  }

  // 1) registrazione
  let rec = null, wake = null;
  async function screenRecord(m0) {
    if (!navigator.mediaDevices || !window.MediaRecorder) return $(`<div class="card"><div class="big err">Registrazione non supportata</div><p class="sub">Apri l'app con Chrome.</p></div>`);
    let meal = (typeof m0 === "string" ? m0 : guessMeal()), stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { $(`<div class="card row"><div class="big err">Microfono non consentito</div><p class="sub">Dai il permesso al microfono (icona lucchetto accanto all'indirizzo, oppure Impostazioni › App › Pasti › Autorizzazioni).</p><button class="btn" id="retry">Riprova</button></div>`); document.getElementById("retry").onclick = () => screenRecord(meal); return; }
    const mime = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(t => MediaRecorder.isTypeSupported(t)) || "";
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = []; let t0 = Date.now(), tick;
    mr.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
    mr.start(1000);
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch {}
    $(`<div class="card"><div class="sub"><span class="dot"></span>Registro…</div><div class="timer" id="t">00:00</div><p class="sub">Racconta cosa mangi: quantità, condimenti, bevande.</p></div>
       ${chips(meal)}<button class="stop" id="stop" aria-label="Ferma"></button><button class="btn ghost" id="cancel">Annulla</button>`);
    bindChips(m => meal = m);
    tick = setInterval(() => { const e = document.getElementById("t"); if (e) e.textContent = fmtT((Date.now() - t0) / 1000); }, 250);
    const release = () => { clearInterval(tick); stream.getTracks().forEach(t => t.stop()); try { wake && wake.release(); } catch {} wake = null; };
    document.getElementById("cancel").onclick = () => { mr.onstop = null; try { mr.stop(); } catch {} release(); screenStart(); };
    document.getElementById("stop").onclick = () => {
      getToken().catch(() => {});      // l'accesso Google va chiesto qui, con un tocco dell'utente (altrimenti il popup viene bloccato)
      const dur = (Date.now() - t0) / 1000;
      mr.onstop = async () => {
        release();
        const type = (mr.mimeType || mime || "audio/webm").split(";")[0];
        const it = { id: "r" + t0, createdAt: t0, meal, audio: new Blob(chunks, { type }), audioType: type, duration: dur, photo: null, photoType: "", state: "asking" };
        await idb.put(it); screenAsk(it);
      };
      mr.stop();
    };
  }

  // 2) "vuoi fare la foto?"
  function screenAsk(it, note) {
    $(`<div class="card row"><div class="big ok">✓ Registrazione fatta (${fmtT(it.duration || 0)})</div>
       ${note ? `<p class="sub warn">${esc(note)}</p>` : ""}
       <div class="sub">Pasto</div>${chips(it.meal)}</div>
       <div class="row"><button class="btn" id="photo">📷 Sì, scatta la foto</button><button class="btn ghost" id="nophoto">Salva senza foto</button><button class="btn ghost" id="discard">Elimina</button></div>
       <input type="file" id="cam" accept="image/*" capture="environment" hidden>`);
    bindChips(async m => { it.meal = m; await idb.put(it); });
    const cam = document.getElementById("cam");
    document.getElementById("photo").onclick = async () => { it.state = "awaiting-photo"; await idb.put(it); cam.click(); };
    cam.onchange = async () => { const f = cam.files && cam.files[0]; if (!f) return; it.photo = f; it.photoType = f.type || "image/jpeg"; it.state = "ready"; await idb.put(it); send(it); };
    cam.addEventListener("cancel", () => screenAsk(it, "Foto non scattata. Puoi riprovare o salvare senza."));
    document.getElementById("nophoto").onclick = async () => { getToken().catch(() => {}); it.state = "ready"; await idb.put(it); send(it); };
    document.getElementById("discard").onclick = async () => { await idb.del(it.id); screenStart(); };
  }

  // 3) invio a Drive
  async function send(it) {
    $(`<div class="card row"><div class="big">Salvo su Drive…</div><p class="sub">${esc(baseName(it.meal, new Date(it.createdAt)))}</p></div>`);
    try {
      const base = await uploadItem(it);
      $(`<div class="card row"><div class="big ok">✓ Salvato su Drive</div><div class="name">${esc(base)}${it.photo ? "<br>registrazione + foto" : "<br>solo registrazione"}</div></div>
         <div class="row"><button class="btn grn" id="again">Nuovo pasto</button></div>`);
      document.getElementById("again").onclick = screenRecord;
    } catch (e) {
      $(`<div class="card row"><div class="big err">Non salvato</div><p class="sub">${esc(e.message)}</p><p class="small">Non hai perso niente: la registrazione resta sul telefono.</p></div>
         <div class="row"><button class="btn" id="retry">Riprova</button><button class="btn ghost" id="later">Più tardi</button></div>`);
      document.getElementById("retry").onclick = () => { tok = null; send(it); };
      document.getElementById("later").onclick = screenStart;
    }
  }

  // 0) avvio: se c è qualcosa in sospeso lo propone, altrimenti schermata Pronto
  async function screenStart() {
    let items = []; try { items = await idb.all(); } catch {}
    items.sort((a, b) => a.createdAt - b.createdAt);
    const ask = items.find(i => i.state === "asking" || i.state === "awaiting-photo");
    if (ask) return screenAsk(ask, "Registrazione in sospeso: vuoi aggiungere la foto?");
    const ready = items.filter(i => i.state === "ready");
    if (ready.length) {
      $(`<div class="card row"><div class="big warn">${ready.length} in attesa di invio</div><p class="sub">Non sono ancora su Drive.</p></div>
         <div class="row"><button class="btn" id="flush">Invia ora</button><button class="btn ghost" id="new">Nuova registrazione</button></div>`);
      document.getElementById("new").onclick = () => screenReady();
      document.getElementById("flush").onclick = async () => { getToken().catch(() => {}); for (const it of ready) { try { await uploadItem(it); } catch (e) { return send(it); } } screenStart(); };
      return;
    }
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith("INCOLLA")) return $(`<div class="card row"><div class="big warn">Manca un'impostazione</div><p class="sub">Apri config.js e incolla il tuo CLIENT_ID di Google (vedi LEGGIMI.txt, passo 3).</p></div>`);
    screenReady();
  }

  // schermata di attesa: la registrazione parte solo quando premi
  function screenReady() {
    let meal = guessMeal();
    $(`<div class="card"><div class="big">Pronto</div><p class="sub">Scegli il pasto e premi il tasto per iniziare a registrare.</p></div>
       ${chips(meal)}<button class="btn red" id="go">🎙️ Inizia registrazione</button>`);
    bindChips(m => meal = m);
    document.getElementById("go").onclick = () => screenRecord(meal);
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  screenStart();
})();
