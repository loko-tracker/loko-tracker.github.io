/* ===========================================================================
   Трекер сезона КХЛ — логика страницы. Один файл на обе версии сайта.

   Локальная версия (refresh.bat): данные берутся с сервера — /data.json,
   отметки о травмах сохраняются через /api/injuries.

   Публичная версия (ссылка): данные зашифрованы и лежат прямо в странице
   (<script id="vault">). Логин и пароль превращаются в ключ PBKDF2-SHA256,
   им расшифровывается AES-GCM, затем распаковывается gzip. Никуда по сети
   ни пароль, ни ключ не уходят.

   Стек: GSAP + ScrollTrigger (движение), ECharts (графики), Lenis (скролл).
   Без Alpine намеренно: он вычисляет выражения через eval, а политика
   безопасности публичной страницы может это запрещать.
   =========================================================================== */

(function () {
  "use strict";

  var APP = { data: null, charts: {} };
  var $ = function (id) { return document.getElementById(id); };

  var MODE = $("vault") ? "web" : "local";
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
  function monthKey(iso) {
    var d = parseDate(iso);
    return d ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") : "";
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
  function byName(a, b) {
    return String(a.name).localeCompare(String(b.name), "ru");
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

  // Логотип — пустой блок с классом logo-<id>. Сама картинка описана один
  // раз в стилях: локально ссылкой на файл, в публичной версии встроенной.
  function crest(teamId, size) {
    var id = String(teamId || "").replace(/[^0-9]/g, "");
    if (!id) return "";
    return '<span class="' + (size === "big" ? "crest" : "crest-sm") +
      " logo-" + id + '" aria-hidden="true"></span>';
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
    var raf = null, x = 0, y = 0;
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
     GSAP просто стоят. Поэтому: покой = готовое состояние, анимация поверх. */
  function canAnimate() {
    return HAS_GSAP && !REDUCED && !document.hidden;
  }

  function armAnimations() {
    if (canAnimate()) document.body.classList.add("anim-on", "reveal-armed");
  }

  // Вкладку открыли уже после загрузки — снимаем подготовку, чтобы блоки
  // не остались спрятанными навсегда.
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
    // Страховка: что бы ни случилось с анимацией, через 2.5 с всё видно.
    setTimeout(function () {
      items.forEach(function (node) {
        if (Number(getComputedStyle(node).opacity) < 0.05) {
          node.style.opacity = 1;
          node.style.transform = "none";
        }
      });
    }, 2500);
  }

  // Итоговое значение ставится сразу и только потом набегает от нуля.
  // Если кадров не будет, на экране уже верное число.
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
      // Таймер, а не кадр отрисовки: на фоновой вкладке кадров нет.
      setTimeout(function () { $("railFill").style.width = share.toFixed(2) + "%"; }, 30);
      $("heroProgress").textContent = "пройдено " + share.toFixed(0) + "%";
    }
  }

  function moveTabPill(view) {
    var pill = $("tabPill");
    var link = $("tabs").querySelector('a[data-view="' + view + '"]');
    if (!pill || !link) return;
    // На узком экране вкладки переносятся на вторую строку, поэтому пилюля
    // встаёт и по горизонтали, и по вертикали — ровно под нужную ссылку.
    pill.style.opacity = "1";
    pill.style.width = link.offsetWidth + "px";
    pill.style.height = link.offsetHeight + "px";
    pill.style.transform = "translate(" + link.offsetLeft + "px," + link.offsetTop + "px)";
  }

  /* =========================== обратный отсчёт =========================== */

  // Отсчётов на странице два — до ближайшего матча лиги и до матча клуба,
  // поэтому таймеры хранятся по имени и перезапускаются независимо.
  var countdownTimers = {};

  function runCountdown(name, targetIso, ids) {
    if (countdownTimers[name]) { clearInterval(countdownTimers[name]); delete countdownTimers[name]; }
    var target = parseDate(targetIso);
    if (!target) return;

    function tick() {
      var left = Math.max(0, target - Date.now());
      var s = Math.floor(left / 1000);
      var parts = [Math.floor(s / 86400), Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60), s % 60];
      ids.forEach(function (id, index) {
        var node = $(id);
        if (!node) return;
        var value = index ? String(parts[index]).padStart(2, "0") : String(parts[index]);
        if (node.textContent !== value) node.textContent = value;
      });
      if (left === 0 && countdownTimers[name]) {
        clearInterval(countdownTimers[name]);
        delete countdownTimers[name];
      }
    }
    tick();
    countdownTimers[name] = setInterval(tick, 1000);
  }

  // «Впереди» — это не просто «не отмечен сыгранным»: данные обновляются
  // раз в сутки, и к вечеру утренние матчи в них ещё числятся несыгранными.
  // Поэтому смотрим на часы зрителя: матч впереди, только если он не начался.
  function isAhead(game) {
    if (game.state === "finished") return false;
    var start = parseDate(game.start_at);
    return !start || start.getTime() > Date.now();
  }

  // Прошёл по времени, но итога в данных ещё нет (ждёт утреннего обновления).
  function isAwaitingResult(game) {
    return game.state !== "finished" && !isAhead(game);
  }

  function startCountdown() {
    var next = (APP.data.games || []).filter(isAhead)[0];
    if (!next) {
      $("cdGame").textContent = "Матчей впереди нет.";
      return;
    }
    $("cdGame").innerHTML = crest(next.home_id) + esc(next.home) +
      ' <span style="color:var(--muted)">—</span> ' + crest(next.away_id) + esc(next.away) +
      ' <span style="color:var(--muted)">· ' + esc(fmtDayFull(next.start_at)) +
      ", " + esc(fmtTime(next.start_at)) + "</span>";
    runCountdown("league", next.start_at, ["cdD","cdH","cdM","cdS"]);
  }

  /* ============================== мой клуб ============================== */

  // Клуб по умолчанию задаётся при сборке (site.json), но у каждого
  // посетителя может быть свой — выбор хранится в его браузере.
  var TEAM_KEY = "khl-tracker-my-team-v1";

  function myTeamId() {
    try {
      var stored = window.localStorage.getItem(TEAM_KEY);
      if (stored && teamById(Number(stored))) return Number(stored);
    } catch (error) { /* хранилище недоступно — берём клуб по умолчанию */ }
    return APP.data.my_team_id || null;
  }

  function setMyTeam(teamId) {
    try { window.localStorage.setItem(TEAM_KEY, String(teamId)); }
    catch (error) { /* не запомнится, но на эту сессию сработает */ }
    APP.myTeam = Number(teamId);
  }

  function isMine(teamId) {
    return APP.myTeam != null && Number(teamId) === APP.myTeam;
  }

  function teamById(teamId) {
    return (APP.data.teams || []).filter(function (t) { return t.id === teamId; })[0] || null;
  }

  // Исход матча глазами клуба. Счёт в данных итоговый: решающая шайба
  // в овертайме или по буллитам уже в нём, а как кончилось — видно по периодам.
  function outcome(game, teamId) {
    var parts = String(game.score || "").split(":");
    if (parts.length !== 2) return null;
    var home = game.home_id === teamId;
    var mine = Number(home ? parts[0] : parts[1]);
    var theirs = Number(home ? parts[1] : parts[0]);
    var periods = game.periods || {};
    var extra = periods.so ? "Б" : periods.ot ? "ОТ" : "";
    var win = mine > theirs;
    return {
      win: win,
      extra: extra,
      mine: mine,
      theirs: theirs,
      home: home,
      points: win ? 2 : (extra ? 1 : 0),
      code: win ? "w" : (extra ? "otl" : "l"),
      // Как в таблице КХЛ: ВО/ВБ — победа в овертайме/по буллитам, ПО/ПБ — поражение.
      label: (win ? "В" : "П") + (extra === "ОТ" ? "О" : extra === "Б" ? "Б" : ""),
      opponentId: home ? game.away_id : game.home_id,
      opponent: home ? game.away : game.home
    };
  }

  function clubModel(teamId) {
    var team = teamById(teamId);
    if (!team) return null;

    var row = null;
    ["west","east"].forEach(function (key) {
      (APP.data.standings[key] || []).forEach(function (r) { if (r.team_id === teamId) row = r; });
    });
    var odds = (APP.data.odds.teams || []).filter(function (t) { return t.team_id === teamId; })[0] || null;

    var games = (APP.data.games || []).filter(function (g) {
      return g.home_id === teamId || g.away_id === teamId;
    });
    var played = games.filter(function (g) { return g.state === "finished"; })
      .map(function (g) { return { game: g, result: outcome(g, teamId) }; })
      .filter(function (x) { return x.result; });
    var upcoming = games.filter(isAhead);

    // Текущая серия: сколько последних матчей подряд с одним исходом.
    var streak = { count: 0, win: null };
    for (var i = played.length - 1; i >= 0; i--) {
      var won = played[i].result.win;
      if (streak.win === null) streak.win = won;
      if (won !== streak.win) break;
      streak.count++;
    }

    var roster = (APP.data.players || []).filter(function (p) { return p.team_id === teamId; });
    var official = !!(APP.data.club_rosters || {})[String(teamId)];
    var injuries = (APP.data.injuries || []).filter(function (i) {
      return i.team_id === teamId || i.team === team.name;
    });

    return {
      team: team, row: row, odds: odds, games: games, played: played,
      upcoming: upcoming, next: upcoming[0] || null, streak: streak,
      roster: roster, official: official, injuries: injuries
    };
  }

  function streakText(streak) {
    if (!streak.count) return "—";
    var n = streak.count, word;
    var mod10 = n % 10, mod100 = n % 100;
    if (streak.win) word = (mod10 === 1 && mod100 !== 11) ? "победа" : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) ? "победы" : "побед";
    else word = (mod10 === 1 && mod100 !== 11) ? "поражение" : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) ? "поражения" : "поражений";
    return n + " " + word + " подряд";
  }

  function formChip(item) {
    var r = item.result;
    return '<span class="chip ' + r.code + '" title="' + esc(fmtDayFull(item.game.start_at) + " · " +
      (r.home ? "дома" : "в гостях") + " · " + item.game.home + " " + item.game.score + " " + item.game.away) + '">' +
      "<b>" + esc(r.label) + "</b>" + crest(r.opponentId) + r.mine + ":" + r.theirs + "</span>";
  }

  function renderClubHero() {
    var host = $("clubHero");
    var club = APP.myTeam ? clubModel(APP.myTeam) : null;
    if (!club) { host.hidden = true; return; }
    host.hidden = false;

    var row = club.row || {}, odds = club.odds || {};
    var place = row.position ? row.position + "-е место на " + (row.conference_key === "east" ? "Востоке" : "Западе") : "";
    var meta = [club.team.location, place, row.coach ? "тренер " + row.coach.split(" ").slice(0, 2).reverse().join(" ") : ""]
      .filter(Boolean).join(" · ");

    var kpis = [
      { k: "Очки", v: row.pts != null ? row.pts : "—" },
      { k: "Матчи", v: row.gp != null ? row.gp : "—" },
      { k: "Шайбы", v: row.gf != null ? row.gf + "–" + row.ga : "—" },
      { k: "Плей-офф", v: odds.playoff_pct != null ? pct(odds.playoff_pct) + "%" : "—" },
      { k: "Серия", v: streakText(club.streak), hot: club.streak.win && club.streak.count >= 3 }
    ];

    var form = club.played.slice(-6).map(formChip).join("") ||
      '<span class="chip">сезон ещё не начался</span>';

    var next = club.next, nextHtml;
    if (next) {
      var home = next.home_id === club.team.id;
      var oppId = home ? next.away_id : next.home_id;
      var opp = home ? next.away : next.home;
      nextHtml =
        '<span class="k">Следующий матч · ' + (home ? "дома" : "в гостях") + '</span>' +
        '<div class="vs">' + crest(oppId) + esc(opp) + '</div>' +
        '<div class="when">' + esc(fmtDayFull(next.start_at)) + ", " + esc(fmtWeekday(next.start_at)) +
          ", " + esc(fmtTime(next.start_at)) + '</div>' +
        '<div class="cd-clock">' +
          '<span class="cd-unit"><b id="ccD">—</b><i>дн</i></span>' +
          '<span class="cd-unit"><b id="ccH">—</b><i>ч</i></span>' +
          '<span class="cd-unit"><b id="ccM">—</b><i>мин</i></span>' +
          '<span class="cd-unit"><b id="ccS">—</b><i>с</i></span>' +
        '</div>';
    } else {
      nextHtml = '<span class="k">Следующий матч</span><div class="when">Матчей впереди нет.</div>';
    }

    host.innerHTML =
      '<div>' +
        '<div class="club-id">' + crest(club.team.id, "big").replace('class="crest ', 'class="club-crest ') +
          '<div><p class="club-eyebrow">Мой клуб</p>' +
          '<h2 class="club-name">' + esc(club.team.name) + '</h2>' +
          '<p class="club-meta">' + esc(meta) + '</p></div>' +
        '</div>' +
        '<div class="club-kpis">' + kpis.map(function (x) {
          return '<div class="club-kpi"><span class="k">' + esc(x.k) + '</span>' +
            '<span class="v' + (x.hot ? " hot" : "") + '">' + esc(x.v) + '</span></div>';
        }).join("") + '</div>' +
        '<div class="form-strip" aria-label="Последние матчи">' + form + '</div>' +
      '</div>' +
      '<div class="club-next">' + nextHtml +
        '<a class="club-link" href="#/club">Календарь и состав →</a>' +
      '</div>';

    if (next) runCountdown("club", next.start_at, ["ccD","ccH","ccM","ccS"]);
  }

  var ROLE_GROUPS = [
    { key: "goaltender", title: "Вратари" },
    { key: "defenseman", title: "Защитники" },
    { key: "forward",    title: "Нападающие" }
  ];

  function renderClub() {
    var club = APP.myTeam ? clubModel(APP.myTeam) : null;
    if (!club) {
      $("clubHead").innerHTML = '<p class="empty">Клуб не выбран — выбери его ниже.</p>';
      fillClubSelect();
      return;
    }
    var row = club.row || {}, odds = club.odds || {};

    $("clubHead").innerHTML =
      crest(club.team.id, "big").replace('class="crest ', 'class="club-crest ') +
      '<div><p class="club-eyebrow">Мой клуб</p><h1 class="club-name">' + esc(club.team.name) + '</h1>' +
      '<p class="club-meta">' + esc([club.team.location, club.team.division ? "дивизион " + club.team.division : "",
        row.coach ? "тренер " + row.coach : ""].filter(Boolean).join(" · ")) + '</p></div>';

    var tiles = [
      { k: "Место", v: row.position ? row.position : "—", sub: row.conference_key === "east" ? "на Востоке" : "на Западе" },
      { k: "Очки", v: row.pts != null ? row.pts : "—", sub: row.gp != null ? "за " + row.gp + " матч." : "" },
      { k: "Плей-офф", v: odds.playoff_pct != null ? pct(odds.playoff_pct) + "%" : "—", sub: "шанс по симуляции" },
      { k: "Прогноз очков", v: odds.proj_pts != null ? dec(odds.proj_pts, 0) : "—",
        sub: odds.proj_pts_low != null ? "вероятно " + odds.proj_pts_low + "–" + odds.proj_pts_high : "" },
      { k: "Серия", v: club.streak.count || "—", sub: club.streak.count ? streakText(club.streak).replace(/^\d+ /, "") : "" }
    ];
    $("clubTiles").innerHTML = tiles.map(function (t) {
      return '<div class="stat"><div class="k">' + esc(t.k) + '</div><div class="v">' + esc(t.v) +
        '</div><div class="sub">' + esc(t.sub) + '</div></div>';
    }).join("");

    // Календарь: сыгранные сверху вниз по времени, затем предстоящие.
    var head = "<thead><tr><th class='l'>Дата</th><th class='l'></th><th class='l'>Соперник</th>" +
      "<th>Счёт</th><th class='l'>Итог</th></tr></thead>";
    var body = club.games.map(function (g) {
      var home = g.home_id === club.team.id;
      var oppId = home ? g.away_id : g.home_id, opp = home ? g.away : g.home;
      var r = g.state === "finished" ? outcome(g, club.team.id) : null;
      var result = r
        ? "<span class='pill " + (r.code === "w" ? "zone" : r.code === "otl" ? "dim" : "hot") + "'>" +
            (r.win ? "победа" : "поражение") + (r.extra ? " · " + r.extra : "") + "</span>"
        : isAwaitingResult(g)
          ? "<span class='pill dim'>ждём итог</span>"
          : "<span class='pill dim'>" + esc(fmtTime(g.start_at)) + "</span>";
      return "<tr" + (g === club.next ? " class='mine'" : "") + ">" +
        "<td class='l dim'>" + esc(fmtDay(g.start_at)) + ", " + esc(fmtWeekday(g.start_at)) + "</td>" +
        "<td class='l dim'>" + (home ? "дома" : "в гостях") + "</td>" +
        "<td class='l'>" + crest(oppId) + esc(opp) + "</td>" +
        "<td class='strong'>" + (r ? r.mine + ":" + r.theirs : "—") + "</td>" +
        "<td class='l'>" + result + "</td>" +
      "</tr>";
    }).join("");
    $("clubGames").innerHTML = head + "<tbody>" +
      (body || "<tr><td class='l dim' colspan='5'>Матчей нет.</td></tr>") + "</tbody>";

    // Лазарет клуба: данные клуба, твои отметки и новости вместе.
    $("clubInjuries").innerHTML = club.injuries.length
      ? "<div class='table-scroll'><table class='grid'><tbody>" + club.injuries.map(function (i) {
          var source = i.source === "club" ? "данные клуба" : i.source === "manual" ? "твоя отметка" : "из новостей";
          return "<tr><td class='l'>" + esc(i.player) + "</td>" +
            "<td class='l'><span class='pill hot'>" + esc(i.status || "травма") + "</span></td>" +
            "<td class='l dim'>" + esc(i.until || i.term || "") + "</td>" +
            "<td class='l dim'>" + esc(source) + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<p class="empty">Травмированных нет' + (club.official ? " — по данным клуба." : ".") + '</p>';

    var leaders = club.roster.filter(function (p) { return p.gp; })
      .sort(function (a, b) { return (b.pts - a.pts) || (b.g - a.g); }).slice(0, 5);
    $("clubLeaders").innerHTML = leaders.length
      ? "<div class='table-scroll'><table class='grid'><tbody>" + leaders.map(function (p, i) {
          return "<tr><td class='dim'>" + (i + 1) + "</td><td class='l'>" + esc(p.name) + "</td>" +
            "<td class='dim'>" + p.g + "+" + p.a + "</td><td class='strong'>" + p.pts + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<p class="empty">Статистики пока нет.</p>';

    $("clubRosterNote").textContent = club.official
      ? "Состав — по данным официального сайта клуба (" + club.roster.length + " игроков), статистика — по данным лиги. У тех, кто ещё не выходил на лёд, нули."
      : "Состав — по данным лиги: в нём только игроки, у которых уже есть статистика в сезоне.";

    $("clubRoster").innerHTML = ROLE_GROUPS.map(function (group) {
      var list = club.roster.filter(function (p) { return p.role_key === group.key; });
      if (!list.length) return "";
      list.sort(function (a, b) {
        return group.key === "goaltender" ? (b.gp - a.gp) : ((b.pts - a.pts) || (b.gp - a.gp));
      });
      var goalie = group.key === "goaltender";
      // У вратарей лига отдаёт только число игр: время на льду у них нулевое,
      // а сейвов в данных нет — показывать нечего, кроме матчей.
      var headRow = "<thead><tr><th class='l'>№</th><th class='l'>Игрок</th><th>И</th>" +
        (goalie ? "" : "<th>Г</th><th>П</th><th>О</th><th>+/−</th>") + "</tr></thead>";
      var rows = list.map(function (p) {
        var flags = (p.injured ? " <span class='pill hot'>травма</span>" : "") +
                    (p.farm_club ? " <span class='pill dim'>фарм</span>" : "");
        return "<tr><td class='l'><span class='num-badge'>" + esc(p.number != null ? p.number : "") + "</span></td>" +
          "<td class='l'>" + esc(p.name) + flags + "</td><td>" + (p.gp || 0) + "</td>" +
          (goalie ? ""
                  : "<td>" + (p.g || 0) + "</td><td>" + (p.a || 0) + "</td><td class='strong'>" + (p.pts || 0) +
                    "</td><td>" + signed(p.plus_minus) + "</td>") +
          "</tr>";
      }).join("");
      return '<div class="panel"><h3 class="panel-head">' + esc(group.title) +
        ' <span style="color:var(--muted);font-weight:400">' + list.length + '</span></h3>' +
        '<div class="table-scroll"><table class="grid">' + headRow + "<tbody>" + rows + "</tbody></table></div></div>";
    }).join("");

    fillClubSelect();
  }

  function fillClubSelect() {
    var select = $("clubSelect");
    if (select.options.length) { select.value = String(APP.myTeam || ""); return; }
    (APP.data.teams || []).slice().sort(byName).forEach(function (t) {
      var option = document.createElement("option");
      option.value = String(t.id);
      option.textContent = t.name;
      select.appendChild(option);
    });
    select.value = String(APP.myTeam || "");
    select.addEventListener("change", function () {
      setMyTeam(select.value);
      updateClubTab();
      // Клуб влияет на подсветку во всех разделах — перерисуем их заново.
      rendered = {};
      paint(currentView());
    });
  }

  function updateClubTab() {
    var team = APP.myTeam ? teamById(APP.myTeam) : null;
    $("clubTab").textContent = team ? team.name : "Мой клуб";
    moveTabPill(currentView());
  }

  /* ================================= обзор ================================= */

  function renderOverview() {
    renderClubHero();
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
             '<div class="v" id="tile' + i + '">' + esc(t.v) + '</div>' +
             '<div class="sub">' + esc(t.sub) + '</div></div>';
    }).join("");
    tiles.forEach(function (t, i) { if (t.num) countUp($("tile" + i), t.v); });

    $("oddsNote").textContent =
      "Доля из " + odds.sims.toLocaleString("ru-RU") + " симуляций остатка сезона (" +
      odds.games_remaining + " матчей). Раннему сезону верить нельзя: рейтинги стянуты к среднему.";

    var upcoming = (APP.data.games || []).filter(isAhead).slice(0, 8);
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
    window.gsap.timeline()
      .from(".hero .eyebrow", { opacity: 0, y: 10, duration: 0.5, ease: "power2.out" })
      .from(".hero-title", { opacity: 0, y: 26, duration: 0.8, ease: "power3.out" }, "-=0.25")
      .from(".countdown", { opacity: 0, y: 16, duration: 0.6, ease: "power2.out" }, "-=0.45")
      .from(".hero-side", { opacity: 0, x: 24, duration: 0.7, ease: "power3.out" }, "-=0.55")
      .from(".stat", { opacity: 0, y: 18, duration: 0.55, ease: "power2.out", stagger: 0.06 }, "-=0.35");
  }

  function periodsText(game) {
    var periods = game.periods || {};
    var parts = ["p1","p2","p3"].map(function (k) { return periods[k]; }).filter(Boolean);
    if (periods.ot) parts.push("ОТ " + periods.ot);
    if (periods.so) parts.push("Б " + periods.so);
    return parts.join(" · ");
  }

  function gameRow(game) {
    var finished = game.state === "finished";
    var periods = periodsText(game);
    var mine = isMine(game.home_id) || isMine(game.away_id);
    return '<div class="game' + (mine ? " mine" : "") + '">' +
      '<div class="when">' + esc(fmtDay(game.start_at)) + '<br>' + esc(fmtTime(game.start_at)) + '</div>' +
      '<div class="who">' + crest(game.home_id) + esc(game.home) +
        ' <span class="vs">—</span> ' + crest(game.away_id) + esc(game.away) + '</div>' +
      (finished ? '<div class="sc">' + esc(game.score || "") + '</div>'
                : '<div class="sc pending">' + esc(fmtWeekday(game.start_at)) + '</div>') +
      (finished && periods ? '<div class="per">' + esc(periods) + '</div>' : '') +
      '</div>';
  }

  function renderOddsBars(hostId, confKey) {
    var rows = (APP.data.odds.teams || []).filter(function (r) { return r.conference_key === confKey; });
    rows.sort(function (a, b) { return b.playoff_pct - a.playoff_pct; });

    $(hostId).innerHTML = rows.map(function (r) {
      var tipText = "<b>" + esc(r.name) + "</b><span class='num'>плей-офф " + pct(r.playoff_pct) +
        "%<br>1-е в конференции " + pct(r.conf_first_pct) +
        "%<br>прогноз очков " + dec(r.proj_pts) + " (вероятно " + r.proj_pts_low + "–" + r.proj_pts_high + ")</span>";
      return '<div class="obar' + (isMine(r.team_id) ? " mine" : "") + '" data-tip="' + esc(tipText) +
        '" data-pct="' + r.playoff_pct + '">' +
        '<div class="nm">' + crest(r.team_id) + esc(r.name) + '</div>' +
        '<div class="track"><div class="fill" style="background:' + oddsColor(r.playoff_pct) + '"></div></div>' +
        '<div class="val"><b>' + pct(r.playoff_pct) + '%</b></div>' +
      '</div>';
    }).join("");

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

  function tooltipBase() {
    return {
      backgroundColor: "#0b111a",
      borderColor: cssVar("--rule-strong"),
      borderWidth: 1,
      textStyle: { color: cssVar("--ink"), fontSize: 12.5 },
      extraCssText: "border-radius:9px;box-shadow:0 16px 40px -14px rgba(0,0,0,.95);"
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
    option.backgroundColor = "transparent";
    option.textStyle = { fontFamily: '"IBM Plex Sans", system-ui, sans-serif', color: cssVar("--ink-2") };
    option.animationDuration = REDUCED ? 0 : (option.animationDuration || 900);
    chart.setOption(option, true);
    chart.resize();
    return chart;
  }

  // Прогноз очков: точка — набрано сейчас, полоса — вероятный интервал,
  // засечка — средний прогноз. Одна шкала (очки) на все три серии.
  function chartProjection() {
    var rows = (APP.data.odds.teams || []).slice().sort(function (a, b) {
      return a.proj_pts - b.proj_pts;
    });
    makeChart("chartProjection", {
      tooltip: Object.assign(tooltipBase(), {
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
      yAxis: Object.assign({ type: "category", data: rows.map(function (r) { return r.name; }) }, axisStyle(), {
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
      animationEasing: "cubicOut"
    });
  }

  // Атака против обороны. Обе оси в голах за матч — это облако точек,
  // а не совмещение двух разных шкал. Цвет кодирует шанс на плей-офф.
  function chartScatter() {
    var rows = APP.data.odds.teams || [];
    makeChart("chartScatter", {
      tooltip: Object.assign(tooltipBase(), {
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
      }]
    });
  }

  function chartOdds() {
    var rows = (APP.data.odds.teams || []).slice().sort(function (a, b) {
      return a.playoff_pct - b.playoff_pct;
    });
    makeChart("chartOdds", {
      tooltip: Object.assign(tooltipBase(), {
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
      animationDuration: 1000,
      animationEasing: "cubicOut"
    });
  }

  /* =============================== таблица =============================== */

  function renderTable() {
    ["west","east"].forEach(function (key) {
      var rows = APP.data.standings[key] || [];
      var head = "<thead><tr><th class='l'>#</th><th class='l'>Клуб</th>" +
        "<th>И</th><th>В</th><th>ВО</th><th>ВБ</th><th>ПБ</th><th>ПО</th><th>П</th>" +
        "<th>Ш</th><th>О</th><th>П-О</th></tr></thead>";
      var body = rows.map(function (r) {
        var cls = [r.position === 8 ? "cut" : "", isMine(r.team_id) ? "mine" : ""].join(" ").trim();
        return "<tr" + (cls ? " class='" + cls + "'" : "") + ">" +
          "<td class='l dim'>" + r.position + "</td>" +
          "<td class='l'>" + crest(r.team_id) + esc(r.name) + "</td>" +
          "<td>" + r.gp + "</td><td>" + r.w + "</td><td>" + r.otw + "</td><td>" + r.sow + "</td>" +
          "<td>" + r.sol + "</td><td>" + r.otl + "</td><td>" + r.l + "</td>" +
          "<td class='dim'>" + r.gf + "–" + r.ga + "</td>" +
          "<td class='strong'>" + r.pts + "</td>" +
          "<td style='color:" + oddsColor(r.playoff_pct) + ";font-weight:600'>" + pct(r.playoff_pct) + "%</td>" +
        "</tr>";
      }).join("");
      $(key === "west" ? "tableWest" : "tableEast").innerHTML = head + "<tbody>" + body + "</tbody>";
    });
  }

  /* ================================ шансы ================================ */

  var oddsSort = { field: "playoff_pct", asc: false };

  var ODDS_COLS = [
    { field: "name",            label: "Клуб",   cls: "l", logo: true },
    { field: "conference",      label: "Конф.",  cls: "l", dim: true },
    { field: "gp",              label: "И" },
    { field: "pts",             label: "О сейчас" },
    { field: "proj_pts",        label: "Прогноз О", decimals: 1, strong: true },
    { field: "playoff_pct",     label: "Плей-офф",  percent: true },
    { field: "conf_first_pct",  label: "1-е в конф.", percent: true },
    { field: "continental_pct", label: "Кубок Континента", percent: true },
    { field: "attack",          label: "Атака",   decimals: 2, dim: true },
    { field: "defence",         label: "Оборона", decimals: 2, dim: true }
  ];

  function sortRows(rows, sort) {
    var field = sort.field, asc = sort.asc;
    return rows.sort(function (a, b) {
      var x = a[field], y = b[field];
      if (typeof x === "string" || typeof y === "string") {
        var cmp = String(x || "").localeCompare(String(y || ""), "ru");
        return asc ? cmp : -cmp;
      }
      var diff = (Number(x) || 0) - (Number(y) || 0);
      if (diff === 0 && a.pts !== undefined) diff = (Number(a.pts) || 0) - (Number(b.pts) || 0);
      return asc ? diff : -diff;
    });
  }

  function sortableHead(columns, sort, leading) {
    return "<thead><tr>" + (leading || "") + columns.map(function (c) {
      var sorted = c.field === sort.field ? " sorted" + (sort.asc ? " asc" : "") : "";
      return "<th class='" + (c.cls || "") + sorted + "' data-field='" + c.field + "'>" + esc(c.label) + "</th>";
    }).join("") + "</tr></thead>";
  }

  function wireSort(table, sort, rerender) {
    table.querySelectorAll("th[data-field]").forEach(function (th) {
      th.addEventListener("click", function () {
        var next = th.getAttribute("data-field");
        if (sort.field === next) sort.asc = !sort.asc;
        else { sort.field = next; sort.asc = false; }
        rerender();
      });
    });
  }

  function renderOdds() {
    var odds = APP.data.odds;
    $("oddsMethod").textContent =
      "Посчитано: " + odds.sims.toLocaleString("ru-RU") + " прогонов остатка календаря (" +
      odds.games_remaining + " матчей). Средняя результативность лиги — " +
      dec(odds.league_avg_goals, 2) + " гола за матч.";
    $("priorGames").textContent = odds.prior_games;
    $("remainingGames").textContent = odds.games_remaining;
    $("homeAdv").textContent = "×" + dec(odds.home_advantage, 3);
    $("simCount").textContent = odds.sims.toLocaleString("ru-RU");

    renderOddsTable();
    chartScatter();
    chartOdds();
    revealIn($("view-odds"));
  }

  function renderOddsTable() {
    var rows = sortRows((APP.data.odds.teams || []).slice(), oddsSort);
    var body = rows.map(function (r) {
      return "<tr" + (isMine(r.team_id) ? " class='mine'" : "") + ">" + ODDS_COLS.map(function (c) {
        var value = r[c.field], style = "";
        if (c.percent) {
          if (c.field === "playoff_pct") style = " style='color:" + oddsColor(value) + ";font-weight:600'";
          value = pct(value) + "%";
        } else if (c.decimals !== undefined) {
          value = dec(value, c.decimals);
        }
        var cls = [c.cls || "", c.dim ? "dim" : "", c.strong ? "strong" : ""].join(" ").trim();
        return "<td class='" + cls + "'" + style + ">" + (c.logo ? crest(r.team_id) : "") + esc(value) + "</td>";
      }).join("") + "</tr>";
    }).join("");

    $("oddsTable").innerHTML = sortableHead(ODDS_COLS, oddsSort) + "<tbody>" + body + "</tbody>";
    wireSort($("oddsTable"), oddsSort, renderOddsTable);
  }

  /* ================================ матчи ================================ */

  function renderGames() {
    var team = $("gameTeam").value;
    var state = $("gameState").value;
    var month = $("gameMonth").value;

    var list = (APP.data.games || []).filter(function (g) {
      if (team && String(g.home_id) !== team && String(g.away_id) !== team) return false;
      if (state === "finished" && g.state !== "finished") return false;
      if (state === "upcoming" && !isAhead(g)) return false;
      if (month && monthKey(g.start_at) !== month) return false;
      return true;
    });

    $("gamesCount").textContent = list.length + " матч.";

    var head = "<thead><tr><th class='l'>Дата</th><th>Время</th>" +
      "<th class='l'>Хозяева</th><th>Счёт</th><th class='l'>Гости</th>" +
      "<th class='l'>По периодам</th><th class='l'>Арена</th></tr></thead>";

    var body = list.map(function (g) {
      var finished = g.state === "finished";
      var mine = isMine(g.home_id) || isMine(g.away_id);
      return "<tr" + (mine ? " class='mine'" : "") + ">" +
        "<td class='l dim'>" + esc(fmtDayFull(g.start_at)) + ", " + esc(fmtWeekday(g.start_at)) + "</td>" +
        "<td class='dim'>" + esc(fmtTime(g.start_at)) + "</td>" +
        "<td class='l'>" + crest(g.home_id) + esc(g.home) + "</td>" +
        "<td class='strong'>" + (finished ? esc(g.score || "")
          : "<span class='pill dim'>" + (isAwaitingResult(g) ? "ждём итог" : "скоро") + "</span>") + "</td>" +
        "<td class='l'>" + crest(g.away_id) + esc(g.away) + "</td>" +
        "<td class='l dim'>" + esc(periodsText(g)) + "</td>" +
        "<td class='l dim'>" + esc(g.location || "") + "</td>" +
      "</tr>";
    }).join("");

    $("gamesTable").innerHTML = head + "<tbody>" +
      (body || "<tr><td class='l dim' colspan='7'>Ничего не нашлось под эти фильтры.</td></tr>") + "</tbody>";
  }

  /* =============================== игроки =============================== */

  var playerSort = { field: "pts", asc: false };

  var PLAYER_COLS = [
    { field: "name",       label: "Игрок", cls: "l" },
    { field: "team",       label: "Клуб",  cls: "l", dim: true, logo: true },
    { field: "role",       label: "Поз.", cls: "l", dim: true, short: true },
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
    var team = $("playerTeam").value;
    var role = $("playerRole").value;
    var query = $("playerSearch").value.trim().toLowerCase();

    var list = (APP.data.players || []).filter(function (p) {
      if (team && String(p.team_id) !== team) return false;
      if (role && p.role_key !== role) return false;
      if (query && String(p.name || "").toLowerCase().indexOf(query) === -1) return false;
      return true;
    });
    sortRows(list, playerSort);

    var shown = list.slice(0, 400);
    $("playersCount").textContent = list.length + " игр." + (list.length > 400 ? " (показаны первые 400)" : "");

    var body = shown.map(function (p, index) {
      var cells = PLAYER_COLS.map(function (c) {
        var value = p[c.field];
        if (c.short) value = ROLE_SHORT[value] || value;
        if (c.signed) value = signed(value);
        else if (c.decimals !== undefined) value = dec(value, c.decimals);
        var cls = [c.cls || "", c.dim ? "dim" : "", c.strong ? "strong" : ""].join(" ").trim();
        return "<td class='" + cls + "'>" + (c.logo ? crest(p.team_id) : "") + esc(value) + "</td>";
      }).join("");
      return "<tr" + (isMine(p.team_id) ? " class='mine'" : "") + "><td class='l dim'>" +
        (index + 1) + "</td>" + cells + "</tr>";
    }).join("");

    $("playersTable").innerHTML = sortableHead(PLAYER_COLS, playerSort, "<th class='l'>#</th>") +
      "<tbody>" + (body || "<tr><td class='l dim' colspan='12'>Никого не нашлось.</td></tr>") + "</tbody>";
    wireSort($("playersTable"), playerSort, renderPlayers);
  }

  /* =============================== лазарет =============================== */

  function manualList() {
    return (APP.data.injuries || []).filter(function (i) { return i.source === "manual"; });
  }

  function renderInjuries() {
    var editable = MODE === "local";
    var manual = manualList();
    var auto = (APP.data.injuries || []).filter(function (i) { return i.source === "auto"; });

    var manualHead = "<thead><tr><th class='l'>Игрок</th><th class='l'>Клуб</th>" +
      "<th class='l'>Статус</th><th class='l'>До</th><th class='l'>Заметка</th>" +
      (editable ? "<th></th>" : "") + "</tr></thead>";
    // Травмы по данным самих клубов — первыми и без кнопки «убрать»:
    // их снимает клуб, а не мы. Индексы удаления считаются только по своим.
    var clubRows = (APP.data.injuries || []).filter(function (i) { return i.source === "club"; })
      .map(function (item) {
        return "<tr" + (isMine(item.team_id) ? " class='mine'" : "") + ">" +
          "<td class='l'>" + esc(item.player) + "</td>" +
          "<td class='l dim'>" + crest(item.team_id) + esc(item.team) + "</td>" +
          "<td class='l'><span class='pill hot'>" + esc(item.status || "травма") + "</span></td>" +
          "<td class='l dim'>" + esc(item.until || "—") + "</td>" +
          "<td class='l dim'>по данным клуба</td>" +
          (editable ? "<td></td>" : "") +
        "</tr>";
      }).join("");
    var manualBody = clubRows + manual.map(function (item, index) {
      return "<tr" + (isMine(item.team_id) ? " class='mine'" : "") + ">" +
        "<td class='l'>" + esc(item.player) + "</td>" +
        "<td class='l dim'>" + crest(item.team_id) + esc(item.team) + "</td>" +
        "<td class='l'><span class='pill hot'>" + esc(item.status || "травма") + "</span></td>" +
        "<td class='l dim'>" + esc(item.until || "—") + "</td>" +
        "<td class='l dim'>" + esc(item.note || "") + "</td>" +
        (editable ? "<td><button class='link' data-remove='" + index + "'>убрать</button></td>" : "") +
      "</tr>";
    }).join("");
    var emptyManual = editable ? "Пока пусто — добавь первого через форму выше." : "Отметок пока нет.";
    $("manualTable").innerHTML = manualHead + "<tbody>" +
      (manualBody || "<tr><td class='l dim' colspan='6'>" + emptyManual + "</td></tr>") + "</tbody>";

    if (editable) {
      $("manualTable").querySelectorAll("[data-remove]").forEach(function (button) {
        button.addEventListener("click", function () {
          var next = manualList().slice();
          next.splice(Number(button.getAttribute("data-remove")), 1);
          saveManual(next);
        });
      });
    }

    var autoHead = "<thead><tr><th class='l'>Игрок</th><th class='l'>Клуб</th>" +
      "<th class='l'>Срок</th><th class='l'>Замечено</th><th class='l'>Надёжность</th>" +
      "<th class='l'>Новость</th></tr></thead>";
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
        "<td class='l dim'>" + esc(fmtDay(item.first_seen || item.found_at)) + "</td>" +
        "<td class='l'><span class='pill " + (item.confidence === "высокая" ? "cool" : "dim") + "'>" +
          esc(item.confidence || "") + "</span></td>" +
        "<td class='l dim'>" + link + "</td>" +
      "</tr>";
    }).join("");
    $("autoTable").innerHTML = autoHead + "<tbody>" +
      (autoBody || "<tr><td class='l dim' colspan='6'>За последние три недели упоминаний о травмах игроков КХЛ не нашлось.</td></tr>") +
      "</tbody>";
  }

  function setInjuryState(message, kind) {
    var node = $("injState");
    if (!node) return;
    node.textContent = message || "";
    node.className = "save-state" + (kind ? " " + kind : "");
  }

  function saveManual(entries) {
    var button = $("injSave");
    if (button) button.disabled = true;
    setInjuryState("сохраняю…");

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
      setInjuryState("сохранено", "ok");
    }).catch(function () {
      setInjuryState("не сохранилось — сервер не ответил", "bad");
    }).then(function () {
      if (button) button.disabled = false;
    });
  }

  function wireInjuryForm() {
    var form = $("injuryForm");
    if (!form) return;                           // публичная версия — только чтение

    var names = $("playerNames");
    (APP.data.players || []).slice().sort(byName).forEach(function (p) {
      var option = document.createElement("option");
      option.value = p.name;
      option.label = p.team || "";
      names.appendChild(option);
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var name = $("injPlayer").value.trim();
      if (!name) return;
      // Подтягиваем клуб и id из состава: так запись связывается
      // с реальным игроком, а не остаётся просто строкой.
      var match = (APP.data.players || []).filter(function (p) {
        return String(p.name).toLowerCase() === name.toLowerCase();
      })[0];

      saveManual(manualList().concat([{
        player: match ? match.name : name,
        player_id: match ? match.id : null,
        team: match ? match.team : "",
        team_id: match ? match.team_id : null,
        status: $("injStatus").value,
        until: $("injUntil").value.trim(),
        note: $("injNote").value.trim(),
        added_at: new Date().toISOString().slice(0, 19)
      }])).then(function () {
        $("injPlayer").value = "";
        $("injUntil").value = "";
        $("injNote").value = "";
      });
    });
  }

  /* =============================== фильтры =============================== */

  function fillSelect(select, options) {
    options.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });
  }

  function wireFilters() {
    var teams = (APP.data.teams || []).slice().sort(byName).map(function (t) {
      return { value: String(t.id), label: t.name };
    });
    fillSelect($("gameTeam"), teams);
    fillSelect($("playerTeam"), teams);

    var seen = {}, months = [];
    (APP.data.games || []).forEach(function (g) {
      var key = monthKey(g.start_at), d = parseDate(g.start_at);
      if (key && !seen[key]) {
        seen[key] = true;
        months.push({ value: key, label: MONTHS_NOM[d.getMonth()] + " " + d.getFullYear() });
      }
    });
    fillSelect($("gameMonth"), months);

    ["gameTeam","gameState","gameMonth"].forEach(function (id) {
      $(id).addEventListener("change", renderGames);
    });
    ["playerTeam","playerRole"].forEach(function (id) {
      $(id).addEventListener("change", renderPlayers);
    });
    var searchTimer = null;
    $("playerSearch").addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderPlayers, 180);
    });
  }

  /* ============================== навигация ============================== */

  var VIEWS = ["overview","club","games","table","odds","players","injuries"];
  var rendered = {};

  function currentView() {
    var name = (window.location.hash || "#/").replace(/^#\/?/, "").split("/")[0] || "overview";
    return VIEWS.indexOf(name) === -1 ? "overview" : name;
  }

  function paint(view) {
    if (rendered[view]) return;
    if (view === "overview") renderOverview();
    if (view === "club") renderClub();
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
    else window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", function () {
    if (APP.data) show(currentView());
  });
  window.addEventListener("resize", function () {
    if (!APP.data) return;
    moveTabPill(currentView());
    Object.keys(APP.charts).forEach(function (id) {
      if ($(id) && $(id).offsetParent !== null) APP.charts[id].resize();
    });
  });

  /* ================================ старт ================================ */

  function start(data) {
    APP.data = data;
    APP.myTeam = myTeamId();
    if ($("app")) $("app").hidden = false;
    $("loading").hidden = true;
    armAnimations();
    renderHeader();
    wireFilters();
    wireInjuryForm();
    updateClubTab();
    show(currentView());
  }

  function fail(message) {
    if ($("app")) $("app").hidden = false;
    $("loading").hidden = true;
    var box = $("errorBox");
    box.hidden = false;
    box.textContent = message;
  }

  /* ---------------------- локальная версия: с сервера ---------------------- */

  function bootLocal() {
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
        fail("Данные не загрузились: " + error.message + ". Запусти refresh.bat, чтобы собрать их заново.");
      });
  }

  /* -------------------- публичная версия: расшифровка -------------------- */

  var KEY_STORAGE = "khl-tracker-key-v1";

  function b64ToBytes(text) {
    var binary = atob(text), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function bytesToB64(buffer) {
    var bytes = new Uint8Array(buffer), binary = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function readVault() {
    return JSON.parse($("vault").textContent);
  }

  // Тот же вывод ключа, что в webkey.py: логин в нижнем регистре,
  // перевод строки, пароль как есть; PBKDF2-SHA256 → 256-битный ключ.
  function deriveKey(login, password, vault) {
    var material = new TextEncoder().encode(String(login).trim().toLowerCase() + "\n" + password);
    return crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", hash: "SHA-256", salt: b64ToBytes(vault.salt), iterations: vault.iterations },
          base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
      });
  }

  function importStoredKey(raw) {
    return crypto.subtle.importKey("raw", b64ToBytes(raw), { name: "AES-GCM" }, true, ["decrypt"]);
  }

  // Неверный ключ здесь не даёт мусор: AES-GCM проверяет целостность
  // и честно отказывает. Это и есть проверка пароля.
  function openVault(key, vault) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(vault.iv) }, key, b64ToBytes(vault.data))
      .then(function (packed) {
        var stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
        return new Response(stream).text();
      })
      .then(function (text) { return JSON.parse(text); });
  }

  function storage(action, value) {
    // Хранилище браузера бывает недоступно (приватный режим, запреты) —
    // тогда просто не запоминаем, вход всё равно работает.
    try {
      if (action === "get") return window.localStorage.getItem(KEY_STORAGE);
      if (action === "set") window.localStorage.setItem(KEY_STORAGE, value);
      if (action === "del") window.localStorage.removeItem(KEY_STORAGE);
    } catch (error) { /* нет хранилища — нет запоминания */ }
    return null;
  }

  function showGate(message) {
    $("gate").hidden = false;
    $("app").hidden = true;
    var error = $("gateError");
    error.hidden = !message;
    error.textContent = message || "";
    setTimeout(function () { $("gateLogin").focus(); }, 50);
  }

  function unlock(data) {
    $("gate").hidden = true;
    $("loading").hidden = true;
    start(data);
  }

  function bootWeb() {
    if (!window.crypto || !crypto.subtle || typeof DecompressionStream === "undefined") {
      showGate("Этот браузер слишком старый для расшифровки. Обнови его или открой в Chrome, Safari или Firefox.");
      $("gateSubmit").disabled = true;
      return;
    }

    var vault;
    try { vault = readVault(); }
    catch (error) { fail("Страница повреждена: не читаются зашифрованные данные."); return; }

    $("webLogout").addEventListener("click", function () {
      storage("del");
      window.location.reload();
    });

    var form = $("gateForm"), button = $("gateSubmit");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var login = $("gateLogin").value, password = $("gatePassword").value;
      if (!login.trim() || !password) return;

      button.disabled = true;
      button.textContent = "Проверяю…";
      $("gateError").hidden = true;

      var key;
      deriveKey(login, password, vault)
        .then(function (derived) { key = derived; return openVault(derived, vault); })
        .then(function (data) {
          $("gatePassword").value = "";
          if ($("gateRemember").checked) {
            return crypto.subtle.exportKey("raw", key).then(function (raw) {
              storage("set", bytesToB64(raw));
              return data;
            });
          }
          storage("del");
          return data;
        })
        .then(unlock)
        .catch(function () {
          // Небольшая пауза после неудачи: перебирать руками неудобно.
          setTimeout(function () {
            button.disabled = false;
            button.textContent = "Войти";
            showGate("Неверный логин или пароль.");
            $("gatePassword").value = "";
            var gate = $("gate");
            gate.classList.remove("shake");
            void gate.offsetWidth;
            gate.classList.add("shake");
          }, 700);
        });
    });

    // Запомненный ключ: пробуем открыть сразу. Если пароль с тех пор
    // сменили, ключ не подойдёт — забываем его и просим войти заново.
    var remembered = storage("get");
    if (!remembered) { showGate(); return; }

    $("gate").hidden = true;
    $("loadingText").textContent = "Расшифровываю…";
    $("app").hidden = false;
    importStoredKey(remembered)
      .then(function (key) { return openVault(key, vault); })
      .then(unlock)
      .catch(function () {
        storage("del");
        showGate("Пароль был изменён — войди заново.");
      });
  }

  if (MODE === "web") bootWeb();
  else bootLocal();
}());
