// Functional tests for the simulator rules (web-demo/state.js). Node built-ins only:
//   node --test tests/web-demo/state.test.mjs tests/web-demo/static.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../../web-demo/state.js');

const approved = (s, id) => {
  const r = D.approve(s, id, s.version);
  assert.equal(r.ok, true, r.message);
  return r.state;
};

test('initial state: three pending synthetic candidates, no reviews, nothing on calendar', () => {
  const s = D.initialState();
  assert.deepEqual(s.candidates.map((c) => [c.id, c.status]), [['c-lumora', 'pending'], ['c-corvane', 'pending'], ['c-pellwick', 'pending']]);
  assert.equal(s.reviews.length, 0);
  assert.deepEqual(D.calendarEvents(s), []);
  const d = D.dashboard(s);
  assert.equal(d.pendingCandidates, 3);
  assert.equal(d.activeReviews, 0);
  assert.equal(d.overdue, 0);
  for (const c of s.candidates) {
    for (const addr of c.from.match(/[\w.-]+@[\w.-]+/g)) assert.match(addr, /\.example$/);
  }
});

test('approval creates exactly one review and the same dates feed calendar and dashboard', () => {
  const s0 = D.initialState();
  const r = D.approve(s0, 'c-lumora', s0.version);
  assert.equal(r.ok, true);
  assert.equal(r.reviewId, 'R-001');
  const s = r.state;
  assert.equal(s0.reviews.length, 0, 'input state is not mutated');
  assert.equal(s.reviews.length, 1);
  assert.deepEqual(s.brands, ['Lumora']);
  const c = D.findCandidate(s, 'c-lumora');
  assert.equal(c.status, 'accepted');
  assert.equal(c.reviewId, 'R-001');
  const rev = D.findReview(s, 'R-001');
  assert.equal(rev.dates.publish, '2026-11-20');
  assert.equal(rev.dates.embargo, '2026-11-18');
  assert.equal(rev.dates.write_by, null);
  assert.deepEqual(D.calendarEvents(s).map((e) => [e.date, e.kind, e.reviewId]),
    [['2026-11-18', 'embargo', 'R-001'], ['2026-11-20', 'publish', 'R-001']]);
  const d = D.dashboard(s);
  assert.equal(d.pendingCandidates, 2);
  assert.equal(d.activeReviews, 1);
  assert.equal(d.stages.find((x) => x.key === 'intake').count, 1);
  assert.equal(d.upcoming.length, 2);
});

test('duplicate approval of the same candidate is refused and changes nothing', () => {
  const s = approved(D.initialState(), 'c-lumora');
  const again = D.approve(s, 'c-lumora', s.version);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'already_accepted');
  assert.equal(again.state, s);
  assert.equal(s.reviews.length, 1);
});

test('stale confirmation (state changed after the dialog opened) is refused', () => {
  const s0 = D.initialState();
  const opened = s0.version;
  const s1 = approved(s0, 'c-corvane');
  const r = D.approve(s1, 'c-lumora', opened);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale');
  assert.equal(r.state.reviews.length, 1);
});

test('same-thread follow-up after approval is linked as duplicate and cannot become a second review', () => {
  const s1 = approved(D.initialState(), 'c-lumora');
  const f = D.deliverFollowup(s1);
  assert.equal(f.ok, true);
  assert.equal(f.code, 'linked_duplicate');
  const fu = D.findCandidate(f.state, 'c-lumora-followup');
  assert.equal(fu.status, 'duplicate');
  assert.equal(fu.reviewId, 'R-001');
  const r = D.approve(f.state, 'c-lumora-followup', f.state.version);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'duplicate');
  assert.equal(f.state.reviews.length, 1);
  assert.equal(D.deliverFollowup(f.state).code, 'already_delivered');
});

test('follow-up before approval waits as pending and is refused once the thread owns a review', () => {
  const f = D.deliverFollowup(D.initialState());
  assert.equal(f.code, 'pending');
  const s = approved(f.state, 'c-lumora');
  const r = D.approve(s, 'c-lumora-followup', s.version);
  assert.equal(r.code, 'thread_has_review');
  assert.equal(s.reviews.length, 1);
});

test('reject creates no review; rejected candidate cannot be approved; reset restores the initial state', () => {
  const s0 = D.initialState();
  const r = D.reject(s0, 'c-pellwick');
  assert.equal(r.ok, true);
  assert.equal(D.findCandidate(r.state, 'c-pellwick').status, 'rejected');
  assert.equal(r.state.reviews.length, 0);
  assert.equal(D.approve(r.state, 'c-pellwick', r.state.version).code, 'rejected');
  assert.equal(D.reject(r.state, 'c-pellwick').code, 'not_pending');
  assert.deepEqual(D.initialState(), s0);
});

test('unknown candidate never guesses: no product, no dates', () => {
  const s = approved(D.initialState(), 'c-pellwick');
  const rev = s.reviews[0];
  assert.equal(rev.product, '(제품 미정)');
  assert.deepEqual(Object.values(rev.dates), [null, null, null, null]);
  assert.deepEqual(D.calendarEvents(s), []);
});

test('deterministic: the same action sequence gives byte-identical state', () => {
  const run = () => {
    let s = D.initialState();
    s = approved(s, 'c-lumora');
    s = approved(s, 'c-corvane');
    s = D.deliverFollowup(s).state;
    s = D.reject(s, 'c-pellwick').state;
    return JSON.stringify(s);
  };
  assert.equal(run(), run());
  const s = JSON.parse(run());
  assert.deepEqual(s.reviews.map((r) => r.id), ['R-001', 'R-002']);
  assert.deepEqual(s.log.map((l) => l.seq), [1, 2, 3, 4]);
});

test('month grid is Monday-first and contains the fixed today', () => {
  const g = D.monthGrid(2026, 10);
  assert.equal(g.length, 6);
  assert.equal(g[0][0].date, '2026-09-28');
  assert.ok(g.flat().some((d) => d.date === D.TODAY && d.inMonth));
  assert.deepEqual(D.dashboard(D.initialState()).week, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
});
