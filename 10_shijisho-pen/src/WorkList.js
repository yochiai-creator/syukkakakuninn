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
    if (r.件数) {
      r.追加分 = step_(makeExtraLists_);     // 新しい一覧表に合わせて追加分を作り直す
      Logger.log(JSON.stringify(r, null, 2));
    }
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
    var mine = destFiles.filter(function (d) {
      return d.name.indexOf(base) === 0 && !gone[d.id] && !isExtraListName_(d.name);
    });
    var cands = mine.filter(isSaved_).map(function (d) { return { f: d, state: '途中保存' }; })
      .concat(doneWorkLists_(key).filter(function (d) { return !isExtraListName_(d.name); })
        .map(function (d) { return { f: d, state: '完了' }; }))
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


/* ---------------- 一覧表に載っていない指図書(追加分) ----------------
 * 本社の一覧表は出荷日の数日前に一度だけ出ることがあり、そのあとに届いた指図書は
 * 載っていない(11/2分は 10/27 に出て、10/29〜30 に届いた下松・あがつま などが無い)。
 * そこで、その日の一覧表に載っていない指図書だけを「追加分」の一覧にして、
 * 同じフォルダに 26.11.02_作業指示一覧表(追加分).pdf で置く。チェックの流れは一覧表と同じ。
 *
 *   載っているかどうか … 一覧表の文字から依頼No.(26-30618-0-1)と容器No.(HEP64119)を読み、
 *                        コピーの説明欄「一覧表の依頼No」に覚える(読むのは1回だけ)。
 *                        依頼No. か、最初の容器No. が載っていれば載っているとみなす
 *   作り直し         … 書き込む前なら、中身が変わったら作り直す。書き込んだ・チェック完了した
 *                        追加分は触らず、そのあと増えたぶんを (追加分2) で作る
 */
var WL_EXTRA = '追加分';
var WL_ON_LIST = '一覧表の依頼No';
var WL_EXTRA_ORDERS = '追加分の依頼No';
var WL_EXTRA_HASH = '追加分の中身';
var EXTRA_BUDGET_MS = 90 * 1000;

function isExtraListName_(name) {
  return String(name).indexOf('(' + WL_EXTRA) >= 0;
}

/** 26-30618-0(2) → '26-30618-0#2'。(n) が無いものは 1 */
function orderKey_(no) {
  var m = String(no).match(/^(\d{2}-\d+-\d+)(?:\((\d+)\))?$/);
  return m ? m[1] + '#' + Number(m[2] || 1) : String(no);
}

/** 本社の一覧表に載っている依頼No.(26-30618-0#1)と容器No.(HEP64119)。初回だけ読んで説明欄に覚える */
function officialKeys_(f) {
  var v = readInfo_(f.description)[WL_ON_LIST];
  if (v == null) {
    var t = toHalfAlnum_(readPdfText_(DriveApp.getFileById(f.id)));
    var keys = {};
    (t.match(/\d{2}-\d{4,6}-\d+-\d+/g) || []).forEach(function (s) {
      var m = s.match(/^(.*)-(\d+)$/);
      keys[m[1] + '#' + Number(m[2])] = 1;
    });
    (t.replace(/\s+/g, '').match(/[A-Z]{3}\d{5}/g) || []).forEach(function (c) { keys[c] = 1; });
    v = Object.keys(keys).join(',');
    var desc = (f.description ? f.description + '\n' : '') + WL_ON_LIST + ':' + v;
    Drive.Files.update({ description: desc }, f.id, null, { supportsAllDrives: true });
    f.description = desc;
  }
  return v ? v.split(',') : [];
}

function makeExtraLists_() {
  var started = Date.now();
  var w = workIndex_();
  var dest = cachedChildFolder_(SORT_DEST_ROOT_ID, WORK_LIST_FOLDER);
  var destFiles = listPdfMeta_(dest);
  var made = [], left = 0;

  // 今日以降で、一覧表(コピー)がある日
  var keys = {};
  destFiles.forEach(function (f) {
    var m = f.name.match(/^(\d{2}\.\d{2}\.\d{2})_作業指示一覧表/);
    if (m && dayNum_(m[1]) >= w.today) keys[m[1]] = true;
  });
  Object.keys(keys).sort(function (a, b) { return dayNum_(a) - dayNum_(b); }).forEach(function (key) {
    var base = key + '_' + WORK_LIST_FOLDER;
    var all = destFiles.filter(function (f) { return f.name.indexOf(base) === 0; })
      .map(function (f) { return { f: f, done: false }; })
      .concat(doneWorkLists_(key).map(function (f) { return { f: f, done: true }; }));
    var officials = all.filter(function (x) {
      return !isExtraListName_(x.f.name) && x.f.name.indexOf('(前の版)') < 0;
    });
    if (!officials.length) return;

    if (Date.now() - started > EXTRA_BUDGET_MS) { left++; return; }
    var on = {};
    officials.forEach(function (x) { officialKeys_(x.f).forEach(function (k) { on[k] = true; }); });

    var extras = all.filter(function (x) { return isExtraListName_(x.f.name); });
    var fixed = {}, nFixed = 0;
    extras.forEach(function (x) {
      if (!x.done && !isSaved_(x.f)) return;
      nFixed++;
      String(readInfo_(x.f.description)[WL_EXTRA_ORDERS] || '').split(',').forEach(function (n) { if (n) fixed[n] = true; });
    });
    var open = extras.filter(function (x) { return !x.done && !isSaved_(x.f); });
    var rows = workRowsOf_(w.rows[key]).filter(function (r) {
      return !on[orderKey_(r.no)] && !on[firstContainer_(r.range)] && !fixed[r.no];
    });

    if (!rows.length) { open.forEach(function (x) { trashFile_(x.f.id); }); return; }

    var name = base + '(' + WL_EXTRA + (nFixed ? nFixed + 1 : '') + ').pdf';
    var hash = workListHash_(rows);
    var keep = open[0];
    open.slice(1).forEach(function (x) { trashFile_(x.f.id); });   // 二重にできていたら1つに
    if (keep && readInfo_(keep.f.description)[WL_EXTRA_HASH] === hash && keep.f.name === name) return;
    if (Date.now() - started > EXTRA_BUDGET_MS || overBudget_()) { left++; return; }

    var desc = WL_EXTRA_ORDERS + ':' + rows.map(function (r) { return r.no; }).join(',') + '\n' +
               WL_EXTRA_HASH + ':' + hash;
    var blob = extraListPdf_(key, rows, nFixed + 1).setName(name);
    if (keep) {
      Drive.Files.update({ name: name, description: desc }, keep.f.id, blob, { supportsAllDrives: true });
    } else {
      Drive.Files.create({ name: name, parents: [dest], description: desc, mimeType: MimeType.PDF },
                         blob, { supportsAllDrives: true });
    }
    made.push(WORK_LIST_FOLDER + '/' + name + '  ' + rows.length + '件' + (keep ? '(作り直し)' : ''));
  });

  return { 件数: made.length, 一覧: made, 残り: left };
}

