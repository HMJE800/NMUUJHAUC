/* =========================================================================
   שלוחה 5 — חישוב מצוות (ימות המשיח) → Firebase Firestore
   הזרימה: טלפון → ימות → השרת הזה → workspaces/<קוד> ב‑Firestore → האפליקציה
   בטלפון: אלף = אני · בית = השליח · גימל = הסוכן
   ========================================================================= */

const express = require('express');
const admin = require('firebase-admin');
const { YemotRouter } = require('yemot-router2');

/* ---------- רשת ביטחון: שגיאה לא צפויה לא תפיל את השרת ---------- */
process.on('uncaughtException',  (err) => console.error('⚠️ uncaughtException:', err && err.message));
process.on('unhandledRejection', (err) => console.error('⚠️ unhandledRejection:', err && err.message));

/* ---------- הגדרות ---------- */
const WORKSPACE_CODE = process.env.WORKSPACE_CODE || '037220172';
const ENTRY_DESC     = process.env.ENTRY_DESC     || 'נרשם בטלפון';
const PIN            = process.env.PIN            || '';
const PORT           = process.env.PORT           || 3000;

// יתרת הפתיחה של הדולרים אצלי (אלף) — זהה לקובץ האתר
const OPENING_USD = Number(process.env.OPENING_USD || 3100);
const OPENING_TS  = Number(process.env.OPENING_TS  || Date.parse('2026-10-23T00:00:00+03:00'));

/* ---------- Firebase ---------- */
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const db = admin.firestore();
const wsRef = () => db.collection('workspaces').doc(WORKSPACE_CODE);

