// match.mjs のテスト
//   実行: node --test scripts/reminder_import/
//   DB やネットには触らない

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv } from '../hj_import/supabase.mjs';
import {
  normalizeScale, splitScale, normalizeName, makerUnifier, similarity,
  prepareRow, indexKits, classify, kitIdFor, parseReleaseMonth,
} from './match.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const unify = makerUnifier(readCsv(path.join(SCRIPT_DIR, '..', 'hj_import', 'maker_aliases.csv')));

// CSV の行と DB のキットから判定する
function judge(csvRows, kits, aliases = []) {
  const prepared = csvRows.map((r) => prepareRow({ kit_name: r[0], maker: r[1], release_month: r[2] ?? '' }, unify));
  return classify(prepared, indexKits(kits, aliases, unify));
}
const kit = (id, name, maker, scale = null, extra = {}) =>
  ({ id, name, maker, scale, release_month: null, merged_into: null, ...extra });

// ---------------------------------------------------------------- スケール

test('スケール表記のゆれをそろえる', () => {
  for (const s of ['1/24', '1:24', '1／24', '１／２４', '１：２４', '1 / 24', '1/24スケール', '1/024']) {
    assert.equal(normalizeScale(s), '1/24', s);
  }
  assert.equal(normalizeScale(''), '');
  assert.equal(normalizeScale(null), '');
  assert.equal(normalizeScale('ノンスケール'), 'ノンスケール');
});

test('キット名からスケールを取り出す', () => {
  assert.deepEqual(splitScale('1/24 スバル BRZ'), { name: 'スバル BRZ', scale: '1/24' });
  assert.deepEqual(splitScale('スバル BRZ 1:24'), { name: 'スバル BRZ', scale: '1/24' });
  assert.deepEqual(splitScale('ＨＧ　ガンダム（１／１４４）'), { name: 'HG ガンダム', scale: '1/144' });
  assert.deepEqual(splitScale('ガンダム [1/100スケール]'), { name: 'ガンダム', scale: '1/100' });
  assert.deepEqual(splitScale('スバル BRZ'), { name: 'スバル BRZ', scale: '' });
});

test('スケールでない数字は取り出さない', () => {
  assert.equal(splitScale('F-14A トムキャット').scale, '');
  assert.equal(splitScale('ガンダム Ver.2.0').scale, '');
  assert.equal(splitScale('No.11/24号').scale, '');   // 11/24 は 1/24 ではない
  assert.equal(splitScale('2024/10 限定').scale, '');
});

test('名前がスケールだけなら名前はそのまま残す', () => {
  assert.deepEqual(splitScale('1/24'), { name: '1/24', scale: '1/24' });
});

// ---------------------------------------------------------------- 名前・メーカー

test('全角半角・大小文字・空白・中黒・ひらがなの違いをそろえる', () => {
  const k = normalizeName('ガンダム・エアリアル Ver.2');
  for (const s of ['ｶﾞﾝﾀﾞﾑ･ｴｱﾘｱﾙ　ＶＥＲ．２', 'ガンダムエアリアル ver2', 'がんだむ えありある Ver.2']) {
    assert.equal(normalizeName(s), k, s);
  }
});

test('記号のゆれをそろえる', () => {
  assert.equal(normalizeName('F‐14A'), normalizeName('F-14A'));
  assert.equal(normalizeName('【限定】ザク'), normalizeName('(限定)ザク'));
  assert.equal(normalizeName('「ヤマト」'), normalizeName('ヤマト'));
});

test('長音はハイフンにしない', () => {
  assert.notEqual(normalizeName('スーパー'), normalizeName('ス-パ-'));
});

test('メーカー名は対応表でそろえる', () => {
  assert.equal(unify('バンダイ'), 'BANDAI SPIRITS');
  assert.equal(unify(' ﾊﾞﾝﾀﾞｲ '), 'BANDAI SPIRITS');
  assert.equal(unify('アオシマ'), '青島文化教材社');
  assert.equal(unify('タミヤ'), 'タミヤ');
  assert.equal(unify(''), '');
});

test('似ている度合い', () => {
  assert.equal(similarity('abc', 'abc'), 1);
  assert.ok(similarity('ガンダムエアリアル', 'ガンダムエアリアル改修型') >= 0.8);
  assert.ok(similarity('ガンダムエアリアル', 'ザクⅡ') < 0.3);
});

// ---------------------------------------------------------------- 判定

test('完全に一致すれば重複(スケールの書き方・メーカーの表記が違っても)', () => {
  const [r] = judge([['1:24 スバル ＢＲＺ', 'アオシマ']], [kit('k1', 'スバル BRZ', '青島文化教材社', '1/24')]);
  assert.equal(r.status, '重複');
  assert.equal(r.match.id, 'k1');
});

