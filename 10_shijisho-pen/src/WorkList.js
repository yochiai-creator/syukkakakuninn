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
  // 手でコピーしたものも二重にしないよう、中身(md5)が同じものがあればコピー済みとみなす
  var inDest = {};
  listPdfMeta_(dest).forEach(function (f) { if (f.md5Checksum) inDest[f.md5Checksum] = true; });

  var destFiles = listPdfMeta_(dest);
  var gone = {};      // この回でゴミ箱へ入れた・名前を変えたもの
  listPdfMeta_(WORK_LIST_SRC_ID).forEach(function (f) {
    var key = workListSrcKey_(f.name);
    if (!key || dayNum_(key) < today) return;       // 出荷日を過ぎた一覧表はコピーしない
    // コピー済みは「ID:中身」で覚える。同じファイルの中身が差し替えられたときも新しい版として扱う
    var sig = f.id + ':' + (f.md5Checksum || '');
    if (copied.indexOf(sig) >= 0 || copied.indexOf(f.id) >= 0) return;   // ID だけは以前の覚え方
    if (f.md5Checksum && inDest[f.md5Checksum]) { copied.push(sig); return; }

    // 同じ日の前の版。書き込んだもの(途中保存)・チェック完了したもののうち新しいもの
    var base = key + '_' + WORK_LIST_FOLDER;
    var mine = destFiles.filter(function (d) { return d.name.indexOf(base) === 0 && !gone[d.id]; });
    var cands = mine.filter(isSaved_).map(function (d) { return { f: d, state: '途中保存' }; })
      .concat(doneWorkLists_(key).map(function (d) { return { f: d, state: '完了' }; }))
      .sort(function (a, b) { return a.f.modifiedTime < b.f.modifiedTime ? 1 : -1; });
    var prev = cands[0] || null;

    // 書き込んでいない前の版は、新しい版に置き換える(ゴミ箱へ)
    mine.forEach(function (d) {
      if (isSaved_(d)) return;
      Drive.Files.update({ trashed: true }, d.id, null, { supportsAllDrives: true });
      gone[d.id] = true;
    });
    // 書き込んだ前の版は、チェックを写し終えるまで「(前の版)」として残す
    if (prev && prev.state === '途中保存' && prev.f.name !== base + '(前の版).pdf') {
      Drive.Files.update({ name: base + '(前の版).pdf' }, prev.f.id, null, { supportsAllDrives: true });
      gone[prev.f.id] = true;
    }

    var taken = destFiles.filter(function (d) { return !gone[d.id]; }).map(function (d) { return d.name; });
    var name = base + '.pdf';
    for (var n = 2; taken.indexOf(name) >= 0; n++) name = base + '_' + n + '.pdf';

    var meta = { name: name, parents: [dest] };
    if (prev) meta.description = WL_PREV + ':' + prev.f.id + '\n' + WL_PREV_STATE + ':' + prev.state;
    var c = Drive.Files.copy(meta, f.id, { supportsAllDrives: true, fields: 'id,name' });
    destFiles.push({ id: c.id, name: name, properties: {}, modifiedTime: new Date().toISOString() });
    copied.push(sig);
    made.push(WORK_LIST_FOLDER + '/' + name + (prev ? '  (訂正版。前の版は' + prev.state + ')' : ''));
  });
  props.setProperty(PROP_WL_COPIED, JSON.stringify(copied.slice(-100)));

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

// 訂正版の一覧表の説明欄。前の版の ID・状態(途中保存/完了)、チェックを写したら 写し:済
var WL_PREV = '前の一覧表', WL_PREV_STATE = '前の一覧表の状態', WL_CARRIED = '写し';

