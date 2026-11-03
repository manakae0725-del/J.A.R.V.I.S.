"use strict";

// Calendar mutation routing must require an explicit calendar item and an action verb.
// Booking-system discussions (e.g. 予約変更・キャンセル) are not Google Calendar commands.
function isExplicitCalendarUpdateIntent(text) {
  if (typeof text !== "string") return false;
  return /(?:予定|スケジュール|カレンダー)\\s*(?:[「『][^」』]{1,80}[」』]\\s*)?(?:の(?:日時|時間)\\s*)?(?:を|の)?\\s*(?:変更(?:して|してください|したい|してほしい|をお願いします)|ずらして|移動して|時間を変えて|日時を変えて)/.test(text);
}

function isExplicitCalendarDeleteIntent(text) {
  if (typeof text !== "string") return false;
  return /(?:予定|スケジュール|カレンダー)\\s*(?:[「『][^」』]{1,80}[」』]\\s*)?(?:を|の)?\\s*(?:削除して|消して|取り消して|削除してください|消してください|取り消してください)/.test(text);
}

module.exports = { isExplicitCalendarUpdateIntent, isExplicitCalendarDeleteIntent };
