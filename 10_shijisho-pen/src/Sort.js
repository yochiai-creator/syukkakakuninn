/**
 * 出荷作業指図書の振り分け
 * ------------------------------------------------------------
 * '002_出荷作業指図書/<年>年/<月>月 の PDF を読み、
 * 容器サイズごとに ◆容器種類別 配下へリネームしてコピーする。
 *
 *   元: '002_出荷作業指図書/2026年/9月/出荷作業指図書_26.09.25_26-60749-0(1).pdf
 *   先: ◆容器種類別/小型容器/10Ｋ/26.09.25_26-60749-0(1)_株式会社チョープロ 大島営業所.pdf
 *
 * 容器サイズは PDF の品名から取る。
 *   品名: 24L (10kg) LPガス容器 (PT直付)  → 10Ｋ
 *   品名: 71L (30kg) LPガス容器           → 30Ｋ
 *
 * GAS は PDF の文字を直接読めないため、Drive で Google ドキュメントへ
 * 変換(OCR)して読み、読み終えたら変換物は捨てる。
 * OCR なので読み損ねはあり得る。サイズを判別できなかったファイルは
 * どこにも入れずスキップし、最後にまとめて報告する。
 *
 * 使い方
 *   はじめに1回だけ installSortTrigger を実行する。あとは毎朝勝手に回る。
 *   すぐ回したいときは runSort を実行する。何度実行してもよい。
 *
 *   新しい得意先は、得意先マスタの表に自動で行が足される(会社名は空欄)。
 *   B列に正しい会社名を書けば、次の実行からその名前になり、
 *   既に作ったコピーの名前も直る。表の場所は openCustomerMaster で出る。
 */

// 元: '002_出荷作業指図書 (この下が <年>年/<月>月)
var SRC_ROOT_ID = '13qWXWwBXgbEO9avO5qlnZ0WHDaMSaYA_';

// 先: ◆容器種類別
var SORT_DEST_ROOT_ID = '1qCpeKIO3gvPWkVDqXApVREDEiWKU_3D6';

// 実行時間の上限(GASの6分制限に対する余裕)。
// 1件あたりの所要時間ぶんは残しておくこと。
var SORT_TIME_BUDGET_MS = 5 * 60 * 1000;

// PDF→ドキュメント変換で OCR を使うか。
// 'ja' は実際に読めることを確認済み。ただし1件17秒かかる。
// '' にすると OCR を省いて速くなるが、PDF が文字を持っている場合に
// 限る。持っていなければ何も読めずスキップになる。
var SORT_OCR_LANGUAGE = 'ja';

// 出荷日が当日以前のものは対象にしない。
// 済んだ出荷の指図書は今さらチェックしないため。
// 過去の月をまとめて取り込みたいときだけ false にする。
var SORT_SKIP_PAST = true;

// 当月に加えて何か月先まで見るか。
// 出荷日が先のものは翌月以降のフォルダに入っているため、当月だけ見ると
// これからチェックする指図書を取りこぼす。
var SORT_MONTHS_AHEAD = 2;

// 出荷日を過ぎたのに容器種類別に残っているコピーを移す先。
// '001_【出荷】/'004_要確認
var OVERDUE_FOLDER_ID = '1IhDSDZl8bT1x1iqLclanA213cENGIdD3';
var SORT_MOVE_OVERDUE = true;

// 得意先マスタ(コード→会社名)の置き場。'001_【出荷】 の直下に作る。
var MASTER_PARENT_ID = '1iSYAN13NXaxaLkhVdEywcJkJ0YdVULBu';
var PROP_MASTER_SHEET = 'CUSTOMER_MASTER_ID';

// 毎日の自動実行の時刻(時)。出社前に片付いているように朝にする。
var SORT_DAILY_HOUR = 6;

// 時間切れで残りが出たときの続きの実行。1回ぶんのトリガーの ID を持つ。
var PROP_CONTINUE_TRIGGER = 'SORT_CONTINUE_TRIGGER';
var SORT_CONTINUE_AFTER_MS = 2 * 60 * 1000;


/**
 * 振り分けを1回ぶん回す。毎朝のトリガーもこれを呼ぶ。
 *
 *   1. 新しい指図書を容器種類別へコピーする
 *   2. マスタの会社名が変わっていれば、コピーの名前を直す
 *   3. 出荷日を過ぎた未チェックのコピーを '004_要確認 へ移す
 *   4. マスタに無い得意先を表に書き足す(会社名は空欄)
 *
 * 時間切れで残りが出たら、2分後にもう一度自分を呼ぶ。
 */