/* ---------- תאריך/שעה כמו באפליקציה ---------- */
function nowParts() {
  const tz = 'Asia/Jerusalem';
  const d = new Date();
  return {
    date: d.toLocaleDateString('he-IL', { timeZone: tz }),
    time: d.toLocaleTimeString('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

// זמן הרישום מתוך המזהה (SHP-1782230882470 → 1782230882470)
function tsOf(e) {
  const m = String((e && e.id) || '').match(/(\d{10,})/);
  return m ? Number(m[1]) : 0;
}

/* ---------- חישובים ---------- */
// בית (השליח) וגימל (הסוכן) — כמו במסך "חשבון שליח" באתר
function computeShipperSummary(entries) {
  let given = 0, debtMain = 0, paidMain = 0;
  for (const e of entries) {
    if (e.ledger === 'shipper') { if (e.kind === 'shipper_pay') given += Number(e.amount) || 0; }
    else if (e.ledger === 'usd') { /* קניית דולרים — לא חלק מהחשבון מול גימל */ }
    else if (e.kind === 'order' || e.kind === 'delivery' || e.kind === 'expense') debtMain += Number(e.amount) || 0;
    else if (e.kind === 'payment') paidMain += Number(e.amount) || 0;
  }
  const moneyAtShipper = given - paidMain;
  const debtToAgent    = debtMain - paidMain;
  const stillToGive    = debtToAgent - moneyAtShipper;
  return { debtToAgent, stillToGive, moneyAtShipper, given, paidMain, debtMain };
}

// אלף (אני) — יתרת פתיחה + קניות − מה שהעברתי לבית מאז הפתיחה
function computeUsdSummary(entries) {
  let bought = 0, paidIls = 0, givenSince = 0;
  for (const e of entries) {
    if (e.ledger === 'usd' && e.kind === 'usd_buy') { bought += Number(e.amount) || 0; paidIls += Number(e.ils) || 0; }
    else if (e.ledger === 'shipper' && e.kind === 'shipper_pay' && tsOf(e) >= OPENING_TS) givenSince += Number(e.amount) || 0;
  }
  return { atMe: OPENING_USD + bought - givenSince, bought, paidIls, givenSince };
}

/* ---------- הקראה ---------- */
const ils = (n) => Math.round(n);
const BOXES_PER_CRATE = 24; // קופסאות בארגז (כמו במערכת)

// מסננת קפדנית: משאירה רק אותיות עברית/אנגלית ספרות ורווחים — ימות דוחה כל השאר
const cleanTxt = (s) => String(s || '')
  .replace(/מ"ג/g, ' מיליגרם ')
  .replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const say = (txt) => ({ type: 'text', data: cleanTxt(txt) });

// שליחה בטוחה: מסנן הודעות ריקות, ואם אין כלום — משמיע הודעת גיבוי
const send = (call, msgs) => {
  const clean = msgs.filter(m => m && m.data && m.data.trim().length > 0);
  if (clean.length === 0) clean.push(say('אין מידע להשמעה להתראות'));
  return call.id_list_message(clean);
};

// תאריך שהסוכן מקליד בתיאור בפורמט אמריקאי (חודש/יום/שנה) → יום.חודש.שנה — זהה לאתר
function ilDates(t) {
  return String(t == null ? '' : t).replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, mo, d, y) => {
    mo = +mo; d = +d;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return m;
    return `${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}.${y}`;
  });
}

// קריאת מספר עשרוני בבטחה: הספרות אחרי הנקודה אחת-אחת, כדי ש-3.07 לא יישמע כ-3.7
// 3.70 → "3 נקודה 7 0" · 3.07 → "3 נקודה 0 7" · 1.5 → "1 נקודה 5"
const sayNum = (n) => { const [a, b] = String(n).split('.'); return b ? `${a} נקודה ${b.split('').join(' ')}` : a; };

const ORDINALS = ['ראשונה', 'שנייה', 'שלישית', 'רביעית', 'חמישית', 'שישית', 'שביעית', 'שמינית', 'תשיעית', 'עשירית'];
const ordinal = (i) => ORDINALS[i] || `מספר ${i + 1}`;

// "23.6.2026" → "23 6"
const sayDate = (e) => String(e.date || '').split(/[./]/).slice(0, 2).join(' ');

function kindLabel(kind) {
  return kind === 'order'    ? 'רכישת סחורה'
       : kind === 'payment'  ? 'קבלת תשלום'
       : kind === 'delivery' ? 'הוצאת משלוח'
       : kind === 'expense'  ? 'הוצאה'
       : 'רשומה';
}

// אלף — כמה יש אצלי (סעיף 5)
function atMeLine(u) {
  if (u.atMe < -0.01) return `יצאו ממך ${ils(Math.abs(u.atMe))} דולר יותר ממה שנרשם שקנית`;
  return `יש אצלך כעת ${ils(u.atMe)} דולר`;
}

// אלף — הקשה 6 (כמה עוד להעביר לבית כדי לכסות את החוב לגימל)
function stillToGiveLine(s) {
  if (s.stillToGive > 0.01)       return `כדי לכסות את החוב לגימל עליך להעביר לבית עוד ${ils(s.stillToGive)} דולר`;
  else if (s.stillToGive < -0.01) return `יש עודף אצל בית של ${ils(Math.abs(s.stillToGive))} דולר`;
  else                            return 'אין צורך להעביר עוד לבית';
}

// בית — המאזן (סעיף 10)
function shipperBalanceLines(s) {
  const m = s.moneyAtShipper || 0;
  const head = `בית קיבל ממך ${ils(s.given || 0)} דולר והעביר לגימל ${ils(s.paidMain || 0)} דולר`;
  let tail;
  if (m > 0.01)       tail = `אלף בזכות אצל בית ${ils(m)} דולר`;
  else if (m < -0.01) tail = `בית בזכות על אלף ${ils(Math.abs(m))} דולר`;
  else                tail = 'המאזן של בית מאוזן';
  return [head, tail];
}

// אלף — הדולרים שלך מול ההוצאות (הקשה 7): כל הדולרים (מה שנתת לבית + מה שאצלך) מול כל מה שגימל הוציא
function coverLines(s, u) {
  const total = (s.given || 0) + u.atMe;
  const c = total - (s.debtMain || 0);
  const head = `כל הדולרים שלך ${ils(total)} דולר הסוכן הוציא ${ils(s.debtMain || 0)} דולר`;
  let tail;
  if (c > 0.01)       tail = `עודף ${ils(c)} דולר מעבר לכל מה שהסוכן הוציא`;
  else if (c < -0.01) tail = `חסרים ${ils(Math.abs(c))} דולר כדי לכסות את כל מה שהסוכן הוציא`;
  else                tail = 'מאוזן';
  return [head, tail];
}

// גימל — המאזן (סעיף 14)
function agentBalanceLines(s) {
  const diff = (s.paidMain || 0) - (s.debtMain || 0);
  const head = `גימל קיבל מבית ${ils(s.paidMain || 0)} דולר והוציא ${ils(s.debtMain || 0)} דולר`;
  let tail;
  if (diff > 0.01)       tail = `יש אצל גימל ${ils(diff)} דולר בזכות`;
  else if (diff < -0.01) tail = `גימל הוציא ${ils(Math.abs(diff))} דולר יותר ממה שקיבל זה חוב של ${ils(Math.abs(diff))} דולר`;
  else                   tail = 'המאזן של גימל מאוזן';
  return [head, tail];
}

/* ---------- גישה ל‑Firestore ---------- */
async function loadEntries() {
  const snap = await wsRef().get();
  const data = snap.exists ? snap.data() : {};
  return Array.isArray(data.entries) ? data.entries : [];
}

// הוספת רשומה בראש המערך (כמו באתר) — בטרנזקציה.
// entryOrBuilder: רשומה, או פונקציה שבונה אותה מתוך הרשומות הקיימות (למשל מספר קנייה רץ)
async function addEntry(entryOrBuilder) {
  let entries, entry;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(wsRef());
    const data = snap.exists ? snap.data() : {};
    entries = Array.isArray(data.entries) ? data.entries.slice() : [];
    entry = typeof entryOrBuilder === 'function' ? entryOrBuilder(entries) : entryOrBuilder;
    entries.unshift(entry);
    tx.set(wsRef(), { entries, updatedAt: Date.now() }, { merge: true });
  });
  entries.lastAdded = entry;
  return entries;
}