/** 一覧に載せる中身が変わったかを見る指紋。状態(完了など)は入れない */
function workListHash_(rows) {
  var s = JSON.stringify(rows.map(function (r) {
    return [r.no, r.to, r.qty, r.range, r.time, r.item, r.kg];
  }));
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function trashFile_(id) {
  try { Drive.Files.update({ trashed: true }, id, null, { supportsAllDrives: true }); } catch (e) {}
}

/** HTML を Google ドキュメントに変換してから PDF で取り出す(日本語と罫線がきれいに出る) */
function extraListPdf_(key, rows, n) {
  var doc = null;
  try {
    doc = Drive.Files.create(
      { name: 'wl_' + Utilities.getUuid(), mimeType: MimeType.GOOGLE_DOCS },
      Utilities.newBlob(extraListHtml_(key, rows, n), 'text/html', 'wl.html')
    );
    return DriveApp.getFileById(doc.id).getAs(MimeType.PDF);
  } finally {
    if (doc && doc.id) {
      try { DriveApp.getFileById(doc.id).setTrashed(true); } catch (e) {}
    }
  }
}

/** 26-30114-0(1) → 26-30114-0-1(一覧表と同じ書き方) */
function listStyleNo_(no) {
  return String(no).replace(/\((\d+)\)$/, '-$1');
}

function extraListHtml_(key, rows, n) {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var p = key.split('.');
  var d = new Date(2000 + Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var label = (2000 + Number(p[0])) + '/' + Number(p[1]) + '/' + Number(p[2]) +
              '(' + '日月火水木金土'.charAt(d.getDay()) + ')';
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var madeAt = Utilities.formatDate(new Date(), tz, 'M/d HH:mm');

  var td = 'style="border:1px solid #555;padding:8pt 4pt;font-size:10pt;vertical-align:middle;"';
  var th = 'style="border:1px solid #555;padding:4pt;font-size:9pt;background-color:#e8e8e8;"';
  var gh = 'style="border:1px solid #555;padding:4pt;font-size:10pt;font-weight:bold;background-color:#f3f3f3;"';
  var cols = [['依頼No', 17], ['出荷先', 25], ['品名', 16], ['数量', 7], ['容器番号', 20], ['時間指定', 8], ['確認', 7]];

  var h = [];
  h.push('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;">');
  h.push('<p style="font-size:15pt;font-weight:bold;margin:0;">作業指示一覧表 追加分' + (n > 1 ? n : '') +
         '  出荷日：' + esc(label) + '</p>');
  h.push('<p style="font-size:9pt;margin:2pt 0 8pt 0;">本社の作業指示一覧表に載っていない指図書(一覧表が出たあとに届いたもの)。' +
         '振り分けたコピーから作っています。 作成 ' + esc(madeAt) + '</p>');
  h.push('<table style="border-collapse:collapse;width:100%;"><tr>');
  cols.forEach(function (c) { h.push('<th ' + th + ' width="' + c[1] + '%">' + c[0] + '</th>'); });
  h.push('</tr>');
  var lastKg = null;
  rows.forEach(function (r) {
    if (r.kg !== lastKg) {
      lastKg = r.kg;
      var same = rows.filter(function (x) { return x.kg === r.kg; });
      var q = same.reduce(function (a, x) { return a + (Number(x.qty) || 0); }, 0);
      var size = r.kg === BULK_KG ? 'バルク' : r.kg ? r.kg + 'kg' : 'サイズ不明';
      h.push('<tr><td ' + gh + ' colspan="7">' + esc(size) + '  ' + same.length + '件 · ' + q + '本</td></tr>');
    }
    h.push('<tr>');
    h.push('<td ' + td + '>' + esc(listStyleNo_(r.no)) + '</td>');
    h.push('<td ' + td + '>' + esc(r.to) + '</td>');
    h.push('<td ' + td + '>' + esc(r.item) + '</td>');
    h.push('<td ' + td + ' align="right">' + (r.qty ? esc(r.qty) : '—') + '</td>');
    h.push('<td ' + td + '>' + esc(String(r.range || '').replace('~', ' 〜 ')) + '</td>');
    h.push('<td ' + td + '>' + esc(r.time) + '</td>');
    h.push('<td ' + td + '>&nbsp;</td>');
    h.push('</tr>');
  });
  h.push('</table></body></html>');
  return h.join('');
}