function runSort() {
  // 毎朝のぶんと続きのぶんが重ならないようにする
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    Logger.log('前の実行がまだ続いているので、今回は飛ばしました。');
    return;
  }

  try {
    clearContinueTrigger_();

    // マスタを先に読んでおく。読めないまま進むと、全件 OCR したうえで
    // 会社名を崩れた読みのまま付けてしまう。読めなければここで止める
    // (トリガーの失敗はメールで知らせが来る)。
    loadCustomerMaster_();

    var r = sortMonths_(targetMonths_(), 100000);  // 打ち切りは時間の方で効かせる

    put_(r, '名前を直した', step_(renameCopiesFromMaster_));
    if (SORT_MOVE_OVERDUE) put_(r, '要確認へ移した', step_(moveOverdueCopies_));
    put_(r, '表に足した得意先', step_(function () { return appendUnknownCustomers_(r.未登録); }));

    if (r.残り) scheduleContinue_();

    return finishResult_(r);
  } finally {
    lock.releaseLock();
  }
}

/** 後段の処理は1つ失敗しても他を止めない。結果に理由を残す。 */
function step_(fn) {
  try { return fn(); } catch (e) { return '失敗: ' + e.message; }
}

/** { 件数, 一覧 } を結果に載せる。一覧は1件以上のときだけ。 */
function put_(result, key, v) {
  if (v && typeof v === 'object') {
    result[key] = v.件数;
    if (v.件数) result[key + '_一覧'] = v.一覧;
  } else {
    result[key] = v;
  }
}


/** 当月から SORT_MONTHS_AHEAD か月先までの [年, 月]。年またぎも扱える。 */
function targetMonths_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var now = new Date();
  var y = Number(Utilities.formatDate(now, tz, 'yyyy'));
  var m = Number(Utilities.formatDate(now, tz, 'M'));

  var out = [];
  for (var i = 0; i <= SORT_MONTHS_AHEAD; i++) {
    var d = new Date(y, m - 1 + i, 1);
    out.push([d.getFullYear() + '年', (d.getMonth() + 1) + '月']);
  }
  return out;
}

/**
 * 複数の月をまとめて処理する。件数と時間は全体で1つぶんとして配る。
 * フォルダが無い月は黙って飛ばす(先の月はまだ作られていないことがある)。
 */
function sortMonths_(months, max) {
  sortStarted_ = Date.now();

  var all = {
    対象: [], コピー: [], 済み: 0, 対象外: 0, skip: [], 未登録: [], 残り: 0
  };
  var left = max;

  months.forEach(function (ym) {
    if (left <= 0 || Date.now() - sortStarted_ > SORT_TIME_BUDGET_MS) return;

    var r;
    try {
      r = runMonth_(ym[0], ym[1], left);
    } catch (e) {
      return;                       // その月のフォルダがまだ無い
    }

    all.対象.push(ym[0] + '/' + ym[1] + '(' + r.コピー.length + '件)');
    all.コピー = all.コピー.concat(r.コピー);
    all.skip   = all.skip.concat(r.skip);
    all.未登録 = all.未登録.concat(r.未登録);
    all.済み   += r.済み;
    all.対象外 += r.対象外;
    all.残り   += r.残り;

    left -= r.コピー.length + r.skip.length;
  });

  return all;
}

var sortTodayNum_ = 0;   // 20260919 の形。当日以前の判定に使う
var sortStarted_  = 0;   // 実行の開始時刻。複数の月にまたがっても1つで数える

