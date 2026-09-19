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
 * 使い方: エディタで sortShippingOrders を実行する。
 * 何度実行してもよい。コピー済みのものは飛ばす。
 */

// 元: '002_出荷作業指図書 (この下が <年>年/<月>月)
var SRC_ROOT_ID = '13qWXWwBXgbEO9avO5qlnZ0WHDaMSaYA_';

// 先: ◆容器種類別
var SORT_DEST_ROOT_ID = '1qCpeKIO3gvPWkVDqXApVREDEiWKU_3D6';

// 1回の実行で処理する最大件数。
// 1ファイルごとに OCR 変換が走るので、まとめてやると数分かかり
// エディタが回りっぱなしになる。少しずつ何度も回す方が状況が分かる。
var SORT_MAX_PER_RUN = 10;

// 実行時間の上限(GASの6分制限に対する余裕)。
// 1件あたりの所要時間ぶんは残しておくこと。
var SORT_TIME_BUDGET_MS = 5 * 60 * 1000;

// PDF→ドキュメント変換で OCR を使うか。
// 'ja' は実際に読めることを確認済み。ただし1件17秒かかる。
// '' にすると OCR を省いて速くなるが、PDF が文字を持っている場合に
// 限る。持っていなければ何も読めずスキップになる。
// 切り替える前に sortBenchmark で読めることを確かめること。
var SORT_OCR_LANGUAGE = 'ja';

// 出荷日が当日以前のものは対象にしない。
// 済んだ出荷の指図書は今さらチェックしないため。
// 過去の月をまとめて取り込みたいときだけ false にする。
var SORT_SKIP_PAST = true;

// 当月に加えて何か月先まで見るか。
// 出荷日が先のものは翌月以降のフォルダに入っているため、当月だけ見ると
// これからチェックする指図書を取りこぼす。
var SORT_MONTHS_AHEAD = 2;

// 得意先マスタ(コード→会社名)の置き場。'001_【出荷】 の直下に作る。
var MASTER_PARENT_ID = '1iSYAN13NXaxaLkhVdEywcJkJ0YdVULBu';
var PROP_MASTER_SHEET = 'CUSTOMER_MASTER_ID';


/**
 * 当月ぶんを振り分ける。
 * @return {Object} 処理結果のまとめ
 */
function sortShippingOrders() {
  return sortMonths_(targetMonths_(), SORT_MAX_PER_RUN);
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

  return finishResult_(all);
}

/**
 * まず1件だけ処理して所要時間を見る。
 * OCR が効くか、1件あたり何秒かかるかを確かめてから本番を回す。
 */
function sortTestOne() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var now = new Date();
  var t = Date.now();
  var r = sortShippingOrdersFor(
    Utilities.formatDate(now, tz, 'yyyy') + '年',
    Number(Utilities.formatDate(now, tz, 'M')) + '月',
    1
  );
  r.所要秒 = Math.round((Date.now() - t) / 100) / 10;
  Logger.log('1件あたり約 ' + r.所要秒 + ' 秒');
  return r;
}

/**
 * 当月フォルダの先頭1件で、OCR あり / なし の速さと読み取り結果を比べる。
 * 何もコピーしないので安全。どちらを使うか決めるために実行する。
 */
function sortBenchmark() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var now = new Date();
  var src = findChildFolder_(SRC_ROOT_ID, Utilities.formatDate(now, tz, 'yyyy') + '年');
  src = findChildFolder_(src, Number(Utilities.formatDate(now, tz, 'M')) + '月');

  var it = DriveApp.getFolderById(src).getFilesByType(MimeType.PDF);
  if (!it.hasNext()) throw new Error('PDF がありません');
  var file = it.next();

  var keep = SORT_OCR_LANGUAGE;
  var out = { ファイル: file.getName(), 結果: [] };

  ['', 'ja'].forEach(function (mode) {
    SORT_OCR_LANGUAGE = mode;
    var t = Date.now();
    var row = { OCR: mode ? 'あり' : 'なし' };
    try {
      var text = readPdfText_(file);
      row.秒 = Math.round((Date.now() - t) / 100) / 10;
      row.文字数 = text.length;
      row.容器サイズ = extractSizeKg_(text) || '読めず';
      row.出荷先 = extractDestination_(text) || '読めず';
    } catch (e) {
      row.秒 = Math.round((Date.now() - t) / 100) / 10;
      row.エラー = e.message;
    }
    out.結果.push(row);
  });

  SORT_OCR_LANGUAGE = keep;
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * 年月を指定して振り分ける。過去の月をやり直すとき用。
 * @param {string} yearName  例 '2026年'
 * @param {string} monthName 例 '9月'
 */