// מספר קנייה רץ: הגבוה ביותר שקיים + 1 (מחיקה לא משנה מספרים של אחרות) — זהה לאתר
function nextBuyNum(entries) {
  return entries.reduce((m, e) => (e.ledger === 'usd' && e.kind === 'usd_buy' && Number(e.num) > m) ? Number(e.num) : m, 0) + 1;
}

// מחיקה לפי מזהה, רק אם הרשומה עדיין עונה על התנאי — בטרנזקציה
async function deleteEntryById(id, isAllowed) {
  let entries, deleted = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(wsRef());
    const data = snap.exists ? snap.data() : {};
    entries = Array.isArray(data.entries) ? data.entries.slice() : [];
    const idx = entries.findIndex(e => e.id === id && isAllowed(e));
    if (idx === -1) return;
    entries.splice(idx, 1);
    tx.set(wsRef(), { entries, updatedAt: Date.now() }, { merge: true });
    deleted = true;
  });
  return { deleted, entries };
}

const isUsdBuy      = (e) => e.ledger === 'usd' && e.kind === 'usd_buy';
const isShipperPay  = (e) => e.ledger === 'shipper' && e.kind === 'shipper_pay';
const isAlefAction  = (e) => isUsdBuy(e) || isShipperPay(e);
const isPayment     = (e) => e.ledger !== 'shipper' && e.ledger !== 'usd' && e.kind === 'payment';
const isAgentSpend  = (e) => e.ledger !== 'shipper' && e.ledger !== 'usd' && ['order', 'delivery', 'expense'].includes(e.kind);
const newestFirst   = (list) => list.slice().sort((a, b) => tsOf(b) - tsOf(a));

/* ---------- קלט מספרי ---------- */
async function readWhole(call, prompt, maxDigits) {
  const raw = await call.read([say(prompt)], 'tap', { max_digits: maxDigits, min_digits: 1 });
  const n = parseInt(raw, 10);
  return (n && n > 0) ? n : null;
}
async function confirmed(call, text) {
  const c = await call.read([say(text)], 'tap', { max_digits: 1, min_digits: 1 });
  return c === '1';
}

