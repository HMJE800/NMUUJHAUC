/* =========================================================================
   רישום "נתתי לשליח" דרך הטלפון (ימות המשיח) → Firebase Firestore
   הזרימה: טלפון → ימות → השרת הזה → workspaces/<קוד> ב‑Firestore → האפליקציה
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

/* ---------- Firebase ---------- */
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const db = admin.firestore();

/* ---------- תאריך/שעה כמו באפליקציה ---------- */
function nowParts() {
  const tz = 'Asia/Jerusalem';
  const d = new Date();
  return {
    date: d.toLocaleDateString('he-IL', { timeZone: tz }),
    time: d.toLocaleTimeString('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

/* ---------- חישוב מצב חשבון השליח ---------- */
function computeShipperSummary(entries) {
  let given = 0, debtMain = 0, paidMain = 0;
  for (const e of entries) {
    if (e.ledger === 'shipper') { if (e.kind === 'shipper_pay') given += Number(e.amount) || 0; }
    else if (e.kind === 'order' || e.kind === 'delivery' || e.kind === 'expense') debtMain += Number(e.amount) || 0;
    else if (e.kind === 'payment') paidMain += Number(e.amount) || 0;
  }
  const moneyAtShipper = given - paidMain;
  const debtToAgent    = debtMain - paidMain;
  const stillToGive    = debtToAgent - moneyAtShipper;
  return { debtToAgent, stillToGive, moneyAtShipper, given, paidMain };
}

/* ---------- ניסוח "הריבוע הכחול" ---------- */
const ils = (n) => Math.round(n);

const BOXES_PER_CRATE = 24; // קופסאות בארגז (כמו במערכת)

// ניקוי טקסט להקראה: מ"ג → מיליגרם, והסרת תווים שימות דוחה (גרשיים נקודה פסיק)
// מסננת קפדנית: משאירה רק אותיות עברית/אנגלית ספרות ורווחים — ימות דוחה כל השאר
const cleanTxt = (s) => String(s || '')
  .replace(/מ"ג/g, ' מיליגרם ')
  .replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// כל טקסט שנשלח לימות עובר כאן
const say = (txt) => ({ type: 'text', data: cleanTxt(txt) });

// שליחה בטוחה: מסנן הודעות ריקות, ואם אין כלום — משמיע הודעת גיבוי
const send = (call, msgs) => {
  const clean = msgs.filter(m => m && m.data && m.data.trim().length > 0);
  if (clean.length === 0) clean.push(say('אין מידע להשמעה להתראות'));
  return call.id_list_message(clean);
};

// קריאת מספר עשרוני בבטחה: 16.3 → "16 נקודה 3"
const sayNum = (n) => String(n).replace('.', ' נקודה ');

// מילות סידור בעברית: פעולה ראשונה, שנייה, שלישית...
const ORDINALS = ['ראשונה', 'שנייה', 'שלישית', 'רביעית', 'חמישית', 'שישית', 'שביעית', 'שמינית', 'תשיעית', 'עשירית'];
const ordinal = (i) => ORDINALS[i] || `מספר ${i + 1}`;


// שורת מצב השליח (הריבוע הכחול)
function shipperLine(s) {
  if (s.stillToGive > 0.01)       return `עליך להעביר לשליח עוד ${ils(s.stillToGive)} דולר`;
  else if (s.stillToGive < -0.01) return `יש עודף אצל השליח של ${ils(Math.abs(s.stillToGive))} דולר`;
  else                            return 'אין צורך להעביר עוד לשליח';
}

// שורת זכות/חובה מול השליח — כמו הריבוע האדום באפליקציה
// moneyAtShipper = נתת לשליח פחות הועבר לסוכן (קבלת תשלום)
function shipperBalanceLine(s) {
  const m = s.moneyAtShipper || 0;
  let head;
  if (m < -0.01)      head = `השליח הקדים מכיסו ${ils(Math.abs(m))} דולר`;
  else if (m > 0.01)  head = `יש אצל השליח כסף שלך ${ils(m)} דולר`;
  else                head = 'אין זכות ואין חובה מול השליח';
  return [head, `נתת לשליח ${ils(s.given || 0)} דולר הועבר לסוכן ${ils(s.paidMain || 0)} דולר`];
}

// שורת החוב/עודף לאחראי
function agentDebtLine(s) {
  if (s.debtToAgent > 0.01)       return `החוב לאחראי הוא ${ils(s.debtToAgent)} דולר`;
  else if (s.debtToAgent < -0.01) return `יש עודף אצל האחראי של ${ils(Math.abs(s.debtToAgent))} דולר`;
  else                            return 'אין חוב לאחראי';
}

// שתי השורות יחד (לסיום שיחת הוספת כסף)
function blueBoxSpeech(s) {
  return `${shipperLine(s)} ${agentDebtLine(s)}`;
}

/* ---------- כתיבה ל‑Firestore ---------- */
async function addShipperPayment(amount) {
  const { date, time } = nowParts();
  const entry = { id: 'SHP-' + Date.now(), ledger: 'shipper', kind: 'shipper_pay', date, time, amount, desc: ENTRY_DESC };
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  let summary;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const entries = Array.isArray(data.entries) ? data.entries : [];
    entries.unshift(entry);
    tx.set(ref, { entries, updatedAt: Date.now() }, { merge: true });
    summary = computeShipperSummary(entries);
  });
  return { entry, summary };
}

/* ---------- קריאת מצב בלבד (בלי לכתוב) ---------- */
async function getSummary() {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return computeShipperSummary(entries);
}

/* ---------- מציאת הרשומה האחרונה של "נתתי לשליח" (בלי למחוק) ---------- */
async function getLastShipperPayment() {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  // הרשומות החדשות בראש המערך — נחפש את הראשונה מסוג shipper_pay
  const last = entries.find(e => e.ledger === 'shipper' && e.kind === 'shipper_pay');
  return last || null;
}

/* ---------- מציאת N הרשומות האחרונות של "נתתי לשליח" ---------- */
async function getRecentShipperPayments(n) {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries.filter(e => e.ledger === 'shipper' && e.kind === 'shipper_pay').slice(0, n);
}

// שם הסוג בעברית (כמו במערכת)
function kindLabel(kind) {
  return kind === 'order'    ? 'רכישת סחורה'
       : kind === 'payment'  ? 'קבלת תשלום'
       : kind === 'delivery' ? 'הוצאת משלוח'
       : kind === 'expense'  ? 'הוצאה'
       : 'רשומה';
}

/* ---------- שליפת כל מסד ההזמנות (כל הסוגים, מלבד נתתי לשליח) ---------- */
async function getAllLedger() {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries.filter(e => ['order', 'payment', 'delivery', 'expense'].includes(e.kind));
}

/* ---------- מחיקת רשומת "נתתי לשליח" לפי מזהה (בטוח, עם טרנזקציה) ---------- */
async function deleteShipperPaymentById(id) {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  let summary, deleted = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const idx = entries.findIndex(e => e.id === id && e.ledger === 'shipper' && e.kind === 'shipper_pay');
    if (idx === -1) { summary = computeShipperSummary(entries); return; }
    entries.splice(idx, 1); // הסרת הרשומה
    tx.set(ref, { entries, updatedAt: Date.now() }, { merge: true });
    summary = computeShipperSummary(entries);
    deleted = true;
  });
  return { deleted, summary };
}