/** その日のチェック完了した一覧表(◆チェック完了/<年>/<月>/作業指示一覧表) */
function doneWorkLists_(key) {
  var p = key.split('.');
  var y = findChildFolder_(DONE_FOLDER_ID, (2000 + Number(p[0])) + '年');
  var m = y && findChildFolder_(y, Number(p[1]) + '月');
  var w = m && findChildFolder_(m, WORK_LIST_FOLDER);
  if (!w) return [];
  return listPdfMeta_(w).filter(function (f) { return f.name.indexOf(key + '_' + WORK_LIST_FOLDER) === 0; });
}

/**
 * アプリで訂正版を開いたとき(loadPdf)に渡す、前の版のチェック。
 * 前の版の棚(書き込む前のPDFと書き込みの一覧)を読む。読めなければ { failed:true }
 */
function workListCarry_(meta) {
  var info = readInfo_(meta.description);
  if (!info[WL_PREV] || info[WL_CARRIED]) return null;
  try {
    var pm = Drive.Files.get(info[WL_PREV], {
      supportsAllDrives: true, fields: 'id,name,properties,md5Checksum,description'
    });
    var sh = readShelf_(pm);
    if (!sh) return { failed: true, state: info[WL_PREV_STATE] || '' };
    return { marks: sh.marks, pages: sh.pages, base: Utilities.base64Encode(sh.base.getBytes()),
             state: info[WL_PREV_STATE] || '' };
  } catch (e) {
    return { failed: true, state: info[WL_PREV_STATE] || '' };
  }
}

/**
 * 訂正版にチェックを写して保存したあと(上書き保存)。写し:済 を付け、
 * 途中保存の前の版はゴミ箱へ(チェック完了した前の版は、訂正版をチェック完了したときに置き換える)
 */
function afterWorkListCarry_(fileId) {
  var meta = Drive.Files.get(fileId, { supportsAllDrives: true, fields: 'id,description' });
  var info = readInfo_(meta.description);
  if (!info[WL_PREV] || info[WL_CARRIED]) return;
  var desc = (meta.description || '') + '\n' + WL_CARRIED + ':済';
  Drive.Files.update({ description: desc }, fileId, null, { supportsAllDrives: true });
  if (info[WL_PREV_STATE] === '途中保存') trashWorkList_(info[WL_PREV]);
}

/** 一覧表をゴミ箱へ。棚の2つも */
function trashWorkList_(id) {
  try {
    var m = Drive.Files.get(id, { supportsAllDrives: true, fields: 'id,properties' });
    Drive.Files.update({ trashed: true }, id, null, { supportsAllDrives: true });
    trashShelf_(id, m);
  } catch (e) {}
}

/**
 * 一覧表をチェック完了したとき。あとで訂正版にチェックを写せるよう、完了したファイルにも
 * 棚(書き込む前のPDFと書き込みの一覧)を作る。訂正版なら、チェック完了した前の版と置き換える。
 */
function afterWorkListDone_(done, original, base, marksJson) {
  if (base && marksJson) {
    var props = savedProps_();
    props[SHELF_BASE_PROP] = shelfPut_(shelfNames_(done.id).base, base, null);
    props[SHELF_MARKS_PROP] = putShelfMarks_(done.id, marksJson, done.md5, null);
    Drive.Files.update({ properties: props }, done.id, null, { supportsAllDrives: true });
  }
  var info = readInfo_(original.description);
  // 完了したものを開いたときに、もう一度写そうとしないように
  if (info[WL_PREV] && !info[WL_CARRIED]) {
    Drive.Files.update({ description: (original.description || '') + '\n' + WL_CARRIED + ':済' },
                       done.id, null, { supportsAllDrives: true });
  }
  if (info[WL_PREV] && info[WL_PREV_STATE] === '完了') {
    trashWorkList_(info[WL_PREV]);
    var want = doneName_(original.name).replace(/_\d+(?=\.pdf$)/, '');
    if (done.name !== want) {
      Drive.Files.update({ name: want }, done.id, null, { supportsAllDrives: true });
      done.name = want;
    }
  }
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