test('DB 側の名前に入っているスケールも照合に使う', () => {
  const [r] = judge([['スバル BRZ', 'タミヤ']], [kit('k1', 'スバル BRZ 1/24', 'タミヤ')]);
  assert.equal(r.status, '要確認');   // スケールが片方にしかないので、同じとは言い切れない
  const [r2] = judge([['スバル BRZ 1/24', 'タミヤ']], [kit('k1', 'スバル BRZ 1/24', 'タミヤ')]);
  assert.equal(r2.status, '重複');
});

test('DB の別名と一致しても重複', () => {
  const [r] = judge([['エアリアル', 'バンダイ']],
    [kit('k1', 'ガンダム・エアリアル', 'BANDAI SPIRITS')], [{ kit_id: 'k1', alias: 'エアリアル' }]);
  assert.equal(r.status, '重複');
  assert.equal(r.match.id, 'k1');
});

test('統合済みキットの名前と一致したら、統合先のキットとの重複になる', () => {
  const [r] = judge([['旧名', 'タミヤ']],
    [kit('k1', '新名', 'タミヤ'), kit('k2', '旧名', 'タミヤ', null, { merged_into: 'k1' })]);
  assert.equal(r.status, '重複');
  assert.equal(r.match.id, 'k1');
});

test('一致するものがなければ新規', () => {
  const [r] = judge([['スバル BRZ', 'タミヤ', '2026-10']], [kit('k1', 'ザク', 'BANDAI SPIRITS')]);
  assert.equal(r.status, '新規');
  assert.equal(r.name, 'スバル BRZ');
  assert.equal(r.maker, 'タミヤ');
});

test('メーカーが空なら、DB に何もなくても要確認', () => {
  const [r] = judge([['スバル BRZ', '']], []);
  assert.equal(r.status, '要確認');
  assert.equal(r.reason, 'メーカーが空');
});

test('メーカーが空で、DB のメーカーも空のキットと名前が一致しても要確認', () => {
  const [r] = judge([['スバル BRZ', '  ']], [kit('k1', 'スバル BRZ', null)]);
  assert.equal(r.status, '要確認');
  assert.equal(r.reason, 'メーカーが空');
  assert.equal(r.candidates[0].id, 'k1');   // 候補として見せる
});

test('名前は同じでスケールが違えば要確認', () => {
  const [r] = judge([['スバル BRZ 1/32', 'タミヤ']], [kit('k1', 'スバル BRZ', 'タミヤ', '1/24')]);
  assert.equal(r.status, '要確認');
  assert.equal(r.reason, '名前は同じでメーカーかスケールが違う');
});

test('名前は同じでメーカーが違えば要確認', () => {
  const [r] = judge([['零戦52型 1/48', 'ハセガワ']], [kit('k1', '零戦52型', 'タミヤ', '1/48')]);
  assert.equal(r.status, '要確認');
});

test('名前が似ていれば要確認(同じメーカー)', () => {
  const [r] = judge([['HG ガンダムエアリアル', 'バンダイ']],
    [kit('k1', 'HG ガンダムエアリアル改修型', 'BANDAI SPIRITS', '1/144')]);
  assert.equal(r.status, '要確認');
  assert.equal(r.reason, '名前が似ている');
  assert.equal(r.candidates[0].id, 'k1');
});

test('メーカーが違えば、名前が似ているだけでは要確認にしない', () => {
  const [r] = judge([['HG ガンダムエアリアル', 'タミヤ']],
    [kit('k1', 'HG ガンダムエアリアル改修型', 'BANDAI SPIRITS')]);
  assert.equal(r.status, '新規');
});

test('CSV の中で同じキットが2回出たら2回目は重複', () => {
  const rs = judge([['スバル BRZ 1/24', 'タミヤ'], ['スバル BRZ 1/32', 'タミヤ'], ['1:24 スバルBRZ', 'タミヤ']], []);
  // 1・2件目は名前が同じでスケールだけ違うので、CSV の中で似ている行として要確認
  assert.deepEqual(rs.map((r) => r.status), ['要確認', '要確認', '重複']);
  assert.equal(rs[2].reason, 'CSV の 1 件目と同じ');
  // 取り込みスクリプトでは行番号(見出しが1行目)で出す
  const prepared = [{ kit_name: 'A', maker: 'タミヤ' }, { kit_name: 'A', maker: 'タミヤ' }]
    .map((r, i) => ({ line: i + 2, ...prepareRow(r, unify) }));
  assert.equal(classify(prepared, [])[1].reason, 'CSV の 2 行目と同じ');
});

// ---------------------------------------------------------------- CSV の中で似ている行

