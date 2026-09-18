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

  var result = { 対象: yearName + '/' + monthName, コピー: [], 済み: 0, skip: [], 残り: 0 };
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

  // コピー済みなら OCR せずに飛ばす
  if (alreadyCopied_(prefix, sizeFolders)) { result.済み++; return 'already'; }

  var text = readPdfText_(file);

  var size = extractSizeKg_(text);
  if (!size) throw new Error('品名から容器サイズを読めません');

  var dest = sizeFolders[size];
  if (!dest) throw new Error(size + 'kg の振り分け先フォルダがありません');

  var to = extractDestination_(text);
  var newName = prefix + (to || '出荷先不明') + '.pdf';

  DriveApp.getFolderById(dest.id).createFile(file.getBlob().setName(newName));
  result.コピー.push(dest.path + '/' + newName);
  return 'copied';
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

  // 得意先コードを落とす。空白が無い場合がある(8537(株小国資源開発)。
  // 会社名を削らないよう、実際の形(4桁数字 または 英字1+数字3)に限る。
  line = line.replace(/^(?:\d{4}|[A-Za-z]\d{3})(?=[\s(（])\s*/, '');

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