var sortTodayNum_ = 0;   // 20260919 の形。当日以前の判定に使う
var sortStarted_  = 0;   // 実行の開始時刻。複数の月にまたがっても1つで数える

function sortShippingOrdersFor(yearName, monthName, limit) {
  sortStarted_ = Date.now();
  var r = runMonth_(yearName, monthName, limit || SORT_MAX_PER_RUN);
  r.対象 = [yearName + '/' + monthName];
  return finishResult_(r);
}

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

/** 未登録のまとめとメモ書きを付けて返す。 */
function finishResult_(result) {
  // 未登録はコードごとにまとめる。同じ得意先が何件も並ぶと見づらく、
  // マスタへ写すときにも邪魔になる。
  var seen = {}, rows = [];
  result.未登録.forEach(function (u) {
    var key = u.コード;
    if (seen[key]) { seen[key].件数++; return; }
    seen[key] = { コード: key, OCRの名前: u.OCRの名前, 件数: 1, 例: u.元 };
    rows.push(seen[key]);
  });
  result.未登録 = rows;

  // そのままマスタに貼れる形。名前が崩れているものは直してから使う。
  result.マスタ追記用 = rows
    .filter(function (r) { return r.コード !== '読めず'; })
    .map(function (r) { return r.コード + ',' + r.OCRの名前; });

  result.メモ = result.残り
    ? '残り ' + result.残り + ' 件。もう一度 sortShippingOrders を実行すれば続きから進みます。'
    : '対象の月は全部終わりました。';

  if (result.対象外) {
    result.メモ += ' 出荷日が当日以前のため対象外にしたものが ' +
      result.対象外 + ' 件あります。';
  }
  if (rows.length) {
    result.メモ += ' マスタに無い得意先が ' + rows.length +
      ' 件あります。マスタ追記用 の行を得意先マスタに貼り、' +
      '崩れている会社名を直してください。次回から正確になります。';
  }

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* ---------------- 自動で回す(任意) ---------------- */

/**
 * 自動実行用。件数で区切らず、3分の枠いっぱいまで処理する。
 * トリガーは第1引数にイベントを渡してくるので、件数を受け取る関数を
 * そのままトリガーに指定してはいけない(件数のつもりでイベントが入る)。
 */
function sortShippingOrdersBulk() {
  return sortMonths_(targetMonths_(), 100000);  // 打ち切りは時間の方で効かせる
}

/**
 * 10分おきに自動で回す。件数が多いときに、エディタを見ていなくても
 * 少しずつ片付く。終わったら removeSortTrigger で止めること。
 */
function installSortTrigger() {
  removeSortTrigger();
  ScriptApp.newTrigger('sortShippingOrdersBulk').timeBased().everyMinutes(10).create();
  return '10分おきの自動実行を登録しました。終わったら removeSortTrigger を実行してください。';
}

function removeSortTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'sortShippingOrdersBulk' || f === 'sortShippingOrders') {
      ScriptApp.deleteTrigger(t); n++;
    }
  });
  return n + ' 件の自動実行を解除しました。';
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
    result.未登録.push({ コード: code || '読めず', OCRの名前: to, 元: srcName });
  }

  var newName = prefix + (to || '出荷先不明') + '.pdf';

  DriveApp.getFolderById(dest.id).createFile(file.getBlob().setName(newName));
  doneNames.push(newName);   // 同じ実行の中でも二重にコピーしない
  result.コピー.push(dest.path + '/' + newName);
  return 'copied';
}