/* ====================== שלוחה 1 — אלף ====================== */
async function alefMenu(call) {
  const choice = await call.read([say('לרישום קניית דולרים הקש 1 לרישום העברה לבית הקש 2 לשמיעת כמה דולרים יש אצלך כעת הקש 3 לשמיעת הקניות וההעברות האחרונות הקש 4 למחיקת הפעולה האחרונה הקש 5 לשמיעת כמה עוד צריך להעביר לבית הקש 6 לשמיעת הדולרים שלך מול ההוצאות הקש 7')],
    'tap', { max_digits: 1, min_digits: 1, digits_allowed: [1, 2, 3, 4, 5, 6, 7] });
  console.log('   אלף, בחירה:', choice);

  /* 1-1: קניית דולרים */
  if (choice === '1') {
    const usd = await readWhole(call, 'נא הקש כמה דולרים קנית ואחריו סולמית', 7);
    if (!usd) return send(call, [say('סכום לא תקין להתראות')]);
    const nis = await readWhole(call, 'נא הקש כמה שקלים שילמת ואחריו סולמית', 8);
    if (!nis) return send(call, [say('סכום לא תקין להתראות')]);
    const rate = (nis / usd).toFixed(2);
    if (!await confirmed(call, `קנית ${usd} דולר ב ${nis} שקלים שער ${sayNum(rate)} שקלים לדולר לאישור הקש 1 לביטול הקש 2`)) {
      return send(call, [say('הפעולה בוטלה להתראות')]);
    }
    const { date, time } = nowParts();
    const entries = await addEntry((list) => ({ id: 'USD-' + Date.now(), ledger: 'usd', kind: 'usd_buy', num: nextBuyNum(list), date, time, amount: usd, ils: nis, desc: ENTRY_DESC }));
    const num = entries.lastAdded.num;
    console.log('   ✅ קניית דולרים:', num, usd, nis);
    return send(call, [say('נרשם בהצלחה'), say(`מספר קנייה ${num}`), say(atMeLine(computeUsdSummary(entries))), say('להתראות')]);
  }

  /* 1-2: העברה לבית */
  if (choice === '2') {
    const amount = await readWhole(call, 'נא הקש כמה דולרים העברת לבית ואחריו סולמית', 7);
    if (!amount) return send(call, [say('סכום לא תקין להתראות')]);
    if (!await confirmed(call, `הקשת ${amount} דולר לאישור הקש 1 לביטול הקש 2`)) {
      return send(call, [say('הפעולה בוטלה להתראות')]);
    }
    const { date, time } = nowParts();
    const entries = await addEntry({ id: 'SHP-' + Date.now(), ledger: 'shipper', kind: 'shipper_pay', date, time, amount, desc: ENTRY_DESC });
    console.log('   ✅ העברה לבית:', amount);
    const u = computeUsdSummary(entries);
    const left = u.atMe < -0.01 ? atMeLine(u) : `נשארו אצלך ${ils(u.atMe)} דולר`;
    return send(call, [say('נרשם בהצלחה'), say(`העברת לבית ${amount} דולר`), say(left), say('להתראות')]);
  }

  /* 1-3: כמה יש אצלי */
  if (choice === '3') {
    const u = computeUsdSummary(await loadEntries());
    return send(call, [say(atMeLine(u)), say('להתראות')]);
  }

  /* 1-4: הקניות וההעברות האחרונות */
  if (choice === '4') {
    const entries = await loadEntries();
    const recent = newestFirst(entries.filter(isAlefAction)).slice(0, 5);
    if (recent.length === 0) return send(call, [say('אין פעולות להשמעה להתראות')]);
    const msgs = [];
    recent.forEach((e, i) => {
      msgs.push(say(`פעולה ${ordinal(i)}`));
      if (isUsdBuy(e)) msgs.push(say(`בתאריך ${sayDate(e)} ${e.num ? `קנייה מספר ${e.num} ` : ''}קנית ${ils(e.amount)} דולר ב ${ils(e.ils || 0)} שקלים`));
      else             msgs.push(say(`בתאריך ${sayDate(e)} העברת לבית ${ils(e.amount)} דולר`));
      const dsc = cleanTxt(ilDates(e.desc || ''));
      if (dsc && e.desc !== ENTRY_DESC) msgs.push(say(`פירוט ${dsc}`));
    });
    msgs.push(say(atMeLine(computeUsdSummary(entries))));
    msgs.push(say('להתראות'));
    return send(call, msgs);
  }

  /* 1-5: מחיקת הפעולה האחרונה (קנייה או העברה לבית) */
  if (choice === '5') {
    const last = newestFirst((await loadEntries()).filter(isAlefAction))[0];
    if (!last) return send(call, [say('אין פעולות למחיקה להתראות')]);
    const what = isUsdBuy(last)
      ? (last.num ? `קנייה מספר ${last.num} של ${ils(last.amount)} דולר` : `קניית ${ils(last.amount)} דולר`)
      : `העברה לבית של ${ils(last.amount)} דולר`;
    if (!await confirmed(call, `הפעולה האחרונה היא ${what} מתאריך ${sayDate(last)} למחיקה הקש 1 לביטול הקש 2`)) {
      return send(call, [say('המחיקה בוטלה להתראות')]);
    }
    const { deleted, entries } = await deleteEntryById(last.id, isAlefAction);
    console.log('   🗑️ מחיקת פעולה של אלף:', last.id, deleted ? 'הצליח' : 'לא נמצא');
    if (!deleted) return send(call, [say('הפעולה כבר נמחקה להתראות')]);
    return send(call, [say('הפעולה נמחקה'), say(atMeLine(computeUsdSummary(entries))), say('להתראות')]);
  }

  /* 1-7: הדולרים שלך מול ההוצאות */
  if (choice === '7') {
    const entries = await loadEntries();
    return send(call, [...coverLines(computeShipperSummary(entries), computeUsdSummary(entries)).map(say), say('להתראות')]);
  }

  /* 1-6: כמה עוד צריך להעביר לבית כדי לכסות את החוב לגימל */
  const s = computeShipperSummary(await loadEntries());
  return send(call, [say(stillToGiveLine(s)), say('להתראות')]);
}

