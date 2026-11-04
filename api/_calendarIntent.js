"use strict";
function isExplicitCalendarUpdateIntent(text) {
 if(typeof text!=="string") return false;
 const target=/(?:予定|カレンダーの予定|スケジュール[「『][^」』]{1,80}[」』])/;
 const action=/(?:変更して|変更してください|変更したい|変更してほしい|ずらして|移動して|時間を変えて|日時を変えて)/;
 return target.test(text)&&action.test(text)&&/(?:を|の日時を|の時間を)/.test(text);
}
function isExplicitCalendarDeleteIntent(text) {
 if(typeof text!=="string") return false;
 const target=/(?:予定|カレンダーの予定|スケジュール[「『][^」』]{1,80}[」』])/;
 const action=/(?:削除して|消して|取り消して|削除してください|消してください|取り消してください)/;
 return target.test(text)&&action.test(text)&&/(?:を|の)/.test(text);
}
module.exports={isExplicitCalendarUpdateIntent,isExplicitCalendarDeleteIntent};