/* ---------------- 得意先マスタ ---------------- */

/**
 * 得意先マスタを作る。初回に一度だけ実行する。
 * 既にあれば作らず URL を返す。
 *
 * CSV を Drive に投げると変換されてスプレッドシートになる。
 * SpreadsheetApp を使うと spreadsheets スコープが要り、再認可で
 * ウェブアプリにも影響が出るため、この作り方にしている。
 */
function setupCustomerMaster() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_MASTER_SHEET);

  if (id) {
    try {
      var f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return { 状態: '既にあります', url: f.getUrl() };
    } catch (e) { /* 消されていれば作り直す */ }
  }

  var csv = '得意先コード,会社名\n';
  var blob = Utilities.newBlob(csv, 'text/csv', 'master.csv');

  var ss = Drive.Files.create(
    {
      name: '得意先マスタ（指図書振り分け用）',
      mimeType: MimeType.GOOGLE_SHEETS,
      parents: [MASTER_PARENT_ID]
    },
    blob,
    { supportsAllDrives: true }
  );

  props.setProperty(PROP_MASTER_SHEET, ss.id);
  return {
    状態: '作りました',
    url: 'https://docs.google.com/spreadsheets/d/' + ss.id + '/edit',
    使い方: 'A列に得意先コード、B列に正しい会社名を入れてください。'
  };
}

/**
 * ここに得意先を書いて registerCustomers を実行すると、マスタに入る。
 * エディタの実行ボタンは引数を渡せないため、この形にしている。
 * 追加したいときはこの表に行を足してから実行する。
 * 既に入っているコードは新しい方で上書きされる。
 */
var CUSTOMER_ROWS = [
  // 指図書の原本で確認済み
  ['8537', '㈱小国資源開発'],
  ['0820', 'ひかり工機'],
  ['3580', '(株)サイサン 磐田工場'],
  ['C942', '福岡LPGセンター(株)福岡西事業所'],
  ['J177', '中部プロパン株式会社供給管理センター'],
  ['4108', '(株)ホームエネルギー北陸 能登センター'],
  ['8515', '(株)ホームエネルギー南九州 熊本センター'],

  // 複数回とも同じに読めており、内容の確認も取れたもの
  ['6757', '株式会社チョープロ 大島営業所'],
  ['G757', '株式会社チョープロ 大島営業所'],   // 6 を G と誤読する分
  ['B070', '東邦液化ガス(株)岡崎充填所'],
  ['H860', '(株)ホームエネルギー近畿 田辺センター'],
  ['6182', 'JA全農とっとり 資材部 生活燃料課'],

  // 読めてはいるが原本での確認は未了。違っていれば直すこと
  ['6862', '(株)アストモスガスセンター広島 福山営業所'],
  ['5906', '岩谷産業株式会社 淡路工場'],
  ['J450', 'イワタニ四国(株)徳島支店'],
  ['B035', '東邦液化ガス株式会社 八開充填所']
];

/** 上の CUSTOMER_ROWS をマスタに登録する。エディタから実行できる。 */
function registerCustomers() {
  return addCustomerMaster(CUSTOMER_ROWS);
}

/**
 * 得意先マスタに行を足す。既にあるコードは上書きする。
 *
 *   addCustomerMaster([['8537','㈱小国資源開発'], ['0820','ひかり工機']])
 *
 * 書き込みも CSV を Drive に被せる形で行う。SpreadsheetApp を使うと
 * spreadsheets スコープが要り、再認可でウェブアプリにも影響が出る。
 * 既存の行は読み直して残すので、手で入れたものは消えない。
 */