/** 1か月ぶんを処理する。開始時刻は sortStarted_ を共有する。 */
function runMonth_(yearName, monthName, max) {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  sortTodayNum_ = Number(Utilities.formatDate(new Date(), tz, 'yyyyMMdd'));

  var src = findChildFolder_(SRC_ROOT_ID, yearName);
  if (!src) throw new Error('元フォルダが見つかりません: ' + yearName);
  src = findChildFolder_(src, monthName);
  if (!src) throw new Error('元フォルダが見つかりません: ' + yearName + '/' + monthName);

  var sizeFolders = buildSizeIndex_(SORT_DEST_ROOT_ID);
  if (!Object.keys(sizeFolders).length) {
    throw new Error('振り分け先の容器サイズフォルダが見つかりません');
  }

  // 振り分け先にある名前を先に全部読んでおく。
  // Drive の name contains は素直な部分一致ではなく、括弧を含む名前で
  // 取りこぼして二重コピーが起きた。手元で突き合わせる方が確実で、
  // 問い合わせも1回で済む。
  var doneNames = collectDestNames_(sizeFolders);

  var result = { コピー: [], 済み: 0, 対象外: 0, skip: [], 未登録: [], 残り: 0 };
  var files = DriveApp.getFolderById(src).getFilesByType(MimeType.PDF);
  var done = 0;

  while (files.hasNext()) {
    var file = files.next();

    // 打ち切ったあとは数えるだけ。もう一度実行すれば続きから進む。
    // 日付はファイル名から取れるので、打ち切り後もここだけは見る。
    // 見ないと、二度と対象にならない過去日まで「残り」に入って
    // 実態とかけ離れた数になる。
    if (done >= max || Date.now() - sortStarted_ > SORT_TIME_BUDGET_MS) {
      if (SORT_SKIP_PAST && isPastFile_(file.getName())) result.対象外++;
      else result.残り++;
      continue;
    }

    try {
      // コピー済みを飛ばした場合は OCR していないので件数に数えない
      if (sortOne_(file, sizeFolders, doneNames, result) === 'copied') {
        done++;
        if (done <= 10 || done % 10 === 0) Logger.log('[' + done + '] ' + file.getName());
      }
    } catch (e) {
      done++;  // 失敗でも OCR は走っている可能性があるので1件ぶんと数える
      result.skip.push(file.getName() + ' — ' + e.message);
      Logger.log('skip: ' + file.getName() + ' — ' + e.message);
    }
  }

  return result;
}

/** 未登録のまとめとメモ書きを付けて、実行ログに出す。 */
function finishResult_(result) {
  // 未登録はコードごとにまとめる。同じ得意先が何件も並ぶと見づらい。
  var seen = {}, rows = [];
  result.未登録.forEach(function (u) {
    var key = u.コード;
    if (seen[key]) { seen[key].件数++; return; }
    seen[key] = { コード: key, OCRの名前: u.OCRの名前, 出荷先の行: u.出荷先の行, 件数: 1, 例: u.元 };
    rows.push(seen[key]);
  });
  result.未登録 = rows;

  var memo = [];
  memo.push(result.残り
    ? '残り ' + result.残り + ' 件。2分後に続きを自動で回します。'
    : '対象の月は全部終わりました。');

  if (result.名前を直した > 0) {
    memo.push('マスタに合わせてコピーの名前を ' + result.名前を直した + ' 件直しました。');
  }
  if (result.要確認へ移した > 0) {
    memo.push('出荷日を過ぎたまま残っていた ' + result.要確認へ移した + ' 件を 要確認 へ移しました。');
  }
  if (result.表に足した得意先 > 0) {
    memo.push('新しい得意先を ' + result.表に足した得意先 + ' 件、得意先マスタに足しました。' +
      'B列(会社名)が空欄の行に正しい名前を書いてください。');
  }
  result.メモ = memo.join(' ');

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* ---------------- 自動で回す ---------------- */

/**
 * 毎朝 SORT_DAILY_HOUR 時に runSort が走るようにする。1回実行すればよい。
 * 何度実行しても、トリガーは1つにまとまる。
 */
function installSortTrigger() {
  removeSortTrigger();
  ScriptApp.newTrigger('runSort')
    .timeBased().everyDays(1).atHour(SORT_DAILY_HOUR)
    .inTimezone(Session.getScriptTimeZone() || 'Asia/Tokyo')
    .create();

  var msg = '毎朝 ' + SORT_DAILY_HOUR + ' 時ごろに振り分けが自動で回るようにしました。';
  Logger.log(msg);
  return msg;
}

/** 自動実行を止める。以前の10分おきのトリガーもまとめて消す。 */
function removeSortTrigger() {
  var names = { runSort: 1, sortShippingOrdersBulk: 1, sortShippingOrders: 1 };
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (names[t.getHandlerFunction()]) { ScriptApp.deleteTrigger(t); n++; }
  });
  PropertiesService.getScriptProperties().deleteProperty(PROP_CONTINUE_TRIGGER);

  var msg = n + ' 件の自動実行を止めました。';
  Logger.log(msg);
  return msg;
}

