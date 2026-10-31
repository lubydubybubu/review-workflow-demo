/*
 * Review Workflow — static simulator UI.
 *
 * Builds every node with createElement/textContent (no HTML string sinks), keeps all state in this
 * closure (no storage, cookies, network or workers) and only reacts to button clicks: there are no
 * text inputs, forms, uploads or logins. See state.js for the rules.
 */
(function () {
  'use strict';

  var D = window.ReviewDemo;
  var REPO_URL = 'https://github.com/lubydubybubu/review-workflow-demo';
  var VIEWS = [
    { key: 'dashboard', label: '대시보드' },
    { key: 'mail', label: '메일 의뢰' },
    { key: 'reviews', label: '리뷰' },
    { key: 'calendar', label: '캘린더' },
    { key: 'about', label: '체험판 안내' }
  ];
  var WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
  var STATUS_LABELS = { pending: '대기', accepted: '승인됨', rejected: '무시됨', duplicate: '중복 연결' };

  var state = D.initialState();
  var ui = { view: 'dashboard', reviewId: null, year: 2026, month: 11, pending: null, menuOpen: false };

  var main = document.getElementById('main');
  var navList = document.getElementById('nav-list');
  var sidebar = document.getElementById('sidebar');
  var menuToggle = document.getElementById('menu-toggle');
  var dialog = document.getElementById('approve-dialog');
  var dialogValues = document.getElementById('approve-values');
  var toast = document.getElementById('toast');

  // ------------------------------------------------------------------ DOM helpers
  function h(tag, props, children) {
    var el = document.createElement(tag);
    props = props || {};
    if (props.className) el.className = props.className;
    if (props.text !== undefined && props.text !== null) el.textContent = String(props.text);
    if (props.attrs) {
      Object.keys(props.attrs).forEach(function (name) {
        if (/^on/i.test(name) || name.toLowerCase() === 'style') throw new Error('blocked attribute ' + name);
        el.setAttribute(name, String(props.attrs[name]));
      });
    }
    if (props.on) {
      Object.keys(props.on).forEach(function (ev) { el.addEventListener(ev, props.on[ev]); });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function button(label, onClick, className, attrs) {
    return h('button', { className: 'btn' + (className ? ' ' + className : ''), text: label, attrs: Object.assign({ type: 'button' }, attrs || {}), on: { click: onClick } });
  }

  function kv(pairs) {
    var dl = h('dl', { className: 'kv' });
    pairs.forEach(function (p) {
      dl.appendChild(h('dt', { text: p[0] }));
      dl.appendChild(h('dd', {}, [p[1]]));
    });
    return dl;
  }

  function shortDate(iso) {
    return +iso.slice(5, 7) + '.' + +iso.slice(8, 10);
  }

  function dateText(dates) {
    var parts = [];
    Object.keys(D.DATE_LABELS).forEach(function (k) {
      if (dates[k]) parts.push(D.DATE_LABELS[k] + ' ' + shortDate(dates[k]));
    });
    return parts.length ? parts.join(' · ') : '없음';
  }

  function pageHeader(title, sub) {
    return h('div', { className: 'page-header' }, [
      h('h1', { text: title, attrs: { tabindex: '-1', id: 'page-title' } }),
      sub ? h('p', { className: 'muted', text: sub }) : null
    ]);
  }

  function showToast(message, kind) {
    toast.className = 'toast is-visible' + (kind === 'error' ? ' is-error' : '');
    toast.setAttribute('data-kind', kind || 'ok');
    toast.textContent = message;
  }

  // ------------------------------------------------------------------ navigation
  function go(view, opts) {
    ui.view = view;
    ui.reviewId = opts && opts.reviewId ? opts.reviewId : null;
    setMenu(false);
    render();
    var title = document.getElementById('page-title');
    if (title) title.focus();
  }

  function setMenu(open) {
    ui.menuOpen = open;
    sidebar.classList.toggle('is-open', open);
    menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderNav() {
    var pending = D.dashboard(state).pendingCandidates;
    navList.replaceChildren();
    VIEWS.forEach(function (v) {
      var current = ui.view === v.key;
      var b = h('button', {
        className: 'nav-item' + (current ? ' is-current' : ''),
        attrs: Object.assign({ type: 'button', 'data-view': v.key }, current ? { 'aria-current': 'page' } : {}),
        on: { click: function () { go(v.key); } }
      }, [h('span', { text: v.label })]);
      if (v.key === 'mail' && pending > 0) {
        b.appendChild(h('span', { className: 'badge-count', text: pending, attrs: { 'aria-label': '대기 ' + pending + '건' } }));
      }
      navList.appendChild(h('li', {}, [b]));
    });
  }

  // ------------------------------------------------------------------ views
  function viewDashboard() {
    var d = D.dashboard(state);
    var frag = [pageHeader('대시보드', '기준일 2026년 10월 31일 (토) — 체험판은 날짜가 고정되어 있습니다')];
    frag.push(h('p', { className: 'inline-notice' }, [
      h('span', { className: 'dot', attrs: { 'aria-hidden': 'true' } }),
      '메일 의뢰 ',
      h('strong', { text: d.pendingCandidates + '건', attrs: { 'data-testid': 'dash-pending' } }),
      ' · ',
      button('확인하기', function () { go('mail'); }, 'btn-link')
    ]));
    var stats = [['지연', d.overdue, 'dash-overdue'], ['이번 주 남은 마감', d.dueThisWeek, 'dash-week'], ['진행 중 리뷰', d.activeReviews, 'dash-active']];
    frag.push(h('div', { className: 'stats' }, stats.map(function (s) {
      return h('div', { className: 'stat' }, [h('div', { className: 'stat-label', text: s[0] }), h('div', { className: 'stat-value', text: s[1], attrs: { 'data-testid': s[2] } })]);
    })));

    var total = Math.max(1, state.reviews.length);
    var groups = h('div', { className: 'stage-list', attrs: { 'data-testid': 'dash-stages' } });
    var lastGroup = null;
    d.stages.forEach(function (s) {
      if (s.group !== lastGroup) {
        groups.appendChild(h('div', { className: 'stage-group', text: s.group }));
        lastGroup = s.group;
      }
      groups.appendChild(h('div', { className: 'stage-row', attrs: { 'data-stage': s.key } }, [
        h('span', { className: 'stage-name', text: s.label }),
        h('progress', { attrs: { max: total, value: s.count, 'aria-label': s.label + ' ' + s.count + '건' } }),
        h('span', { className: 'stage-count', text: s.count })
      ]));
    });

    var upcoming = h('ul', { className: 'plain-list', attrs: { 'data-testid': 'dash-upcoming' } });
    if (!d.upcoming.length) upcoming.appendChild(h('li', { className: 'muted', text: '다가오는 일정이 없습니다. 메일 의뢰를 승인하면 생깁니다.' }));
    d.upcoming.forEach(function (e) {
      upcoming.appendChild(h('li', {}, [
        h('span', { className: 'date-tag', text: shortDate(e.date) }),
        button(e.label + ' · ' + e.title, function () { go('reviews', { reviewId: e.reviewId }); }, 'btn-link')
      ]));
    });

    var log = h('ol', { className: 'plain-list log', attrs: { 'data-testid': 'dash-log' } });
    if (!state.log.length) log.appendChild(h('li', { className: 'muted', text: '아직 기록이 없습니다.' }));
    state.log.slice().reverse().forEach(function (l) { log.appendChild(h('li', { text: '#' + l.seq + ' ' + l.text })); });

    frag.push(h('div', { className: 'grid-2' }, [
      h('section', { className: 'section' }, [h('h2', { className: 'section-title', text: '단계별 현황' }), groups]),
      h('section', { className: 'section' }, [
        h('h2', { className: 'section-title', text: '다가오는 일정' }), upcoming,
        h('h2', { className: 'section-title spaced', text: '체험 기록 (메모리)' }), log
      ])
    ]));
    return frag;
  }

  function candidateCard(c) {
    var isNewBrand = state.brands.indexOf(c.brand) === -1;
    var meta = h('div', { className: 'card-meta' }, [
      h('span', { text: c.from }),
      h('span', { text: c.received }),
      h('span', { className: 'fixture-note', text: 'fixture 표기값 ' + Math.round(c.fixtureConfidence * 100) + '% · AI 정확도 아님' }),
      h('span', { className: 'status status-' + c.status, text: STATUS_LABELS[c.status] })
    ]);
    var body = h('pre', { className: 'mail-body' });
    body.textContent = ['From: ' + c.from, 'Subject: ' + c.subject, ''].concat(c.body).join('\n');
    var actions = h('div', { className: 'card-actions' });
    if (c.status === 'pending') {
      actions.appendChild(button('리뷰로 등록', function () { openApprove(c.id); }, 'btn-primary', { 'data-action': 'approve' }));
      actions.appendChild(button('무시', function () { doReject(c.id); }, 'btn-ghost', { 'data-action': 'reject' }));
    } else if (c.status === 'accepted' || c.status === 'duplicate') {
      actions.appendChild(button('연결된 리뷰 ' + c.reviewId + ' 열기', function () { go('reviews', { reviewId: c.reviewId }); }, '', { 'data-action': 'open-review' }));
      actions.appendChild(button('다시 등록 시도 (거절 확인)', function () { tryApproveAgain(c.id); }, 'btn-ghost', { 'data-action': 'approve-again' }));
    } else {
      actions.appendChild(h('span', { className: 'muted', text: '무시됨 — 리뷰를 만들지 않았습니다. "체험 초기화"로 되돌릴 수 있습니다.' }));
    }
    return h('article', { className: 'card candidate', attrs: { 'data-candidate': c.id, 'data-status': c.status, 'aria-labelledby': 'subj-' + c.id } }, [
      meta,
      h('h2', { className: 'card-title', text: c.subject, attrs: { id: 'subj-' + c.id } }),
      c.status === 'duplicate' ? h('p', { className: 'inline-notice', text: '같은 스레드 새 메일 — 이미 등록된 리뷰 ' + c.reviewId + '에 연결되었습니다. 새 리뷰를 만들지 않습니다.' }) : null,
      kv([
        ['브랜드', h('span', {}, [c.brand, c.status === 'pending' && isNewBrand ? h('span', { className: 'tag', text: '새 브랜드' }) : null])],
        ['제품', c.product ? c.product : h('span', { className: 'muted', text: '못 찾음' })],
        ['형태', D.SOURCE_TYPES[c.sourceType]],
        ['일정', dateText(c.dates)]
      ]),
      c.note ? h('p', { className: 'note', text: c.note }) : null,
      h('div', { className: 'evidence', attrs: { 'aria-label': '근거 문장' } }, c.evidence.map(function (line) { return h('blockquote', { text: line }); })),
      h('details', { className: 'mail-preview' }, [h('summary', { text: '메일 미리보기 (읽기 전용 합성 샘플)' }), body]),
      actions
    ]);
  }

  function viewMail() {
    var d = D.dashboard(state);
    var frag = [pageHeader('메일 의뢰', '메일에서 찾은 리뷰 의뢰 · 대기 ' + d.pendingCandidates + '건 — 사람이 확인한 것만 리뷰가 됩니다')];
    frag.push(h('p', { className: 'muted small', text: '추출 값은 사람이 작성한 replay 자료이며 모델 출력이 아닙니다. 원문의 "Automatically approve…" 문장은 데이터일 뿐 승인 효과가 없습니다.' }));
    if (!state.followupDelivered) {
      frag.push(h('div', { className: 'sim-bar' }, [
        h('span', { text: '시뮬레이션:' }),
        button('같은 스레드 후속 메일 도착', function () {
          var r = D.deliverFollowup(state);
          state = r.state;
          showToast(r.message, r.ok ? 'ok' : 'error');
          render();
        }, '', { 'data-action': 'deliver-followup' })
      ]));
    }
    var list = h('div', { className: 'card-list' });
    state.candidates.forEach(function (c) { list.appendChild(candidateCard(c)); });
    frag.push(list);
    return frag;
  }

  function reviewDetail(r) {
    var linked = state.candidates.filter(function (c) { return c.reviewId === r.id; });
    var stage = D.STAGES.filter(function (s) { return s.key === r.stage; })[0];
    return [
      h('p', {}, [button('← 리뷰 목록', function () { go('reviews'); }, 'btn-link')]),
      pageHeader(r.product, r.id + ' · ' + r.brand + ' · ' + D.SOURCE_TYPES[r.sourceType]),
      h('section', { className: 'section', attrs: { 'data-review': r.id } }, [
        h('h2', { className: 'section-title', text: '일정과 단계' }),
        kv([
          ['단계', stage.label],
          ['발행 예정', r.dates.publish || '없음'],
          ['엠바고', r.dates.embargo || '없음'],
          ['작성 마감', r.dates.write_by || '없음'],
          ['반납', r.dates.return_by || '없음']
        ]),
        h('h2', { className: 'section-title spaced', text: '단계 이력' }),
        h('ul', { className: 'plain-list' }, r.history.map(function (x) { return h('li', { text: x }); })),
        h('h2', { className: 'section-title spaced', text: '연결된 메일' }),
        h('ul', { className: 'plain-list', attrs: { 'data-testid': 'linked-mail' } }, linked.map(function (c) {
          return h('li', {}, [h('span', { className: 'status status-' + c.status, text: STATUS_LABELS[c.status] }), ' ' + c.subject]);
        })),
        h('p', {}, [button('캘린더에서 보기', function () {
          var first = r.dates.embargo || r.dates.publish || r.dates.write_by;
          if (first) { ui.year = +first.slice(0, 4); ui.month = +first.slice(5, 7); }
          go('calendar');
        }, '')])
      ])
    ];
  }

  function viewReviews() {
    if (ui.reviewId) {
      var r = D.findReview(state, ui.reviewId);
      if (r) return reviewDetail(r);
    }
    var frag = [pageHeader('리뷰', '승인된 리뷰 ' + state.reviews.length + '건')];
    if (!state.reviews.length) {
      frag.push(h('p', { className: 'empty', text: '아직 승인된 리뷰가 없습니다. 메일 의뢰에서 사람이 승인하면 여기에 생깁니다.' }));
      return frag;
    }
    var tbody = h('tbody');
    state.reviews.forEach(function (r) {
      tbody.appendChild(h('tr', { attrs: { 'data-review-row': r.id } }, [
        h('td', {}, [button(r.id, function () { go('reviews', { reviewId: r.id }); }, 'btn-link')]),
        h('td', { text: r.product }),
        h('td', { text: r.brand }),
        h('td', { text: D.SOURCE_TYPES[r.sourceType] }),
        h('td', { text: D.STAGES.filter(function (s) { return s.key === r.stage; })[0].label }),
        h('td', { text: r.dates.publish || '—' }),
        h('td', { text: r.dates.embargo || '—' })
      ]));
    });
    var head = h('tr', {}, ['ID', '제품', '브랜드', '형태', '단계', '발행 예정', '엠바고'].map(function (t) { return h('th', { text: t, attrs: { scope: 'col' } }); }));
    frag.push(h('div', { className: 'table-wrap' }, [h('table', { className: 'table' }, [h('thead', {}, [head]), tbody])]));
    return frag;
  }

  function viewCalendar() {
    var events = D.calendarEvents(state);
    var monthKey = ui.year + '-' + String(ui.month).padStart(2, '0');
    var frag = [pageHeader('캘린더', '승인된 리뷰의 날짜가 같은 레코드에서 표시됩니다')];
    frag.push(h('div', { className: 'cal-toolbar' }, [
      button('← 이전 달', function () { shiftMonth(-1); }, '', { 'data-action': 'prev-month' }),
      h('h2', { className: 'cal-title', text: ui.year + '년 ' + ui.month + '월', attrs: { 'aria-live': 'polite', 'data-testid': 'cal-title' } }),
      button('다음 달 →', function () { shiftMonth(1); }, '', { 'data-action': 'next-month' })
    ]));
    var thead = h('thead', {}, [h('tr', {}, WEEKDAYS.map(function (w) { return h('th', { text: w, attrs: { scope: 'col' } }); }))]);
    var tbody = h('tbody');
    D.monthGrid(ui.year, ui.month).forEach(function (week) {
      var tr = h('tr');
      week.forEach(function (day) {
        var cls = 'cal-day' + (day.inMonth ? '' : ' is-outside') + (day.date === D.TODAY ? ' is-today' : '');
        var td = h('td', { className: cls, attrs: { 'data-date': day.date } }, [h('span', { className: 'cal-num', text: +day.date.slice(8, 10) })]);
        events.filter(function (e) { return e.date === day.date; }).forEach(function (e) {
          td.appendChild(button(e.label + ' · ' + e.title, function () { go('reviews', { reviewId: e.reviewId }); }, 'chip chip-' + e.kind, { 'data-event': e.reviewId + ':' + e.kind }));
        });
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    frag.push(h('div', { className: 'table-wrap' }, [h('table', { className: 'calendar' }, [h('caption', { className: 'sr-only', text: ui.year + '년 ' + ui.month + '월 달력' }), thead, tbody])]));
    var agenda = h('ul', { className: 'plain-list agenda', attrs: { 'data-testid': 'cal-agenda' } });
    var inMonth = events.filter(function (e) { return e.date.slice(0, 7) === monthKey; });
    if (!inMonth.length) agenda.appendChild(h('li', { className: 'muted', text: '이 달에는 일정이 없습니다.' }));
    inMonth.forEach(function (e) {
      agenda.appendChild(h('li', {}, [h('span', { className: 'date-tag', text: shortDate(e.date) }), e.label + ' · ' + e.title + ' (' + e.reviewId + ')']));
    });
    frag.push(h('section', { className: 'section' }, [h('h2', { className: 'section-title', text: '이 달의 일정' }), agenda]));
    return frag;
  }

  function shiftMonth(delta) {
    var m = ui.month + delta;
    ui.year += m < 1 ? -1 : m > 12 ? 1 : 0;
    ui.month = ((m + 11) % 12) + 1;
    render();
  }

  function externalLink(label, href) {
    return h('a', { text: label, attrs: { href: href, target: '_blank', rel: 'noopener noreferrer' } });
  }

  function viewAbout() {
    return [
      pageHeader('체험판 안내', '무엇이 시뮬레이션이고 무엇이 실제인지'),
      h('section', { className: 'section prose' }, [
        h('p', { text: '이 페이지는 브라우저 안에서만 동작하는 정적 시뮬레이터입니다. 합성 후보 3건과 후속 메일 1건이 코드에 들어 있고, 승인·무시·초기화는 이 탭의 메모리만 바꿉니다. 입력·상호작용 상태를 어떤 서버로도 보내지 않습니다(페이지 파일을 내려받는 일반 요청은 호스팅 서버가 봅니다).' }),
        h('p', { text: '실제 백엔드와 연결되어 있지 않습니다. 원래 앱(Next.js + PostgreSQL)은 저장소의 소스로 각자 로컬에서만 실행할 수 있으며, 저장소 문서의 스크린샷은 그 로컬 앱의 실제 실행 화면입니다. 이 체험판 화면과는 다릅니다.' }),
        h('p', { text: '"fixture 표기값 %"는 사람이 붙인 예시 주석입니다. AI 추출 정확도나 모델 점수가 아닙니다.' }),
        h('p', { text: '사람·회사·제품·메일은 모두 가상이며 .example 도메인을 씁니다.' }),
        h('h2', { className: 'section-title spaced', text: '소스와 사례 설명 (새 탭, 직접 클릭할 때만 이동)' }),
        h('ul', { className: 'plain-list' }, [
          h('li', {}, [externalLink('소스 저장소 (공개 후보)', REPO_URL)]),
          h('li', {}, [externalLink('사례 설명 (한국어)', REPO_URL + '/blob/main/CASE-STUDY.ko.md')]),
          h('li', {}, [externalLink('보안·위협 모델', REPO_URL + '/blob/main/SECURITY.md')])
        ])
      ])
    ];
  }

  // ------------------------------------------------------------------ actions
  function openApprove(candidateId) {
    var c = D.findCandidate(state, candidateId);
    ui.pending = { candidateId: candidateId, version: state.version, opener: document.activeElement };
    dialogValues.replaceChildren();
    [['브랜드', c.brand + (state.brands.indexOf(c.brand) === -1 ? ' (새 브랜드로 생성)' : '')],
      ['제품', c.product || '못 찾음 — 리뷰에는 "(제품 미정)"으로 기록'],
      ['형태', D.SOURCE_TYPES[c.sourceType]],
      ['발행 예정', c.dates.publish || '없음'],
      ['엠바고', c.dates.embargo || '없음'],
      ['작성 마감', c.dates.write_by || '없음'],
      ['반납', c.dates.return_by || '없음']].forEach(function (p) {
      dialogValues.appendChild(h('dt', { text: p[0] }));
      dialogValues.appendChild(h('dd', { text: p[1] }));
    });
    dialog.setAttribute('data-candidate', candidateId);
    dialog.showModal();
    document.getElementById('approve-cancel').focus();
  }

  function closeApprove() {
    var opener = ui.pending && ui.pending.opener;
    ui.pending = null;
    if (dialog.open) dialog.close();
    return opener;
  }

  function confirmApprove() {
    if (!ui.pending) return;
    var r = D.approve(state, ui.pending.candidateId, ui.pending.version);
    closeApprove();
    if (r.ok) state = r.state;
    showToast(r.message, r.ok ? 'ok' : 'error');
    render();
    var title = document.getElementById('page-title');
    if (title) title.focus();
  }

  function tryApproveAgain(candidateId) {
    var r = D.approve(state, candidateId, state.version);
    if (r.ok) state = r.state;
    showToast(r.message, r.ok ? 'ok' : 'error');
    render();
  }

  function doReject(candidateId) {
    var r = D.reject(state, candidateId);
    if (r.ok) state = r.state;
    showToast(r.message, r.ok ? 'ok' : 'error');
    render();
  }

  function reset() {
    closeApprove();
    state = D.initialState();
    ui.reviewId = null;
    ui.year = 2026;
    ui.month = 11;
    showToast('체험을 처음 상태로 되돌렸습니다. (메모리만 초기화)', 'ok');
    render();
  }

  // ------------------------------------------------------------------ render
  function render() {
    renderNav();
    var views = { dashboard: viewDashboard, mail: viewMail, reviews: viewReviews, calendar: viewCalendar, about: viewAbout };
    main.replaceChildren.apply(main, views[ui.view]());
    main.setAttribute('data-view', ui.view);
  }

  document.getElementById('approve-cancel').addEventListener('click', function () {
    var opener = closeApprove();
    if (opener && opener.focus) opener.focus();
  });
  document.getElementById('approve-confirm').addEventListener('click', confirmApprove);
  dialog.addEventListener('cancel', function () { ui.pending = null; });
  document.getElementById('reset-button').addEventListener('click', reset);
  menuToggle.addEventListener('click', function () {
    setMenu(!ui.menuOpen);
    if (ui.menuOpen) {
      var first = navList.querySelector('button');
      if (first) first.focus();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && ui.menuOpen) {
      setMenu(false);
      menuToggle.focus();
    }
  });

  render();
})();
