/**
 * 作業指示一覧のPDF
 * ------------------------------------------------------------
 * 指図書と同じ流れでチェックできるよう、作業指示一覧(簡易版)を PDF にして
 * 容器種類別のサイズのフォルダに置く。アプリで開いてペンで書き込み、
 * チェック完了すると ◆チェック完了/<年>/<月>/<サイズ> に入る(指図書と同じ)。
 *
 *   名前  26.10.26_作業指示一覧(50Ｋ).pdf
 *         「出荷日_依頼No_出荷先」の形にしない(2つ目の _ を入れない)。
 *         指図書のコピー向けの片付け・名前直し・数量の読み足しが触らないように。
 *   説明欄 一覧の依頼No:26-30613-0(1),26-30614-0(1)
 *         一覧の中身:<md5>
 *
 * 振り分け(runSort)のたびに、今日以降の出荷日について作り直す。
 *   - まだ書き込んでいない一覧は、中身が変わっていれば作り直す
 *   - 書き込んだ(途中保存)・チェック完了した一覧は触らない。その後に増えた
 *     指図書だけの一覧を「…(50Ｋ)追加.pdf」で別に作る
 *   - 指図書が無くなった日の、書き込んでいない一覧はゴミ箱へ
 */
var WORK_LIST_BUDGET_MS = 90 * 1000;   // 1回の振り分けで一覧づくりに使う時間。残りは次の回
var WL_INFO_ORDERS = '一覧の依頼No';
var WL_INFO_HASH = '一覧の中身';

function makeWorkLists_() {
  var started = Date.now();
  var w = workIndex_();
  var made = [], left = 0;

  // いまある一覧を 出荷日|サイズのフォルダ名 ごとに
  var have = {};
  w.workLists.forEach(function (l) {
    var k = l.key + '|' + workListSize_(l.name);
    (have[k] = have[k] || []).push(l);
  });

  var keys = Object.keys(w.rows).filter(function (k) { return dayNum_(k) >= w.today; })
    .sort(function (a, b) { return dayNum_(a) - dayNum_(b); });   // 近い日から

  var seen = {};
  keys.forEach(function (key) {
    var byKg = {};
    workRowsOf_(w.rows[key]).forEach(function (r) {
      if (r.kg && w.sizeIndex[r.kg]) (byKg[r.kg] = byKg[r.kg] || []).push(r);
    });

    Object.keys(byKg).forEach(function (kg) {
      var folder = w.sizeIndex[kg];
      var size = folder.path.split('/').pop();
      var lists = have[key + '|' + size] || [];
      seen[key + '|' + size] = true;

      // 書き込んだ・チェック完了した一覧に載っている指図書は、もう載せない
      var fixed = {}, nFixed = 0;
      lists.forEach(function (l) {
        if (!l.done && !l.saved) return;
        nFixed++;
        workListOrders_(l.description).forEach(function (no) { fixed[no] = true; });
      });
      var open = lists.filter(function (l) { return !l.done && !l.saved; });
      var rows = byKg[kg].filter(function (r) { return !fixed[r.no]; });

      if (!rows.length) {             // 全部どこかの一覧に載っている
        open.forEach(function (l) { trashFile_(l.id); });
        return;
      }

      var name = key + '_' + WORK_LIST_WORD + '(' + size + ')' +
                 (nFixed ? '追加' + (nFixed > 1 ? nFixed : '') : '') + '.pdf';
      var hash = workListHash_(rows);
      var keep = open[0];
      open.slice(1).forEach(function (l) { trashFile_(l.id); });      // 二重にできていたら1つに
      if (keep && readInfo_(keep.description)[WL_INFO_HASH] === hash && keep.name === name) return;

      if (Date.now() - started > WORK_LIST_BUDGET_MS || overBudget_()) { left++; return; }

      var desc = WL_INFO_ORDERS + ':' + rows.map(function (r) { return r.no; }).join(',') + '\n' +
                 WL_INFO_HASH + ':' + hash;
      var blob = workListPdf_(key, size, rows, !!nFixed).setName(name);
      if (keep) {
        Drive.Files.update({ name: name, description: desc }, keep.id, blob, { supportsAllDrives: true });
      } else {
        Drive.Files.create({ name: name, parents: [folder.id], description: desc, mimeType: MimeType.PDF },
                           blob, { supportsAllDrives: true });
      }
      made.push(folder.path + '/' + name + '  ' + rows.length + '件' + (keep ? '(作り直し)' : ''));
    });
  });

  // 指図書が無くなった日・サイズの、書き込んでいない一覧は片付ける
  Object.keys(have).forEach(function (k) {
    if (seen[k] || dayNum_(k.split('|')[0]) < w.today) return;
    have[k].forEach(function (l) { if (!l.done && !l.saved) trashFile_(l.id); });
  });

  return { 件数: made.length, 一覧: made, 残り: left };
}

