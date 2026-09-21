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
        '<div class="club-next-links">' +
          '<a class="club-link" href="#/club">Календарь и состав →</a>' +
          (next ? watchLink(watchLinks().team, "Смотреть матч ↗") : "") +
        '</div>' +
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
      var info = matchInfo(g);
      var classes = ((g === club.next ? "mine " : "") + (info ? "openable" : "")).trim();
      var result = r
        ? "<span class='pill " + (r.code === "w" ? "zone" : r.code === "otl" ? "dim" : "hot") + "'>" +
            (r.win ? "победа" : "поражение") + (r.extra ? " · " + r.extra : "") + "</span>"
        : isAwaitingResult(g)
          ? "<span class='pill dim'>ждём итог</span>"
          : "<span class='pill dim'>" + esc(fmtTime(g.start_at)) + "</span>";
      return "<tr" + (classes ? " class='" + classes + "'" : "") +
        (info ? " data-day='" + esc(matchDay(g)) + "' title='Открыть разбор матча'" : "") + ">" +
        "<td class='l dim'>" + esc(fmtDay(g.start_at)) + ", " + esc(fmtWeekday(g.start_at)) + "</td>" +
        "<td class='l dim'>" + (home ? "дома" : "в гостях") + "</td>" +
        "<td class='l'>" + crest(oppId) + esc(opp) + "</td>" +
        "<td class='strong'>" + (r ? r.mine + ":" + r.theirs : "—") + "</td>" +
        "<td class='l'>" + result + (info ? " <span class='open-hint'>разбор</span>" : "") + "</td>" +
      "</tr>";
    }).join("");
    wireMatchRows($("clubGames"));
    $("clubGames").innerHTML = head + "<tbody>" +
      (body || "<tr><td class='l dim' colspan='5'>Матчей нет.</td></tr>") + "</tbody>";

    renderClubWatch(club);

    // Лазарет клуба: данные клуба, твои отметки и новости вместе.
    $("clubInjuries").innerHTML = club.injuries.length
      ? "<div class='table-scroll'><table class='grid'><tbody>" + club.injuries.map(function (i) {
          var source = i.source === "club" ? "данные клуба" : i.source === "manual" ? "твоя отметка" : "из новостей";
          var note = i.source === "manual" && i.note ? "<div class='inj-note'>" + esc(i.note) + "</div>" : "";
          return "<tr><td class='l'>" + esc(i.player) + note + "</td>" +
            "<td class='l'><span class='pill hot'>" + esc(i.status || "травма") + "</span></td>" +
            "<td class='l dim'>" + esc(i.until || i.term || "") + "</td>" +
            "<td class='l dim'>" + esc(source) + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<p class="empty">Травмированных нет' + (club.official ? " — по данным клуба." : ".") + '</p>';

    var leaders = club.roster.filter(function (p) { return p.gp; })
      .sort(function (a, b) { return (b.pts - a.pts) || (b.g - a.g); }).slice(0, 5);
    $("clubLeaders").innerHTML = leaders.length
      ? "<div class='table-scroll'><table class='grid'><tbody>" + leaders.map(function (p, i) {
          return "<tr class='openable' data-player='" + esc(p.name) + "'><td class='dim'>" + (i + 1) + "</td><td class='l'>" + esc(p.name) + "</td>" +
            "<td class='dim'>" + p.g + "+" + p.a + "</td><td class='strong'>" + p.pts + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<p class="empty">Статистики пока нет.</p>';

    $("clubRosterNote").textContent = club.official
      ? "Состав — по данным официального сайта клуба (" + club.roster.length + " игроков), статистика — по данным лиги. У тех, кто ещё не выходил на лёд, нули."
      : "Состав — по данным лиги: в нём только игроки, у которых уже есть статистика в сезоне.";

    var photos = clubPhotos(club.team.id), hurt = hurtKeys(club);
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
        var media = photos[nameKey(p.name)] || {};
        var flags = (p.injured || hurt[nameKey(p.name)] ? " <span class='pill hot'>травма</span>" : "") +
                    (p.farm_club ? " <span class='pill dim'>фарм</span>" : "");
        var face = media.photo
          ? "<img class='ava' src='" + esc(photoUrl(media.photo)) + "' alt='' loading='lazy' decoding='async'>" : "";
        return "<tr class='openable' data-player='" + esc(p.name) + "' title='Открыть карточку игрока'><td class='l'><span class='num-badge'>" + esc(p.number != null ? p.number : "") + "</span></td>" +
          "<td class='l'>" + face + esc(p.name) + flags + "</td><td>" + (p.gp || 0) + "</td>" +
          (goalie ? ""
                  : "<td>" + (p.g || 0) + "</td><td>" + (p.a || 0) + "</td><td class='strong'>" + (p.pts || 0) +
                    "</td><td>" + signed(p.plus_minus) + "</td>") +
          "</tr>";
      }).join("");
      return '<div class="panel"><h3 class="panel-head">' + esc(group.title) +
        ' <span style="color:var(--muted);font-weight:400">' + list.length + '</span></h3>' +
        '<div class="table-scroll"><table class="grid">' + headRow + "<tbody>" + rows + "</tbody></table></div></div>";
    }).join("");

    wirePlayerRows($("clubRoster"), club.team.id);
    wirePlayerRows($("clubLeaders"), club.team.id);
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
      renderWings();
    });
  }

  function updateClubTab() {
    var team = APP.myTeam ? teamById(APP.myTeam) : null;
    $("clubTab").textContent = team ? team.name : "Мой клуб";
    moveTabPill(currentView());
  }

  /* ================================ крылья ================================ */

  // На вкладке клуба свободные поля по бокам широкого экрана отданы ему:
  // слева лента портретов, справа снимки с матчей вперемешку с фактами.
  // Ленты плывут навстречу друг другу и откликаются на прокрутку страницы.
  // Строятся, только когда открыта вкладка клуба и экран достаточно широк:
  // на других вкладках и на телефоне фото не качаются.
  var WIDE = window.matchMedia("(min-width: 1500px)");
  var WING_SPEED = 0.022;      // пикселей в миллисекунду — около 22 в секунду
  var WING_SCROLL = 0.35;      // какую долю прокрутки страницы повторяют ленты
  var wingState = { lanes: [], running: false, last: 0, shown: null };

  function photoUrl(name) {
    return (MODE === "web" ? "photos/" : "/photos/") + encodeURIComponent(name);
  }

  // Клуб пишет «Берёзкин», лига иногда «Березкин» — сравниваем без «ё».
  function nameKey(name) {
    return String(name || "").toLowerCase().replace(/ё/g, "е").trim();
  }

  function clubPhotos(teamId) {
    var map = {};
    ((APP.data.club_rosters || {})[String(teamId)] || []).forEach(function (m) {
      map[nameKey(m.name)] = m;
    });
    return map;
  }

  // Травмирован — если так считает клуб или игрок есть в лазарете.
  function hurtKeys(club) {
    var keys = {};
    club.injuries.forEach(function (i) { keys[nameKey(i.player)] = true; });
    return keys;
  }

  function roleShort(key) {
    return key === "goaltender" ? "вр" : key === "defenseman" ? "защ" : "нап";
  }

  function wordForm(n, one, few, many) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function playerLine(x) {
    var p = x.p, role = roleShort(p.role_key);
    if (x.hurt) return role + " · лечится";
    if (!p.gp) return role + " · ещё не играл";
    var line = role + " · " + p.gp + " И";
    return p.role_key === "goaltender" ? line : line + " · " + (p.g || 0) + "+" + (p.a || 0);
  }

  function wingPlayers(club) {
    var photos = clubPhotos(club.team.id), hurt = hurtKeys(club);
    return club.roster.map(function (p) {
      var media = photos[nameKey(p.name)] || {};
      return { p: p, photo: media.photo, action: media.action, hurt: !!(p.injured || hurt[nameKey(p.name)]) };
    });
  }

  function portraitCard(x) {
    var p = x.p;
    return '<figure class="pcard' + (x.hurt ? " hurt" : "") + '" data-player="' + esc(p.name) + '">' +
      '<img src="' + esc(photoUrl(x.photo)) + '" alt="" loading="lazy" decoding="async" draggable="false">' +
      (p.number != null ? '<span class="pno">' + esc(p.number) + '</span>' : "") +
      (x.hurt ? '<span class="ptag">травма</span>' : "") +
      '<figcaption class="pname">' + esc(String(p.name).split(" ")[0]) +
        '<small>' + esc(playerLine(x)) + '</small></figcaption>' +
    '</figure>';
  }

  function actionCard(x) {
    var p = x.p;
    return '<figure class="acard" data-player="' + esc(p.name) + '">' +
      '<img src="' + esc(photoUrl(x.action)) + '" alt="" loading="lazy" decoding="async" draggable="false">' +
      '<figcaption>' + (p.number != null ? '<b>' + esc(p.number) + '</b>' : "") + esc(p.name) + '</figcaption>' +
    '</figure>';
  }

  function factTile(f) {
    return '<div class="fact' + (f.tone ? " " + esc(f.tone) : "") + '">' + (f.html || "") +
      (f.k ? '<span class="k">' + esc(f.k) + '</span>' : "") +
      '<span class="v">' + esc(f.v) + '</span></div>';
  }

  // Живые факты из данных сезона плюс постоянные из club_facts.
  function wingFacts(club) {
    var row = club.row || {}, facts = [];
    facts.push({
      tone: "crest", k: club.team.location || "", v: club.team.name,
      html: crest(club.team.id, "big").replace('class="crest ', 'class="club-crest ')
    });
    if (row.position) {
      facts.push({ k: "Сейчас", v: row.position + "-е на " + (row.conference_key === "east" ? "Востоке" : "Западе") });
      facts.push({ k: "В таблице", v: row.pts + " " + wordForm(row.pts, "очко", "очка", "очков") });
    }
    if (club.streak.count >= 2) {
      facts.push({ k: "Серия", v: streakText(club.streak), tone: club.streak.win ? "good" : "" });
    }
    ((APP.data.club_facts || {})[String(club.team.id)] || []).forEach(function (f) { facts.push(f); });
    if (club.next) {
      var home = club.next.home_id === club.team.id;
      facts.push({
        k: "Дальше · " + fmtDay(club.next.start_at) + (home ? " · дома" : " · в гостях"),
        v: home ? club.next.away : club.next.home
      });
    }
    return facts;
  }

  function buildLane(el, html, count, down) {
    var track = el.querySelector(".wing-track");
    track.innerHTML = html + html;           // вторая копия — для бесшовной петли
    track.style.transform = "";
    el.onmouseenter = function () { lane.hover = true; };
    el.onmouseleave = function () { lane.hover = false; };
    el.onclick = function (event) {
      var card = event.target.closest("[data-player]");
      if (card) openPlayer(card.getAttribute("data-player"), APP.myTeam);
    };
    var lane = { el: el, track: track, count: count, down: down, half: 0, t: 0, speed: 1, hover: false };
    return lane;
  }

  // Высота одной копии ленты = отступ первой карточки второй копии.
  function measureWings() {
    var mast = document.querySelector(".masthead");
    if (mast) document.documentElement.style.setProperty("--mast-h", mast.offsetHeight + "px");
    wingState.lanes.forEach(function (lane) {
      var first = lane.track.children[lane.count];
      lane.half = first ? first.offsetTop - lane.track.children[0].offsetTop : 0;
    });
  }

  function renderWings() {
    var host = $("wings");
    if (!host) return;
    wingState.shown = wingsWanted();
    var club = APP.myTeam && wingState.shown ? clubModel(APP.myTeam) : null;
    var list = club ? wingPlayers(club) : [];
    var portraits = list.filter(function (x) { return x.photo; });
    if (portraits.length < 4) {
      host.hidden = true;
      stopWings();
      wingState.lanes = [];
      return;
    }
    host.hidden = false;

    portraits.sort(function (a, b) { return (a.p.number == null ? 999 : a.p.number) - (b.p.number == null ? 999 : b.p.number); });
    // Справа сначала лидеры по очкам; через каждые три снимка — факт о клубе.
    var actions = list.filter(function (x) { return x.action; }).sort(function (a, b) {
      return ((b.p.pts || 0) - (a.p.pts || 0)) || ((b.p.gp || 0) - (a.p.gp || 0));
    });
    var facts = wingFacts(club), right = [], f = 0;
    actions.forEach(function (x, i) {
      if (i % 3 === 0 && f < facts.length) right.push(factTile(facts[f++]));
      right.push(actionCard(x));
    });
    while (f < facts.length) right.push(factTile(facts[f++]));

    wingState.lanes = [
      buildLane($("wingL"), portraits.map(portraitCard).join(""), portraits.length, false),
      buildLane($("wingR"), right.join(""), right.length, true)
    ];

    var edge = [club.team.name, club.team.location, "мой клуб"].filter(Boolean).join("  ·  ");
    $("edgeL").textContent = $("edgeR").textContent = [edge, edge, edge].join("  ·  ");

    measureWings();
    // Шрифты догружаются позже и меняют высоту подписей — перемеряем.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureWings);
    startWings();
  }

  function wingsFrame(now) {
    var dt = Math.min(100, Math.max(0, now - (wingState.last || now)));
    wingState.last = now;
    var scroll = (lenis ? lenis.scroll : window.pageYOffset) * WING_SCROLL;
    wingState.lanes.forEach(function (lane) {
      if (!lane.half) return;
      // Под курсором лента плавно замирает, после — так же плавно трогается.
      lane.speed += ((lane.hover ? 0 : 1) - lane.speed) * Math.min(1, dt / 220);
      lane.t += dt * WING_SPEED * lane.speed;
      var offset = ((lane.t + scroll) % lane.half + lane.half) % lane.half;
      var y = lane.down ? offset - lane.half : -offset;
      lane.track.style.transform = "translate3d(0," + y.toFixed(1) + "px,0)";
    });
  }

  function wingsTick(time) { wingsFrame(time * 1000); }

  function startWings() {
    // Без движения — ленты просто стоят, но смотреть на них можно.
    if (REDUCED || wingState.running) return;
    wingState.running = true;
    wingState.last = 0;
    if (HAS_GSAP) { window.gsap.ticker.add(wingsTick); return; }
    var loop = function (now) {
      if (!wingState.running) return;
      wingsFrame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function stopWings() {
    if (!wingState.running) return;
    wingState.running = false;
    if (HAS_GSAP) window.gsap.ticker.remove(wingsTick);
  }

  function wingsWanted() {
    return WIDE.matches && currentView() === "club";
  }

  // Сменилась вкладка или экран перешёл границу ширины — собрать или убрать крылья.
  function syncWings() {
    if (wingsWanted() !== wingState.shown) renderWings();
    else if (wingState.lanes.length) measureWings();
  }

  function setupWings() {
    if (WIDE.addEventListener) WIDE.addEventListener("change", syncWings);
    else if (WIDE.addListener) WIDE.addListener(syncWings);
  }

  /* ============================ где смотреть ============================ */

  // Права на трансляции КХЛ у Кинопоиска: встроить их плеер в свою страницу
  // нельзя (подписка и защита от копирования), поэтому даём прямые ссылки —
  // на клуб и на матч. Адреса лежат в site.json, ключ «watch».
  function watchLinks() { return APP.data.watch || {}; }

  function watchLink(url, label) {
    var safe = safeUrl(url);
    if (!safe) return "";
    return '<a class="watch-go" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">' +
      esc(label) + "</a>";
  }

  function khlGameLink(game, label) {
    var stage = watchLinks().khl_stage;
    if (!stage || !game.match_id) return "";
    return watchLink("https://www.khl.ru/game/" + encodeURIComponent(stage) + "/" +
      encodeURIComponent(game.match_id) + "/" + (game.state === "finished" ? "resume" : "preview") + "/", label);
  }

  function renderClubWatch(club) {
    var host = $("clubWatch");
    if (!host) return;
    var links = watchLinks();
    var parts = [
      watchLink(links.team, "«" + club.team.name + "» на Кинопоиске"),
      watchLink(links.league, "Вся КХЛ")
    ].filter(Boolean);
    host.innerHTML = parts.length
      ? "Где смотреть: " + parts.join(" · ") +
        '<span class="dim"> — трансляции идут на Кинопоиске, нужна подписка.</span>'
      : "";
  }

  /* ============================= лист матча ============================= */

  // Протокола матчей в API лиги нет, зато его выкладывает сам клуб: кто забил
  // и с чьих передач, командные числа, отчёт о матче и стенограмма
  // послематчевой пресс-конференции. Щелчок по сыгранной игре открывает это.
  function matchDay(game) { return String(game.start_at || "").slice(0, 10); }

  function matchInfo(game) {
    var id = APP.data.my_team_id;
    if (!game || game.state !== "finished" || id == null) return null;
    if (game.home_id !== id && game.away_id !== id) return null;
    return (APP.data.club_games || {})[matchDay(game)] || null;
  }

  function gameByDay(day) {
    var id = APP.data.my_team_id;
    return (APP.data.games || []).filter(function (g) {
      return matchDay(g) === day && (g.home_id === id || g.away_id === id);
    })[0] || null;
  }

  function periodName(period, game) {
    if (period <= 3) return period + "-й период";
    var shootout = game && game.periods && game.periods.so;
    return (period >= 5 || shootout) ? "буллиты" : "овертайм";
  }

  function goalRow(goal, game) {
    var scorer = goal.scorer || {};
    var assists = (goal.assists || []).map(function (a) { return esc(a.name); }).join(" · ");
    return '<li class="goal' + (goal.mine ? " mine" : "") + '">' +
      '<span class="g-when"><b>' + esc(goal.time || "") + '</b><i>' + esc(periodName(goal.period, game)) + '</i></span>' +
      '<span class="g-score">' + esc(goal.score || "") + '</span>' +
      '<span class="g-who"><b>' + esc(scorer.name || "") +
        (scorer.number != null ? ' <i>№' + esc(scorer.number) + '</i>' : "") + '</b>' +
        (scorer.season ? '<i class="g-tally">' + esc(scorer.season) + '-я шайба в сезоне</i>' : "") +
        (assists ? '<span class="g-ass">передачи: ' + assists + '</span>' : "") +
      '</span>' +
      (goal.power_play ? '<span class="g-tag">большинство</span>' : "") +
    '</li>';
  }

  var SHEET_STATS = [
    { key: "shots",   label: "Броски в створ" },
    { key: "blocked", label: "Блокированные броски" },
    { key: "hits",    label: "Силовые приёмы" },
    { key: "penalty", label: "Штраф, минут" },
    { key: "attack",  label: "Время в атаке" }
  ];

  // Время вида «21:33» для полосы переводим в секунды, остальное — как есть.
  function statValue(value) {
    var text = String(value == null ? "" : value);
    if (text.indexOf(":") > -1) {
      var parts = text.split(":");
      return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
    }
    return Number(text) || 0;
  }

  function statRow(label, pair) {
    var mine = statValue(pair[0]), theirs = statValue(pair[1]);
    var total = mine + theirs;
    var share = total ? Math.round((mine / total) * 100) : 50;
    return '<div class="sheet-stat">' +
      '<b>' + esc(pair[0] == null ? "—" : pair[0]) + '</b>' +
      '<span class="s-mid"><i>' + esc(label) + '</i>' +
        '<span class="s-bar"><u style="width:' + share + '%"></u></span></span>' +
      '<b>' + esc(pair[1] == null ? "—" : pair[1]) + '</b>' +
    '</div>';
  }

  // Отчёт — обычные абзацы. Пресс-конференция — разговор: «Фамилия:» это
  // говорящий, вопрос журналиста и ответ клуб часто склеивает в один абзац,
  // поэтому разрезаем их по «? —».
  function sheetArticle(article, empty, talk) {
    if (!article) return '<p class="empty">' + esc(empty) + '</p>';
    var body = [];
    (article.text || []).forEach(function (line) {
      if (/^[^:]{2,48}:$/.test(line)) {
        body.push('<h4 class="speaker">' + esc(line.replace(/:$/, "")) + '</h4>');
        return;
      }
      if (!talk) {
        body.push("<p>" + esc(line) + "</p>");
        return;
      }
      if (/^Вопрос/i.test(line) && line.length < 20) {
        body.push('<p class="qhead">' + esc(line) + '</p>');
        return;
      }
      line.replace(/\?\s*[-\u2013\u2014]\s+/g, "?\n").split("\n").forEach(function (piece) {
        var text = piece.replace(/^[-\u2013\u2014]\s*/, "").trim();
        if (text) body.push('<p class="' + (/\?$/.test(text) ? "ask" : "say") + '">' + esc(text) + '</p>');
      });
    });
    return '<h3>' + esc(article.title) + '</h3>' +
      (article.lead ? '<p class="lead">' + esc(article.lead) + '</p>' : "") + body.join("");
  }

  function sheetHtml(game, info) {
    var id = APP.data.my_team_id;
    var result = outcome(game, id);
    var meta = [
      fmtDayFull(game.start_at) + ", " + fmtWeekday(game.start_at) + ", " + fmtTime(game.start_at),
      info.arena || game.location,
      info.audience ? info.audience + " " + wordForm(Number(info.audience), "зритель", "зрителя", "зрителей") : ""
    ].filter(Boolean).join(" · ");

    // В протоколе тренер записан как «Квартальнов Дмитрий Вячеславович».
    var coaches = [info.coach_mine, info.coach_rival].filter(Boolean).map(function (name) {
      var parts = name.split(" ");
      return parts.length > 1 ? parts[1] + " " + parts[0] : name;
    }).join(" — ");

    var goals = (info.goals || []).map(function (g) { return goalRow(g, game); }).join("");
    var stats = SHEET_STATS.filter(function (row) { return (info.stats || {})[row.key]; })
      .map(function (row) { return statRow(row.label, info.stats[row.key]); }).join("");

    return '<header class="sheet-head">' +
        '<p class="sheet-meta">' + esc(meta) + '</p>' +
        '<div class="sheet-score">' +
          '<span class="s-team">' + crest(game.home_id, "big").replace('class="crest ', 'class="s-crest ') +
            '<b>' + esc(game.home) + '</b></span>' +
          '<span class="s-num"><b>' + esc(game.score || "") + '</b><i>' + esc(periodsText(game)) + '</i></span>' +
          '<span class="s-team">' + crest(game.away_id, "big").replace('class="crest ', 'class="s-crest ') +
            '<b>' + esc(game.away) + '</b></span>' +
        '</div>' +
        '<p class="sheet-tag">' +
          (result ? '<span class="pill ' + (result.code === "w" ? "zone" : result.code === "otl" ? "dim" : "hot") + '">' +
            (result.win ? "победа" : "поражение") + (result.extra ? " · " + result.extra : "") + '</span>' : "") +
          (coaches ? '<span class="dim">тренеры: ' + esc(coaches) + '</span>' : "") +
        '</p>' +
        '<p class="sheet-links">' +
          watchLink(watchLinks().team, "Повтор на Кинопоиске ↗") +
          khlGameLink(game, "Матч на сайте КХЛ ↗") +
        '</p>' +
      '</header>' +
      '<h2 class="sheet-sec">Голы</h2>' +
      (goals ? '<ol class="goals">' + goals + '</ol>' : '<p class="empty">В этом матче не забивали.</p>') +
      (stats ? '<h2 class="sheet-sec">Матч в числах</h2><div class="sheet-stats">' + stats + '</div>' : "") +
      '<h2 class="sheet-sec">Отчёт клуба</h2>' +
      '<article class="sheet-text">' + sheetArticle(info.report, "Клуб не публиковал отчёт об этом матче.") + '</article>' +
      '<h2 class="sheet-sec">После матча</h2>' +
      '<article class="sheet-text talk">' +
        sheetArticle(info.presser, "Пресс-конференцию после этого матча клуб не публиковал — так бывает после выездных игр.", true) +
      '</article>';
  }

  function openSheet(game) {
    var info = matchInfo(game);
    if (!info) return;
    showSheet(sheetHtml(game, info));
  }

  // Один лист на всё: разбор матча и карточка игрока открываются в нём же.
  function showSheet(html) {
    $("sheetBody").innerHTML = html;
    var sheet = $("matchSheet");
    sheet.hidden = false;
    document.body.classList.add("sheet-open");
    sheet.querySelector(".sheet-card").scrollTop = 0;
    if (lenis) lenis.stop();
    if (canAnimate()) {
      window.gsap.fromTo(sheet.querySelector(".sheet-card"),
        { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" });
    }
  }

  function closeSheet() {
    var sheet = $("matchSheet");
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    document.body.classList.remove("sheet-open");
    $("sheetBody").innerHTML = "";
    if (lenis) lenis.start();
  }

  function wireSheet() {
    var sheet = $("matchSheet");
    if (!sheet) return;
    sheet.addEventListener("click", function (event) {
      if (event.target.closest("[data-sheet-close]")) { closeSheet(); return; }
      // Из карточки игрока — в разбор матча, где он забил или отдал пас.
      var moment = event.target.closest("[data-day]");
      if (moment && sheet.contains(moment)) {
        var game = gameByDay(moment.getAttribute("data-day"));
        if (game) openSheet(game);
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeSheet();
    });
  }

  // Щелчок по строке матча в любой таблице, где есть data-day.
  function wireMatchRows(table) {
    if (!table) return;
    table.onclick = function (event) {
      var row = event.target.closest("tr[data-day]");
      if (!row) return;
      var game = gameByDay(row.getAttribute("data-day"));
      if (game) openSheet(game);
    };
  }

  /* =========================== карточка игрока =========================== */

  // Щелчок по игроку — на крыле, в составе клуба, среди лидеров или в общей
  // таблице — открывает его карточку: анкета с сайта клуба, цифры сезона,
  // голы и передачи по протоколам матчей, травма и биография. Для игроков
  // других клубов анкеты и протоколов нет — там только цифры лиги.
  function playerByName(name, teamId) {
    var key = nameKey(name);
    return (APP.data.players || []).filter(function (p) {
      return nameKey(p.name) === key && (teamId == null || Number(p.team_id) === Number(teamId));
    })[0] || null;
  }

  // В протоколе бывает «Кузин Артём В.» — сравниваем по фамилии и имени.
  function protoKey(name) {
    return nameKey(String(name || "").split(" ").slice(0, 2).join(" "));
  }

  function fmtDate(iso) {
    var d = parseDate(String(iso || "").slice(0, 10) + "T12:00:00");
    return d ? d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() : "";
  }

  function yearsSince(iso) {
    var born = parseDate(String(iso || "").slice(0, 10) + "T12:00:00");
    if (!born) return null;
    var now = new Date();
    var years = now.getFullYear() - born.getFullYear();
    if (now.getMonth() < born.getMonth() ||
        (now.getMonth() === born.getMonth() && now.getDate() < born.getDate())) years--;
    return years;
  }

  function fmtIce(minutes) {
    if (!minutes) return "—";
    var whole = Math.floor(minutes), seconds = Math.round((minutes - whole) * 60);
    if (seconds === 60) { whole++; seconds = 0; }
    return whole + ":" + String(seconds).padStart(2, "0");
  }

  // Голы и передачи игрока «моего» клуба по протоколам, с датой и соперником.
  function playerMoments(p) {
    var id = APP.data.my_team_id, key = protoKey(p.name), out = [];
    if (Number(p.team_id) !== Number(id)) return out;
    var games = APP.data.club_games || {};
    Object.keys(games).sort().forEach(function (day) {
      var game = gameByDay(day);
      (games[day].goals || []).forEach(function (goal) {
        if (!goal.mine) return;
        var kind = protoKey((goal.scorer || {}).name) === key ? "гол"
          : (goal.assists || []).some(function (a) { return protoKey(a.name) === key; }) ? "передача" : "";
        if (kind) out.push({ day: day, game: game, goal: goal, kind: kind });
      });
    });
    return out;
  }

  function momentRow(m) {
    var game = m.game, rival = "";
    if (game) rival = game.home_id === APP.data.my_team_id ? game.away : game.home;
    return '<li class="pl-moment" data-day="' + esc(m.day) + '" title="Открыть разбор матча">' +
      '<span class="pm-day">' + esc(fmtDay(m.day + "T12:00:00")) + '</span>' +
      '<span class="pm-vs">' + (game ? crest(game.home_id === APP.data.my_team_id ? game.away_id : game.home_id) : "") +
        esc(rival) + '</span>' +
      '<span class="pm-kind ' + (m.kind === "гол" ? "goal" : "assist") + '">' + esc(m.kind) + '</span>' +
      '<span class="pm-when">' + esc(m.goal.time || "") + ' · ' + esc(m.goal.score || "") +
        (m.goal.power_play ? " · в большинстве" : "") + '</span>' +
    '</li>';
  }

  function playerFacts(bio, p) {
    var facts = [];
    var age = yearsSince(bio.birth);
    if (bio.birth) facts.push(["Возраст", age + " " + wordForm(age, "год", "года", "лет") + " · " + fmtDate(bio.birth)]);
    if (bio.birth_place) facts.push(["Родился", bio.birth_place]);
    if (bio.country) facts.push(["Страна", bio.country]);
    if (bio.height || bio.weight) {
      facts.push(["Рост и вес", [bio.height ? bio.height + " см" : "", bio.weight ? bio.weight + " кг" : ""].filter(Boolean).join(" · ")]);
    }
    if (bio.grip) facts.push(["Хват", bio.grip]);
    if (bio.school) facts.push(["Школа", bio.school]);
    if (bio.debut) facts.push(["Первый матч за клуб", fmtDate(bio.debut)]);
    if (bio.contract_ends) facts.push(["Контракт до", fmtDate(bio.contract_ends)]);
    if (!facts.length && p.team) facts.push(["Клуб", p.team]);
    return facts.map(function (f) {
      return '<div class="pl-fact"><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>';
    }).join("");
  }

  function playerStats(p) {
    var goalie = p.role_key === "goaltender";
    var tiles = [["Матчи", p.gp || 0]];
    if (!goalie) {
      tiles.push(["Голы", p.g || 0], ["Передачи", p.a || 0], ["Очки", p.pts || 0],
        ["+/−", signed(p.plus_minus)], ["Штраф", (p.pim || 0) + " мин"],
        ["Время на льду", fmtIce(p.toi_avg)], ["Макс. скорость", p.top_speed ? dec(p.top_speed, 1) + " км/ч" : "—"]);
    }
    return tiles.map(function (t, i) {
      return '<div class="pl-stat' + (i === 3 ? " hot" : "") + '"><span>' + esc(t[0]) + '</span><b>' + esc(t[1]) + '</b></div>';
    }).join("");
  }

  function playerHtml(p) {
    var media = clubPhotos(p.team_id)[nameKey(p.name)] || {};
    var bio = media.bio || {};
    var injury = (APP.data.injuries || []).filter(function (i) { return nameKey(i.player) === nameKey(p.name); })[0];
    var hurt = injury || p.injured;
    var moments = playerMoments(p);
    var goals = moments.filter(function (m) { return m.kind === "гол"; }).length;
    var story = (bio.story || []).map(function (sec) {
      return '<h4 class="speaker">' + esc(sec.title) + '</h4>' +
        sec.text.map(function (line) { return "<p>" + esc(line) + "</p>"; }).join("");
    }).join("");
    var face = media.photo
      ? '<img class="pl-face" src="' + esc(photoUrl(media.photo)) + '" alt="">'
      : crest(p.team_id, "big").replace('class="crest ', 'class="pl-face crest-face ');
    var backdrop = media.action ? ' style="--pl-bg:url(&quot;' + esc(photoUrl(media.action)) + '&quot;)"' : "";
    var goalie = p.role_key === "goaltender";

    return '<header class="pl-head' + (media.action ? " has-bg" : "") + '"' + backdrop + '>' +
        face +
        '<div class="pl-id">' +
          (p.number != null ? '<span class="pl-no">' + esc(p.number) + '</span>' : "") +
          '<h2 class="pl-name">' + esc(p.name) + '</h2>' +
          '<p class="pl-role">' + esc(p.role || "") + ' · ' + crest(p.team_id) + esc(p.team || "") + '</p>' +
          (hurt ? '<span class="pill hot">травма' + (injury && (injury.until || injury.term) ? " · " + esc(injury.until || injury.term) : "") + '</span>' : "") +
        '</div>' +
      '</header>' +
      '<dl class="pl-facts">' + playerFacts(bio, p) + '</dl>' +
      (injury && injury.note ? '<p class="pl-note">' + esc(injury.note) + '</p>' : "") +
      '<h2 class="sheet-sec">Сезон 2026/27</h2>' +
      '<div class="pl-stats">' + playerStats(p) + '</div>' +
      (goalie ? '<p class="pl-hint">Для вратарей лига отдаёт только число матчей — сейвов и пропущенных в данных нет.</p>' : "") +
      (Number(p.team_id) === Number(APP.data.my_team_id)
        ? '<h2 class="sheet-sec">Голы и передачи' + (moments.length ? ' <i class="pl-count">' + goals + ' + ' + (moments.length - goals) + '</i>' : "") + '</h2>' +
          (moments.length ? '<ol class="pl-moments">' + moments.map(momentRow).join("") + '</ol>'
                          : '<p class="empty">В протоколах этого сезона его голов и передач пока нет.</p>')
        : "") +
      (story ? '<h2 class="sheet-sec">Биография</h2><article class="sheet-text">' + story +
        '<p class="pl-source">По материалам официального сайта ХК «Локомотив».</p></article>' : "");
  }

  function openPlayer(name, teamId) {
    var p = playerByName(name, teamId) || playerByName(name);
    if (p) showSheet(playerHtml(p));
  }

  // Щелчок по любой строке с data-player внутри таблицы.
  function wirePlayerRows(host, teamId) {
    if (!host) return;
    host.onclick = function (event) {
      var row = event.target.closest("[data-player]");
      if (!row) return;
      var team = row.getAttribute("data-team");
      openPlayer(row.getAttribute("data-player"), team ? Number(team) : teamId);
    };
  }

  /* ================================ помним ================================ */

  // Вкладка памяти команды 2011 года. Пока она открыта, весь сайт меняет
  // облик (класс mourning на body): ни бирюзы, ни красного — тьма, слоновая
  // кость и тёплый свет свечи. Портреты проявляются из темноты по одному.
  function memYears(n) {
    return n + " " + wordForm(n, "год", "года", "лет");
  }

  function memPlayer(p, crashDay) {
    var meta = [p.role, p.captain ? "капитан" : "", p.country].filter(Boolean).join(" · ");
    var later = p.died && p.died !== crashDay ? "скончался " + fmtDayFull(p.died + "T12:00:00") : "";
    return '<figure class="mem-card" data-lit>' +
      '<div class="mem-photo">' +
        (p.photo ? '<img src="' + esc(photoUrl(p.photo)) + '" alt="' + esc(p.name) + '" loading="lazy" decoding="async">' : "") +
        (p.number != null ? '<span class="mem-num">' + esc(p.number) + '</span>' : "") +
      '</div>' +
      '<figcaption>' +
        '<b class="mem-name">' + esc(p.name) + '</b>' +
        '<span class="mem-years">' + esc(p.born) + ' — 2011</span>' +
        '<span class="mem-meta">' + esc(meta) + '</span>' +
        (later ? '<span class="mem-note">' + esc(later) + '</span>' : "") +
      '</figcaption>' +
    '</figure>';
  }

  // Без фото: инициалы в медальоне и огонёк свечи.
  function memPerson(x) {
    var initials = String(x.name).split(" ").map(function (w) { return w.charAt(0); }).join("");
    var about = [x.age ? memYears(x.age) : "", x.country || ""].filter(Boolean).join(" · ");
    return '<div class="mem-person" data-lit>' +
      '<span class="mem-medal" aria-hidden="true">' + esc(initials) + '</span>' +
      '<b class="mem-name">' + esc(x.name) + '</b>' +
      '<span class="mem-meta">' + esc(x.role) + '</span>' +
      (about ? '<span class="mem-meta">' + esc(about) + '</span>' : "") +
    '</div>';
  }

  function memSection(title, body, note) {
    return '<section class="mem-group">' +
      '<h2 class="mem-sec"><span>' + esc(title) + '</span></h2>' +
      (note ? '<p class="mem-sub">' + esc(note) + '</p>' : "") + body +
    '</section>';
  }

  function renderMemory() {
    var m = APP.data.memorial || {};
    var crashDay = m.crash_day || "2011-09-07";
    var players = m.players || [];
    var now = new Date();
    var years = now.getFullYear() - 2011 -
      ((now.getMonth() < 8 || (now.getMonth() === 8 && now.getDate() < 7)) ? 1 : 0);
    var team = players.length + (m.coaches || []).length + (m.staff || []).length;

    var groups = [
      { key: "goaltender", title: "Вратари" },
      { key: "defenseman", title: "Защитники" },
      { key: "forward",    title: "Нападающие" }
    ].map(function (g) {
      var list = players.filter(function (p) { return p.role_key === g.key; })
        .sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
      if (!list.length) return "";
      return '<h3 class="mem-role">' + esc(g.title) + '</h3>' +
        '<div class="mem-grid">' + list.map(function (p) { return memPlayer(p, crashDay); }).join("") + '</div>';
    }).join("");

    var people = function (list) {
      return '<div class="mem-people">' + (list || []).map(memPerson).join("") + '</div>';
    };

    var memory = (m.memory || []).map(function (x) {
      return '<li data-lit><span class="mem-when">' + esc(x.when) + '</span><p>' + esc(x.what) + '</p></li>';
    }).join("");

    $("view-memory").innerHTML =
      '<header class="mem-hero">' +
        '<div class="candle" aria-hidden="true"><i class="glow"></i><i class="flame"></i><b class="wax"></b></div>' +
        '<p class="mem-date">7 сентября 2011</p>' +
        '<h1 class="mem-title">Помним</h1>' +
        '<p class="mem-lead">Хоккеисты, тренеры и сотрудники «Локомотива», погибшие в авиакатастрофе под Ярославлем. ' +
          'Команда летела в Минск на первый матч сезона.</p>' +
        '<div class="mem-count">' +
          '<div><b>' + team + '</b><span>хоккеистов, тренеров<br>и сотрудников клуба</span></div>' +
          '<div><b>' + (m.crew || []).length + '</b><span>членов<br>экипажа</span></div>' +
          '<div><b>' + years + '</b><span>' + esc(wordForm(years, "год", "года", "лет")) + ' со дня<br>катастрофы</span></div>' +
        '</div>' +
      '</header>' +

      '<div class="mem-story" data-lit>' +
        '<p>7 сентября 2011 года в 15:59 самолёт Як-42 с командой на борту взлетал из ярославского аэропорта Туношна. ' +
          'Он не смог набрать высоту и упал у реки Туношонки, недалеко от взлётной полосы.</p>' +
        '<p>На борту было 45 человек, погибли 44. Нападающий Александр Галимов выжил при падении, ' +
          'но через пять дней скончался в больнице. Выжил только инженер Александр Сизов.</p>' +
        '<p>Расследование назвало причиной ошибку экипажа: во время разбега кто-то из пилотов нажимал на тормозные педали. ' +
          '«Локомотив» снялся с чемпионата того сезона.</p>' +
      '</div>' +

      memSection("Хоккеисты", groups) +
      memSection("Тренеры", people(m.coaches)) +
      memSection("Сотрудники клуба", people(m.staff)) +
      memSection("Экипаж", people(m.crew), "Вместе с командой погибли семь человек из экипажа самолёта.") +
      memSection("Память", '<ol class="mem-timeline">' + memory + '</ol>') +

      '<footer class="mem-end" data-lit>' +
        '<div class="candle small" aria-hidden="true"><i class="glow"></i><i class="flame"></i><b class="wax"></b></div>' +
        '<p>Вечная память</p>' +
      '</footer>';

    lightUp($("view-memory"));
  }

  // Проявление из темноты по мере прокрутки. Если кадры не идут (фоновая
  // вкладка) или движение отключено — всё видно сразу.
  function lightUp(root) {
    var items = [].slice.call(root.querySelectorAll("[data-lit]"));
    if (!canAnimate() || !("IntersectionObserver" in window)) {
      items.forEach(function (node) { node.classList.add("lit"); });
      return;
    }
    root.classList.add("lit-armed");
    var seen = false;
    var observer = new IntersectionObserver(function (entries) {
      seen = true;
      var batch = entries.filter(function (e) { return e.isIntersecting; });
      batch.forEach(function (entry, i) {
        entry.target.style.transitionDelay = Math.min(i * 90, 900) + "ms";
        entry.target.classList.add("lit");
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    items.forEach(function (node) { observer.observe(node); });
    setTimeout(function () {
      if (seen) return;
      observer.disconnect();
      items.forEach(function (node) { node.classList.add("lit"); });
    }, 1500);
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
      var info = matchInfo(g);
      var classes = ((mine ? "mine " : "") + (info ? "openable" : "")).trim();
      return "<tr" + (classes ? " class='" + classes + "'" : "") +
        (info ? " data-day='" + esc(matchDay(g)) + "' title='Открыть разбор матча'" : "") + ">" +
        "<td class='l dim'>" + esc(fmtDayFull(g.start_at)) + ", " + esc(fmtWeekday(g.start_at)) + "</td>" +
        "<td class='dim'>" + esc(fmtTime(g.start_at)) + "</td>" +
        "<td class='l'>" + crest(g.home_id) + esc(g.home) + "</td>" +
        "<td class='strong'>" + (finished ? esc(g.score || "")
          : "<span class='pill dim'>" + (isAwaitingResult(g) ? "ждём итог" : "скоро") + "</span>") + "</td>" +
        "<td class='l'>" + crest(g.away_id) + esc(g.away) + "</td>" +
        "<td class='l dim'>" + esc(periodsText(g)) + "</td>" +
        "<td class='l dim'>" + esc(g.location || "") +
          (info ? " <span class='open-hint'>разбор</span>" : "") + "</td>" +
      "</tr>";
    }).join("");

    wireMatchRows($("gamesTable"));
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
      return "<tr class='openable" + (isMine(p.team_id) ? " mine" : "") + "' data-player='" + esc(p.name) +
        "' data-team='" + esc(p.team_id) + "'><td class='l dim'>" + (index + 1) + "</td>" + cells + "</tr>";
    }).join("");

    $("playersTable").innerHTML = sortableHead(PLAYER_COLS, playerSort, "<th class='l'>#</th>") +
      "<tbody>" + (body || "<tr><td class='l dim' colspan='12'>Никого не нашлось.</td></tr>") + "</tbody>";
    wireSort($("playersTable"), playerSort, renderPlayers);
    wirePlayerRows($("playersTable"));
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

  var VIEWS = ["overview","club","memory","games","table","odds","players","injuries"];
  var rendered = {};

  function currentView() {
    var name = (window.location.hash || "#/").replace(/^#\/?/, "").split("/")[0] || "overview";
    return VIEWS.indexOf(name) === -1 ? "overview" : name;
  }

  function paint(view) {
    if (rendered[view]) return;
    if (view === "overview") renderOverview();
    if (view === "club") renderClub();
    if (view === "memory") renderMemory();
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
    // Вкладка памяти меняет облик всего сайта, пока она открыта.
    document.body.classList.toggle("mourning", view === "memory");
    moveTabPill(view);
    paint(view);
    syncWings();

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
    syncWings();
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
    wireSheet();
    updateClubTab();
    setupWings();
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
