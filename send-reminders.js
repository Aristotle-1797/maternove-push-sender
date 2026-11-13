// Sends due reminders and Premium expiry warnings. Each one becomes an in-app
// notification (the bell) plus a push to the user's registered devices.
// Runs on a schedule (GitHub Actions). Reads only what is in the current time
// window, so it stays inside the free Firestore quota as the app grows.
import admin from "firebase-admin";

const TZ = process.env.APP_TZ || "Africa/Nairobi"; // reminder times are stored as local HH:MM
const LOOKBACK_MIN = 30; // catches reminders if a scheduled run was late or skipped
const NOTIF_DAYS = 30; // in-app notifications are removed after this many days (Firestore TTL on expireAt)
const WARN_DAYS = 3; // warn this many days before a Premium pass ends
const PREMIUM_CHECK_FROM = "09:00"; // Premium checks run once a day, in this local window
const PREMIUM_CHECK_TO = "09:14";

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();
const messaging = admin.messaging();

function localParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const DEAD = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"];
const ALREADY_EXISTS = 6; // Firestore gRPC code

// Writes the in-app notification (once per id) and pushes it to the user's devices.
// Returns { created, delivered }, or null if the in-app write failed (caller retries next run).
async function notify(uid, id, title, body, url, tag) {
  // The id is fixed per event and create() fails if it exists, so a re-run can never
  // duplicate it or turn a read notification back into an unread one.
  let created = true;
  try {
    await db.collection("users").doc(uid).collection("notifications").doc(id).create({
      title,
      body,
      kind: id.startsWith("prem") ? "premium" : "reminder",
      url,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + NOTIF_DAYS * 86400000),
    });
  } catch (e) {
    if (e.code === ALREADY_EXISTS) created = false;
    else {
      console.log(`  in-app notification failed for "${title}":`, e.message);
      return null;
    }
  }

  const devices = await db.collection("users").doc(uid).collection("devices").get();
  if (devices.empty) {
    console.log(`"${title}": no registered device, in-app notification only`);
    return { created, delivered: 0 };
  }
  const res = await messaging.sendEachForMulticast({
    tokens: devices.docs.map((x) => x.data().token),
    data: { title, body, url, tag },
    webpush: { headers: { Urgency: "high", TTL: "3600" } },
  });
  console.log(`"${title}": ${res.successCount} sent, ${res.failureCount} failed`);
  res.responses.forEach((x, i) => {
    if (!x.success) {
      console.log("  push error:", x.error && x.error.code);
      // Remove tokens that no longer work (app uninstalled, permission removed)
      if (x.error && DEAD.includes(x.error.code)) devices.docs[i].ref.delete();
    }
  });
  return { created, delivered: res.successCount };
}

const now = new Date();
const a = localParts(new Date(now.getTime() - LOOKBACK_MIN * 60000));
const b = localParts(now);
const windows = a.date === b.date
  ? [{ date: b.date, from: a.time, to: b.time }]
  : [{ date: a.date, from: a.time, to: "23:59" }, { date: b.date, from: "00:00", to: b.time }];

const BODY = {
  medicine: "Time for your medicine.",
  appointment: "You have an appointment reminder.",
  other: "You have a reminder.",
};

let sent = 0;
let notified = 0;

/* ---------- 1) Reminders ---------- */
for (const w of windows) {
  const snap = await db.collectionGroup("reminders")
    .where("time", ">=", w.from).where("time", "<=", w.to).get();
  console.log(`Window ${w.date} ${w.from}-${w.to}: ${snap.size} reminder(s) with a time in range`);

  for (const d of snap.docs) {
    const r = d.data();
    const slot = `${w.date}T${r.time}`;
    if (r.repeat === "once" && r.date !== w.date) {
      console.log(`Skip "${r.title}": one-off reminder for ${r.date}, not today`);
      continue;
    }
    if (r.lastDone && (r.repeat === "once" || r.lastDone >= w.date)) {
      console.log(`Skip "${r.title}": already marked done`);
      continue;
    }
    if (r.lastPushed && r.lastPushed >= slot) {
      console.log(`Skip "${r.title}": already pushed for ${r.lastPushed}`);
      continue;
    }

    const uid = d.ref.parent.parent.id;
    const out = await notify(
      uid,
      `rem-${d.id}-${slot.replace(/[^0-9T]/g, "")}`,
      r.title,
      BODY[r.kind] || BODY.other,
      "reminders.html",
      "rem-" + d.id,
    );
    if (!out) continue; // nothing recorded, so the next run retries

    await d.ref.update({ lastPushed: slot }); // this slot is handled
    if (out.created) notified++;
    sent += out.delivered;
  }
}

/* ---------- 2) Premium expiry warnings ---------- */
// Runs once a day (09:00-09:14 local). A range query on premiumUntil alone needs
// no extra index and only reads users whose pass ends soon.
if (b.time >= PREMIUM_CHECK_FROM && b.time <= PREMIUM_CHECK_TO) {
  const soon = await db.collection("users")
    .where("premiumUntil", ">", admin.firestore.Timestamp.fromDate(now))
    .where("premiumUntil", "<=", admin.firestore.Timestamp.fromMillis(now.getTime() + WARN_DAYS * 86400000))
    .get();
  console.log(`Premium: ${soon.size} pass(es) ending within ${WARN_DAYS} day(s)`);

  for (const u of soon.docs) {
    const until = u.get("premiumUntil");
    const days = Math.max(1, Math.ceil((until.toMillis() - now.getTime()) / 86400000));
    const out = await notify(
      u.id,
      `prem-exp-${until.toMillis()}`, // a renewal changes premiumUntil, so it gets a fresh id
      "Your Premium pass is ending soon",
      `Your Premium pass ends in ${days} ${days === 1 ? "day" : "days"}. Renew from your profile to keep premium articles and ad-free use.`,
      "profile.html",
      "prem-exp",
    );
    if (out) {
      if (out.created) notified++;
      sent += out.delivered;
    }
  }

  // Passes that ended in the last 2 days
  const ended = await db.collection("users")
    .where("premiumUntil", ">", admin.firestore.Timestamp.fromMillis(now.getTime() - 2 * 86400000))
    .where("premiumUntil", "<=", admin.firestore.Timestamp.fromDate(now))
    .get();
  console.log(`Premium: ${ended.size} pass(es) ended in the last 2 days`);

  for (const u of ended.docs) {
    const until = u.get("premiumUntil");
    const out = await notify(
      u.id,
      `prem-end-${until.toMillis()}`,
      "Your Premium pass has ended",
      "Renew from your profile to get premium articles and ad-free use back.",
      "profile.html",
      "prem-end",
    );
    if (out) {
      if (out.created) notified++;
      sent += out.delivered;
    }
  }
}

console.log(
  `Checked ${windows.length} window(s) in ${TZ}; ${notified} in-app notification(s), ${sent} push message(s) delivered.`,
);