/** 時間切れで残ったぶんを、少し後にもう一度回す。 */
function scheduleContinue_() {
  var t = ScriptApp.newTrigger('runSort').timeBased().after(SORT_CONTINUE_AFTER_MS).create();
  PropertiesService.getScriptProperties().setProperty(PROP_CONTINUE_TRIGGER, t.getUniqueId());
}

/**
 * 前回の続き用トリガーを消す。1回ぶんのトリガーは発火後も残るため。
 * 毎朝のトリガーは ID が違うので消さない。
 */
function clearContinueTrigger_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_CONTINUE_TRIGGER);
  if (!id) return;

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getUniqueId() === id) ScriptApp.deleteTrigger(t);
  });
  props.deleteProperty(PROP_CONTINUE_TRIGGER);
}


/* ---------------- 1ファイルぶんの処理 ---------------- */

function sortOne_(file, sizeFolders, doneNames, result) {
  var srcName = file.getName();

  // 日付と依頼Noはファイル名から取れる。ここは OCR に頼らない。
  //   出荷作業指図書_26.09.25_26-60749-0(1).pdf
  var m = srcName.match(/_(\d{2}\.\d{2}\.\d{2})_(\d{2}-\d+-\d+)(\(\d+\))?\s*\.pdf$/i);
  if (!m) throw new Error('ファイル名から日付と依頼Noを読めません');

  var date = m[1];                 // 26.09.25
  var orderNo = m[2] + (m[3] || ''); // 26-60749-0(1)

  // 出荷日が当日以前なら何もしない。日付はファイル名から取れるので
  // OCR を通す前に判定でき、そのぶん変換も走らない。
  if (SORT_SKIP_PAST && shipDateNum_(date) <= sortTodayNum_) {
    result.対象外++;
    return 'past';
  }

  var prefix = date + '_' + orderNo + '_';

  // コピー済みなら OCR せずに飛ばす。
  // 出荷先は OCR 由来で実行ごとに揺れるため、完全一致では見ない。
  // 末尾の _ があるので 26-60754-0_ が 26-60754-0(1)_ に当たることはない。
  if (alreadyCopied_(prefix, doneNames)) { result.済み++; return 'already'; }

  var text = readPdfText_(file);

  var size = extractSizeKg_(text);
  if (!size) throw new Error('品名から容器サイズを読めません');

  var dest = sizeFolders[size];
  if (!dest) throw new Error(size + 'kg の振り分け先フォルダがありません');

  // 出荷先はマスタを優先する。OCR の読みは会社名が崩れるため、
  // 得意先コードで引き当てて正しい表記に置き換える。
  var code = extractCustomerCode_(text);
  var to = lookupCustomer_(code);

  if (!to) {
    to = extractDestination_(text);                 // マスタに無ければOCRの読み
    var raw = text.match(/出荷先[^\r\n]{0,40}/);
    result.未登録.push({
      コード: code || '読めず',
      OCRの名前: to,
      出荷先の行: raw ? raw[0] : '(出荷先が見つからない)',
      元: srcName
    });
  }

  var newName = copyName_(prefix, to);

  var copy = DriveApp.getFolderById(dest.id).createFile(file.getBlob().setName(newName));

  // 得意先コードをファイルの説明に残す。あとでマスタの会社名が
  // 直されたとき、OCR をやり直さずにこのコピーの名前を直せる。
  if (code) copy.setDescription(CODE_TAG + code);

  doneNames.push(newName);   // 同じ実行の中でも二重にコピーしない
  result.コピー.push(dest.path + '/' + newName);
  return 'copied';
}


/** コピーの名前。振り分け時と、あとで直すときで同じ付け方にする。 */
function copyName_(prefix, to) {
  return prefix + (to || '出荷先不明') + '.pdf';
}

// コピーの「説明」に残す得意先コードの書き方
var CODE_TAG = '得意先コード:';


/* ---------------- 得意先マスタ ---------------- */

/**
 * 得意先マスタの表の URL を実行ログに出す。表を開きたいとき用。
 *
 * 表の見方
 *   A列 得意先コード / B列 会社名 / C列 OCRの読み(参考) / D列 例
 *   B列が空欄の行は、振り分けで見つかった新しい得意先。
 *   C列の読みと原本を見比べて、B列に正しい会社名を書く。
 *   書いた名前は次の実行から使われ、既に作ったコピーの名前も直る。
 */
function openCustomerMaster() {
  var url = 'https://docs.google.com/spreadsheets/d/' + masterId_() + '/edit';
  Logger.log(url);
  return url;
}

