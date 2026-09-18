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

// 得意先マスタ(コード→会社名)の置き場。'001_【出荷】 の直下に作る。
var MASTER_PARENT_ID = '1iSYAN13NXaxaLkhVdEywcJkJ0YdVULBu';
var PROP_MASTER_SHEET = 'CUSTOMER_MASTER_ID';


/**
 * 当月ぶんを振り分ける。
 * @return {Object} 処理結果のまとめ
 */
function sortShippingOrders() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var now = new Date();
  return sortShippingOrdersFor(
    Utilities.formatDate(now, tz, 'yyyy') + '年',
    Number(Utilities.formatDate(now, tz, 'M')) + '月'
  );
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
function sortShippingOrdersFor(yearName, monthName, limit) {
  var started = Date.now();
  var max = limit || SORT_MAX_PER_RUN;

  var src = findChildFolder_(SRC_ROOT_ID, yearName);
  if (!src) throw new Error('元フォルダが見つかりません: ' + yearName);
  src = findChildFolder_(src, monthName);
  if (!src) throw new Error('元フォルダが見つかりません: ' + yearName + '/' + monthName);

  var sizeFolders = buildSizeIndex_(SORT_DEST_ROOT_ID);
  if (!Object.keys(sizeFolders).length) {
    throw new Error('振り分け先の容器サイズフォルダが見つかりません');
  }

  var result = { 対象: yearName + '/' + monthName, コピー: [], 済み: 0, skip: [], 未登録: [], 残り: 0 };
  var files = DriveApp.getFolderById(src).getFilesByType(MimeType.PDF);
  var done = 0;

  while (files.hasNext()) {
    var file = files.next();

    // 打ち切ったあとは数えるだけ。もう一度実行すれば続きから進む
    if (done >= max || Date.now() - started > SORT_TIME_BUDGET_MS) {
      result.残り++;
      continue;
    }

    try {
      // コピー済みを飛ばした場合は OCR していないので件数に数えない
      if (sortOne_(file, sizeFolders, result) === 'copied') {
        done++;
        if (done <= 10 || done % 10 === 0) Logger.log('[' + done + '] ' + file.getName());
      }
    } catch (e) {
      done++;  // 失敗でも OCR は走っている可能性があるので1件ぶんと数える
      result.skip.push(file.getName() + ' — ' + e.message);
      Logger.log('skip: ' + file.getName() + ' — ' + e.message);
    }
  }

  result.メモ = result.残り
    ? '残り ' + result.残り + ' 件。もう一度 sortShippingOrders を実行すれば続きから進みます。'
    : 'この月は全部終わりました。';

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
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var now = new Date();
  return sortShippingOrdersFor(
    Utilities.formatDate(now, tz, 'yyyy') + '年',
    Number(Utilities.formatDate(now, tz, 'M')) + '月',
    100000  // 実質無制限。打ち切りは時間の方で効かせる
  );
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

function sortOne_(file, sizeFolders, result) {
  var srcName = file.getName();

  // 日付と依頼Noはファイル名から取れる。ここは OCR に頼らない。
  //   出荷作業指図書_26.09.25_26-60749-0(1).pdf
  var m = srcName.match(/_(\d{2}\.\d{2}\.\d{2})_(\d{2}-\d+-\d+)(\(\d+\))?\s*\.pdf$/i);
  if (!m) throw new Error('ファイル名から日付と依頼Noを読めません');

  var date = m[1];                 // 26.09.25
  var orderNo = m[2] + (m[3] || ''); // 26-60749-0(1)

  var prefix = date + '_' + orderNo + '_';

  // コピー済みなら OCR せずに飛ばす。
  // 出荷先は OCR 由来で実行ごとに揺れるため、完全一致では見ない。
  // 末尾の _ があるので 26-60754-0_ が 26-60754-0(1)_ に当たることはない。
  if (alreadyCopied_(prefix, sizeFolders)) { result.済み++; return 'already'; }

  var text = readPdfText_(file);

  var size = extractSizeKg_(text);
  if (!size) throw new Error('品名から容器サイズを読めません');

  var dest = sizeFolders[size];
  if (!dest) throw new Error(size + 'kg の振り分け先フォルダがありません');

  // 出荷先はマスタを優先する。OCR の読みは会社名が崩れるため、
  // 得意先コードで引き当てて正しい表記に置き換える。
  var code = extractCustomerCode_(text);
  var master = loadCustomerMaster_();
  var to = code && master[code] ? master[code] : '';

  if (!to) {
    to = extractDestination_(text);                 // マスタに無ければOCRの読み
    result.未登録.push({ コード: code || '読めず', OCRの名前: to, 元: srcName });
  }

  var newName = prefix + (to || '出荷先不明') + '.pdf';

  DriveApp.getFolderById(dest.id).createFile(file.getBlob().setName(newName));
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
    var code = String(row[0] || '').trim();
    var name = String(row[1] || '').trim();
    if (code && name) map[code.toUpperCase()] = name;
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
  var m = text.match(/出荷先[:：]\s*(\d{3,5}|[A-Za-z]\d{2,4})(?![0-9A-Za-z])/);
  return m ? m[1].toUpperCase() : '';
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

  // 先頭の得意先コードを落とす。区切りが無いことがある
  // (8537(株小国資源開発 / 8537株小国資源開発)。
  // 実際の形は4文字(6757 / G737 / 8537 / 3580 / H860)だが、OCR が桁を
  // 読み違える余地を見て3〜5桁まで許す。直後が英数字でなければ
  // 区切りとみなす(漢字が続く形があるため)。
  line = line.replace(/^(?:\d{3,5}|[A-Za-z]\d{2,4})(?![0-9A-Za-z])\s*/, '');

  return sanitizeName_(line);
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
 * 同じ日付・依頼Noのコピーが振り分け先に既にあるか。
 * 探すのは容器サイズフォルダの中だけ。ドライブ全体を見ると別名保存で
 * できた _書込.pdf まで拾い、未処理のものを処理済みと誤判定する。
 */
function alreadyCopied_(prefix, sizeFolders) {
  var parents = Object.keys(sizeFolders).map(function (kg) {
    return "'" + q_(sizeFolders[kg].id) + "' in parents";
  }).join(' or ');
  if (!parents) return false;

  var res = Drive.Files.list({
    q: '(' + parents + ") and mimeType = '" + PDF_MIME + "' and trashed = false" +
       " and name contains '" + q_(prefix) + "'",
    pageSize: 1,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return !!(res.files && res.files.length);
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
