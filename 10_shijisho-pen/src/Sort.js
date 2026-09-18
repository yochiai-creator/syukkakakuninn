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

// 実行時間の上限(GASの6分制限に対する余裕)
var SORT_TIME_BUDGET_MS = 4.5 * 60 * 1000;


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
 * 年月を指定して振り分ける。過去の月をやり直すとき用。
 * @param {string} yearName  例 '2026年'
 * @param {string} monthName 例 '9月'
 */
function sortShippingOrdersFor(yearName, monthName) {
  var started = Date.now();

  var src = findChildFolder_(SRC_ROOT_ID, yearName);
  if (!src) throw new Error('元フォルダが見つかりません: ' + yearName);
  src = findChildFolder_(src, monthName);
  if (!src) throw new Error('元フォルダが見つかりません: ' + yearName + '/' + monthName);

  var sizeFolders = buildSizeIndex_(SORT_DEST_ROOT_ID);
  if (!Object.keys(sizeFolders).length) {
    throw new Error('振り分け先の容器サイズフォルダが見つかりません');
  }

  var result = { 対象: yearName + '/' + monthName, コピー: [], 済み: 0, skip: [], 残り: 0 };
  var files = DriveApp.getFolderById(src).getFilesByType(MimeType.PDF);

  while (files.hasNext()) {
    var file = files.next();

    if (Date.now() - started > SORT_TIME_BUDGET_MS) {
      result.残り++;
      continue;  // 時間切れ。もう一度実行すれば続きから進む
    }

    try {
      sortOne_(file, sizeFolders, result);
    } catch (e) {
      result.skip.push(file.getName() + ' — ' + e.message);
    }
  }

  Logger.log(JSON.stringify(result, null, 2));
  return result;
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

  // コピー済みなら OCR せずに飛ばす
  if (alreadyCopied_(prefix, sizeFolders)) { result.済み++; return; }

  var text = readPdfText_(file);

  var size = extractSizeKg_(text);
  if (!size) throw new Error('品名から容器サイズを読めません');

  var dest = sizeFolders[size];
  if (!dest) throw new Error(size + 'kg の振り分け先フォルダがありません');

  var to = extractDestination_(text);
  var newName = prefix + (to || '出荷先不明') + '.pdf';

  DriveApp.getFolderById(dest.id).createFile(file.getBlob().setName(newName));
  result.コピー.push(dest.path + '/' + newName);
}


/* ---------------- PDF を読む ---------------- */

/**
 * PDF を Google ドキュメントへ変換して本文を取り出す。
 * 変換物は読み終えたら必ず捨てる。
 */
function readPdfText_(file) {
  var doc = null;
  try {
    doc = Drive.Files.create(
      { name: 'ocr_' + Utilities.getUuid(), mimeType: MimeType.GOOGLE_DOCS },
      file.getBlob(),
      { ocrLanguage: 'ja', supportsAllDrives: true }
    );
    return DocumentApp.openById(doc.id).getBody().getText();
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
  line = line.replace(/^[0-9A-Za-z]{2,6}\s+/, '');   // 得意先コード
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
 * 探すのは容器サイズフォルダの中だけにする。ドライブ全体を見ると
 * 別名保存でできた _書込.pdf まで拾ってしまい、未処理のものを
 * 処理済みと誤判定する。
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

/** 指定の名前の子フォルダの ID。無ければ空文字。 */
function findChildFolder_(parentId, name) {
  var it = DriveApp.getFolderById(parentId).getFoldersByName(name);
  return it.hasNext() ? it.next().getId() : '';
}
