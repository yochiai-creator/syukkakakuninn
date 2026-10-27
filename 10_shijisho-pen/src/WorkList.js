/**
 * 作業指示一覧表のコピー
 * ------------------------------------------------------------
 * 本社から毎朝届く「作業指示一覧表(26.10.26出荷分).PDF」を、指図書と同じ流れで
 * チェックできるよう、容器種類別の「作業指示一覧表」フォルダへコピーする。
 * アプリで開いてペンで書き込み、チェック完了すると
 * ◆チェック完了/<年>/<月>/作業指示一覧表 に入る(指図書と同じ)。
 *
 *   元      WORK_LIST_SRC_ID のフォルダの 作業指示一覧表(26.10.26出荷分).PDF
 *   コピー  ◆容器種類別/作業指示一覧表/26.10.26_作業指示一覧表.pdf
 *           「出荷日_依頼No_出荷先」の形にしない(2つ目の _ を入れない)。
 *           指図書のコピー向けの片付け・名前直し・数量の読み足しが触らないように。
 *
 * 一覧表は出荷日の朝(8時前)や、前の日の夕方に届くので、振り分けとは別に15分ごとに見に行く
 * (copyWorkLists)。振り分け(runSort)のときにも見る。
 * コピー済みの元ファイルは ID で覚える。同じ日の一覧表が出し直されたら
 * (ID が違う)、それもコピーする(_2 が付く)。
 */
var WORK_LIST_SRC_ID = '1LvjaUHY6Je53Aid_wR6p5SZv53zS1W5o';
var WORK_LIST_FOLDER = '作業指示一覧表';          // 容器種類別・チェック完了の中のフォルダ名
var PROP_WL_COPIED = 'WORK_LIST_COPIED';          // コピー済みの元ファイル ID(JSON の配列)
var PROP_WL_TRIGGER = 'WORK_LIST_TRIGGER';
var WORK_LIST_EVERY_MIN = 15;
var WORK_LIST_HOURS = [5, 23];                    // この時間帯だけ見に行く(5時〜23時前)。先の日の分が夕方に届くこともある

/** 15分ごとのトリガーから呼ぶ。振り分けが動いている間は次の回に回す */
function copyWorkLists() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var hour = Number(Utilities.formatDate(new Date(), tz, 'H'));
  if (hour < WORK_LIST_HOURS[0] || hour >= WORK_LIST_HOURS[1]) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var r = copyWorkLists_();
    if (r.件数) Logger.log(JSON.stringify(r, null, 2));
    return r;
  } finally {
    lock.releaseLock();
  }
}

function copyWorkLists_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var today = Number(Utilities.formatDate(new Date(), tz, 'yyyyMMdd'));
  var props = PropertiesService.getScriptProperties();
  var copied = [];
  try { copied = JSON.parse(props.getProperty(PROP_WL_COPIED) || '[]'); } catch (e) {}

  var dest = cachedChildFolder_(SORT_DEST_ROOT_ID, WORK_LIST_FOLDER);
  var made = [];

  listPdfMeta_(WORK_LIST_SRC_ID).forEach(function (f) {
    var key = workListSrcKey_(f.name);
    if (!key || dayNum_(key) < today) return;       // 出荷日を過ぎた一覧表はコピーしない
    if (copied.indexOf(f.id) >= 0) return;
    var name = uniqueName_(dest, key + '_' + WORK_LIST_FOLDER + '.pdf');
    Drive.Files.copy({ name: name, parents: [dest] }, f.id, { supportsAllDrives: true });
    copied.push(f.id);
    made.push(WORK_LIST_FOLDER + '/' + name);
  });
  if (made.length) props.setProperty(PROP_WL_COPIED, JSON.stringify(copied.slice(-100)));

  // 出荷日を過ぎてもチェック完了していない一覧表は、指図書と同じく 要確認/出荷日超過 へ
  var moved = 0;
  listPdfMeta_(dest).forEach(function (f) {
    var m = f.name.match(/^(\d{2}\.\d{2}\.\d{2})_/);
    if (!m || dayNum_(m[1]) >= today) return;
    DriveApp.getFileById(f.id).moveTo(overdueFolder_());
    moved++;
  });

  return { 件数: made.length, 一覧: made, 出荷日超過へ: moved };
}

/**
 * '作業指示一覧表(26.10.26出荷分).PDF' → '26.10.26'。形が違えば ''。
 * 月・日が1桁のこともある('26.11.2出荷分')。2桁にそろえる。
 */
function workListSrcKey_(name) {
  var m = String(name).match(/^作業指示一覧表\((\d{2})\.(\d{1,2})\.(\d{1,2})出荷分\)/);
  var two = function (n) { return ('0' + n).slice(-2); };
  return m ? m[1] + '.' + two(m[2]) + '.' + two(m[3]) : '';
}

/** 15分ごとのトリガーが入っていなければ入れる(振り分けのたびに見る) */
function ensureWorkListTrigger_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_WL_TRIGGER);
  var live = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'copyWorkLists';
  });
  if (id && live.some(function (t) { return t.getUniqueId() === id; })) {
    return '入っています(' + WORK_LIST_EVERY_MIN + '分ごと)';
  }
  live.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var t = ScriptApp.newTrigger('copyWorkLists').timeBased().everyMinutes(WORK_LIST_EVERY_MIN).create();
  props.setProperty(PROP_WL_TRIGGER, t.getUniqueId());
  return '入れました(' + WORK_LIST_EVERY_MIN + '分ごと)';
}

/**
 * 以前、振り分けで自動で作っていた一覧(26.10.27_作業指示一覧(50Ｋ).pdf)を片付ける。
 * 書き込んだ(途中保存)ものは残す。説明欄に「一覧の依頼No」があるものだけが対象。
 */
function removeGeneratedWorkLists_() {
  var index = buildSizeIndex_(SORT_DEST_ROOT_ID);
  var ids = Object.keys(index).map(function (kg) { return index[kg].id; }).concat([overdueFolderId_()]);
  var gone = [];
  listPdfMetaIn_(ids).forEach(function (f) {
    if (!isWorkListName_(f.name) || isSaved_(f)) return;
    if (!readInfo_(f.description)['一覧の依頼No']) return;
    Drive.Files.update({ trashed: true }, f.id, null, { supportsAllDrives: true });
    gone.push(f.name);
  });
  return { 件数: gone.length, 一覧: gone };
}