function addCustomerMaster(rows) {
  if (!rows || !rows.length) throw new Error('追加する行を指定してください');

  var id = PropertiesService.getScriptProperties().getProperty(PROP_MASTER_SHEET);
  if (!id) throw new Error('先に setupCustomerMaster を実行してください');

  customerMasterCache_ = null;          // 手で編集されている場合に備えて読み直す
  var map = loadCustomerMaster_();
  var added = [];

  rows.forEach(function (r) {
    var code = normCode_(r[0]);
    var name = String(r[1] || '').trim();
    if (!code || !name) return;
    added.push(code + ' → ' + name);
    map[code] = name;
  });

  var csv = '得意先コード,会社名\n' + Object.keys(map).sort().map(function (k) {
    return csvCell_(k) + ',' + csvCell_(map[k]);
  }).join('\n') + '\n';

  Drive.Files.update({}, id, Utilities.newBlob(csv, 'text/csv', 'master.csv'),
                     { supportsAllDrives: true });

  customerMasterCache_ = null;
  Logger.log(JSON.stringify({ 追加: added, マスタ件数: Object.keys(map).length }, null, 2));
  return { 追加: added, マスタ件数: Object.keys(map).length };
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

/** 登録済みの得意先を一覧する。何が入っているか確かめるとき用。 */
function showCustomerMaster() {
  customerMasterCache_ = null;
  var map = loadCustomerMaster_();
  var rows = Object.keys(map).sort().map(function (k) { return k + ' → ' + map[k]; });
  Logger.log(JSON.stringify({ 件数: rows.length, 一覧: rows }, null, 2));
  return { 件数: rows.length, 一覧: rows };
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

  var id = PropertiesService.getScriptProperties().getProperty(PROP_MASTER_SHEET);
  if (!id) { customerMasterCache_ = {}; return customerMasterCache_; }

  var res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/csv',
    {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );
  if (res.getResponseCode() !== 200) { customerMasterCache_ = {}; return customerMasterCache_; }

  var map = {};
  parseCsv_(res.getContentText()).forEach(function (row, i) {
    if (i === 0) return;                       // 見出し行
    var code = normCode_(row[0]);
    var name = String(row[1] || '').trim();
    if (code && name) map[code] = name;
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
  var m = text.match(/出荷先[:：]\s*([0-9A-Za-z]{3,5})(?![0-9A-Za-z])/);
  return (m && /\d/.test(m[1])) ? m[1].toUpperCase() : '';
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

/**
 * 品名の (◯◯kg) から容器サイズを取る。
 *   24L (10kg) LPガス容器 → 10
 * 複数の値が混じっている場合は判断できないものとして扱う。
 */
function extractSizeKg_(text) {
  var found = {}, m, re = /(\d{1,3})\s*kg/gi;
  while ((m = re.exec(text)) !== null) found[Number(m[1])] = true;

  var keys = Object.keys(found);
  return keys.length === 1 ? Number(keys[0]) : 0;
}

/**
 * 出荷先を取る。先頭の得意先コードは落とす。
 *   出荷先: 6757 株式会社チョープロ 大島営業所 → 株式会社チョープロ 大島営業所
 *   出荷先: G737 (株)りゅうせき 中部物流センター → (株)りゅうせき 中部物流センター
 */
function extractDestination_(text) {
  var m = text.match(/出荷先[:：]\s*([^\r\n]+)/);
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
  var m = line.match(/^([0-9A-Za-z]{3,5})(?![0-9A-Za-z])[\s　]*/);
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
 * 振り分け済みのコピーのうち、出荷先がマスタの名前と一致しないものを探す。
 * 消さずに一覧にするだけ。まずこれで中身を見てから trashGarbledCopies を使う。
 *
 * マスタに載っている得意先なら、正しい名前で入っていれば一致する。
 * 一致しないものは OCR が崩れたまま入っているか、まだマスタに無い得意先。
 */
function listGarbledCopies() {
  var found = scanCopies_();
  Logger.log(JSON.stringify(found, null, 2));
  return found;
}

/**
 * 上で見つかったコピーをゴミ箱へ移す。元の指図書には触らない。
 * 消したあと sortShippingOrders を実行すると、マスタを使って
 * 正しい名前で入り直す。
 */
function trashGarbledCopies() {
  var found = scanCopies_();
  found.一致しない.forEach(function (r) {
    DriveApp.getFileById(r.id).setTrashed(true);
  });

  var out = { 消した件数: found.一致しない.length, 残した件数: found.一致した件数,
              一覧: found.一致しない.map(function (r) { return r.場所; }) };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** 振り分け先を見て、マスタの名前と一致するか調べる。 */
function scanCopies_() {
  var index  = buildSizeIndex_(SORT_DEST_ROOT_ID);
  var master = loadCustomerMaster_();

  var known = {};
  Object.keys(master).forEach(function (k) { known[master[k]] = true; });

  var bad = [], ok = 0;

  Object.keys(index).forEach(function (kg) {
    var it = DriveApp.getFolderById(index[kg].id).getFiles();
    while (it.hasNext()) {
      var f = it.next(), name = f.getName();

      // 26.09.25_26-60754-0(1)_会社名.pdf
      var m = name.match(/^(\d{2}\.\d{2}\.\d{2})_([^_]+)_(.+)\.pdf$/i);
      if (!m) { ok++; continue; }        // この形でないものは触らない

      if (known[m[3]]) { ok++; continue; }
      bad.push({ id: f.getId(), 場所: index[kg].path + '/' + name, 出荷先: m[3] });
    }
  });

  return { 一致した件数: ok, 一致しない: bad, マスタ件数: Object.keys(master).length };
}

/**
 * ここに 日付_依頼No_ を並べて trashListedCopies を実行すると消える。
 * エディタの実行ボタンは引数を渡せないため、この形にしている。
 * 下は これまでの実行でできたコピー(二重ぶんを含む)。
 */
var TRASH_PREFIXES = [
  '26.09.18_26-10713-0(1)_',   // 姫路センターが崩れ。出荷日が過去なので作り直されない
  '26.09.29_26-50390-0(1)_',   // )工機株式会社 → 0820 ひかり工機 で入り直す
  '26.09.30_26-60736-0_',      // 福岡LPG它一夕- が崩れ
  '26.09.30_26-70288-0(1)_',   // BO70 がファイル名に残っている
  '26.09.30_26-70289-0(1)_'    // 東邦液化ガス の間に余分な空白
];

/** 上の TRASH_PREFIXES のコピーをゴミ箱へ。エディタから実行できる。 */
function trashListedCopies() {
  return trashSortedCopies(TRASH_PREFIXES);
}

/**
 * 振り分け済みのコピーをゴミ箱へ移す。読み取りを直してやり直すとき用。
 * 元の指図書には触らない。消すのはコピーだけ。
 *
 *   trashSortedCopies(['26.09.25_26-60753-0_', '26.09.29_26-50390-0(1)_'])
 *
 * @param {Array<string>} prefixes 日付_依頼No_ の形の先頭一致
 */
function trashSortedCopies(prefixes) {
  if (!prefixes || !prefixes.length) throw new Error('消す対象を指定してください');

  var index = buildSizeIndex_(SORT_DEST_ROOT_ID);
  var removed = [];

  Object.keys(index).forEach(function (kg) {
    var folder = DriveApp.getFolderById(index[kg].id);
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next(), name = f.getName();
      for (var i = 0; i < prefixes.length; i++) {
        if (name.indexOf(prefixes[i]) === 0) {
          f.setTrashed(true);
          removed.push(index[kg].path + '/' + name);
          break;
        }
      }
    }
  });

  Logger.log(JSON.stringify(removed, null, 2));
  return { 消した件数: removed.length, 一覧: removed };
}

/** 指定の名前の子フォルダの ID。無ければ空文字。 */
function findChildFolder_(parentId, name) {
  var it = DriveApp.getFolderById(parentId).getFoldersByName(name);
  return it.hasNext() ? it.next().getId() : '';
}