/* ---------- מערכת הטלפון ---------- */
const router = YemotRouter({ printLog: false, defaults: { removeInvalidChars: true, read: { timeout: 60000 } } });

router.get('/', async (call) => {
  console.log('📞 שיחה חדשה');
  try {
    if (PIN) {
      const pin = await call.read([say('נא הקש את קוד הגישה ואחריו סולמית')],
        'tap', { max_digits: 8, min_digits: 1 });
      if (pin !== PIN) return send(call, [say('קוד שגוי להתראות')]);
    }

    // תפריט ראשי
    const choice = await call.read([{ type: 'text',
      data: 'להוספת כסף לשליח הקש 1 לשמיעת מצב השליח הקש 2 לשמיעת חוב לאחראי הקש 3 למחיקת הפעולה האחרונה הקש 4 לשמיעת הפעולות האחרונות הקש 5 לשמיעת כל מסד ההזמנות הקש 6 לשמיעת זכות או חובה מול השליח הקש 7' }],
      'tap', { max_digits: 1, min_digits: 1, digits_allowed: [1, 2, 3, 4, 5, 6, 7] });
    console.log('   בחירת תפריט:', choice);

    /* ===== 2: שמיעת מצב השליח (עודף/חוב) בלבד ===== */
    if (choice === '2') {
      const s = await getSummary();
      return send(call, [
        say(shipperLine(s)),
        say('להתראות'),
      ]);
    }

    /* ===== 7: שמיעת זכות/חובה מול השליח ===== */
    if (choice === '7') {
      const s = await getSummary();
      return send(call, [
        ...shipperBalanceLine(s).map(say),
        say('להתראות'),
      ]);
    }

    /* ===== 3: שמיעת חוב/עודף לאחראי בלבד ===== */
    if (choice === '3') {
      const s = await getSummary();
      return send(call, [
        say(agentDebtLine(s)),
        say('להתראות'),
      ]);
    }

    /* ===== 5: שמיעת הפעולות האחרונות ===== */
    if (choice === '5') {
      const recent = await getRecentShipperPayments(5);
      if (recent.length === 0) {
        return send(call, [say('אין פעולות להשמעה להתראות')]);
      }
      const msgs = [];
      recent.forEach((e, i) => {
        const t = String(e.time || '').replace(/:/g, ' ');
        const parts = String(e.date || '').split(/[./]/);     // 23.6.2026 → [23,6,2026]
        const d = parts.slice(0, 2).join(' ');                 // יום וחודש בלבד: "23 6"
        msgs.push(say(`פעולה ${ordinal(i)}`));                 // הודעה נפרדת = הפסקה טבעית
        msgs.push(say(`בתאריך ${d} בשעה ${t} נתתי לשליח ${ils(e.amount)} דולר`));
        const dsc = cleanTxt(e.desc || '');
        if (dsc) msgs.push(say(`פירוט ${dsc}`));
      });
      msgs.push(say('להתראות'));
      return send(call, msgs);
    }

    /* ===== 6: שמיעת כל מסד ההזמנות ===== */
    if (choice === '6') {
      const all = (await getAllLedger()).slice(0, 3);
      if (all.length === 0) {
        return send(call, [say('אין רשומות במסד להשמעה להתראות')]);
      }

      const msgs = [];
      all.forEach((e, i) => {
        const t = String(e.time || '').replace(/:/g, ' ');
        const parts = String(e.date || '').split(/[./]/);
        const d = parts.slice(0, 2).join(' ');

        // כל שורה היא הודעה נפרדת — ימות עושה הפסקה טבעית ביניהן
        msgs.push(say(`פעולה ${ordinal(i)}`));
        msgs.push(say(`בתאריך ${d} בשעה ${t} ${kindLabel(e.kind)} ${ils(e.amount)} דולר`));

        // פירוט (משלוחים/הוצאות ב‑desc, הזמנות ב‑note)
        const detail = cleanTxt(e.note || e.desc || '');
        if (detail) msgs.push(say(`פירוט ${detail}`));

        // פריטים ומחירים
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
    if (choice === '4') {
      const last = await getLastShipperPayment();
      if (!last) {
        return send(call, [say('אין פעולות למחיקה להתראות')]);
      }
      const safeTime = String(last.time || '').replace(/:/g, ' ');
      const delConfirm = await call.read([{ type: 'text',
        data: `הפעולה האחרונה היא ${ils(last.amount)} דולר שנרשמה בשעה ${safeTime} למחיקה הקש 1 לביטול הקש 2` }],
        'tap', { max_digits: 1, min_digits: 1 });
      if (delConfirm !== '1') {
        return send(call, [say('המחיקה בוטלה להתראות')]);
      }
      const { deleted, summary } = await deleteShipperPaymentById(last.id);
      console.log('   🗑️ מחיקה:', last.amount, deleted ? 'הצליח' : 'לא נמצא');
      if (!deleted) {
        return send(call, [say('הפעולה כבר נמחקה להתראות')]);
      }
      return send(call, [
        say(`הפעולה נמחקה בהצלחה`),
        say(blueBoxSpeech(summary)),
        say('להתראות'),
      ]);
    }

    /* ===== 1: הוספת כסף לשליח ===== */
    const raw = await call.read([say('נא הקש את הסכום שנתת לשליח בדולרים שלמים ואחריו סולמית')],
      'tap', { max_digits: 7, min_digits: 1 });
    console.log('   סכום שהוקש:', raw);
    const amount = parseInt(raw, 10);
    if (!amount || amount <= 0) return send(call, [say('סכום לא תקין להתראות')]);

    const confirm = await call.read([say(`הקשת ${amount} דולר לאישור הקש 1 לביטול הקש 2`)],
      'tap', { max_digits: 1, min_digits: 1 });
    if (confirm !== '1') return send(call, [say('הפעולה בוטלה להתראות')]);

    const { summary } = await addShipperPayment(amount);
    console.log('   ✅ נרשם:', amount);

    return send(call, [
      say(`נרשם בהצלחה נתת לשליח ${amount} דולר`),
      say(blueBoxSpeech(summary)),
      say('להתראות'),
    ]);
  } catch (err) {
    if (err && err.isExitError) return;               // המתקשר ניתק — לא שגיאה אמיתית
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
app.listen(PORT, () => console.log(`🚀 השרת רץ על פורט ${PORT}`));