/* ====================== שלוחה 2 — בית ====================== */
async function betMenu(call) {
  const choice = await call.read([say('לרישום סכום שבית העביר לגימל הקש 1 לשמיעת המאזן של בית הקש 2 לשמיעת ההעברות האחרונות לגימל הקש 3 למחיקת ההעברה האחרונה הקש 4')],
    'tap', { max_digits: 1, min_digits: 1, digits_allowed: [1, 2, 3, 4] });
  console.log('   בית, בחירה:', choice);

  /* 2-1: בית העביר לגימל */
  if (choice === '1') {
    const amount = await readWhole(call, 'נא הקש כמה דולרים בית העביר לגימל ואחריו סולמית', 7);
    if (!amount) return send(call, [say('סכום לא תקין להתראות')]);
    if (!await confirmed(call, `הקשת ${amount} דולר לאישור הקש 1 לביטול הקש 2`)) {
      return send(call, [say('הפעולה בוטלה להתראות')]);
    }
    const { date, time } = nowParts();
    const entries = await addEntry({ id: 'PAY-' + Date.now(), kind: 'payment', date, time, amount, desc: ENTRY_DESC });
    console.log('   ✅ בית העביר לגימל:', amount);
    return send(call, [
      say('נרשם בהצלחה'), say(`בית העביר לגימל ${amount} דולר`),
      ...shipperBalanceLines(computeShipperSummary(entries)).map(say),
      say('להתראות'),
    ]);
  }

  /* 2-2: המאזן של בית */
  if (choice === '2') {
    const s = computeShipperSummary(await loadEntries());
    return send(call, [...shipperBalanceLines(s).map(say), say('להתראות')]);
  }

  /* 2-3: ההעברות האחרונות לגימל */
  if (choice === '3') {
    const recent = newestFirst((await loadEntries()).filter(isPayment)).slice(0, 5);
    if (recent.length === 0) return send(call, [say('אין פעולות להשמעה להתראות')]);
    const msgs = [];
    recent.forEach((e, i) => {
      msgs.push(say(`פעולה ${ordinal(i)}`));
      msgs.push(say(`בתאריך ${sayDate(e)} בית העביר לגימל ${ils(e.amount)} דולר`));
    });
    msgs.push(say('להתראות'));
    return send(call, msgs);
  }

  /* 2-4: מחיקת ההעברה האחרונה לגימל */
  const last = newestFirst((await loadEntries()).filter(isPayment))[0];
  if (!last) return send(call, [say('אין פעולות למחיקה להתראות')]);
  if (!await confirmed(call, `ההעברה האחרונה היא ${ils(last.amount)} דולר מתאריך ${sayDate(last)} למחיקה הקש 1 לביטול הקש 2`)) {
    return send(call, [say('המחיקה בוטלה להתראות')]);
  }
  const { deleted, entries } = await deleteEntryById(last.id, isPayment);
  console.log('   🗑️ מחיקת העברה לגימל:', last.id, deleted ? 'הצליח' : 'לא נמצא');
  if (!deleted) return send(call, [say('הפעולה כבר נמחקה להתראות')]);
  return send(call, [say('ההעברה נמחקה'), ...shipperBalanceLines(computeShipperSummary(entries)).map(say), say('להתראות')]);
}