/**
 * 得意先マスタの ID。無ければ作る。
 *
 * CSV を Drive に投げると変換されてスプレッドシートになる。
 * SpreadsheetApp を使うと spreadsheets スコープが要り、再認可で
 * ウェブアプリにも影響が出るため、この作り方にしている。
 */
function masterId_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_MASTER_SHEET);

  if (id) {
    try {
      if (!DriveApp.getFileById(id).isTrashed()) return id;
    } catch (e) { /* 消されていれば作り直す */ }
  }

  var ss = Drive.Files.create(
    {
      name: '得意先マスタ（指図書振り分け用）',
      mimeType: MimeType.GOOGLE_SHEETS,
      parents: [MASTER_PARENT_ID]
    },
    Utilities.newBlob(MASTER_HEADER.join(',') + '\n', 'text/csv', 'master.csv'),
    { supportsAllDrives: true }
  );
  props.setProperty(PROP_MASTER_SHEET, ss.id);
  return ss.id;
}

var MASTER_HEADER = ['得意先コード', '会社名', 'OCRの読み(参考)', '例'];

/**
 * 表の中身を行の配列で返す(見出しは除く)。
 * 空欄の列も落とさず、4列にそろえて返す。
 */
function readMasterRows_() {
  var res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + masterId_() + '/export?mimeType=text/csv',
    {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );
  if (res.getResponseCode() !== 200) {
    throw new Error('得意先マスタを読めません (HTTP ' + res.getResponseCode() + ')');
  }

  return parseCsv_(res.getContentText()).slice(1)
    .filter(function (row) { return String(row[0] || '').trim(); })
    .map(function (row) {
      var r = [];
      for (var i = 0; i < MASTER_HEADER.length; i++) r.push(String(row[i] || '').trim());
      return r;
    });
}

/**
 * マスタに無い得意先を表に書き足す。会社名(B列)は空欄のまま。
 * OCR の読みは崩れていることが多いので、会社名には入れず参考として残す。
 * 既に表にあるコード(会社名が空欄のものも含む)は足さない。
 *
 * 足した行は見つけやすいよう見出しのすぐ下に入れる。
 * 既存の行の並びは変えない。
 *
 * @return {number} 足した件数
 */
function appendUnknownCustomers_(unknowns) {
  var fresh = (unknowns || []).filter(function (u) { return u.コード && u.コード !== '読めず'; });
  if (!fresh.length) return 0;

  var rows = readMasterRows_();
  var have = {};
  rows.forEach(function (r) { have[normCode_(r[0])] = true; });

  var add = [];
  fresh.forEach(function (u) {
    var k = normCode_(u.コード);
    if (have[k]) return;
    have[k] = true;
    add.push([u.コード, '', u.OCRの名前 || '', u.例 || u.元 || '']);
  });
  if (!add.length) return 0;

  var csv = [MASTER_HEADER].concat(add, rows).map(function (r) {
    return r.map(csvCell_).join(',');
  }).join('\n') + '\n';

  Drive.Files.update({}, masterId_(), Utilities.newBlob(csv, 'text/csv', 'master.csv'),
                     { supportsAllDrives: true });
  customerMasterCache_ = null;
  return add.length;
}

/**
 * 得意先コードの突き合わせ用に正す。
 *
 * CSV をスプレッドシートに変換すると 0820 が数値扱いになり 820 に
 * なってしまう。表の側を直しても入力のたびに同じことが起きるため、
 * 数字だけのコードは先頭のゼロを無視して比べる。
 */
function normCode_(code) {
  code = String(code || '').trim().toUpperCase();

  // OCR は O と 0、I と 1 を取り違える。同じ得意先を B070 と BO70 の
  // 両方で読んでいたため、数字側に寄せて比べる。
  // 数字を含むコードに限る(英字だけの語を壊さないため)。
  if (/\d/.test(code)) code = code.replace(/O/g, '0').replace(/I/g, '1');

  // CSV をスプレッドシートに変換すると 0820 が数値扱いになり 820 に
  // なる。表を直しても入力のたびに同じことが起きるため、数字だけの
  // コードは先頭のゼロを無視して比べる。
  return /^\d+$/.test(code) ? String(Number(code)) : code;
}