/** '26.10.26_作業指示一覧(50Ｋ)追加.pdf' → '50Ｋ' */
function workListSize_(name) {
  var m = String(name).match(/作業指示一覧\(([^)]+)\)/);
  return m ? m[1] : '';
}

function workListOrders_(description) {
  var v = readInfo_(description)[WL_INFO_ORDERS];
  return v ? v.split(',') : [];
}

/** 一覧に載せる中身が変わったかを見る指紋。状態(完了など)は入れない(変わるたびに作り直さない) */
function workListHash_(rows) {
  var s = JSON.stringify(rows.map(function (r) {
    return [r.no, r.to, r.qty, r.range, r.time, r.item, r.rev];
  }));
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function trashFile_(id) {
  try { Drive.Files.update({ trashed: true }, id, null, { supportsAllDrives: true }); } catch (e) {}
}

/**
 * 一覧の PDF を作る。HTML を Google ドキュメントに変換してから PDF で取り出す
 * (日本語の字形と表の罫線がきれいに出る)。変換に使ったドキュメントは捨てる。
 */
function workListPdf_(key, size, rows, extra) {
  var doc = null;
  try {
    doc = Drive.Files.create(
      { name: 'wl_' + Utilities.getUuid(), mimeType: MimeType.GOOGLE_DOCS },
      Utilities.newBlob(workListHtml_(key, size, rows, extra), 'text/html', 'wl.html')
    );
    return DriveApp.getFileById(doc.id).getAs(MimeType.PDF);
  } finally {
    if (doc && doc.id) {
      try { DriveApp.getFileById(doc.id).setTrashed(true); } catch (e) {}
    }
  }
}

function workListHtml_(key, size, rows, extra) {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var p = key.split('.');
  var d = new Date(2000 + Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var label = Number(p[1]) + '月' + Number(p[2]) + '日(' + '日月火水木金土'.charAt(d.getDay()) + ')';
  var qty = 0, miss = 0;
  rows.forEach(function (r) { if (r.qty) qty += Number(r.qty); else miss++; });
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var madeAt = Utilities.formatDate(new Date(), tz, 'M/d HH:mm');

  var td = 'style="border:1px solid #555;padding:9pt 4pt;font-size:10pt;vertical-align:middle;"';
  var th = 'style="border:1px solid #555;padding:4pt;font-size:9pt;background-color:#e8e8e8;"';
  var cols = [['チェック', 9], ['依頼No.', 15], ['出荷先', 24], ['品名', 15], ['数量', 7], ['容器No.', 20], ['時間指定', 10]];

  var h = [];
  h.push('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;">');
  h.push('<p style="font-size:16pt;font-weight:bold;margin:0;">作業指示一覧(簡易版)' + (extra ? ' 追加分' : '') +
         ' ' + esc(label) + ' 出荷  ' + esc(size) + '</p>');
  h.push('<p style="font-size:10pt;margin:2pt 0 8pt 0;">' + rows.length + ' 件 · ' + qty + ' 本' +
         (miss ? '(数量不明 ' + miss + ' 件)' : '') + '    作成 ' + esc(madeAt) +
         '    振り分けたコピーから作っています。正式な一覧表は当日の発行分を見てください。</p>');
  h.push('<table style="border-collapse:collapse;width:100%;"><tr>');
  cols.forEach(function (c) { h.push('<th ' + th + ' width="' + c[1] + '%">' + c[0] + '</th>'); });
  h.push('</tr>');
  rows.forEach(function (r) {
    h.push('<tr>');
    h.push('<td ' + td + '>&nbsp;</td>');
    h.push('<td ' + td + '>' + esc(r.no) + (r.rev ? '<br><span style="font-size:8pt;">訂正版</span>' : '') + '</td>');
    h.push('<td ' + td + '>' + esc(r.to) + '</td>');
    h.push('<td ' + td + '>' + esc(r.item) + '</td>');
    h.push('<td ' + td + ' align="right">' + (r.qty ? esc(r.qty) + '本' : '—') + '</td>');
    h.push('<td ' + td + '>' + esc(String(r.range || '').replace('~', ' 〜 ')) + '</td>');
    h.push('<td ' + td + '>' + esc(r.time) + '</td>');
    h.push('</tr>');
  });
  h.push('</table></body></html>');
  return h.join('');
}