// 取り込みスクリプトと同じく行番号(見出しが1行目)を付けて判定する
function judgeLines(csvRows, kits = []) {
  const prepared = csvRows.map((r, i) =>
    ({ line: i + 2, ...prepareRow({ kit_name: r[0], maker: r[1], release_month: '' }, unify) }));
  return classify(prepared, indexKits(kits, [], unify));
}

test('記事タイトルのように言葉が足された書き方違いは、両方とも要確認', () => {
  const rs = judgeLines([
    ['コジマプロダクション設立10周年記念 プラモデルルーデンス', 'コトブキヤ'],
    ['コジマプロダクションルーデンスプラモデル', 'コトブキヤ'],
  ]);
  assert.deepEqual(rs.map((r) => r.status), ['要確認', '要確認']);
  assert.equal(rs[0].reason, 'CSV の 3 行目と名前が似ている');
  assert.equal(rs[1].reason, 'CSV の 2 行目と名前が似ている');
  assert.equal(rs[0].csvSimilar[0].name, 'コジマプロダクションルーデンスプラモデル');
});

test('片方の名前がもう片方に含まれていれば要確認', () => {
  const rs = judgeLines([['ルーデンス', 'コトブキヤ'], ['ルーデンス 特典付き', 'コトブキヤ']]);
  assert.deepEqual(rs.map((r) => r.status), ['要確認', '要確認']);
});

test('メーカーが空の行の理由には、CSV の似ている行も書き足す', () => {
  const rs = judgeLines([['ルーデンス', ''], ['ルーデンス 特典付き', 'コトブキヤ']]);
  assert.equal(rs[0].reason, 'メーカーが空 / CSV の 3 行目と名前が似ている');
});

test('3行以上似ていれば、似ている行をすべて書く', () => {
  const rs = judgeLines([['ルーデンス', 'コトブキヤ'], ['ルーデンス 限定版', 'コトブキヤ'], ['ルーデンス 特典付き', 'コトブキヤ']]);
  assert.equal(rs[0].reason, 'CSV の 3 行目・4 行目と名前が似ている');
});

test('メーカーが違えば、CSV の中で名前が似ているだけでは要確認にしない', () => {
  const rs = judgeLines([['HG ガンダムエアリアル', 'バンダイ'], ['HG ガンダムエアリアル改修型', 'タミヤ']]);
  assert.deepEqual(rs.map((r) => r.status), ['新規', '新規']);
});

test('似ていない別のキットは、CSV の中でも要確認にしない', () => {
  const rs = judgeLines([
    ['HG ガンダム', 'バンダイ'], ['RG ガンダム Mk-II', 'バンダイ'],
    ['零戦52型 1/48', 'タミヤ'], ['零戦21型 1/48', 'タミヤ'],
  ]);
  assert.deepEqual(rs.map((r) => r.status), ['新規', '新規', '新規', '新規']);
});

test('DB と重複する行は、CSV の中の比較には使わない(登録されないため)', () => {
  const rs = judgeLines([['ルーデンス', 'コトブキヤ'], ['ルーデンス 特典付き', 'コトブキヤ']],
    [kit('k1', 'ルーデンス', 'コトブキヤ')]);
  assert.equal(rs[0].status, '重複');
  assert.equal(rs[1].status, '要確認');
  assert.equal(rs[1].reason, '名前が似ている');   // DB のキットと似ているだけ
  assert.deepEqual(rs[1].csvSimilar, []);
});

// ---------------------------------------------------------------- id・発売月

test('同じキットなら id は毎回同じ・違うキットなら違う', () => {
  const a = prepareRow({ kit_name: '1/24 スバル BRZ', maker: 'アオシマ' }, unify);
  const b = prepareRow({ kit_name: 'スバル ＢＲＺ 1:24', maker: '青島文化教材社' }, unify);
  const c = prepareRow({ kit_name: 'スバル BRZ 1/32', maker: 'アオシマ' }, unify);
  assert.equal(kitIdFor(a.key), kitIdFor(b.key));
  assert.notEqual(kitIdFor(a.key), kitIdFor(c.key));
  assert.match(kitIdFor(a.key), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('発売月を読む', () => {
  assert.equal(parseReleaseMonth('2026-10'), '2026-10-01');
  assert.equal(parseReleaseMonth('2026-3'), '2026-03-01');
  assert.equal(parseReleaseMonth('２０２６－１０'), '2026-10-01');
  assert.equal(parseReleaseMonth(' '), null);
  assert.equal(parseReleaseMonth(''), null);
  assert.equal(parseReleaseMonth('2026-13'), undefined);
  assert.equal(parseReleaseMonth('2026/10'), undefined);
  assert.equal(parseReleaseMonth('10月'), undefined);
});