/** ファイル名の日付を見て、出荷日が当日以前かどうか。読めなければ対象扱い。 */
function isPastFile_(name) {
  var m = name.match(/_(\d{2}\.\d{2}\.\d{2})_/);
  return m ? shipDateNum_(m[1]) <= sortTodayNum_ : false;
}

/** '26.09.25' を 20260925 にする。比較しやすい形にするだけ。 */
function shipDateNum_(date) {
  var p = date.split('.');
  return Number('20' + p[0] + p[1] + p[2]);
}

/** CSV の1セル。区切りや引用符を含むときだけ囲う。 */
function csvCell_(v) {
  v = String(v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** マスタを読み込む。1回の実行につき1度だけ取りに行く。 */
var customerMasterCache_ = null;

function loadCustomerMaster_() {
  if (customerMasterCache_) return customerMasterCache_;

  var map = {};
  readMasterRows_().forEach(function (r) {
    var code = normCode_(r[0]);
    if (code && r[1]) map[code] = r[1];      // 会社名が空欄の行は未登録扱い
  });

  customerMasterCache_ = map;
  return map;
}

/** 引用符付きに対応した最小限の CSV 解析。 */
function parseCsv_(text) {
  var rows = [], row = [], cell = '', quoted = false;

  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);

    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 出荷先の行から得意先コードだけを取る。
 * 区切りが無く漢字が続く形(8537株小国資源開発)があるため、
 * 直後が英数字でなければ区切りとみなす。
 */
function extractCustomerCode_(text) {
  // コロンが無い書式がある(出荷先 0820 ひかり工機株式会社)。
  // 付いていない場合も拾えるようにする。
  // 出荷先とコードの間に OCR が拾った記号(: や ・)が挟まる回がある。
  // 記号か空白なら数文字まで読み飛ばす。
  var m = toHalfAlnum_(text).match(/出荷先[^0-9A-Za-z\r\n]{0,4}([0-9A-Za-z]{3,5})(?![0-9A-Za-z])/);
  return (m && /\d/.test(m[1])) ? m[1].toUpperCase() : '';
}

/**
 * 全角の英数字を半角にする。
 * OCR が ０８２０ のように全角で返す回があり、そのときコードとして
 * 拾えず、ファイル名にコードが残ってしまう。比較の前に揃える。
 */
function toHalfAlnum_(s) {
  return String(s || '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
}

/** 読み取ったコードでマスタを引く。先頭ゼロの違いは吸収する。 */
function lookupCustomer_(code) {
  if (!code) return '';
  var map = loadCustomerMaster_();
  return map[normCode_(code)] || '';
}


/* ---------------- PDF を読む ---------------- */

/**
 * PDF を Google ドキュメントへ変換して本文を取り出す。
 * 変換物は読み終えたら必ず捨てる。
 *
 * 本文の取得に DocumentApp は使わない。documents スコープが要るため、
 * マニフェストにスコープを足す→再認可、となってウェブアプリ側にも
 * 影響が出る。Drive API の export なら既にある drive スコープで済む。
 */
function readPdfText_(file) {
  var doc = null;
  try {
    // 変換先は自分のマイドライブ(親を指定しない)。共有ドライブを汚さない。
    var opts = SORT_OCR_LANGUAGE ? { ocrLanguage: SORT_OCR_LANGUAGE } : {};
    doc = Drive.Files.create(
      { name: 'conv_' + Utilities.getUuid(), mimeType: MimeType.GOOGLE_DOCS },
      file.getBlob(),
      opts
    );

    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + doc.id + '/export?mimeType=text/plain',
      {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      }
    );
    if (res.getResponseCode() !== 200) {
      throw new Error('本文を取り出せません (HTTP ' + res.getResponseCode() + ')');
    }
    return res.getContentText();

  } finally {
    if (doc && doc.id) {
      try { DriveApp.getFileById(doc.id).setTrashed(true); } catch (e) {}
    }
  }
}

// 容量と容器サイズの対応。指図書の実物で確認した組み合わせ。
// kg を読めなかったときの控えに使う。
var LITER_TO_KG = { 19: 8, 24: 10, 47: 20, 71: 30, 118: 50 };

/**
 * 品名から容器サイズを取る。
 *   24L (10kg) LPガス容器 → 10
 *
 * まず (◯◯kg) を探す。複数の値が混じっていたら判断できないものとして扱う。
 * kg を読めなかった場合だけ、容量(◯◯L)から引く。OCR は 50kg を
 * 読み落とすことがあるが、118L の方は残っていることが多い。
 */
function extractSizeKg_(text) {
  var kgCounts = countNumbers_(text, /(\d{1,3})\s*kg/gi);

  var kg = onlyOne_(kgCounts);
  if (kg) return kg;

  // kg を読めない、または複数に割れた場合は容量から引く
  var liter = onlyOne_(countNumbers_(text, /(\d{1,3})\s*L[\s(（]/gi));
  if (liter && LITER_TO_KG[liter]) return LITER_TO_KG[liter];

  // それでも決まらないときだけ、kg のうち一番多く出た値を使う。
  // 同数なら決めない。振り分け先のフォルダが無ければ呼び出し側で弾かれる。
  return dominant_(kgCounts);
}

/** 正規表現で拾えた数の出現回数を数える。 */
function countNumbers_(text, re) {
  var counts = {}, m;
  while ((m = re.exec(text)) !== null) {
    var n = Number(m[1]);
    counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

/** 1種類しか無ければその値。複数あれば0。 */
function onlyOne_(counts) {
  var keys = Object.keys(counts);
  return keys.length === 1 ? Number(keys[0]) : 0;
}

/** 一番多く出た値。同数で並んだ場合は決めない。 */
function dominant_(counts) {
  var best = 0, bestN = 0, tie = false;
  Object.keys(counts).forEach(function (k) {
    var n = counts[k];
    if (n > bestN) { best = Number(k); bestN = n; tie = false; }
    else if (n === bestN) { tie = true; }
  });
  return tie ? 0 : best;
}

/**
 * 出荷先を取る。先頭の得意先コードは落とす。
 *   出荷先: 6757 株式会社チョープロ 大島営業所 → 株式会社チョープロ 大島営業所
 *   出荷先: G737 (株)りゅうせき 中部物流センター → (株)りゅうせき 中部物流センター
 */
function extractDestination_(text) {
  var m = text.match(/出荷先[:：]?\s*([^\r\n]+)/);
  if (!m) return '';

  var line = m[1].replace(/\s+/g, ' ').trim();

  line = stripCustomerCode_(line);

  return sanitizeName_(line);
}

/**
 * 先頭の得意先コードを落とす。
 *
 * 実際の形は4文字(6757 / G737 / 8537 / 3580 / H860 / BO70)。
 * 英字1+数字3 に限定していたため BO70 のような英字2つの形が
 * 残ってしまった。英数3〜5文字で数字を1つ以上含むもの、と広げる。
 * 数字を含むことを条件にするのは、LPG や JA のような語を
 * コードと取り違えないため。
 * 区切りが無く漢字が続く形(8537株小国資源開発)もあるので、
 * 直後が英数字でなければ区切りとみなす。
 */
function stripCustomerCode_(line) {
  // 全角で読まれた回にも効くよう、判定用に半角へ寄せる。
  // 落とす長さは元の行と同じなので、切る位置はそのまま使える。
  var m = toHalfAlnum_(line).match(/^[^0-9A-Za-z\r\n]{0,3}([0-9A-Za-z]{3,5})(?![0-9A-Za-z])[\s　]*/);
  return (m && /\d/.test(m[1])) ? line.slice(m[0].length) : line;
}

/** ファイル名に使えない文字を落とす。 */
function sanitizeName_(s) {
  return String(s).replace(/[\/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}


/* ---------------- 振り分け先を調べる ---------------- */

/**
 * ◆容器種類別 配下(2階層)を見て、容器サイズ → フォルダ の対応を作る。
 * フォルダ名の全角・半角の違い(10Ｋ と ８Ｋ が混在している)を吸収する。
 */
function buildSizeIndex_(rootId) {
  var index = {};
  var root = DriveApp.getFolderById(rootId);

  addSizeFolders_(root, '', index);

  var subs = root.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    addSizeFolders_(sub, sub.getName(), index);
  }
  return index;
}

function addSizeFolders_(parent, prefix, index) {
  var it = parent.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    var kg = folderSizeKg_(f.getName());
    if (kg && !index[kg]) {
      index[kg] = { id: f.getId(), path: (prefix ? prefix + '/' : '') + f.getName() };
    }
  }
}

/** '30Ｋ' '８Ｋ' → 30 / 8。容器サイズを表さない名前は 0。 */
function folderSizeKg_(name) {
  var half = String(name).replace(/[０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  var m = half.match(/^\s*(\d{1,3})\s*[KＫk]/);
  return m ? Number(m[1]) : 0;
}

/**
 * 振り分け先にあるファイル名を集める。
 * 見るのは容器サイズフォルダの中だけ。ドライブ全体を見ると別名保存で
 * できた _書込.pdf まで拾い、未処理のものを処理済みと誤判定する。
 */
function collectDestNames_(sizeFolders) {
  var names = [];
  Object.keys(sizeFolders).forEach(function (kg) {
    var it = DriveApp.getFolderById(sizeFolders[kg].id).getFiles();
    while (it.hasNext()) names.push(it.next().getName());
  });
  return names;
}

/** 同じ日付・依頼Noのコピーが既にあるか。先頭一致で見る。 */
function alreadyCopied_(prefix, doneNames) {
  for (var i = 0; i < doneNames.length; i++) {
    if (doneNames[i].indexOf(prefix) === 0) return true;
  }
  return false;
}

/**
 * 出荷日を過ぎたのに容器種類別に残っているコピーを '004_要確認 へ移す。
 *
 * チェック完了するとコピーは ◆チェック完了 へ移って元は消える。
 * つまり容器種類別に残っているものは、まだチェックしていないもの。
 * 出荷日を過ぎたものは見落としなので、目に付くところへ分けておく。
 *
 * 当日ぶんは残す。移すのは出荷日が昨日以前のものだけ。
 * 元の指図書には触らない。移すのはコピーだけ。
 */
function moveOverdueCopies_() {
  var tz    = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var today = Number(Utilities.formatDate(new Date(), tz, 'yyyyMMdd'));

  var dest  = overdueFolder_();
  var index = buildSizeIndex_(SORT_DEST_ROOT_ID);

  var moved = [];

  Object.keys(index).forEach(function (kg) {
    var it = DriveApp.getFolderById(index[kg].id).getFiles();
    while (it.hasNext()) {
      var f = it.next(), name = f.getName();

      // 振り分けが付けた名前は 26.09.25_… の形。違うものは触らない。
      var m = name.match(/^(\d{2}\.\d{2}\.\d{2})_/);
      if (!m) continue;

      if (shipDateNum_(m[1]) >= today) continue;   // 当日ぶんは残す

      f.moveTo(dest);
      moved.push(index[kg].path + '/' + name);
    }
  });

  return { 件数: moved.length, 一覧: moved };
}

/**
 * マスタの会社名に合わせて、コピーの名前を直す。
 *
 * 振り分けのときにファイルの説明へ得意先コードを残してあるので、
 * OCR をやり直さずに済む。表の B列に会社名が書き足されたり直されたり
 * したら、次の実行でここが名前をそろえる。
 * 説明にコードが無いコピー(この仕組みより前に作ったもの)は触らない。
 * 容器種類別と 要確認 の両方を見る。
 */
function renameCopiesFromMaster_() {
  var master = loadCustomerMaster_();
  var folders = [];
  var index = buildSizeIndex_(SORT_DEST_ROOT_ID);
  Object.keys(index).forEach(function (kg) { folders.push(index[kg]); });
  folders.push({ id: OVERDUE_FOLDER_ID, path: '要確認' });

  var renamed = [];

  folders.forEach(function (fo) {
    var it = DriveApp.getFolderById(fo.id).getFiles();
    while (it.hasNext()) {
      var f = it.next(), name = f.getName();

      var m = name.match(/^(\d{2}\.\d{2}\.\d{2}_[^_]+_)/);   // 26.09.25_26-60749-0(1)_
      if (!m) continue;

      var tag = String(f.getDescription() || '');
      if (tag.indexOf(CODE_TAG) !== 0) continue;

      var to = master[normCode_(tag.slice(CODE_TAG.length))];
      if (!to) continue;                           // まだ会社名が書かれていない

      var want = copyName_(m[1], to);
      if (want === name) continue;

      f.setName(want);
      renamed.push(fo.path + '/' + name + '  →  ' + want);
    }
  });

  return { 件数: renamed.length, 一覧: renamed };
}

/** 移す先の要確認フォルダを返す。 */
function overdueFolder_() {
  return DriveApp.getFolderById(OVERDUE_FOLDER_ID);
}

/** 指定の名前の子フォルダの ID。無ければ空文字。 */
function findChildFolder_(parentId, name) {
  var it = DriveApp.getFolderById(parentId).getFoldersByName(name);
  return it.hasNext() ? it.next().getId() : '';
}