/* ====================== שלוחה 3 — גימל ====================== */
async function gimelMenu(call) {
  const choice = await call.read([say('לשמיעת המאזן של גימל הקש 1 לשמיעת הקניות והמשלוחים האחרונים הקש 2')],
    'tap', { max_digits: 1, min_digits: 1, digits_allowed: [1, 2] });
  console.log('   גימל, בחירה:', choice);

  /* 3-1: המאזן של גימל */
  if (choice === '1') {
    const s = computeShipperSummary(await loadEntries());
    return send(call, [...agentBalanceLines(s).map(say), say('להתראות')]);
  }

  /* 3-2: הקניות והמשלוחים האחרונים */
  const recent = newestFirst((await loadEntries()).filter(isAgentSpend)).slice(0, 5);
  if (recent.length === 0) return send(call, [say('אין רשומות במסד להשמעה להתראות')]);
  const msgs = [];
  recent.forEach((e, i) => {
    msgs.push(say(`פעולה ${ordinal(i)}`));
    msgs.push(say(`בתאריך ${sayDate(e)} ${kindLabel(e.kind)} ${ils(e.amount)} דולר`));
    const detail = cleanTxt(ilDates(e.note || e.desc || ''));
    if (detail) msgs.push(say(`פירוט ${detail}`));
    if (Array.isArray(e.items) && e.items.length > 0) {
      e.items.forEach((item) => {
        let line = `${cleanTxt(item.product)} ${cleanTxt(item.option)} ${item.count} ארגזים`;
        if (item.boxPrice && item.boxPrice > 0) {
          line += ` מחיר לקופסה ${sayNum(item.boxPrice)} דולר ${item.count * BOXES_PER_CRATE} קופסאות`;
        }
        msgs.push(say(line));
      });
    }
    if (e.discount && e.discount > 0) msgs.push(say(`הנחה ${sayNum(e.discount)} דולר`));
  });
  msgs.push(say('להתראות'));
  return send(call, msgs);
}

/* ====================== מערכת הטלפון ====================== */
const router = YemotRouter({ printLog: false, defaults: { removeInvalidChars: true, read: { timeout: 60000 } } });

router.get('/', async (call) => {
  console.log('📞 שיחה חדשה');
  try {
    if (PIN) {
      const pin = await call.read([say('נא הקש את קוד הגישה ואחריו סולמית')],
        'tap', { max_digits: 8, min_digits: 1 });
      if (pin !== PIN) return send(call, [say('קוד שגוי להתראות')]);
    }

    const who = await call.read([say('לחשבון של אלף הקש 1 לחשבון של בית הקש 2 לחשבון של גימל הקש 3')],
      'tap', { max_digits: 1, min_digits: 1, digits_allowed: [1, 2, 3] });
    console.log('   תפריט ראשי:', who);

    if (who === '1') return await alefMenu(call);
    if (who === '2') return await betMenu(call);
    return await gimelMenu(call);
  } catch (err) {
    // סיום רגיל של שיחה (הודעה אחרונה נשלחה) או ניתוק המתקשר — לא שגיאה אמיתית
    if (err && (err.isExitError || err.name === 'ExitError' || err.name === 'HangupError')) return;
    console.error('❌ שגיאה בשיחה:', err && err.message ? err.message : err);
    try {
      return send(call, [say('אירעה שגיאה נסה שוב מאוחר יותר')]);
    } catch (e2) {
      console.error('   (לא ניתן היה לשלוח הודעת שגיאה)');
    }
  }
});

/* ---------- שרת ---------- */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(router);
app.get('/health', (_req, res) => res.send('OK'));

if (require.main === module) {
  app.listen(PORT, () => console.log(`🚀 השרת רץ על פורט ${PORT}`));
}
module.exports = { app, computeShipperSummary, computeUsdSummary, nextBuyNum, tsOf, OPENING_USD, OPENING_TS };
