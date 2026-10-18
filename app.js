/* ============================================================
   一碰知鲜 · 应用逻辑（多罐模型）
   导航：状态 / 冲调 / 碰一碰 / 记录 / 家人
   - 没有「当前这一罐」：所有奶粉罐是平等的一条条记录，可同时存在多罐
   - 超过保质期自动归档，归档后仍可查看，并在界面标注「已过期」
   - 碰一碰 / 摄像头扫码 / 手动短码，三入口识别
   - 重复识别同一罐 → 弹出警告；溯源并入每罐详情
   ============================================================ */
(function () {
  "use strict";

  var KEY = "touchfresh.v4";
  var SHELF = 28;                       // 品牌建议：开罐后 4 周内用完
  var DAY = 86400000;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function randHex(n) {
    var s = "", h = "0123456789ABCDEF";
    for (var i = 0; i < n; i++) s += h[Math.floor(Math.random() * 16)];
    return s;
  }
  function newId() { return "c" + Date.now().toString(36) + randHex(4); }

  // 云端出厂档案（演示：按 UID 稳定映射，真实方案由产线写入云端）
  var FACTORY_POOL = [
    { ranch: "内蒙古 · 乌兰察布牧场", plant: "天津 · 三厂" },
    { ranch: "黑龙江 · 齐齐哈尔牧场", plant: "黑龙江 · 一厂" },
    { ranch: "新西兰 · 怀卡托牧场", plant: "新西兰 · 奥克兰工厂" }
  ];
  function hashOf(str) {
    var h = 0, t = String(str || "X");
    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
  }
  function factoryOf(uid) {
    var h = hashOf(uid), f = FACTORY_POOL[h % FACTORY_POOL.length];
    return { ranch: f.ranch, plant: f.plant, report: "IN-" + (2026000 + (h % 9000)) };
  }
  function fmtYMD(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  /** 补齐老数据缺失的云端字段；返回补齐后的罐 */
  function ensureMeta(c) {
    if (c.queries === undefined || c.queries === null) c.queries = 1;
    if (!c.producedAt) {
      var t = c.made ? Date.parse(c.made + "T00:00:00") : NaN;
      c.producedAt = (isNaN(t) ? Date.now() - 20 * DAY : t) + 2 * DAY;
    }
    var f = factoryOf(c.raw || c.uid || "X");
    if (!c.ranch) c.ranch = f.ranch;
    if (!c.plant) c.plant = f.plant;
    if (!c.report) c.report = f.report;
    return c;
  }
  function makeCan() {
    var u = randHex(8), uid = u.slice(0, 4) + "…" + u.slice(6);
    // 生产 → 出厂 → 今天：让「流通时长」有真实含义
    var madeTs = Date.now() - Math.round(12 + Math.random() * 26) * DAY;
    var producedTs = madeTs + Math.round(1 + Math.random() * 3) * DAY;
    var d = new Date(madeTs);
    var f = factoryOf(u);
    return {
      id: newId(),
      uid: uid,
      raw: u,
      batch: "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
             "-" + "ABCDEF"[Math.floor(Math.random() * 6)] + (1 + Math.floor(Math.random() * 9)),
      made: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
      producedAt: producedTs,
      ranch: f.ranch, plant: f.plant, report: f.report,
      queries: 0,
      openedAt: null, archived: false, archivedAt: null, reason: null
    };
  }
  function normalizeCode(c) {
    var clean = String(c == null ? "" : c).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (!clean) return null;
    return {
      uid: clean.length >= 8 ? clean.slice(0, 4) + "…" + clean.slice(-2) : clean,
      raw: clean, batch: "", made: ""
    };
  }

  var S = load();
  var scan = { phase: "idle", code: null, kind: "", timer: null };
  var detailId = null;
  var cam = { stream: null, raf: null, detector: null, active: false, track: null };

  /* ---------------- 存取与迁移 ---------------- */
  function defaults() {
    return {
      cans: [], brand: "××品牌", seg: "1 段", weight: "900g",
      ranch: "内蒙古 · 乌兰察布牧场", plant: "天津 · 三厂",
      dayOffset: 0, entry: "NFC", tab: "home", theme: "", onboarded: false, toured: false,
      scoopMl: 60, scoopG: 8.8, calcMode: "water", calcWater: 120, calcScoop: 2, milkAt: null
    };
  }
  function load() {
    var out = defaults();
    var raw = null;
    try {
      raw = localStorage.getItem(KEY) || localStorage.getItem("touchfresh.v3") ||
            localStorage.getItem("touchfresh.v2") || localStorage.getItem("touchfresh.v1");
    } catch (e) {}
    if (!raw) { out.cans = [makeCan()]; return out; }
    try {
      var v = JSON.parse(raw);
      if (v.cans && v.cans.length !== undefined) {
        // v4 结构
        for (var k in v) if (v.hasOwnProperty(k)) out[k] = v[k];
        if (!out.cans.length) out.cans = [makeCan()];
      } else {
        // 旧结构迁移：单罐 + 历史列表 → cans[]
        var cans = [];
        (v.history || []).forEach(function (h) {
          cans.push({
            id: newId(), uid: h.uid, raw: h.raw || "", batch: h.batch || "",
            made: h.made || "", openedAt: h.openedAt || null,
            archived: true, archivedAt: (h.openedAt || Date.now()),
            reason: (h.days || 0) >= SHELF ? "expired" : "manual"
          });
        });
        if (v.uid) {
          cans.push({
            id: newId(), uid: v.uid, raw: v.raw || "", batch: v.batch || "",
            made: v.made || "", openedAt: v.openedAt || null,
            archived: false, archivedAt: null, reason: null
          });
        }
        out.cans = cans.length ? cans : [makeCan()];
        out.brand = v.brand || out.brand;
        out.seg = v.seg || out.seg;
        out.weight = v.weight || out.weight;
        out.ranch = v.ranch || out.ranch;
        out.plant = v.plant || out.plant;
        out.entry = v.entry || out.entry;
        out.tab = (v.tab === "home" || v.tab === "recipe" || v.tab === "records" ||
                   v.tab === "family" || v.tab === "scan") ? v.tab : "home";
        out.theme = v.theme || "";
      }
    } catch (e) {
      out.cans = [makeCan()];
    }
    out.cans.forEach(function (c) { ensureMeta(c); });
    out.syncedAt = Date.now();
    return out;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  /* ---------------- 时间与状态 ---------------- */
  function days(c) {
    if (!c || !c.openedAt) return null;
    return Math.max(0, Math.floor((Date.now() - c.openedAt) / DAY) + (S.dayOffset || 0));
  }
  function expiryOf(c) { return c && c.openedAt ? new Date(c.openedAt + SHELF * DAY) : null; }
  function fmt(d) { return (d.getMonth() + 1) + " 月 " + d.getDate() + " 日"; }

  function statusOf(c) {
    if (c.archived) {
      return c.reason === "expired"
        ? { key: "expired", label: "已过期", seal: "red", tone: "#8F2B1F", left: 0,
            note: "超过保质期，已自动归档", dot: "expired" }
        : { key: "archived", label: "已归档", seal: "gray", tone: "#857F73", left: 0,
            note: "已结束使用", dot: "off" };
    }
    if (!c.openedAt) {
      return { key: "sealed", label: "未开罐", seal: "gray", tone: "#857F73",
               left: SHELF, note: "等待记录开罐", dot: "off" };
    }
    var n = days(c);
    if (n >= SHELF) {
      return { key: "expired", label: "已过期", seal: "red", tone: "#8F2B1F", left: 0,
               note: "已开 " + n + " 天，超过保质期", dot: "expired" };
    }
    if (n >= 21) {
      return { key: "near", label: "临近到期 D+" + n, seal: "orange", tone: "#C2410C",
               left: SHELF - n, note: "剩余 " + (SHELF - n) + " 天", dot: "near" };
    }
    return { key: "active", label: "使用中 D+" + n, seal: "green", tone: "#0F766E",
             left: SHELF - n, note: "剩余 " + (SHELF - n) + " 天", dot: "on" };
  }

  function liveCans() { return S.cans.filter(function (c) { return !c.archived; }); }
  function sortCans(list) {
    var order = { near: 0, active: 1, sealed: 2, expired: 3, archived: 4 };
    return list.slice().sort(function (a, b) {
      var sa = statusOf(a), sb = statusOf(b);
      if (order[sa.key] !== order[sb.key]) return order[sa.key] - order[sb.key];
      if (sa.key === "near" || sa.key === "active") return (sa.left || 0) - (sb.left || 0);
      return (b.archivedAt || b.openedAt || 0) - (a.archivedAt || a.openedAt || 0);
    });
  }
  function findCan(raw, uid) {
    for (var i = 0; i < S.cans.length; i++) {
      var c = S.cans[i];
      if ((raw && c.raw && raw === c.raw) || (uid && c.uid === uid)) return c;
    }
    return null;
  }

  /* ---------------- 过期自动归档 ---------------- */
  function sweep(quiet) {
    var n = 0;
    S.cans.forEach(function (c) {
      if (!c.archived && c.openedAt && days(c) >= SHELF) {
        c.archived = true; c.reason = "expired"; c.archivedAt = Date.now();
        n++;
      }
    });
    if (n) {
      save();
      if (!quiet) {
        toast("已自动归档 " + n + " 罐", "这些罐已超过 " + SHELF +
          " 天保质期，已自动归档。仍可在「记录」中查看，界面会标注「已过期」。");
      }
      render();
    }
    return n;
  }

  /* ---------------- 提示 / 通知 / 弹窗 ---------------- */
  var toastTimer;
  function toast(title, body) {
    var t = $("toast");
    t.innerHTML = "<b>" + esc(title) + "</b>" + esc(body || "");
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3800);
  }
  function notify(title, body) {
    try {
      if (window.AndroidNotify && window.AndroidNotify.show) { window.AndroidNotify.show(title, body); return; }
      if (window.Notification && Notification.permission === "granted") {
        new Notification(title, { body: body, icon: "icons/icon-192.png" });
      }
    } catch (e) {}
  }
  function askNotify() {
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
  }
  function showModal(cfg) {
    $("modalIco").className = "modal-ico" + (cfg.tone ? " " + cfg.tone : "");
    $("modalIco").textContent = cfg.ico || "!";
    $("modalTitle").textContent = cfg.title || "";
    $("modalBody").innerHTML = cfg.body || "";
    var acts = $("modalActs");
    acts.innerHTML = "";
    var old = $("modalInput");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var oldF = $("modalFields");
    if (oldF && oldF.parentNode) oldF.parentNode.removeChild(oldF);
    if (cfg.fields) {
      var box = document.createElement("div");
      box.className = "mfields"; box.id = "modalFields";
      cfg.fields.forEach(function (f) {
        var lab = document.createElement("label");
        lab.className = "mfield";
        var sp = document.createElement("span");
        sp.textContent = f.label || "";
        var inp = document.createElement("input");
        inp.className = "minput"; inp.id = "mf_" + f.id;
        inp.type = f.type || "text";
        if (f.type === "number") inp.inputMode = "decimal";
        inp.placeholder = f.placeholder || "";
        inp.value = f.value == null ? "" : f.value;
        lab.appendChild(sp); lab.appendChild(inp); box.appendChild(lab);
      });
      acts.parentNode.insertBefore(box, acts);
    }
    if (cfg.input) {
      var inp = document.createElement("input");
      inp.className = "minput"; inp.id = "modalInput";
      inp.placeholder = cfg.input.placeholder || "";
      inp.maxLength = cfg.input.maxlength || 24;
      inp.value = cfg.input.value || "";
      acts.parentNode.insertBefore(inp, acts);
    }
    (cfg.acts || []).forEach(function (a) {
      var b = document.createElement("button");
      b.className = "btn" + (a.style ? " " + a.style : "");
      b.textContent = a.label;
      b.onclick = function () { if (a.onClick) a.onClick(); };
      acts.appendChild(b);
    });
    $("modal").classList.add("show");
  }
  function hideModal() { $("modal").classList.remove("show"); }
  var modalOpen = function () { return $("modal").classList.contains("show"); };
  var inputValue = function () { var i = $("modalInput"); return i ? i.value : ""; };
  var fieldValue = function (id) { var i = $("mf_" + id); return i ? i.value : ""; };

  /* ---------------- 原生 NFC ---------------- */
  function hasNativeNfc() {
    try { return !!(window.AndroidNfc && window.AndroidNfc.start); } catch (e) { return false; }
  }
  function nfc(on) {
    if (!hasNativeNfc()) return;
    try { on ? window.AndroidNfc.start() : window.AndroidNfc.stop(); } catch (e) {}
  }
  window.tfOnTag = function (uid) {
    var c = normalizeCode(uid);
    if (!c) return;
    S.entry = "NFC"; save();
    onCode(c);
  };

  /* ---------------- 识别 ---------------- */
  function startScan() {
    clearTimeout(scan.timer);
    scan.phase = "scanning"; scan.code = null; scan.kind = "";
    nfc(true); render();
    if (!hasNativeNfc()) {
      scan.timer = setTimeout(function () {
        if (scan.phase !== "scanning") return;
        onCode(makeCan());
      }, 2200);
    }
  }
  function stopScan() {
    clearTimeout(scan.timer);
    scan.phase = "idle"; scan.code = null; scan.kind = "";
    nfc(false);
  }
  function classify(code) {
    var hit = findCan(code.raw, code.uid);
    if (!hit) return { kind: "new", can: null };
    var st = statusOf(hit);
    if (st.key === "sealed") return { kind: "known-sealed", can: hit };
    if (hit.archived) return { kind: "archived", can: hit };
    return { kind: "reopen", can: hit };
  }
  function onCode(code) {
    clearTimeout(scan.timer);
    nfc(false);
    var r = classify(code);
    scan.phase = "found"; scan.code = code; scan.kind = r.kind; scan.hit = r.can;
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
    render();
    if (r.kind === "reopen") warnReopen(r.can);
    else if (r.kind === "archived") warnArchived(r.can);
    else if (r.kind === "known-sealed") toast("这是已在列表中的一罐", r.can.uid + " · 还没有开罐记录");
    else toast("识别到新的一罐", code.uid);
  }

  function warnReopen(c) {
    var n = days(c), p = statusOf(c);
    showModal({
      tone: "warn", ico: "!",
      title: p.key === "near" ? "这一罐已经开罐过了" : "这一罐正在使用中",
      body: "罐码 <b>" + esc(c.uid) + "</b> 已于 <b>" + fmt(new Date(c.openedAt)) +
            "</b> 记录开罐，目前 <b>第 " + n + " 天</b>，剩余 " + Math.max(SHELF - n, 0) + " 天。<br><br>" +
            "同一罐被反复识别，通常是两种情况：家人重复登记，或者<b>标签被撕下转移到了别的罐上</b>。" +
            "请核对页面上的罐码与罐身标签是否一致。",
      acts: [
        { label: "查看这一罐的详情", onClick: function () { hideModal(); stopScan(); openCan(c.id); } },
        { label: "重新识别", style: "ghost", onClick: function () { hideModal(); startScan(); } }
      ]
    });
  }
  function warnArchived(c) {
    var p = statusOf(c);
    var isExp = p.key === "expired";
    showModal({
      tone: "warn", ico: "!",
      title: isExp ? "这一罐已经过期归档" : "这一罐已经结束使用",
      body: "罐码 <b>" + esc(c.uid) + "</b> " +
            (isExp ? "开罐已 <b>" + days(c) + " 天</b>，超过 " + SHELF + " 天保质期，已自动归档。"
                   : "此前已归档（共使用 " + (days(c) || 0) + " 天）。") +
            "<br><br>如果这不是你已经归档的那一罐，请警惕<b>标签被撕下转移到新罐上</b>。",
      acts: [
        { label: "查看这一罐的档案", onClick: function () { hideModal(); stopScan(); openCan(c.id); } },
        { label: "我知道了", style: "ghost", onClick: hideModal }
      ]
    });
  }

  function addCan(code) {
    var madeTs = code.made ? Date.parse(code.made + "T00:00:00") : (Date.now() - 20 * DAY);
    if (isNaN(madeTs)) madeTs = Date.now() - 20 * DAY;
    var c = {
      id: newId(), uid: code.uid, raw: code.raw || "",
      batch: code.batch || "", made: code.made || fmtYMD(madeTs),
      producedAt: madeTs + 2 * DAY,
      openedAt: null, archived: false, archivedAt: null, reason: null, queries: 0
    };
    ensureMeta(c);
    S.cans.unshift(c);
    save(); stopScan();
    toast("已添加这一罐", c.uid + (c.batch ? " · 批次 " + c.batch : "") +
      "。可以在「状态」里记录它的开罐时间。");
    detailId = c.id; go("records");
  }

  /* ---------------- 摄像头扫码 ---------------- */
  function parseScanText(t) {
    if (!t) return null;
    t = String(t).trim();
    var code = null, batch = null, made = null;
    var m = t.match(/[#?&](?:can|uid|c)=([0-9A-Za-z]{4,16})/);
    if (m) code = m[1];
    var mb = t.match(/[#?&]batch=([0-9A-Za-z\-]{4,24})/);
    if (mb) batch = mb[1];
    var md = t.match(/[#?&]made=(\d{4}-\d{2}-\d{2})/);
    if (md) made = md[1];
    if (!code) {
      m = t.match(/touchfresh:\/\/[^\/]*\/?([0-9A-Za-z]{4,16})/);
      if (m) code = m[1];
    }
    if (!code && /^[0-9A-Za-z]{4,16}$/.test(t)) code = t;
    if (!code) return null;
    return { code: code, batch: batch, made: made };
  }
  function openScanner() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("此环境无法调用摄像头", "请使用「手动输入短码」。");
      return;
    }
    $("scanner").classList.add("show");
    cam.active = true;
    $("scanHint").textContent = "正在启动摄像头…";
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }, audio: false
    }).then(function (st) {
      cam.stream = st;
      cam.track = st.getVideoTracks()[0] || null;
      var v = $("scanVideo");
      v.srcObject = st;
      return v.play();
    }).then(function () {
      if ("BarcodeDetector" in window) {
        try {
          cam.detector = new window.BarcodeDetector({
            formats: ["qr_code", "ean_13", "code_128", "code_39", "data_matrix"]
          });
          $("scanHint").textContent = "把罐身二维码放入框内";
          loop();
        } catch (e) {
          cam.detector = null;
          $("scanHint").textContent = "此设备不支持自动识别，请用「手动输入短码」";
        }
      } else {
        $("scanHint").textContent = "当前环境不支持二维码识别，请用「手动输入短码」";
      }
    }).catch(function (err) {
      var n = err && err.name ? err.name : "未知错误";
      $("scanHint").textContent = "无法打开摄像头（" + n + "）。请检查相机权限，或改用手动输入。";
    });
  }
  function loop() {
    if (!cam.active || !cam.detector) return;
    var v = $("scanVideo");
    if (v.readyState >= 2) {
      cam.detector.detect(v).then(function (codes) {
        if (!cam.active) return;
        if (codes && codes.length) { onScanText(codes[0].rawValue); return; }
        cam.raf = requestAnimationFrame(loop);
      }).catch(function () { cam.raf = requestAnimationFrame(loop); });
    } else {
      cam.raf = requestAnimationFrame(loop);
    }
  }
  function closeScanner() {
    cam.active = false;
    if (cam.raf) cancelAnimationFrame(cam.raf);
    cam.raf = null; cam.detector = null;
    if (cam.stream) {
      try { cam.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      cam.stream = null; cam.track = null;
    }
    try { $("scanVideo").srcObject = null; } catch (e) {}
    $("scanner").classList.remove("show");
  }
  var scannerOpen = function () { return $("scanner").classList.contains("show"); };

  function onScanText(text) {
    var p = parseScanText(text);
    closeScanner();
    if (!p) { toast("无法识别这个码", "请确认是罐身上的二维码，或改用手动输入短码。"); return; }
    var c = normalizeCode(p.code);
    if (!c) return;
    if (p.batch) c.batch = p.batch;
    if (p.made) c.made = p.made;
    S.entry = "扫码"; save();
    onCode(c);
  }
  function manualInput() {
    showModal({
      tone: "", ico: "⌨",
      title: "手动输入罐身短码",
      body: "二维码磨损或摄像头不可用时使用。短码印在罐身二维码下方。",
      input: { placeholder: "例如 04A29F", maxlength: 16 },
      acts: [
        { label: "确认", onClick: function () {
            var c = normalizeCode(inputValue());
            if (!c) { toast("短码格式不正确", "请输入 4–16 位字母或数字。"); return; }
            hideModal(); S.entry = "短码"; save(); onCode(c);
          } },
        { label: "取消", style: "ghost", onClick: hideModal }
      ]
    });
    setTimeout(function () { var i = $("modalInput"); if (i) i.focus(); }, 60);
  }
  function toggleTorch() {
    if (!cam.track) { toast("手电筒不可用", "当前摄像头不支持。"); return; }
    try {
      var on = !cam.track.getSettings().torch;
      cam.track.applyConstraints({ advanced: [{ torch: on }] });
      $("scanTorch").textContent = on ? "关手电筒" : "开手电筒";
    } catch (e) { toast("手电筒不可用", "当前设备不支持。"); }
  }

  /* ---------------- 罐操作 ---------------- */
  function openCan(id) {
    var c = byId(id);
    if (c) { c.queries = (c.queries || 0) + 1; save(); }   // 一次溯源查询
    detailId = id; go("records");
  }
  function recordOpen(id) {
    var c = byId(id); if (!c) return;
    c.openedAt = Date.now(); c.archived = false; c.reason = null; c.archivedAt = null;
    save(); askNotify(); render();
    toast("开罐时间已记录", c.uid + " 已开始 28 天倒计时。");
  }
  function archiveCan(id) {
    var c = byId(id); if (!c || c.archived) return;
    c.archived = true; c.reason = "manual"; c.archivedAt = Date.now();
    save(); render();
    toast("已结束使用并归档", c.uid + " 保留在「记录」里，随时可以查看它的溯源。");
  }
  function deleteCan(id) {
    var c = byId(id); if (!c) return;
    showModal({
      tone: "warn", ico: "?",
      title: "删除这条奶粉记录？",
      body: "罐码 <b>" + esc(c.uid) + "</b> 的开罐记录与溯源档案将被永久删除，无法恢复。",
      acts: [
        { label: "删除", style: "accent", onClick: function () {
            hideModal();
            S.cans = S.cans.filter(function (x) { return x.id !== id; });
            if (!S.cans.length) S.cans = [makeCan()];
            if (detailId === id) detailId = null;
            save(); render(); toast("已删除", "这条奶粉记录已移除。");
          } },
        { label: "取消", style: "ghost", onClick: hideModal }
      ]
    });
  }
  function byId(id) {
    for (var i = 0; i < S.cans.length; i++) if (S.cans[i].id === id) return S.cans[i];
    return null;
  }

  /* ---------------- 视图 ---------------- */
  function ringSvg(pct, tone, big, sub) {
    var C = 2 * Math.PI * 54;
    return '<div class="ring"><svg viewBox="0 0 180 180">' +
      '<circle cx="90" cy="90" r="54" fill="none" stroke="rgba(127,127,127,.18)" stroke-width="13"/>' +
      '<circle cx="90" cy="90" r="54" fill="none" stroke="' + tone + '" stroke-width="13" ' +
      'stroke-linecap="round" stroke-dasharray="' + (C * pct).toFixed(1) + " " + C.toFixed(1) + '"/>' +
      '</svg><div class="nums"><b style="color:' + tone + '">' + big + "</b><span>" + sub + "</span></div></div>";
  }

  function canCard(c, i) {
    var st = statusOf(c), n = days(c);
    var pct = st.key === "sealed" ? 0 : Math.min((n || 0) / SHELF, 1);
    var big = st.key === "sealed" ? "—" : (st.key === "expired" ? "0" : st.left);
    var sub = st.key === "sealed" ? "待开罐" : (st.key === "expired" ? "已过期" : "天后到期");
    return '<button class="cancard" data-open="' + c.id + '" style="--i:' +
      Math.min(i || 0, 8) + '">' +
      '<div class="cc-head"><span class="cc-uid">' + esc(c.uid) + "</span>" +
      '<span class="seal ' + st.seal + '">' + st.label + "</span></div>" +
      '<div class="cc-body">' +
        '<div class="cc-left"><b style="color:' + st.tone + '">' + big + "</b><span>" + sub + "</span></div>" +
        '<div class="cc-mid">' +
          '<div class="cc-bar"><i style="width:' + (pct * 100).toFixed(1) + '%;background:' + st.tone + '"></i></div>' +
          '<div class="cc-note">' + esc(st.note) +
            (c.openedAt ? "　·　建议 " + fmt(expiryOf(c)) + " 前用完" : "") + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="cc-foot">' + esc(S.brand) + " " + esc(S.seg) + " " + esc(S.weight) +
        "　·　批次 " + esc(c.batch || "—") + "</div>" +
      "</button>";
  }

  function vHome() {
    var live = sortCans(liveCans());
    var left = "";
    if (!live.length) {
      left = '<div class="hero"><div><span class="seal gray">暂无在用的罐</span></div>' +
        "<h3>还没有在用的奶粉</h3>" +
        "<p>碰一碰罐盖、扫码，或者手动输入短码，<br>把新买的奶粉加进来。</p>" +
        '<button class="btn big" id="homeScan">碰一碰 / 扫码添加</button></div>' +
        '<div class="alert dim">已过期的罐会自动归档到「记录」，仍然可以查看它的溯源。</div>';
    } else {
      var urgent = live[0], ust = statusOf(urgent);
      left = '<div class="acts" style="margin-bottom:.8rem">' +
        '<button class="btn" id="homeScan">碰一碰 / 扫码添加新罐</button></div>';
      if (ust.key === "near")
        left += '<div class="alert">' + esc(urgent.uid) + " 已临近到期，剩余 " + ust.left +
          " 天（建议 " + fmt(expiryOf(urgent)) + " 前用完）。</div>";
      left += live.map(function (c, i) { return canCard(c, i); }).join("");
      if (live.length > 1)
        left += '<div class="alert dim">同时有 ' + live.length + " 罐在用，各自独立计时。</div>";
    }

    var all = S.cans;
    var exp = all.filter(function (c) { return statusOf(c).key === "expired"; }).length;
    var arc = all.filter(function (c) { return statusOf(c).key === "archived"; }).length;
    var right = '<div class="sect">总览</div>' +
      '<div class="kv"><span class="k">在用</span><span class="v">' + live.length + " 罐</span></div>" +
      '<div class="kv"><span class="k">已过期</span><span class="v">' + exp + " 罐</span></div>" +
      '<div class="kv"><span class="k">已归档</span><span class="v">' + arc + " 罐</span></div>" +
      '<div class="link" id="goRecords"><span>查看全部记录与溯源</span><span class="arw">›</span></div>' +
      '<div class="sect">家人共享</div>' +
      '<div class="fam"><div class="av">妈</div><div><div class="n">妈妈</div>' +
      '<div class="r">开罐记录人</div></div></div>' +
      '<div class="fam"><div class="av t">奶</div><div><div class="n">奶奶</div>' +
      '<div class="r">已加入 · 可查看剩余天数</div></div></div>' +
      '<div class="link" id="inInvite"><span>邀请家人</span><span class="arw">›</span></div>';
    return '<div class="grid2"><div class="col">' + left + "</div>" +
           '<div class="col">' + right + "</div></div>";
  }

  function vScan() {
    var st = scan.phase;
    var ringCls = st === "scanning" ? "" : (st === "found" ? "done" : "idle");
    var left = '<div class="scanstage">' +
      '<div class="rings ' + ringCls + '"><i></i><i></i><i></i><b>' +
      (st === "found" ? "OK" : "NFC") + "</b></div>";

    if (st === "found" && scan.code) {
      var c = scan.hit, kind = scan.kind;
      if (kind === "reopen" || kind === "archived") {
        var p = statusOf(c);
        left += '<div class="warncard"><div class="wt">⚠ ' +
          (kind === "reopen" ? "这一罐已经开罐过了" : (p.key === "expired" ? "这一罐已过期归档" : "这一罐已结束使用")) +
          '</div><div class="wb">罐码 ' + esc(c.uid) +
          (c.openedAt ? "　·　开罐于 " + fmt(new Date(c.openedAt)) + "，已开 " + days(c) + " 天" : "") +
          "。重复识别可能意味着标签被转移，或家人重复登记。</div></div>" +
          '<button class="btn" id="scanLook">查看这一罐的详情</button>' +
          '<button class="btn ghost" id="scanAgain">重新识别</button>';
      } else if (kind === "known-sealed") {
        left += "<h3>这是已在列表中的一罐</h3><p>标签与列表里的一罐一致，它还没有开罐记录。</p>" +
          '<div class="foundn"><div class="lab">罐码</div><div class="u">' + esc(c.uid) + "</div></div>" +
          '<button class="btn" id="scanLook">去记录开罐时间</button>' +
          '<button class="btn ghost" id="scanAgain">重新识别</button>';
      } else {
        left += "<h3>识别到新的一罐</h3>" +
          "<p>把它加入你的奶粉列表，之后可以单独记录它的开罐时间。</p>" +
          '<div class="foundn"><div class="lab">新罐码</div><div class="u">' + esc(scan.code.uid) + "</div>" +
          (scan.code.batch ? '<div class="m">批次 ' + esc(scan.code.batch) + "</div>" : "") + "</div>" +
          '<button class="btn accent" id="scanAdd">添加到我的奶粉</button>' +
          '<button class="btn ghost" id="scanAgain">重新识别</button>';
      }
    } else if (st === "scanning") {
      left += "<h3>正在识别…</h3><p>请保持手机贴近罐盖顶部，不要移开。</p>" +
        '<button class="btn ghost" id="scanCancel">取消</button>';
    } else {
      left += "<h3>碰一碰罐盖，或扫码</h3>" +
        "<p>NFC 标签位于塑料盖中央；也可以调用摄像头扫罐身二维码。</p>" +
        '<button class="btn lg" id="scanStart">开始识别（NFC）</button>' +
        '<button class="btn line" id="scanCam">扫码识别（摄像头）</button>' +
        '<button class="btn ghost" id="scanSim">' +
        (hasNativeNfc() ? "没有标签？手动登记一罐" : "模拟识别到标签（演示）") + "</button>";
    }
    left += "</div>" +
      '<div class="link" id="scanCode"><span>手动输入罐身短码</span><span class="arw">›</span></div>';

    var live = sortCans(liveCans());
    var right = '<div class="sect">我的奶粉（' + S.cans.length + '）</div>';
    if (!S.cans.length) right += '<div class="alert dim">列表为空。</div>';
    else sortCans(S.cans).slice(0, 6).forEach(function (c, i) {
      var p = statusOf(c);
      right += '<button class="rec" data-open="' + c.id + '" style="--i:' + i + '">' +
        '<span class="dot ' + p.dot + '"></span><span class="rinfo"><span class="ru">' + esc(c.uid) +
        '</span><span class="rm">' + esc(c.batch || "") + " · " + esc(p.note) + "</span></span>" +
        '<span class="seal ' + p.seal + '">' + p.label + "</span></button>";
    });
    if (live.length) right += '<div class="alert dim">同时有 ' + live.length + " 罐在用，各自独立计时。</div>";
    right += '<div class="link" id="goRecords"><span>查看全部记录与溯源</span><span class="arw">›</span></div>';
    return '<div class="grid2"><div class="col">' + left + "</div>" +
           '<div class="col">' + right + "</div></div>";
  }

  function vRecords() {
    if (detailId) return vCanDetail();
    var all = sortCans(S.cans);
    var live = all.filter(function (c) { return !c.archived; });
    var done = all.filter(function (c) { return c.archived; });

    var left = '<div class="sect">在用（' + live.length + "）</div>";
    if (!live.length) left += '<div class="alert dim">没有在用的罐。去「碰一碰」添加一罐吧。</div>';
    else live.forEach(function (c, i) {
      var p = statusOf(c);
      left += '<button class="rec" data-open="' + c.id + '" style="--i:' + i + '">' +
        '<span class="dot ' + p.dot + '"></span><span class="rinfo"><span class="ru">' + esc(c.uid) +
        '</span><span class="rm">' + esc(c.batch || "") + "　·　" + esc(p.note) +
        (c.openedAt ? "　·　开罐 " + fmt(new Date(c.openedAt)) : "") + "</span></span>" +
        '<span class="seal ' + p.seal + '">' + p.label + "</span></button>";
    });

    var right = '<div class="sect">已归档（' + done.length + "）</div>";
    if (!done.length) right += '<div class="alert dim">还没有归档的罐。超过 ' + SHELF +
      ' 天保质期会自动归档，也可以手动结束使用。</div>';
    else done.forEach(function (c, i) {
      var p = statusOf(c);
      right += '<button class="rec' + (p.key === "expired" ? " is-expired" : "") +
        '" data-open="' + c.id + '" style="--i:' + i + '">' +
        '<span class="dot ' + p.dot + '"></span><span class="rinfo"><span class="ru">' + esc(c.uid) +
        '</span><span class="rm">' + esc(c.batch || "") + "　·　" + esc(p.note) +
        (c.archivedAt ? "　·　归档 " + fmt(new Date(c.archivedAt)) : "") + "</span></span>" +
        '<span class="seal ' + p.seal + '">' + p.label + "</span></button>";
    });
    right += '<div class="alert dim">归档的罐仍然可以点开查看溯源与开罐档案；' +
      '已过期的会在界面标注「已过期」。</div>';
    return '<div class="grid2"><div class="col">' + left + "</div>" +
           '<div class="col">' + right + "</div></div>";
  }

  function vCanDetail() {
    var c = byId(detailId);
    if (!c) { detailId = null; return vRecords(); }
    var st = statusOf(c), n = days(c);

    var banner = "";
    if (st.key === "expired") {
      banner = '<div class="warncard"><div class="wt">⚠ 已过期 · 已自动归档</div>' +
        '<div class="wb">这一罐开罐已 <b>' + n + " 天</b>，超过品牌建议的 " + SHELF +
        " 天保质期" + (c.archivedAt ? "，已于 " + fmt(new Date(c.archivedAt)) + " 自动归档" : "") +
        "。<br>建议<b>停止使用</b>；如罐内仍有较多奶粉，可联系客服咨询处置方式。记录与溯源仍然保留，仅供查询。</div></div>";
    } else if (st.key === "archived") {
      banner = '<div class="alert dim">这一罐已结束使用并归档（共使用 ' + (n || 0) +
        " 天）。记录与溯源仍然保留，仅供查询。</div>";
    } else if (st.key === "near") {
      banner = '<div class="alert">临近到期：剩余 ' + st.left + " 天，建议 " +
        fmt(expiryOf(c)) + " 前用完。</div>";
    }

    var left = '<div class="backlink" id="recBack">‹ 返回记录</div>' + banner +
      '<div class="tincan"><div class="l1">' + esc(c.uid) + "</div>" +
      '<div class="l2">' + esc(S.brand) + " " + esc(S.seg) + " " + esc(S.weight) +
      "　·　批次 " + esc(c.batch || "—") + "</div></div>" +
      '<div class="kv"><span class="k">状态</span><span class="v">' + st.label + "</span></div>" +
      (c.openedAt ? '<div class="kv"><span class="k">开罐时间</span><span class="v">' +
        fmt(new Date(c.openedAt)) + "</span></div>" : "") +
      (n !== null ? '<div class="kv"><span class="k">已开天数</span><span class="v">' + n + " 天</span></div>" : "") +
      (c.openedAt ? '<div class="kv"><span class="k">建议用完</span><span class="v">' +
        fmt(expiryOf(c)) + "</span></div>" : "") +
      (c.producedAt && c.openedAt
        ? '<div class="kv"><span class="k">流通时长</span><span class="v">' +
          Math.max(0, Math.round((c.openedAt - c.producedAt) / DAY)) + " 天（出厂 → 开罐）</span></div>"
        : "") +
      (c.archivedAt ? '<div class="kv"><span class="k">归档时间</span><span class="v">' +
        fmt(new Date(c.archivedAt)) + "</span></div>" : "") +
      '<div class="acts" style="margin-top:.6rem">' +
      (!c.archived && !c.openedAt ? '<button class="btn accent" data-open-act="' + c.id + '">记录开罐时间</button>' : "") +
      (!c.archived && c.openedAt ? '<button class="btn line" data-archive="' + c.id + '">结束使用（归档）</button>' : "") +
      '<button class="btn ghost" data-delete="' + c.id + '">删除这条记录</button>' +
      "</div>";

    var qn2 = c.queries || 1;
    var right = '<div class="sect">溯源信息</div>' +
      '<div class="kv"><span class="k">档案来源</span><span class="v cloudtag">云端档案 · 已同步</span></div>' +
      '<div class="kv"><span class="k">出厂时间</span><span class="v">' + fmtYMD(c.producedAt) + "</span></div>" +
      '<div class="kv"><span class="k">牧场</span><span class="v">' + esc(c.ranch) + "</span></div>" +
      '<div class="kv"><span class="k">工厂</span><span class="v">' + esc(c.plant) + "</span></div>" +
      '<div class="kv"><span class="k">生产日期</span><span class="v">' + esc(c.made || "—") + "</span></div>" +
      '<div class="kv"><span class="k">批次</span><span class="v mono">' + esc(c.batch || "—") + "</span></div>" +
      '<div class="link" id="inReport"><span>检验报告 ' + esc(c.report || "") + '</span><span class="arw">›</span></div>' +
      '<div class="sect">真伪校验</div>' +
      '<div class="kv"><span class="k">首次激活</span><span class="v">' +
        (c.openedAt ? fmt(new Date(c.openedAt)) : "尚未激活") + "　<i>云端记录</i></span></div>" +
      '<div class="kv"><span class="k">查询次数</span><span class="v">' + qn2 + " 次 · " +
        (qn2 > 3 ? "偏多" : "正常") + "</span></div>" +
      (qn2 > 3
        ? '<div class="alert">本罐码已被查询 ' + qn2 + " 次，明显高于常规。" +
          "若非家人重复查看，请警惕标签被复制或转移。</div>"
        : '<div class="alert ok">查询次数在正常范围，与生产批次、销售区域匹配。</div>') +
      '<div class="alert dim">若同一罐码被多次识别，页面会弹出重复识别警告 —— ' +
      "这通常意味着标签被转移，或家人重复登记。</div>";
    return '<div class="grid2"><div class="col">' + left + "</div>" +
           '<div class="col">' + right + "</div></div>";
  }

  /* ---------------- 冲调计算 ---------------- */
  function scoopMl() { return S.scoopMl || 60; }
  function scoopG() { return S.scoopG || 8.8; }
  function nf(n) {
    var r = Math.round(n * 10) / 10;
    return r === Math.floor(r) ? String(r) : r.toFixed(1);
  }
  function scoopWord(sc) {
    var r = Math.round(sc * 2) / 2;                 // 允许半勺
    if (Math.abs(sc - Math.round(sc)) < 0.02) return Math.round(sc) + " 平勺";
    if (Math.abs(sc - r) < 0.02) return nf(r) + " 平勺（半勺）";
    return nf(sc) + " 平勺";
  }
  function fromWater(ml) {
    var sc = ml / scoopMl();
    return { scoops: sc, grams: sc * scoopG() };
  }
  function fromScoops(sc) {
    return { scoops: sc, ml: sc * scoopMl(), grams: sc * scoopG() };
  }

  function calcHTML() {
    var water = S.calcMode !== "powder";
    var ml = S.calcWater || 120;
    var sc = S.calcScoop || 2;
    var out, hint = "";

    if (water) {
      var r = fromWater(ml);
      out = '<div class="big">需要 ' + esc(scoopWord(r.scoops)) + "</div>" +
        '<div class="sub">≈ ' + nf(r.grams) + " g　·　" + ml + " ml 水 + " +
        nf(r.grams) + " g 奶粉</div>";
      var near = Math.round(r.scoops);
      if (Math.abs(r.scoops - near) > 0.02) {
        hint = "⚠ " + ml + " ml 水对应 " + nf(r.scoops) + " 平勺，不是整数勺。" +
          "量勺多带一点会偏浓，建议用「刮平」手法取半勺，或改用 " +
          (near * scoopMl()) + " ml 水配 " + near + " 平勺。";
      } else {
        hint = "先加 " + ml + " ml 温水（40–50℃），再加 " + near +
          " 平勺奶粉，刮平不要压实。";
      }
    } else {
      var r2 = fromScoops(sc);
      out = '<div class="big">需要 ' + Math.round(r2.ml) + " ml 水</div>" +
        '<div class="sub">' + scoopWord(sc) + " ≈ " + nf(r2.grams) + " g 奶粉</div>";
      hint = "先量好 " + Math.round(r2.ml) + " ml 温水，再加 " + scoopWord(sc) +
        "奶粉。奶粉应先刮平再入水，不要压实。";
    }

    var ctrl = water
      ? '<div class="calc-row"><span class="calc-lab">水量</span>' +
        '<button class="step" data-w="-10">−</button>' +
        '<span class="calc-val"><b>' + ml + '</b><i>ml</i></span>' +
        '<button class="step" data-w="10">+</button></div>' +
        '<input type="range" class="slider" id="wRange" min="20" max="300" step="10" value="' + ml + '">'
      : '<div class="calc-row"><span class="calc-lab">奶粉</span>' +
        '<button class="step" data-s="-0.5">−</button>' +
        '<span class="calc-val"><b>' + nf(sc) + '</b><i>平勺</i></span>' +
        '<button class="step" data-s="0.5">+</button></div>';

    return '<div class="card calc">' +
      '<div class="calc-head"><div>' +
        '<div class="calc-title">冲调计算器</div>' +
        '<div class="calc-ratio">当前比例：1 平勺 = <b>' + nf(scoopG()) +
          ' g</b>　兑 <b>' + scoopMl() + ' ml</b> 水</div>' +
      '</div><button class="calc-edit" id="calcEdit">改比例</button></div>' +

      '<div class="seg">' +
        '<button class="seg-btn' + (water ? " is-on" : "") + '" data-mode="water">按水量算奶粉</button>' +
        '<button class="seg-btn' + (!water ? " is-on" : "") + '" data-mode="powder">按奶粉算水量</button>' +
      "</div>" +
      ctrl +
      '<div class="calc-out">' + out + "</div>" +
      '<div class="calc-hint">' + esc(hint) + "</div>" +
      '<div class="calc-warn">比例请以<b>罐身冲调说明为准</b>——不同品牌差异很大，' +
        "过浓会加重宝宝肾脏负担，过稀会营养不足，都不要自行调整。</div>" +
      "</div>";
  }

  function bindCalc() {
    var w = $("calcWrap");
    if (!w) return;
    w.querySelectorAll(".seg-btn").forEach(function (b) {
      b.onclick = function () {
        S.calcMode = b.getAttribute("data-mode"); save(); updateCalc();
      };
    });
    w.querySelectorAll("[data-w]").forEach(function (b) {
      b.onclick = function () {
        S.calcWater = Math.max(20, Math.min(300, (S.calcWater || 120) + parseInt(b.getAttribute("data-w"), 10)));
        save(); updateCalc();
      };
    });
    w.querySelectorAll("[data-s]").forEach(function (b) {
      b.onclick = function () {
        S.calcScoop = Math.max(0.5, Math.min(10, (S.calcScoop || 2) + parseFloat(b.getAttribute("data-s"))));
        save(); updateCalc();
      };
    });
    var rg = $("wRange");
    if (rg) {
      rg.oninput = function () { S.calcWater = parseInt(rg.value, 10); save(); updateCalc(); };
    }
    var ed = $("calcEdit");
    if (ed) ed.onclick = editRatio;
  }
  function updateCalc() {
    var w = $("calcWrap");
    if (!w) return;
    w.innerHTML = calcHTML();
    bindCalc();
  }
  function editRatio() {
    showModal({
      tone: "", ico: "⚖",
      title: "按罐身说明填比例",
      body: "在奶粉罐的冲调表里找到「1 平勺兑多少毫升水」。",
      fields: [
        { id: "ml", label: "1 平勺兑水量（ml）", type: "number", value: scoopMl() },
        { id: "g", label: "1 平勺奶粉重量（g，可留空）", type: "number", value: scoopG() }
      ],
      acts: [
        { label: "保存", onClick: function () {
            var ml = parseFloat(fieldValue("ml")), g = parseFloat(fieldValue("g"));
            if (!ml || ml < 10 || ml > 200) { toast("兑水量不合理", "请填 10–200 之间的数字。"); return; }
            S.scoopMl = ml;
            if (g && g > 0 && g < 50) S.scoopG = g;
            save(); hideModal(); updateCalc();
            toast("比例已更新", "1 平勺 = " + nf(scoopG()) + " g 兑 " + ml + " ml 水。");
          } },
        { label: "恢复默认", style: "ghost", onClick: function () {
            S.scoopMl = 60; S.scoopG = 8.8; save(); hideModal(); updateCalc();
            toast("已恢复默认比例", "1 平勺 8.8g 兑 60ml 水。");
          } }
      ]
    });
  }

  /* ---------------- 冲好的奶：1 小时计时 ---------------- */
  function milkLeft() {
    if (!S.milkAt) return null;
    return 60 * 60000 - (Date.now() - S.milkAt);
  }
  function milkHTML() {
    var left = milkLeft();
    if (left === null) {
      return '<button class="btn line" id="milkStart">🍼 刚冲好一瓶 · 开始 1 小时计时</button>' +
        '<div class="alert dim">冲好的奶液建议 1 小时内喝完，喝剩的请丢弃，不要留到下顿。</div>';
    }
    if (left <= 0) {
      return '<div class="milk warn"><div class="t">已超时</div>' +
        '<div class="l">冲好已超过 1 小时，请勿再喂</div></div>' +
        '<button class="btn ghost" id="milkDone">已倒掉 / 喂完了</button>';
    }
    var m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
    var pct = Math.max(0, Math.min(1, left / (60 * 60000)));
    return '<div class="milk" id="milkBox"><div class="t" id="milkTime">' +
      m + ":" + pad(sec) + '</div><div class="l">冲好的奶还能放这么久</div>' +
      '<div class="milk-bar"><i style="width:' + (pct * 100).toFixed(1) + '%"></i></div></div>' +
      '<button class="btn ghost" id="milkDone">已喝完 / 倒掉，结束计时</button>';
  }
  function tickMilk() {
    var t = $("milkTime");
    if (!t) return;
    var left = milkLeft();
    if (left === null) return;
    if (left <= 0) { render(); return; }
    var m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
    t.textContent = m + ":" + pad(sec);
  }

  /* ---------------- 冲调页 ---------------- */
  function vRecipe() {
    var live = liveCans();
    var steps = [
      "洗净双手，奶瓶、奶嘴、量勺先用沸水消毒 5 分钟，取出沥干。",
      "饮用水煮沸后放凉到 <b>40–50 ℃</b>（滴在手腕内侧感觉温热不烫）。",
      "<b>先加水</b>，按计算器算出的水量倒进奶瓶，视线与刻度平齐。",
      "再按算出勺数加奶粉，量勺要<b>刮平</b>，不要压实、不要堆尖。",
      "盖紧瓶盖，<b>水平搓滚</b>摇匀（不要上下猛摇，会起泡胀气）。",
      "滴几滴在手腕内侧试温，合适后尽快喂哺；1 小时内喝完。"
    ];
    var myths = [
      ["冲浓一点更有营养", "浓度过高会加重宝宝肾脏负担，可能引起便秘、脱水。严格按罐身比例。"],
      ["剩奶留着下顿喝", "奶液是细菌温床。冲好的奶 1 小时内喝完，喝剩的直接丢弃。"],
      ["用矿泉水 / 纯净水冲", "用煮沸后放凉的自来水即可。矿泉水矿物质偏高，长期冲调不适宜。"],
      ["开水直接冲调", "高温会破坏益生菌与部分维生素。40–50℃ 足够溶解且不伤营养。"],
      ["先加奶粉再加水", "粉先入瓶会结块、比例也不准。一定先加水后加粉。"],
      ["用力上下摇匀", "会打进大量空气，宝宝容易吐奶、胀气。应水平搓滚。"],
      ["奶粉放冰箱保存", "受潮结块反而更糟。开罐后阴凉干燥处密封，28 天内用完。"]
    ];
    var feeds = [
      ["0–1 月", "60–90 ml", "7–8 次"],
      ["1–2 月", "90–120 ml", "6–7 次"],
      ["2–4 月", "120–180 ml", "5–6 次"],
      ["4–6 月", "180–210 ml", "4–5 次"],
      ["6 月以上", "210–240 ml", "3–4 次 · 加辅食"]
    ];
    var quick = [30, 60, 90, 120, 150, 180, 210, 240];

    var left = '<div id="calcWrap">' + calcHTML() + "</div>" +
      '<div class="card">' +
        '<div class="sect" style="margin-top:0">常用水量速查</div>' +
        '<div class="qtable">' +
          quick.map(function (ml) {
            var r = fromWater(ml);
            return '<button class="qcell" data-quick="' + ml + '"><b>' + ml + '</b>' +
              "<span>ml</span><span class=\"qsub\">" + nf(r.grams) + "g · " +
              nf(r.scoops) + "勺</span></button>";
          }).join("") +
        "</div>" +
        '<div class="alert dim">点任意一格可直接填进上面的计算器。</div>' +
      "</div>" +
      '<div class="card">' +
        '<div class="sect" style="margin-top:0">刚冲好的奶</div>' +
        '<div id="milkWrap">' + milkHTML() + "</div>" +
      "</div>";

    var right =
      '<div class="card"><div class="sect" style="margin-top:0">冲调六步</div>' +
        '<ol class="steps">' + steps.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ol>" +
        '<div class="link" id="inVoice"><span>▶ 语音播报冲调步骤</span><span class="arw">›</span></div>' +
      "</div>" +
      '<div class="card"><div class="sect" style="margin-top:0">按月龄喂哺量参考</div>' +
        '<div class="feedtab">' +
          '<div class="fh"><span>月龄</span><span>每次</span><span>每天次数</span></div>' +
          feeds.map(function (f) {
            return '<div class="fr"><span>' + f[0] + "</span><span>" + f[1] + "</span><span>" +
              f[2] + "</span></div>";
          }).join("") +
        "</div>" +
        '<div class="alert dim">只是常见参考值，宝宝个体差异很大 —— 以实际需求、「饿了就喂」和医生建议为准。</div>' +
      "</div>" +
      '<div class="card"><div class="sect" style="margin-top:0">新手常见误区</div>' +
        myths.map(function (m) {
          return '<div class="myth"><span class="x">✗</span><div><b>' + m[0] + "</b><br>" + m[1] + "</div></div>";
        }).join("") +
      "</div>" +
      '<div class="card"><div class="sect" style="margin-top:0">消毒与储存</div>' +
        '<div class="kv"><span class="k">奶瓶奶嘴</span><span class="v">沸水 5 分钟 / 蒸汽消毒</span></div>' +
        '<div class="kv"><span class="k">量勺</span><span class="v">干燥保存，勿水洗后直接入罐</span></div>' +
        '<div class="kv"><span class="k">奶粉开罐后</span><span class="v">阴凉干燥处 · ' + SHELF + " 天内用完</span></div>" +
        '<div class="kv"><span class="k">冲好的奶</span><span class="v">1 小时内喝完</span></div>' +
        '<div class="alert dim">' + esc(S.seg) + " 当前在用 " + live.length + " 罐；" +
          "开罐满 " + SHELF + " 天会自动归档，界面标注「已过期」。</div>" +
      "</div>";

    return '<div class="grid2"><div class="col">' + left + "</div>" +
           '<div class="col">' + right + "</div></div>";
  }

  function vFamily() {
    return '<div class="grid2"><div class="col">' +
      '<div class="tincan"><div class="l1">这些罐的家人</div>' +
      '<div class="l2">任一成员碰触后，其余家人页面同步可见</div></div>' +
      '<div class="fam"><div class="av">妈</div><div><div class="n">妈妈</div>' +
      '<div class="r">开罐记录人 · 主体账号</div></div></div>' +
      '<div class="fam"><div class="av t">奶</div><div><div class="n">奶奶</div>' +
      '<div class="r">已加入 · 可查看剩余天数与冲调指南</div></div></div>' +
      '<div class="fam"><div class="av a">爸</div><div><div class="n">爸爸</div>' +
      '<div class="r">待加入 · 已发送邀请</div></div></div>' +
      '<div class="link" id="inInvite"><span>生成邀请二维码</span><span class="arw">›</span></div>' +
      "</div>" +
      '<div class="col"><div class="sect">提醒通道</div>' +
      '<div class="kv"><span class="k">微信服务通知</span><span class="v">已开启</span></div>' +
      '<div class="kv"><span class="k">系统通知</span><span class="v">App 内直达</span></div>' +
      '<div class="kv"><span class="k">日历 .ics</span><span class="v">可随时导出</span></div>' +
      '<div class="kv"><span class="k">罐身转盘</span><span class="v">盖顶刻度 · 无需手机</span></div>' +
      '<div class="alert dim">每罐到期前 3 天提醒；超过 ' + SHELF +
      " 天自动归档并停止提醒。</div>" +
      "</div></div>";
  }

  /* ---------------- 使用引导 ---------------- */
  var GUIDE = [
    { art: "rings", t: "碰一碰，就知道这罐奶粉开了多久",
      d: "撕开铝膜后碰一下罐盖，自动记录开罐时间并开始 28 天倒计时。不用记日子，也不用翻罐身小字。" },
    { art: "chips", t: "把奶粉加进列表",
      d: "三种方式任选。家里有几罐就加几罐，每一罐各自独立计时。",
      chips: ["碰一碰罐盖", "扫罐身二维码", "手动输入短码"] },
    { art: "ring", t: "记录开罐，全家人同步",
      d: "撕开封口膜后，点一次「记录开罐时间」就完成。邀请家人加入后，谁开的罐、还剩几天，大家看到的都一样。" },
    { art: "calc", t: "冲调不靠猜",
      d: "输入水量自动算出要几勺几克，也能反过来按奶粉算水量；还有常用水量速查表、六步冲调法、按月龄喂哺量和新手常见误区。" },
    { art: "tl", t: "到期前提醒，过期自动归档",
      d: "第 21 天开始温和提醒，第 25 天强烈提示。超过 28 天自动归档，但仍然可以查询 —— 在「记录」里点开这一罐就能看到它的溯源，界面会标注「已过期」。" }
  ];
  var gi = 0;

  function guideArt(step) {
    if (step.art === "rings")
      return '<div class="gart-rings"><i></i><i></i><i></i><b>NFC</b></div>';
    if (step.art === "chips")
      return '<div class="gart-chips">' + step.chips.map(function (c) {
        return '<span class="gart-chip">' + esc(c) + "</span>";
      }).join("") + "</div>";
    if (step.art === "calc")
      return '<div class="gart-calc"><div class="gc-row"><span>120</span><i>ml 水</i></div>' +
        '<div class="gc-eq">＋</div><div class="gc-row hot"><span>2</span><i>平勺 · 17.6g</i></div></div>';
    if (step.art === "ring")
      return '<div class="gart-ring"><svg viewBox="0 0 120 120">' +
        '<circle cx="60" cy="60" r="48" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="10"/>' +
        '<circle cx="60" cy="60" r="48" fill="none" stroke="var(--accent)" stroke-width="10" ' +
        'stroke-linecap="round" stroke-dasharray="58 302"/></svg>' +
        "<b>28<span>天倒计时</span></b></div>";
    return '<div class="gart-tl"><u>D+0 开罐</u><em>›</em><u>D+21 提醒</u><em>›</em>' +
      '<u>D+25 强提示</u><em>›</em><u class="red">D+28 归档</u></div>';
  }

  function renderGuide() {
    var track = $("guideTrack");
    track.innerHTML = GUIDE.map(function (s, i) {
      return '<section class="guide-slide">' +
        '<div class="guide-art">' + guideArt(s) + "</div>" +
        '<div class="guide-step">' + (i + 1) + " / " + GUIDE.length + "</div>" +
        "<h2>" + esc(s.t) + "</h2><p>" + esc(s.d) + "</p></section>";
    }).join("");
    track.style.transform = "translateX(" + (-gi * 100) + "%)";
    $("guideDots").innerHTML = GUIDE.map(function (_, i) {
      return '<i class="' + (i === gi ? "on" : "") + '"></i>';
    }).join("");
    var last = gi === GUIDE.length - 1;
    $("guideActs").className = "guide-acts" + (gi === 0 ? " one" : "");
    $("guidePrev").style.display = gi === 0 ? "none" : "";
    $("guideNext").textContent = last ? "开始使用" : "下一步";
  }
  function showGuide() { gi = 0; $("guide").classList.add("show"); renderGuide(); }
  function hideGuide(done, chainTour) {
    $("guide").classList.remove("show");
    if (done) { S.onboarded = true; save(); }
    render();
    if (chainTour) setTimeout(startTour, 320);
  }
  var guideOpen = function () { return $("guide").classList.contains("show"); };

  $("guideNext").onclick = function () {
    if (gi < GUIDE.length - 1) { gi++; renderGuide(); }
    else hideGuide(true, true);          // 看完介绍 → 直接进入界面导览
  };
  $("guidePrev").onclick = function () { if (gi > 0) { gi--; renderGuide(); } };
  $("guideSkip").onclick = function () { hideGuide(true); };

  // 手势：左右滑动切换
  (function () {
    var x0 = null;
    $("guideViewport").addEventListener("touchstart", function (e) {
      x0 = e.touches[0].clientX;
    }, { passive: true });
    $("guideViewport").addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) < 40) return;
      if (dx < 0 && gi < GUIDE.length - 1) { gi++; renderGuide(); }
      else if (dx > 0 && gi > 0) { gi--; renderGuide(); }
    }, { passive: true });
  })();

  /* ---------------- 界面操作导览（聚光灯） ---------------- */
  var TOUR = [
    { sel: [".tab-btn.mid", ".rail-btn.scan-rail"], tab: null,
      t: "识别入口常驻在这里",
      d: "底部中间这个凸起的按钮就是「碰一碰」。点它可以用 NFC 读罐盖标签、调摄像头扫二维码，或者手动输入短码。" },
    { sel: [".cancard", "#homeScan"], tab: "home",
      t: "每罐一张卡，各自独立计时",
      d: "家里有几罐奶粉就显示几张卡。卡上是剩余天数和进度条；点进任意一张，能看到这一罐的开罐记录和溯源信息。" },
    { sel: ['[data-tab="recipe"]'], tab: "recipe",
      t: "「冲调」是给新手爸妈的",
      d: "双向计算器：给水量算奶粉，或给奶粉算水量；还有常用水量速查表、六步冲调法、按月龄喂哺量和常见误区。" },
    { sel: ['[data-tab="records"]'], tab: "records",
      t: "「记录」存放所有奶粉档案",
      d: "在用的和已归档的都在这里。开罐满 28 天会自动归档，列表里标注「已过期」，但仍然可以点开查看溯源。" },
    { sel: ["#btnDemo"], tab: null,
      t: "右上角「⋯」是更多",
      d: "可以重看使用引导和这个界面导览，也能打开演示工具、切换深色模式。" },
    { sel: ['[data-tab="family"]'], tab: "home",
      t: "邀请家人，共享同一份倒计时",
      d: "家人加入后，谁开的罐、还剩几天，大家看到的都一样 —— 不用再口头问「这罐开了多久」。" }
  ];
  var ti = 0;

  function visibleEl(sels) {
    for (var i = 0; i < sels.length; i++) {
      var list = document.querySelectorAll(sels[i]);
      for (var j = 0; j < list.length; j++) {
        var r = list[j].getBoundingClientRect();
        if (r.width > 2 && r.height > 2) return list[j];
      }
    }
    return null;
  }
  function positionTour() {
    var step = TOUR[ti];
    if (!step) return;
    var el = visibleEl(step.sel);
    var hole = $("tourHole"), tip = $("tourTip");
    var vw = window.innerWidth, vh = window.innerHeight;
    var tw = Math.min(340, vw - 28);
    tip.style.width = tw + "px";
    if (!el) {
      hole.style.display = "none";
      tip.style.left = ((vw - tw) / 2) + "px";
      tip.style.top = "38%";
      return;
    }
    hole.style.display = "";
    var r = el.getBoundingClientRect(), pad = 8;
    var x = Math.max(6, r.left - pad), y = Math.max(6, r.top - pad);
    var w = Math.min(vw - x - 6, r.width + pad * 2);
    var h = Math.min(vh - y - 6, r.height + pad * 2);
    hole.style.left = x + "px"; hole.style.top = y + "px";
    hole.style.width = w + "px"; hole.style.height = h + "px";

    var left = Math.min(Math.max(14, r.left + r.width / 2 - tw / 2), vw - tw - 14);
    var tipH = tip.offsetHeight || 190;
    var below = vh - (y + h);
    var top = (below > tipH + 24) ? (y + h + 14) : Math.max(14, y - tipH - 14);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  function renderTour() {
    var step = TOUR[ti];
    $("tourStep").textContent = (ti + 1) + " / " + TOUR.length;
    $("tourTitle").textContent = step.t;
    $("tourBody").textContent = step.d;
    $("tourPrev").style.visibility = ti === 0 ? "hidden" : "visible";
    $("tourNext").textContent = ti === TOUR.length - 1 ? "完成" : "下一步";
    if (step.tab && S.tab !== step.tab) go(step.tab);
    requestAnimationFrame(positionTour);
  }
  function startTour() {
    ti = 0;
    $("tour").classList.add("show");
    renderTour();
  }
  function endTour(done) {
    $("tour").classList.remove("show");
    if (done) { S.toured = true; save(); }
  }
  function tourOpen() { return $("tour").classList.contains("show"); }

  $("tourNext").onclick = function () {
    if (ti < TOUR.length - 1) { ti++; renderTour(); } else endTour(true);
  };
  $("tourPrev").onclick = function () { if (ti > 0) { ti--; renderTour(); } };
  $("tourSkip").onclick = function () { endTour(true); };
  window.addEventListener("resize", function () { if (tourOpen()) positionTour(); });

  /* ---------------- 渲染 ---------------- */
  var viewKey = "";
  function render() {
    var v = $("view");
    var key = S.tab + "|" + (detailId || "");
    var moved = key !== viewKey;
    viewKey = key;
    if (S.tab === "scan") v.innerHTML = vScan();
    else if (S.tab === "recipe") v.innerHTML = vRecipe();
    else if (S.tab === "records") v.innerHTML = vRecords();
    else if (S.tab === "family") v.innerHTML = vFamily();
    else v.innerHTML = vHome();

    var live = liveCans();
    if (!live.length) $("barHint").textContent = "暂无在用的罐";
    else {
      var min = Math.min.apply(null, live.map(function (c) { return statusOf(c).left || 0; }));
      $("barHint").textContent = live.length + " 罐在用 · 最近剩 " + min + " 天";
    }
    $("entryChip").textContent = S.entry;
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-tab") === S.tab);
    });
    if (moved) {
      v.classList.remove("view-anim");
      void v.offsetWidth;                  // 强制重排，让动画可重播
      v.classList.add("view-anim");
    }
    bind();
    $("main").scrollTop = 0;
    if (tourOpen()) requestAnimationFrame(positionTour);
  }

  function bind() {
    var b;
    document.querySelectorAll("[data-open]").forEach(function (x) {
      x.onclick = function () { openCan(x.getAttribute("data-open")); };
    });
    document.querySelectorAll("[data-open-act]").forEach(function (x) {
      x.onclick = function () { recordOpen(x.getAttribute("data-open-act")); };
    });
    document.querySelectorAll("[data-archive]").forEach(function (x) {
      x.onclick = function () { archiveCan(x.getAttribute("data-archive")); };
    });
    document.querySelectorAll("[data-delete]").forEach(function (x) {
      x.onclick = function () { deleteCan(x.getAttribute("data-delete")); };
    });

    if ((b = $("recBack"))) b.onclick = function () { detailId = null; render(); };
    if ((b = $("goRecords"))) b.onclick = function () { detailId = null; go("records"); };
    if ((b = $("homeScan"))) b.onclick = function () { go("scan"); };
    if ((b = $("inInvite"))) b.onclick = function () {
      toast("邀请已生成", "家人扫码即可加入，开罐记录与提醒对所有成员可见。");
    };
    if ((b = $("inVoice"))) b.onclick = function () {
      toast("语音播报", "「水温 40 到 50 度，先加水，再加一平勺奶粉，刮平不要压实……」");
    };
    if ((b = $("milkStart"))) b.onclick = function () {
      S.milkAt = Date.now(); save();
      var w = $("milkWrap"); if (w) w.innerHTML = milkHTML();
      bind(); toast("已开始计时", "冲好的奶 1 小时内喝完。");
    };
    if ((b = $("milkDone"))) b.onclick = function () {
      S.milkAt = null; save();
      var w = $("milkWrap"); if (w) w.innerHTML = milkHTML();
      bind(); toast("计时已结束", "下次冲调再点一下就行。");
    };
    document.querySelectorAll("[data-quick]").forEach(function (x) {
      x.onclick = function () {
        S.calcMode = "water";
        S.calcWater = parseInt(x.getAttribute("data-quick"), 10);
        save(); updateCalc();
      };
    });
    bindCalc();
    if ((b = $("inReport"))) b.onclick = function () { toast("检验报告", "该批次检验报告已加载（演示数据）。"); };

    if ((b = $("scanStart"))) b.onclick = startScan;
    if ((b = $("scanCam"))) b.onclick = openScanner;
    if ((b = $("scanCode"))) b.onclick = manualInput;
    if ((b = $("scanCancel"))) b.onclick = function () { stopScan(); render(); };
    if ((b = $("scanAgain"))) b.onclick = startScan;
    if ((b = $("scanAdd"))) b.onclick = function () { if (scan.code) addCan(scan.code); };
    if ((b = $("scanLook"))) b.onclick = function () {
      var c = scan.hit; stopScan(); if (c) openCan(c.id); else render();
    };
    if ((b = $("scanSim"))) b.onclick = function () {
      clearTimeout(scan.timer);
      scan.phase = "scanning"; scan.code = null; scan.kind = ""; render();
      scan.timer = setTimeout(function () {
        if (scan.phase !== "scanning") return;
        onCode(makeCan());
      }, 700);
    };
  }

  function go(tab) {
    if (tab !== "scan" && scan.phase === "scanning") stopScan();
    if (tab !== "records") detailId = null;
    S.tab = tab; save(); render();
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t === "dark" ? "#0A1722" : "#16324F");
    S.theme = t; save();
  }
  $("railTheme").onclick = function () {
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  };

  /* ---------------- 扫码层 / 弹窗 ---------------- */
  $("scanClose").onclick = closeScanner;
  $("scanTorch").onclick = toggleTorch;
  $("modal").onclick = function (e) { if (e.target === $("modal")) hideModal(); };

  /* ---------------- 演示工具 ---------------- */
  function closeSheet() { $("sheetWrap").classList.remove("show"); }
  $("btnDemo").onclick = function () {
    $("sheetWrap").classList.add("show");
    var w = window.innerWidth;
    var bp = w >= 1200 ? "≥1200 侧栏加宽" : w >= 840 ? "≥840 平板双栏"
      : w >= 600 ? "≥600 侧边导航栏" : "<600 手机单栏";
    $("deviceInfo").innerHTML =
      "视口 " + w + " × " + window.innerHeight + "　·　DPR " + (window.devicePixelRatio || 1) +
      "<br>断点：" + bp +
      "<br>NFC：" + (hasNativeNfc() ? "原生硬件读取" : "模拟（浏览器）") +
      "<br>扫码：" + (("BarcodeDetector" in window) ? "支持" : "不支持，可手动输入") +
      "<br>罐总数：" + S.cans.length + "　·　在用 " + liveCans().length +
      "　·　时间偏移 " + (S.dayOffset || 0) + " 天";
  };
  $("sheetScrim").onclick = closeSheet;
  $("btnGuide").onclick = function () { closeSheet(); showGuide(); };
  $("btnTour").onclick = function () { closeSheet(); startTour(); };

  document.querySelectorAll("[data-jump]").forEach(function (b) {
    b.onclick = function () {
      var k = b.getAttribute("data-jump");
      if (k === "resetday") S.dayOffset = 0;
      else if (k === "to21") S.dayOffset = (S.dayOffset || 0) + 21;
      else if (k === "to28") S.dayOffset = (S.dayOffset || 0) + SHELF;
      else S.dayOffset = (S.dayOffset || 0) + parseInt(k, 10);
      save(); sweep(); go("home"); closeSheet();
      toast("时间已推进", "当前所有在用的罐同步前进 " + (S.dayOffset || 0) + " 天（演示用）。");
    };
  });
  $("btnPush").onclick = function () {
    var live = liveCans();
    if (!live.length) { toast("没有在用的罐", "先添加一罐奶粉。"); closeSheet(); return; }
    var c = sortCans(live)[0], p = statusOf(c);
    closeSheet(); go("home");
    var body = c.uid + " 已开罐 " + days(c) + " 天，建议 " + fmt(expiryOf(c)) + " 前用完。";
    notify("一碰知鲜 · 到期提醒", body);
    toast("系统通知 · 一碰知鲜", body);
  };
  $("btnReopen").onclick = function () {
    var live = liveCans().filter(function (c) { return c.openedAt; });
    if (!live.length) { toast("没有已开罐的罐", "重复识别警告针对的是已开罐的罐。"); closeSheet(); return; }
    closeSheet(); S.tab = "scan"; detailId = null; render();
    var c = live[0];
    onCode({ uid: c.uid, raw: c.raw, batch: c.batch, made: c.made });
  };
  $("btnExpire").onclick = function () {
    if (!liveCans().length) { toast("没有在用的罐", ""); closeSheet(); return; }
    S.dayOffset = (S.dayOffset || 0) + SHELF;
    save(); closeSheet();
    var n = sweep(true);
    go("records");
    toast("已模拟过期自动归档", n ? (n + " 罐超过保质期，已自动归档，界面标注「已过期」。")
                                  : "没有罐达到过期条件。");
  };
  $("btnReset").onclick = function () {
    S.cans = [makeCan()]; S.dayOffset = 0; detailId = null;
    save(); closeSheet(); go("home"); toast("已重置", "列表回到一罐未开罐的奶粉。");
  };
  $("btnWipe").onclick = function () {
    try {
      ["touchfresh.v4", "touchfresh.v3", "touchfresh.v2", "touchfresh.v1"]
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
    closeSheet(); toast("本机数据已清除", "刷新后回到初始状态。");
  };

  /* ---------------- 导航 / 返回键 ---------------- */
  document.querySelectorAll(".tab-btn, .rail-btn[data-tab]").forEach(function (b) {
    b.onclick = function () { go(b.getAttribute("data-tab")); };
  });
  window.tfBack = function () {
    if (tourOpen()) { endTour(true); return true; }
    if (guideOpen()) { hideGuide(true); return true; }
    if (scannerOpen()) { closeScanner(); return true; }
    if (modalOpen()) { hideModal(); return true; }
    if (S.tab === "records" && detailId) { detailId = null; render(); return true; }
    if ($("sheetWrap").classList.contains("show")) { closeSheet(); return true; }
    if (scan.phase !== "idle") { stopScan(); render(); return true; }
    if (S.tab !== "home") { go("home"); return true; }
    return false;
  };

  /* ---------------- 深链 ---------------- */
  function applyDeepLink() {
    var h = (location.hash || "").replace(/^#/, "");
    if (!h) return null;
    var q = {};
    h.split("&").forEach(function (kv) {
      var p = kv.split("=");
      if (p[0]) q[p[0]] = p[1] === undefined ? "1" : p[1];
    });
    if (q.can) {
      var c = normalizeCode(q.can);
      if (c) {
        if (q.batch) c.batch = q.batch;
        if (q.made) c.made = q.made;
        var hit = findCan(c.raw, c.uid);
        if (!hit) {
          hit = { id: newId(), uid: c.uid, raw: c.raw, batch: c.batch || "", made: c.made || "",
                  openedAt: null, archived: false, archivedAt: null, reason: null, queries: 0 };
          ensureMeta(hit);
          S.cans.unshift(hit);
        }
        if (q.d !== undefined) {
          var n = Math.max(0, parseInt(q.d, 10) || 0);
          hit.openedAt = Date.now() - n * DAY;
          hit.archived = false; hit.reason = null; hit.archivedAt = null;
        }
        S.entry = "二维码"; detailId = hit.id; save();
      }
    } else if (q.d !== undefined) {
      var n2 = Math.max(0, parseInt(q.d, 10) || 0);
      if (S.cans[0]) {
        S.cans[0].openedAt = Date.now() - n2 * DAY;
        S.cans[0].archived = false; S.cans[0].reason = null; S.cans[0].archivedAt = null;
      }
      S.entry = "二维码"; save();
    }
    if (q.tab) S.tab = q.tab;
    if (q.tour !== undefined) {
      // 演示：直接打开界面导览的第 N 步
      var n3 = Math.max(0, Math.min(parseInt(q.tour, 10) || 0, TOUR.length - 1));
      setTimeout(function () { startTour(); ti = n3; renderTour(); }, 520);
    }
    return q;
  }

  /* ---------------- 启动 ---------------- */
  (function boot() {
    var deep = applyDeepLink();
    var t = (deep && deep.theme) || S.theme;
    if (!t) t = (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    applyTheme(t);
    if (deep && deep.tab) S.tab = deep.tab;
    if (S.tab === "records" && detailId) { /* 深链直接进详情 */ }
    sweep(true);
    render();

    setInterval(tickMilk, 1000);
    setTimeout(function () {
      $("splash").classList.add("hide");
      document.documentElement.classList.add("ready");
      if (!S.onboarded) setTimeout(showGuide, 280);
    }, 420);
    setInterval(function () { sweep(); if (S.tab === "home" || S.tab === "records") render(); }, 60000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { sweep(); render(); }
    });
    if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  })();
})();
