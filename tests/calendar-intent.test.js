"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isExplicitCalendarUpdateIntent,
  isExplicitCalendarDeleteIntent
} = require("../api/_calendarIntent");

test("calendar feature and booking discussions do not trigger event mutations", () => {
  const examples = [
    "担当者ごとのスケジュール管理、予約変更・キャンセルにも対応したい",
    "予約変更とキャンセルの機能を設計してください",
    "スタッフ別のスケジュール管理を追加したい",
    "カレンダー連携の仕様を調べてください",
    "スケジュール管理機能の変更点を整理してください"
  ];
  for (const text of examples) {
    assert.equal(isExplicitCalendarUpdateIntent(text), false, text);
    assert.equal(isExplicitCalendarDeleteIntent(text), false, text);
  }
});

test("explicitly requested calendar event updates are routed", () => {
  for (const text of [
    "明日の予定を変更して",
    "カレンダーの予定を明日10時から11時に変更してください",
    "予定「定例会議」の時間を変えて",
    "スケジュールを30分ずらして"
  ]) assert.equal(isExplicitCalendarUpdateIntent(text), true, text);
});

test("explicitly requested calendar event deletions are routed", () => {
  for (const text of [
    "今日の予定を削除して",
    "カレンダーの予定「定例会議」を消してください",
    "スケジュールを取り消して"
  ]) assert.equal(isExplicitCalendarDeleteIntent(text), true, text);
});

test("booking changes without a calendar item do not route to Google Calendar", () => {
  for (const text of ["予約を変更して", "予約変更をお願いします", "予約をキャンセルして"]) {
    assert.equal(isExplicitCalendarUpdateIntent(text), false, text);
    assert.equal(isExplicitCalendarDeleteIntent(text), false, text);
  }
});
