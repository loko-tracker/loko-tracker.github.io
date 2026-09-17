/* ===========================================================================
   Трекер сезона КХЛ — логика страницы.

   Данные приходят одним файлом /data.json, который готовит build.py.
   Здесь: отображение, фильтры, графики, анимации и правка лазарета.

   Стек: GSAP + ScrollTrigger (движение), ECharts (графики),
   Lenis (инерционный скролл), Alpine (состояние фильтров и формы).
   Все библиотеки лежат локально в web/vendor — сайт работает без сети.
   =========================================================================== */

(function () {
  "use strict";

  var APP = { data: null, alpine: null, charts: {} };
  var $ = function (id) { return document.getElementById(id); };

  var HAS_GSAP = typeof window.gsap !== "undefined";
  var HAS_ECHARTS = typeof window.echarts !== "undefined";
  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============================== утилиты ============================== */

  // Всё, что попадает в разметку, проходит через esc: имена игроков и
  // особенно заголовки новостей — внешний текст, доверять ему нельзя.
  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function safeUrl(url) {
    var text = String(url || "");
    return /^https?:\/\//i.test(text) ? text : "";
  }

  var MONTHS = ["января","февраля","марта","апреля","мая","июня",
                "июля","августа","сентября","октября","ноября","декабря"];
  var MONTHS_NOM = ["Январь","Февраль","Март","Апрель","Май","Июнь",
                    "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  var WEEKDAYS = ["вс","пн","вт","ср","чт","пт","сб"];

  function parseDate(iso) {
    if (!iso) return null;
    var date = new Date(iso);
    return isNaN(date.getTime()) ? null : date;
  }
  function fmtDay(iso) {
    var d = parseDate(iso);
    return d ? d.getDate() + " " + MONTHS_SHORT[d.getMonth()] : "—";
  }
  function fmtDayFull(iso) {
    var d = parseDate(iso);
    return d ? d.getDate() + " " + MONTHS[d.getMonth()] : "—";
  }
  function fmtTime(iso) {
    var d = parseDate(iso);
    return d ? String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") : "";
  }
  function fmtWeekday(iso) {
    var d = parseDate(iso);
    return d ? WEEKDAYS[d.getDay()] : "";
  }
  function pct(value) {
    var n = Number(value) || 0;
    if (n >= 99.95) return "100";
    if (n > 0 && n < 0.1) return "<0,1";
    return n.toFixed(1).replace(".", ",");
  }
  function dec(value, places) {
    return (Number(value) || 0).toFixed(places === undefined ? 1 : places).replace(".", ",");
  }
  function signed(value) {
    var n = Number(value) || 0;
    return (n > 0 ? "+" : "") + n;
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  var RAMP = [];
  function ramp() {
    if (!RAMP.length) RAMP = ["--p1","--p2","--p3","--p4","--p5"].map(cssVar);
    return RAMP;
  }
  // Пять шагов одного тона: светлее = больше шансов.
  function oddsColor(percent) {
    var steps = ramp(), n = Number(percent) || 0;
    if (n >= 80) return steps[4];
    if (n >= 55) return steps[3];
    if (n >= 30) return steps[2];
    if (n >= 12) return steps[1];
    return steps[0];
  }

  function crest(teamId, size) {
    if (!teamId) return "";
    return '<img class="' + (size === "big" ? "crest" : "crest-sm") +
      '" src="/logos/' + encodeURIComponent(teamId) + '.png" alt="" loading="lazy">';
  }

  /* ============================== подсказка ============================== */

  var tip = $("tip"), tipOn = false;

  function showTip(html, event) {
    tip.innerHTML = html;
    tip.classList.add("on");
    tip.setAttribute("aria-hidden", "false");
    tipOn = true;
    moveTip(event);
  }
  function moveTip(event) {
    if (!tipOn) return;
    var box = tip.getBoundingClientRect(), pad = 14;
    var x = event.clientX + pad, y = event.clientY + pad;
    if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() {
    tip.classList.remove("on");
    tip.setAttribute("aria-hidden", "true");
    tipOn = false;
  }
  document.addEventListener("scroll", hideTip, { passive: true });

  function attachTips(root) {
    root.querySelectorAll("[data-tip]").forEach(function (node) {
      node.addEventListener("mouseenter", function (e) { showTip(node.getAttribute("data-tip"), e); });
      node.addEventListener("mousemove", moveTip);
      node.addEventListener("mouseleave", hideTip);
    });
  }

  /* ======================= фон: блик за курсором ======================= */

  (function specular() {
    if (REDUCED) return;
    var spec = $("spec");
    if (!spec) return;
    var raf = null, x = window.innerWidth / 2, y = window.innerHeight * 0.4;
    window.addEventListener("pointermove", function (event) {
      x = event.clientX; y = event.clientY;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        spec.style.transform = "translate3d(" + x + "px," + y + "px,0)";
        raf = null;
      });
    }, { passive: true });
  }());

  /* ========================= инерционный скролл ========================= */

  var lenis = null;
  (function smoothScroll() {
    if (REDUCED || typeof window.Lenis === "undefined") return;
    lenis = new window.Lenis({ duration: 0.9, smoothWheel: true });
    if (HAS_GSAP && window.ScrollTrigger) {
      lenis.on("scroll", window.ScrollTrigger.update);
      window.gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
      window.gsap.ticker.lagSmoothing(0);
    } else {
      var loop = function (time) { lenis.raf(time); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
  }());

  /* ============================== раскрытие ============================== */

  if (HAS_GSAP && window.ScrollTrigger) window.gsap.registerPlugin(window.ScrollTrigger);

  /* Анимировать имеет смысл только когда браузер выдаёт кадры. На скрытой
     или фоновой вкладке requestAnimationFrame не вызывается вовсе, твины
     GSAP просто стоят — а страницу в фоновой вкладке как раз и открывает
     refresh.bat. Поэтому: покой = готовое состояние, анимация поверх. */
  function canAnimate() {
    return HAS_GSAP && !REDUCED && !document.hidden;
  }

  if (canAnimate()) {
    // anim-on включает плавные переходы, reveal-armed прячет блоки
    // до появления. Классы разные: первый остаётся, второй снимается.
    document.body.classList.add("anim-on", "reveal-armed");
  }

  // Если вкладка была скрыта при загрузке, а потом её открыли — снимаем
  // подготовку, чтобы блоки не остались спрятанными навсегда.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) unarmReveals();
  });

  function unarmReveals() {
    document.body.classList.remove("reveal-armed");
    document.querySelectorAll("[data-reveal]").forEach(function (node) {
      node.style.opacity = "";
      node.style.transform = "";
    });
  }

  function revealIn(container) {
    if (!canAnimate()) { unarmReveals(); return; }
    var items = container.querySelectorAll("[data-reveal]");
    if (!items.length) return;
    window.gsap.to(items, {
      opacity: 1, y: 0, duration: 0.7, ease: "power2.out", stagger: 0.07,
      scrollTrigger: { trigger: container, start: "top 92%", once: true }
    });
  }

  // Страховка: что бы ни случилось с анимацией, через 2.5 с всё видно.
  setTimeout(function () {
    document.querySelectorAll("[data-reveal]").forEach(function (node) {
      if (Number(getComputedStyle(node).opacity) < 0.05) {
        node.style.opacity = 1;
        node.style.transform = "none";
      }
    });
  }, 2500);

  // Итоговое значение ставится сразу, и только потом отматывается к нулю
  // и набегает обратно. Если кадров не будет, на экране уже верное число.
  function countUp(node, target, suffix) {
    var value = Number(target) || 0;
    node.textContent = value + (suffix || "");
    if (!canAnimate()) return;
    var box = { v: 0 };
    window.gsap.to(box, {
      v: value, duration: 1.1, ease: "power2.out",
      onUpdate: function () { node.textContent = Math.round(box.v) + (suffix || ""); },
      onComplete: function () { node.textContent = value + (suffix || ""); }
    });
  }

  /* ============================ шапка и рельс ============================ */

  function renderHeader() {
    var summary = APP.data.summary;
    $("freshness").textContent = APP.data.fetched_at
      ? "данные: " + fmtDay(APP.data.fetched_at) + ", " + fmtTime(APP.data.fetched_at)
      : "данные: —";

    var start = parseDate(summary.season_start), end = parseDate(summary.season_end);
    if (start && end) {
      var total = end - start, done = Math.min(Math.max(Date.now() - start, 0), total);
      var share = total ? (done / total) * 100 : 0;
      // Через таймер, а не кадр отрисовки: на фоновой вкладке кадров нет.
      setTimeout(function () { $("railFill").style.width = share.toFixed(2) + "%"; }, 30);
      $("heroProgress").textContent = "пройдено " + share.toFixed(0) + "%";
    }
  }

  function moveTabPill(view) {
    var pill = $("tabPill");
    var link = $("tabs").querySelector('a[data-view="' + view + '"]');
    if (!pill || !link) return;
    pill.style.opacity = "1";
    pill.style.width = link.offsetWidth + "px";
    pill.style.transform = "translateX(" + link.offsetLeft + "px)";
  }

  /* =============================== обратный отсчёт =============================== */

  var countdownTimer = null;

  function startCountdown() {
    var upcoming = (APP.data.games || []).filter(function (g) { return g.state !== "finished"; });
    var next = upcoming[0];
    if (!next) {
      $("cdGame").textContent = "Матчей впереди нет.";
      return;
    }
    $("cdGame").innerHTML = crest(next.home_id) + esc(next.home) +
      ' <span style="color:var(--muted)">—</span> ' + esc(next.away) +
      ' <span style="color:var(--muted)">· ' + esc(fmtDayFull(next.start_at)) +
      ", " + esc(fmtTime(next.start_at)) + "</span>";

    var target = parseDate(next.start_at);
    if (!target) return;

    function tick() {
      var left = Math.max(0, target - Date.now());
      var s = Math.floor(left / 1000);
      var parts = [Math.floor(s / 86400), Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60), s % 60];
      ["cdD","cdH","cdM","cdS"].forEach(function (id, index) {
        var node = $(id);
        var value = index ? String(parts[index]).padStart(2, "0") : String(parts[index]);
        if (node.textContent !== value) node.textContent = value;
      });
      if (left === 0 && countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    }
    tick();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tick, 1000);
  }

  /* ================================= обзор ================================= */

  function renderOverview() {
    var summary = APP.data.summary, odds = APP.data.odds;
    var leader = (APP.data.leaders.pts || [])[0];
    var favourite = (odds.teams || []).slice().sort(function (a, b) {
      return b.continental_pct - a.continental_pct;
    })[0];

    if (leader) {
      $("heroLeader").innerHTML =
        crest(leader.team_id, "big") +
        '<div class="who"><span class="k">Лучший бомбардир</span>' +
        '<span class="n">' + esc(leader.name) + '</span>' +
        '<span class="t">' + esc(leader.team) + " · " + leader.g + " + " + leader.a + '</span></div>' +
        '<div class="v" id="heroLeaderPts">0</div>';
      countUp($("heroLeaderPts"), leader.pts);
    }

    var tiles = [
      { k: "Матчей сыграно", v: summary.games_played, num: true, sub: "из " + summary.games_total },
      { k: "Впереди",        v: summary.games_left,   num: true, sub: "матчей до плей-офф" },
      { k: "Фаворит регулярки", v: favourite ? pct(favourite.continental_pct) + "%" : "—",
        sub: favourite ? favourite.name : "—" },
      { k: "Игроков в базе", v: summary.players, num: true, sub: "с личной статистикой" },
      { k: "В лазарете",     v: (APP.data.injuries || []).length, num: true, sub: "отметок всего" }
    ];
    $("statRow").innerHTML = tiles.map(function (t, i) {
      return '<div class="stat"><div class="k">' + esc(t.k) + '</div>' +
             '<div class="v" id="tile' + i + '">' + (t.num ? "0" : esc(t.v)) + '</div>' +
             '<div class="sub">' + esc(t.sub) + '</div></div>';
    }).join("");
    tiles.forEach(function (t, i) { if (t.num) countUp($("tile" + i), Number(t.v) || 0); });

    $("oddsNote").textContent =
      "Доля из " + odds.sims.toLocaleString("ru-RU") + " симуляций остатка сезона (" +
      odds.games_remaining + " матчей). Раннему сезону верить нельзя: рейтинги стянуты к среднему.";

    var upcoming = (APP.data.games || []).filter(function (g) { return g.state !== "finished"; }).slice(0, 8);
    $("nextGames").innerHTML = upcoming.length ? upcoming.map(gameRow).join("")
      : '<p class="empty">Матчей впереди нет.</p>';

    var played = (APP.data.games || []).filter(function (g) { return g.state === "finished"; });
    var recent = played.slice(-8).reverse();
    $("lastGames").innerHTML = recent.length ? recent.map(gameRow).join("")
      : '<p class="empty">Сыгранных матчей пока нет.</p>';

    renderOddsBars("oddsWest", "west");
    renderOddsBars("oddsEast", "east");

    var packs = [
      { title: "Очки", rows: APP.data.leaders.pts },
      { title: "Голы", rows: APP.data.leaders.g },
      { title: "Передачи", rows: APP.data.leaders.a }
    ];
    $("miniLeaders").innerHTML = packs.map(function (pack) {
      var rows = (pack.rows || []).slice(0, 7).map(function (p, i) {
        return "<tr><td class='dim'>" + (i + 1) + "</td>" +
               "<td class='l'>" + crest(p.team_id) + esc(p.name) + "</td>" +
               "<td class='dim'>" + esc(p.team) + "</td>" +
               "<td class='strong'>" + esc(p.value) + "</td></tr>";
      }).join("");
      return '<div class="panel" data-reveal><h3 class="panel-head">' + esc(pack.title) + '</h3>' +
             '<div class="table-scroll"><table class="grid"><tbody>' + rows + '</tbody></table></div></div>';
    }).join("");

    startCountdown();
    heroIntro();
    chartProjection();
    revealIn($("view-overview"));
  }

  function heroIntro() {
    // from() прячет элементы на старте, поэтому без кадров герой остался бы
    // невидимым. Нет анимации — нет и вступления, блок и так на месте.
    if (!canAnimate()) return;
    var timeline = window.gsap.timeline();
    timeline.from(".hero .eyebrow", { opacity: 0, y: 10, duration: 0.5, ease: "power2.out" })
      .from(".hero-title", { opacity: 0, y: 26, duration: 0.8, ease: "power3.out" }, "-=0.25")
      .from(".countdown", { opacity: 0, y: 16, duration: 0.6, ease: "power2.out" }, "-=0.45")
      .from(".hero-side", { opacity: 0, x: 24, duration: 0.7, ease: "power3.out" }, "-=0.55")
      .from(".stat", { opacity: 0, y: 18, duration: 0.55, ease: "power2.out", stagger: 0.06 }, "-=0.35");
  }

  function gameRow(game) {
    var finished = game.state === "finished";
    var periods = game.periods || {};
    var parts = ["p1","p2","p3"].map(function (k) { return periods[k]; }).filter(Boolean);
    if (periods.ot) parts.push("ОТ " + periods.ot);
    if (periods.so) parts.push("Б " + periods.so);

    return '<div class="game">' +
      '<div class="when">' + esc(fmtDay(game.start_at)) + '<br>' + esc(fmtTime(game.start_at)) + '</div>' +
      '<div class="who">' + crest(game.home_id) + esc(game.home) +
        ' <span class="vs">—</span> ' + crest(game.away_id) + esc(game.away) + '</div>' +
      (finished ? '<div class="sc">' + esc(game.score || "") + '</div>'
                : '<div class="sc pending">' + esc(fmtWeekday(game.start_at)) + '</div>') +
      (finished && parts.length ? '<div class="per">' + esc(parts.join(" · ")) + '</div>' : '') +
      '</div>';
  }

  function renderOddsBars(hostId, confKey) {
    var rows = (APP.data.odds.teams || []).filter(function (r) { return r.conference_key === confKey; });
    rows.sort(function (a, b) { return b.playoff_pct - a.playoff_pct; });

    $(hostId).innerHTML = rows.map(function (r) {
      var tipText = "<b>" + esc(r.name) + "</b><span class='num'>плей-офф " + pct(r.playoff_pct) +
        "%<br>1-е в конференции " + pct(r.conf_first_pct) +
        "%<br>прогноз очков " + dec(r.proj_pts) + " (вероятно " + r.proj_pts_low + "–" + r.proj_pts_high + ")</span>";
      return '<div class="obar" data-tip="' + esc(tipText) + '" data-pct="' + r.playoff_pct + '">' +
        '<div class="nm">' + crest(r.team_id) + esc(r.name) + '</div>' +
        '<div class="track"><div class="fill" style="background:' + oddsColor(r.playoff_pct) + '"></div></div>' +
        '<div class="val"><b>' + pct(r.playoff_pct) + '%</b></div>' +
      '</div>';
    }).join("");

    // Полосы наливаются после вставки: анимируется свойство --fill.
    // Через setTimeout, а не requestAnimationFrame: на скрытой вкладке
    // кадров нет, и полосы остались бы пустыми навсегда.
    setTimeout(function () {
      $(hostId).querySelectorAll(".obar").forEach(function (bar) {
        var share = Math.max(0.8, Number(bar.getAttribute("data-pct")) || 0);
        bar.querySelector(".fill").style.setProperty("--fill", share.toFixed(1) + "%");
      });
    }, 30);
    attachTips($(hostId));
  }

  /* =============================== графики =============================== */

  function chartBase() {
    return {
      backgroundColor: "transparent",
      textStyle: { fontFamily: '"IBM Plex Sans", system-ui, sans-serif', color: cssVar("--ink-2") },
      grid: { left: 8, right: 22, top: 26, bottom: 8, containLabel: true },
      tooltip: {
        backgroundColor: "#0b111a",
        borderColor: cssVar("--rule-strong"),
        borderWidth: 1,
        textStyle: { color: cssVar("--ink"), fontSize: 12.5 },
        extraCssText: "border-radius:9px;box-shadow:0 16px 40px -14px rgba(0,0,0,.95);"
      }
    };
  }

  function axisStyle() {
    return {
      axisLine: { lineStyle: { color: cssVar("--rule-strong") } },
      axisTick: { show: false },
      axisLabel: { color: cssVar("--muted"), fontSize: 11 },
      splitLine: { lineStyle: { color: cssVar("--rule"), type: "dashed" } }
    };
  }

  function makeChart(id, option) {
    if (!HAS_ECHARTS) return null;
    var host = $(id);
    if (!host) return null;
    var chart = APP.charts[id] || window.echarts.init(host, null, { renderer: "canvas" });
    APP.charts[id] = chart;
    chart.setOption(option, true);
    chart.resize();
    return chart;
  }

  // Прогноз очков: точка — набрано сейчас, полоса — вероятный интервал,
  // засечка — средний прогноз. Одна шкала (очки) на все три серии.
  function chartProjection() {
    if (!HAS_ECHARTS) return;
    var rows = (APP.data.odds.teams || []).slice().sort(function (a, b) {
      return a.proj_pts - b.proj_pts;
    });
    var names = rows.map(function (r) { return r.name; });
    var base = chartBase();

    makeChart("chartProjection", {
      backgroundColor: base.backgroundColor,
      textStyle: base.textStyle,
      tooltip: Object.assign({}, base.tooltip, {
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(79,216,255,.06)" } },
        formatter: function (items) {
          var row = rows[items[0].dataIndex];
          return "<b style='font-family:Oswald,sans-serif;font-size:14px'>" + esc(row.name) + "</b><br>" +
            "<span style='font-family:var(--mono)'>сейчас " + row.pts + " очк. за " + row.gp + " матч.<br>" +
            "прогноз " + dec(row.proj_pts) + " (8 из 10 прогонов: " + row.proj_pts_low + "–" + row.proj_pts_high + ")<br>" +
            "плей-офф " + pct(row.playoff_pct) + "%</span>";
        }
      }),
      legend: {
        top: 0, right: 0,
        textStyle: { color: cssVar("--muted"), fontSize: 11 },
        itemWidth: 12, itemHeight: 8,
        data: ["Вероятный интервал", "Средний прогноз", "Сейчас"]
      },
      grid: { left: 8, right: 30, top: 34, bottom: 6, containLabel: true },
      xAxis: Object.assign({ type: "value", name: "очки", nameTextStyle: { color: cssVar("--muted"), fontSize: 10 } }, axisStyle()),
      yAxis: Object.assign({ type: "category", data: names }, axisStyle(), {
        axisLabel: { color: cssVar("--ink-2"), fontSize: 11.5, fontFamily: "Oswald, sans-serif" },
        splitLine: { show: false }
      }),
      series: [
        {
          name: "Вероятный интервал",
          type: "custom",
          renderItem: function (params, api) {
            var index = api.value(0);
            var left = api.coord([api.value(1), index]);
            var right = api.coord([api.value(2), index]);
            var height = Math.max(6, api.size([0, 1])[1] * 0.46);
            return {
              type: "rect",
              shape: { x: left[0], y: left[1] - height / 2, width: Math.max(2, right[0] - left[0]), height: height },
              style: { fill: cssVar("--p2"), opacity: 0.55 }
            };
          },
          encode: { x: [1, 2], y: 0 },
          data: rows.map(function (r, i) { return [i, r.proj_pts_low, r.proj_pts_high]; }),
          z: 1
        },
        {
          name: "Средний прогноз",
          type: "scatter",
          symbol: "rect",
          symbolSize: [3, 20],
          itemStyle: { color: cssVar("--p5") },
          data: rows.map(function (r, i) { return [r.proj_pts, i]; }),
          z: 3
        },
        {
          name: "Сейчас",
          type: "scatter",
          symbolSize: 9,
          itemStyle: { color: cssVar("--goal"), borderColor: cssVar("--plane"), borderWidth: 2 },
          data: rows.map(function (r, i) { return [r.pts, i]; }),
          z: 4
        }
      ],
      animationDuration: REDUCED ? 0 : 900,
      animationEasing: "cubicOut"
    });
  }

  // Атака против обороны. Обе оси в голах за матч — это облако точек,
  // а не совмещение двух разных шкал. Цвет кодирует шанс на плей-офф.
  function chartScatter() {
    if (!HAS_ECHARTS) return;
    var rows = APP.data.odds.teams || [];
    var base = chartBase();

    makeChart("chartScatter", {
      backgroundColor: base.backgroundColor,
      textStyle: base.textStyle,
      tooltip: Object.assign({}, base.tooltip, {
        formatter: function (item) {
          var row = rows[item.dataIndex];
          return "<b style='font-family:Oswald,sans-serif;font-size:14px'>" + esc(row.name) + "</b>" +
            "<span style='font-family:var(--mono)'>атака " + dec(row.attack, 2) +
            " · оборона " + dec(row.defence, 2) + "<br>плей-офф " + pct(row.playoff_pct) + "%</span>";
        }
      }),
      grid: { left: 8, right: 26, top: 26, bottom: 6, containLabel: true },
      xAxis: Object.assign({
        type: "value", name: "атака, голов за матч", nameLocation: "middle", nameGap: 28,
        nameTextStyle: { color: cssVar("--muted"), fontSize: 10 }, scale: true
      }, axisStyle()),
      yAxis: Object.assign({
        type: "value", name: "оборона, пропущено за матч", nameLocation: "middle", nameGap: 38,
        nameTextStyle: { color: cssVar("--muted"), fontSize: 10 }, scale: true, inverse: true
      }, axisStyle()),
      series: [{
        type: "scatter",
        symbolSize: function (value) { return 10 + (value[2] / 100) * 22; },
        itemStyle: {
          color: function (params) { return oddsColor(params.value[2]); },
          borderColor: "rgba(5,8,16,.8)", borderWidth: 1.5
        },
        label: {
          show: true, position: "right", distance: 7,
          color: cssVar("--ink-2"), fontSize: 10.5, fontFamily: "Oswald, sans-serif",
          formatter: function (params) { return params.value[3]; }
        },
        data: rows.map(function (r) { return [r.attack, r.defence, r.playoff_pct, r.name]; })
      }],
      animationDuration: REDUCED ? 0 : 900
    });
  }

  function chartOdds() {
    if (!HAS_ECHARTS) return;
    var rows = (APP.data.odds.teams || []).slice().sort(function (a, b) {
      return a.playoff_pct - b.playoff_pct;
    });
    var base = chartBase();

    makeChart("chartOdds", {
      backgroundColor: base.backgroundColor,
      textStyle: base.textStyle,
      tooltip: Object.assign({}, base.tooltip, {
        formatter: function (item) {
          var row = rows[item.dataIndex];
          return "<b style='font-family:Oswald,sans-serif;font-size:14px'>" + esc(row.name) + "</b>" +
            "<span style='font-family:var(--mono)'>плей-офф " + pct(row.playoff_pct) +
            "%<br>1-е в конференции " + pct(row.conf_first_pct) + "%</span>";
        }
      }),
      grid: { left: 8, right: 46, top: 18, bottom: 6, containLabel: true },
      xAxis: Object.assign({ type: "value", max: 100, name: "%", nameTextStyle: { color: cssVar("--muted"), fontSize: 10 } }, axisStyle()),
      yAxis: Object.assign({ type: "category", data: rows.map(function (r) { return r.name; }) }, axisStyle(), {
        axisLabel: { color: cssVar("--ink-2"), fontSize: 11, fontFamily: "Oswald, sans-serif" },
        splitLine: { show: false }
      }),
      series: [{
        type: "bar",
        barWidth: "62%",
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: function (params) { return oddsColor(params.value); }
        },
        label: {
          show: true, position: "right",
          color: cssVar("--ink-2"), fontSize: 10.5, fontFamily: '"IBM Plex Mono", monospace',
          formatter: function (params) { return pct(params.value) + "%"; }
        },
        data: rows.map(function (r) { return r.playoff_pct; })
      }],
      animationDuration: REDUCED ? 0 : 1000,
      animationEasing: "cubicOut"
    });
  }

  /* =============================== таблица =============================== */

  function renderTable() {
    ["west","east"].forEach(function (key) {
      var rows = APP.data.standings[key] || [];
      var host = $(key === "west" ? "tableWest" : "tableEast");
      var head = "<thead><tr><th class='l'>#</th><th class='l'>Клуб</th>" +
        "<th>И</th><th>В</th><th>ВО</th><th>ВБ</th><th>ПБ</th><th>ПО</th><th>П</th>" +
        "<th>Ш</th><th>О</th><th>П-О</th></tr></thead>";

      var body = rows.map(function (r) {
        return "<tr" + (r.position === 8 ? " class='cut'" : "") + ">" +
          "<td class='l dim'>" + r.position + "</td>" +
          "<td class='l'>" + crest(r.team_id) + esc(r.name) + "</td>" +
          "<td>" + r.gp + "</td><td>" + r.w + "</td><td>" + r.otw + "</td><td>" + r.sow + "</td>" +
          "<td>" + r.sol + "</td><td>" + r.otl + "</td><td>" + r.l + "</td>" +
          "<td class='dim'>" + r.gf + "–" + r.ga + "</td>" +
          "<td class='strong'>" + r.pts + "</td>" +
          "<td style='color:" + oddsColor(r.playoff_pct) + ";font-weight:600'>" + pct(r.playoff_pct) + "%</td>" +
        "</tr>";
      }).join("");

      host.innerHTML = head + "<tbody>" + body + "</tbody>";
    });
  }

  /* ================================ шансы ================================ */

  var oddsSort = { field: "playoff_pct", asc: false };

  var ODDS_COLS = [
    { field: "name",            label: "Клуб",   cls: "l", text: true, logo: true },
    { field: "conference",      label: "Конф.",  cls: "l", text: true, dim: true },
    { field: "gp",              label: "И" },
    { field: "pts",             label: "О сейчас" },
    { field: "proj_pts",        label: "Прогноз О", decimals: 1, strong: true },
    { field: "playoff_pct",     label: "Плей-офф",  percent: true },
    { field: "conf_first_pct",  label: "1-е в конф.", percent: true },
    { field: "continental_pct", label: "Кубок Континента", percent: true },
    { field: "attack",          label: "Атака",   decimals: 2, dim: true },
    { field: "defence",         label: "Оборона", decimals: 2, dim: true }
  ];

  function renderOdds() {
    var odds = APP.data.odds;
    $("oddsMethod").textContent =
      "Посчитано локально: " + odds.sims.toLocaleString("ru-RU") + " прогонов остатка календаря (" +
      odds.games_remaining + " матчей). Средняя результативность лиги — " +
      dec(odds.league_avg_goals, 2) + " гола за матч.";
    $("priorGames").textContent = odds.prior_games;
    $("remainingGames").textContent = odds.games_remaining;
    $("homeAdv").textContent = "×" + dec(odds.home_advantage, 3);
    $("simCount").textContent = odds.sims.toLocaleString("ru-RU");

    var rows = (odds.teams || []).slice();
    var field = oddsSort.field, asc = oddsSort.asc;
    rows.sort(function (a, b) {
      var x = a[field], y = b[field];
      if (typeof x === "string" || typeof y === "string") {
        var cmp = String(x || "").localeCompare(String(y || ""), "ru");
        return asc ? cmp : -cmp;
      }
      return asc ? (x - y) : (y - x);
    });

    var head = "<thead><tr>" + ODDS_COLS.map(function (c) {
      var sorted = c.field === field ? " sorted" + (asc ? " asc" : "") : "";
      return "<th class='" + (c.cls || "") + sorted + "' data-field='" + c.field + "'>" + esc(c.label) + "</th>";
    }).join("") + "</tr></thead>";

    var body = rows.map(function (r) {
      return "<tr>" + ODDS_COLS.map(function (c) {
        var value = r[c.field], style = "";
        if (c.percent) {
          if (c.field === "playoff_pct") style = " style='color:" + oddsColor(value) + ";font-weight:600'";
          value = pct(value) + "%";
        } else if (c.decimals !== undefined) {
          value = dec(value, c.decimals);
        }
        var cls = [c.cls || "", c.dim ? "dim" : "", c.strong ? "strong" : ""].join(" ").trim();
        var inner = (c.logo ? crest(r.team_id) : "") + esc(value);
        return "<td class='" + cls + "'" + style + ">" + inner + "</td>";
      }).join("") + "</tr>";
    }).join("");

    $("oddsTable").innerHTML = head + "<tbody>" + body + "</tbody>";
    $("oddsTable").querySelectorAll("th[data-field]").forEach(function (th) {
      th.addEventListener("click", function () {
        var next = th.getAttribute("data-field");
        if (oddsSort.field === next) oddsSort.asc = !oddsSort.asc;
        else { oddsSort.field = next; oddsSort.asc = false; }
        renderOdds();
      });
    });

    chartScatter();
    chartOdds();
    revealIn($("view-odds"));
  }

  /* ================================ матчи ================================ */

  function renderGames() {
    var filters = APP.alpine ? APP.alpine.games : { team: "", state: "all", month: "" };

    var list = (APP.data.games || []).filter(function (g) {
      if (filters.team && String(g.home_id) !== filters.team && String(g.away_id) !== filters.team) return false;
      if (filters.state === "finished" && g.state !== "finished") return false;
      if (filters.state === "upcoming" && g.state === "finished") return false;
      if (filters.month) {
        var d = parseDate(g.start_at);
        if (!d) return false;
        var key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        if (key !== filters.month) return false;
      }
      return true;
    });

    $("gamesCount").textContent = list.length + " матч.";

    var head = "<thead><tr><th class='l'>Дата</th><th>Время</th>" +
      "<th class='l'>Хозяева</th><th>Счёт</th><th class='l'>Гости</th>" +
      "<th class='l'>По периодам</th><th class='l'>Арена</th></tr></thead>";

    var body = list.map(function (g) {
      var periods = g.periods || {};
      var parts = ["p1","p2","p3"].map(function (k) { return periods[k]; }).filter(Boolean);
      if (periods.ot) parts.push("ОТ " + periods.ot);
      if (periods.so) parts.push("Б " + periods.so);
      var finished = g.state === "finished";
      return "<tr>" +
        "<td class='l dim'>" + esc(fmtDayFull(g.start_at)) + ", " + esc(fmtWeekday(g.start_at)) + "</td>" +
        "<td class='dim'>" + esc(fmtTime(g.start_at)) + "</td>" +
        "<td class='l'>" + crest(g.home_id) + esc(g.home) + "</td>" +
        "<td class='strong'>" + (finished ? esc(g.score || "") : "<span class='pill dim'>скоро</span>") + "</td>" +
        "<td class='l'>" + crest(g.away_id) + esc(g.away) + "</td>" +
        "<td class='l dim'>" + esc(parts.join(" · ")) + "</td>" +
        "<td class='l dim'>" + esc(g.location || "") + "</td>" +
      "</tr>";
    }).join("");

    $("gamesTable").innerHTML = head + "<tbody>" +
      (body || "<tr><td class='l dim' colspan='7'>Ничего не нашлось под эти фильтры.</td></tr>") + "</tbody>";
  }

  /* =============================== игроки =============================== */

  var playerSort = { field: "pts", asc: false };

  var PLAYER_COLS = [
    { field: "name",       label: "Игрок", cls: "l", text: true },
    { field: "team",       label: "Клуб",  cls: "l", text: true, dim: true, logo: true },
    { field: "role",       label: "Поз.", cls: "l", text: true, dim: true, short: true },
    { field: "gp",         label: "И" },
    { field: "g",          label: "Г" },
    { field: "a",          label: "П" },
    { field: "pts",        label: "О", strong: true },
    { field: "plus_minus", label: "+/−", signed: true },
    { field: "pim",        label: "Штр" },
    { field: "toi_avg",    label: "ВрЛ", decimals: 1 },
    { field: "top_speed",  label: "Скор", decimals: 1 }
  ];

  var ROLE_SHORT = { "нападающий": "нап", "защитник": "защ", "вратарь": "вр" };

  function renderPlayers() {
    var filters = APP.alpine ? APP.alpine.players : { team: "", role: "", query: "" };
    var query = String(filters.query || "").trim().toLowerCase();

    var list = (APP.data.players || []).filter(function (p) {
      if (filters.team && String(p.team_id) !== filters.team) return false;
      if (filters.role && p.role_key !== filters.role) return false;
      if (query && String(p.name || "").toLowerCase().indexOf(query) === -1) return false;
      return true;
    });

    var field = playerSort.field, asc = playerSort.asc;
    list.sort(function (a, b) {
      var x = a[field], y = b[field];
      if (typeof x === "string" || typeof y === "string") {
        var cmp = String(x || "").localeCompare(String(y || ""), "ru");
        return asc ? cmp : -cmp;
      }
      var diff = (Number(x) || 0) - (Number(y) || 0);
      if (diff === 0) diff = (Number(a.pts) || 0) - (Number(b.pts) || 0);
      return asc ? diff : -diff;
    });

    var shown = list.slice(0, 400);
    $("playersCount").textContent = list.length + " игр." +
      (list.length > 400 ? " (показаны первые 400)" : "");

    var head = "<thead><tr><th class='l'>#</th>" + PLAYER_COLS.map(function (c) {
      var sorted = c.field === field ? " sorted" + (asc ? " asc" : "") : "";
      return "<th class='" + (c.cls || "") + sorted + "' data-field='" + c.field + "'>" + esc(c.label) + "</th>";
    }).join("") + "</tr></thead>";

    var body = shown.map(function (p, index) {
      var cells = PLAYER_COLS.map(function (c) {
        var value = p[c.field];
        if (c.short) value = ROLE_SHORT[value] || value;
        if (c.signed) value = signed(value);
        else if (c.decimals !== undefined) value = dec(value, c.decimals);
        var cls = [c.cls || "", c.dim ? "dim" : "", c.strong ? "strong" : ""].join(" ").trim();
        return "<td class='" + cls + "'>" + (c.logo ? crest(p.team_id) : "") + esc(value) + "</td>";
      }).join("");
      return "<tr><td class='l dim'>" + (index + 1) + "</td>" + cells + "</tr>";
    }).join("");

    $("playersTable").innerHTML = head + "<tbody>" +
      (body || "<tr><td class='l dim' colspan='12'>Никого не нашлось.</td></tr>") + "</tbody>";

    $("playersTable").querySelectorAll("th[data-field]").forEach(function (th) {
      th.addEventListener("click", function () {
        var next = th.getAttribute("data-field");
        if (playerSort.field === next) playerSort.asc = !playerSort.asc;
        else { playerSort.field = next; playerSort.asc = false; }
        renderPlayers();
      });
    });
  }

  /* =============================== лазарет =============================== */

  function manualList() {
    return (APP.data.injuries || []).filter(function (i) { return i.source === "manual"; });
  }

  function renderInjuries() {
    var manual = manualList();
    var auto = (APP.data.injuries || []).filter(function (i) { return i.source === "auto"; });

    var manualHead = "<thead><tr><th class='l'>Игрок</th><th class='l'>Клуб</th>" +
      "<th class='l'>Статус</th><th class='l'>До</th><th class='l'>Заметка</th><th></th></tr></thead>";
    var manualBody = manual.map(function (item, index) {
      return "<tr>" +
        "<td class='l'>" + esc(item.player) + "</td>" +
        "<td class='l dim'>" + crest(item.team_id) + esc(item.team) + "</td>" +
        "<td class='l'><span class='pill hot'>" + esc(item.status || "травма") + "</span></td>" +
        "<td class='l dim'>" + esc(item.until || "—") + "</td>" +
        "<td class='l dim'>" + esc(item.note || "") + "</td>" +
        "<td><button class='link' data-remove='" + index + "'>убрать</button></td>" +
      "</tr>";
    }).join("");
    $("manualTable").innerHTML = manualHead + "<tbody>" +
      (manualBody || "<tr><td class='l dim' colspan='6'>Пока пусто — добавь первого через форму выше.</td></tr>") +
      "</tbody>";

    $("manualTable").querySelectorAll("[data-remove]").forEach(function (button) {
      button.addEventListener("click", function () {
        var next = manualList().slice();
        next.splice(Number(button.getAttribute("data-remove")), 1);
        saveManual(next);
      });
    });

    var autoHead = "<thead><tr><th class='l'>Игрок</th><th class='l'>Клуб</th>" +
      "<th class='l'>Срок</th><th class='l'>Надёжность</th><th class='l'>Новость</th></tr></thead>";
    var autoBody = auto.map(function (item) {
      var url = safeUrl(item.url);
      var headline = esc(item.headline || "");
      var link = url ? "<a href='" + esc(url) + "' target='_blank' rel='noopener noreferrer' " +
                       "style='color:var(--ice);text-decoration:none;border-bottom:1px solid var(--rule-strong)'>" +
                       headline + "</a>" : headline;
      return "<tr>" +
        "<td class='l'>" + esc(item.player) + "</td>" +
        "<td class='l dim'>" + crest(item.team_id) + esc(item.team) + "</td>" +
        "<td class='l dim'>" + esc(item.term || "—") + "</td>" +
        "<td class='l'><span class='pill " + (item.confidence === "высокая" ? "cool" : "dim") + "'>" +
          esc(item.confidence || "") + "</span></td>" +
        "<td class='l dim'>" + link + "</td>" +
      "</tr>";
    }).join("");
    $("autoTable").innerHTML = autoHead + "<tbody>" +
      (autoBody || "<tr><td class='l dim' colspan='5'>В свежих новостях упоминаний о травмах игроков КХЛ не нашлось.</td></tr>") +
      "</tbody>";
  }

  function saveManual(entries) {
    var state = APP.alpine ? APP.alpine.injury : null;
    if (state) { state.saving = true; state.state = "сохраняю…"; state.stateKind = ""; }

    return fetch("/api/injuries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "khl-tracker" },
      body: JSON.stringify({ manual: entries })
    }).then(function (response) {
      if (response.status === 401) { window.location.href = "/login"; return null; }
      if (!response.ok) throw new Error("http " + response.status);
      return response.json();
    }).then(function (result) {
      if (!result) return;
      APP.data.injuries = result.injuries || [];
      renderInjuries();
      rendered.overview = false;
      if (state) { state.state = "сохранено"; state.stateKind = "ok"; }
    }).catch(function () {
      if (state) { state.state = "не сохранилось — сервер не ответил"; state.stateKind = "bad"; }
    }).then(function () {
      if (state) state.saving = false;
    });
  }

  /* ============================== навигация ============================== */

  var VIEWS = ["overview","games","table","odds","players","injuries"];
  var rendered = {};

  function currentView() {
    var hash = (window.location.hash || "#/").replace(/^#\/?/, "");
    var name = hash.split("/")[0] || "overview";
    return VIEWS.indexOf(name) === -1 ? "overview" : name;
  }

  function paint(view) {
    if (rendered[view]) return;
    if (view === "overview") renderOverview();
    if (view === "games") renderGames();
    if (view === "table") renderTable();
    if (view === "odds") renderOdds();
    if (view === "players") renderPlayers();
    if (view === "injuries") renderInjuries();
    rendered[view] = true;
  }

  function show(view) {
    VIEWS.forEach(function (name) { $("view-" + name).hidden = name !== view; });
    $("tabs").querySelectorAll("a").forEach(function (link) {
      link.classList.toggle("on", link.getAttribute("data-view") === view);
    });
    moveTabPill(view);
    paint(view);

    // Графики нельзя разложить в скрытом контейнере — подгоняем после показа.
    Object.keys(APP.charts).forEach(function (id) {
      if ($(id) && $(id).offsetParent !== null) APP.charts[id].resize();
    });

    if (canAnimate()) {
      window.gsap.fromTo("#view-" + view,
        { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.42, ease: "power2.out" });
    }
    if (lenis) lenis.scrollTo(0, { immediate: true });
    else window.scrollTo({ top: 0, behavior: "instant" });
  }

  window.addEventListener("hashchange", function () { show(currentView()); });
  window.addEventListener("resize", function () {
    moveTabPill(currentView());
    Object.keys(APP.charts).forEach(function (id) {
      if ($(id) && $(id).offsetParent !== null) APP.charts[id].resize();
    });
  });

  /* ============================ состояние Alpine ============================ */

  document.addEventListener("alpine:init", function () {
    window.Alpine.data("tracker", function () {
      return {
        teams: [], months: [], playerNameList: [],
        games:   { team: "", state: "all", month: "" },
        players: { team: "", role: "", query: "" },
        injury:  { player: "", status: "травма", until: "", note: "", saving: false, state: "", stateKind: "" },

        init: function () {
          APP.alpine = this;
          if (APP.data) this.hydrate();
        },

        hydrate: function () {
          this.teams = (APP.data.teams || []).slice().sort(function (a, b) {
            return String(a.name).localeCompare(String(b.name), "ru");
          });
          this.playerNameList = (APP.data.players || []).slice().sort(function (a, b) {
            return String(a.name).localeCompare(String(b.name), "ru");
          });
          var seen = {}, months = [];
          (APP.data.games || []).forEach(function (g) {
            var d = parseDate(g.start_at);
            if (!d) return;
            var key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
            if (!seen[key]) {
              seen[key] = true;
              months.push({ key: key, label: MONTHS_NOM[d.getMonth()] + " " + d.getFullYear() });
            }
          });
          this.months = months;
        },

        addInjury: function () {
          var name = String(this.injury.player || "").trim();
          if (!name) return;
          // Подтягиваем клуб и id из состава: так запись связывается
          // с реальным игроком, а не остаётся просто строкой.
          var match = (APP.data.players || []).filter(function (p) {
            return String(p.name).toLowerCase() === name.toLowerCase();
          })[0];

          var entry = {
            player: match ? match.name : name,
            player_id: match ? match.id : null,
            team: match ? match.team : "",
            team_id: match ? match.team_id : null,
            status: this.injury.status,
            until: String(this.injury.until || "").trim(),
            note: String(this.injury.note || "").trim(),
            added_at: new Date().toISOString().slice(0, 19)
          };

          var self = this;
          saveManual(manualList().concat([entry])).then(function () {
            self.injury.player = "";
            self.injury.until = "";
            self.injury.note = "";
          });
        }
      };
    });
  });

  document.addEventListener("filters-games", function () { renderGames(); });
  document.addEventListener("filters-players", function () { renderPlayers(); });

  /* ================================ старт ================================ */

  function start(data) {
    APP.data = data;
    $("loading").hidden = true;
    if (APP.alpine) APP.alpine.hydrate();
    renderHeader();
    show(currentView());
  }

  fetch("/data.json", { headers: { "Accept": "application/json" } })
    .then(function (response) {
      if (response.status === 401) { window.location.href = "/login"; return null; }
      if (!response.ok) throw new Error("http " + response.status);
      return response.json();
    })
    .then(function (data) {
      if (!data) return;
      if (data.error) throw new Error(data.error);
      start(data);
    })
    .catch(function (error) {
      $("loading").hidden = true;
      var box = $("errorBox");
      box.hidden = false;
      box.textContent = "Данные не загрузились: " + error.message +
        ". Запусти refresh.bat, чтобы собрать их заново.";
    });
}());
